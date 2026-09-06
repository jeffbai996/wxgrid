"""Bounded local ingest-path benchmark; writes only a disposable temp store.

Three global steps, two variables, normal store quantization/compression and
point-cube rebuild. Compare fresh processes with/without native/allocator env
limits. This is not a whole-ingest peak or a network/download benchmark.
"""
import gc
import hashlib
import json
from pathlib import Path
import resource
import tempfile
import time

import numpy as np
import zarr
from wxgrid import store


def rss():
    lines = Path("/proc/self/status").read_text().splitlines()
    return int(next(line.split()[1] for line in lines if line.startswith("VmRSS:"))) / 1024


def main():
    start = time.perf_counter()
    digest = hashlib.sha256()
    with tempfile.TemporaryDirectory(prefix="wxgrid-profile-store-") as directory:
        root = Path(directory)
        writer = store.RunWriter("gfs", "2026-01-01T00", [0, 6, 12], ["t2m", "u10"], root=root)
        rng = np.random.default_rng(123)
        for variable in ("t2m", "u10"):
            for step in (0, 6, 12):
                field = rng.random(writer.grid_shape, dtype=np.float32) * 20 + (270 if variable == "t2m" else 0)
                writer.write(variable, step, field)
                del field
        writer.finish()
        assert store.build_point_cube("gfs", "2026-01-01T00", root) == 2
        group = zarr.open_group(store.run_path("gfs", "2026-01-01T00", root), mode="r")
        for variable in ("t2m", "u10"):
            original, point = group[variable][:], group["pt"][variable][:]
            np.testing.assert_array_equal(original, point)
            digest.update(point.tobytes())
            del original, point
        size = sum(p.stat().st_size for p in root.rglob("*") if p.is_file())
        del group, writer
    gc.collect()
    print(json.dumps({"seconds": round(time.perf_counter()-start, 3), "rss_mib": round(rss(), 1),
                      "peak_mib": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1024, 1),
                      "store_bytes": size, "sha256": digest.hexdigest(), "point_cube_equal": True}))


if __name__ == "__main__":
    main()
