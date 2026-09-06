"""Compare bounded ingest paths in fresh, one-core memory-capped processes.

PYTHONPATH=. venv/bin/python scripts/profile_ingest_memory.py point --run ...
PYTHONPATH=. venv/bin/python scripts/profile_ingest_memory.py grib --baseline REF

Point mode reads ONE existing variable, writes a disposable point array on
the store filesystem, and hashes it bandwise. GRIB mode uses deterministic
synthetic decoded HRRR-sized fields and a hashing writer (no fetch/decode).
Neither mode modifies a live run. --baseline imports only the named trusted
local Git revision; run without it for the current checkout.
"""
import argparse
from dataclasses import replace
from datetime import datetime, timezone
import gc
import hashlib
import json
from pathlib import Path
import resource
import subprocess
import sys
import tempfile
import time
import types

import numpy as np
import zarr

from wxgrid import ingest, store
from wxgrid.grib import Field


def module_at(name, revision):
    if not revision:
        return {"ingest": ingest, "store": store}[name]
    code = subprocess.check_output(["git", "show", f"{revision}:wxgrid/{name}.py"], text=True)
    module = types.ModuleType(f"wxgrid._profile_{name}")
    sys.modules[module.__name__] = module
    exec(compile(code, f"{revision}:wxgrid/{name}.py", "exec"), module.__dict__)
    return module


def metrics(start, cpu):
    usage = resource.getrusage(resource.RUSAGE_SELF)
    cg = Path("/sys/fs/cgroup") / Path("/proc/self/cgroup").read_text().strip().split("::", 1)[1].lstrip("/")
    result = {"seconds": round(time.perf_counter() - start, 3),
              "cpu_seconds": round(time.process_time() - cpu, 3),
              "peak_rss_mib": round(usage.ru_maxrss / 1024, 1)}
    for name in ("memory.peak", "memory.swap.peak"):
        path = cg / name
        if path.exists():
            result[name + "_mib"] = round(int(path.read_text()) / 2**20, 1)
    return result


def point(args):
    module = module_at("store", args.baseline)
    source = zarr.open_group(store.run_path(args.model, args.run), mode="r")[args.variable]
    with tempfile.TemporaryDirectory(prefix=".profile-point-", dir=store.STORE_DIR) as directory:
        # Copy compressed source files, not decoded cubes. This makes the
        # legacy builder usable unmodified, with no writes to the live run.
        import shutil
        root = Path(directory)
        path = store.run_path(args.model, args.run, root)
        path.mkdir(parents=True)
        shutil.copytree(store.run_path(args.model, args.run) / args.variable, path / args.variable)
        group = zarr.open_group(path, mode="a")
        group.attrs["variables"] = [args.variable]
        # Flush source-copy cache before measuring either variant.
        for file in (path / args.variable).rglob("*"):
            if file.is_file():
                with file.open("rb") as f:
                    store._drop_staging_cache(f)
        gc.collect()
        start, cpu = time.perf_counter(), time.process_time()
        assert module.build_point_cube(args.model, args.run, root) == 1
        result = metrics(start, cpu)
        digest = hashlib.sha256()
        arr = group["pt"][args.variable]
        for y0 in range(0, arr.shape[1], store.POINT_TILE):
            band = arr[:, y0:y0 + store.POINT_TILE, :]
            digest.update(memoryview(band).cast("B"))
            del band
        result.update(sha256=digest.hexdigest(), shape=list(source.shape),
                      raw_variable_mib=round(np.prod(source.shape).item() * source.dtype.itemsize / 2**20, 1),
                      point_bytes=sum(f.stat().st_size for f in (path / "pt").rglob("*") if f.is_file()))
    return result


def grib(args):
    module = module_at("ingest", args.baseline)
    model = replace(ingest.get_model("hrrr"), steps=[3, 6])
    type(model).canonical = lambda self, name, *a: name
    hashes = {}

    class Writer:
        variables = ["tp6", "sf6"]

        def __init__(self, *args, **kwargs):
            pass

        def write(self, var, step, values):
            # Exercise temporary writer conversion, but retain only a digest.
            encoded = values.astype(np.float16)
            hashes[f"{step}:{var}"] = hashlib.sha256(memoryview(encoded).cast("B")).hexdigest()

        def finish(self):
            return {}

    def fields(path, **kwargs):
        step = int(path.stem[4:])
        rng = np.random.default_rng(step)
        for name in ["tp", "sf", "tsk", "lsm", *[f"t_{i}" for i in range(24)]]:
            values = rng.random(model.grid_shape, dtype=np.float32)
            yield Field(name, step, values)
            del values

    def fetch(model, run, root, on_step):
        for step in model.steps:
            on_step(step, [Path(f"step{step:03d}.grib2")])
        return model.steps

    module.RunWriter = Writer
    module.iter_fields = fields
    module.fetch.fetch_hrrr = fetch
    module.fetch.grib_override = lambda p: (None, None)
    module.wait_for_step_gate = lambda: None
    module.build_point_cube = lambda *a, **kw: 0
    module.prune = lambda *a, **kw: []
    module.warm_layers = lambda *a, **kw: 0
    with tempfile.TemporaryDirectory(prefix="wxgrid-profile-grib-") as directory:
        start, cpu = time.perf_counter(), time.process_time()
        module._ingest_locked(model, datetime(2026, 9, 6, tzinfo=timezone.utc), "2026-09-06T00",
                              Path(directory), Path(directory), True)
        result = metrics(start, cpu)
    result.update(sha256=hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest(),
                  fields_written=len(hashes), shape=list(model.grid_shape), synthetic=True)
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("point", "grib"))
    parser.add_argument("--baseline")
    parser.add_argument("--model", default="hrrr")
    parser.add_argument("--run")
    parser.add_argument("--variable", default="t2m")
    args = parser.parse_args()
    if args.mode == "point" and not args.run:
        parser.error("point mode requires --run")
    print(json.dumps({"mode": args.mode, "revision": args.baseline or "working-tree",
                      **(point(args) if args.mode == "point" else grib(args))}))
