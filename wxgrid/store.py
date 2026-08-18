"""Zarr store: one group per (model, run), arrays per canonical variable.

Layout:  STORE_DIR/<model>/<run>.zarr
           attrs: model, run (ISO), steps [h], complete (bool), attribution
           step (int32[n]), latitude (f32[721]), longitude (f32[1440])
           <var> (f32[n, 721, 1440]) chunked one step at a time, zstd

Chunking one step per chunk means the API reads exactly one 4 MB chunk per
layer request and a point query touches n small slices — both cheap.
Arrays carry `dimension_names`, so `xarray.open_zarr` sees proper coords.
"""
from __future__ import annotations

import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import zarr
from zarr.codecs import BloscCodec

from wxgrid.config import GRID_LAT_N, GRID_LON_N, GRID_RES, KEEP_RUNS, STORE_DIR
from wxgrid.models import HALF_PRECISION_PREFIXES

LATS = np.linspace(90.0, -90.0, GRID_LAT_N, dtype=np.float32)
LONS = (np.arange(GRID_LON_N, dtype=np.float32) * GRID_RES - 180.0).astype(np.float32)


def run_id(when: datetime) -> str:
    """Run key used in paths and URLs: 2026-08-18T00 (UTC, hour precision)."""
    return when.astimezone(timezone.utc).strftime("%Y-%m-%dT%H")


def parse_run_id(rid: str) -> datetime:
    return datetime.strptime(rid, "%Y-%m-%dT%H").replace(tzinfo=timezone.utc)


def run_path(model: str, rid: str, root: Path = STORE_DIR) -> Path:
    return root / model / f"{rid}.zarr"


def list_runs(model: str, root: Path = STORE_DIR, complete_only: bool = True) -> list[str]:
    """Run ids for a model, newest first."""
    mdir = root / model
    if not mdir.is_dir():
        return []
    out = []
    for p in sorted(mdir.glob("*.zarr"), reverse=True):
        if complete_only:
            try:
                if not zarr.open_group(p, mode="r").attrs.get("complete"):
                    continue
            except Exception:
                continue
        out.append(p.name[:-5])
    return out


def latest_run(model: str, root: Path = STORE_DIR) -> str | None:
    runs = list_runs(model, root)
    return runs[0] if runs else None


class RunWriter:
    """Create the group up front, fill step slabs as GRIBs land, mark complete."""

    def __init__(self, model: str, rid: str, steps: list[int], variables: list[str],
                 attribution: str = "", root: Path = STORE_DIR) -> None:
        self.path = run_path(model, rid, root)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if self.path.exists():
            shutil.rmtree(self.path)
        self.steps = list(steps)
        self.variables = list(dict.fromkeys(variables))
        self.group = zarr.open_group(self.path, mode="w")
        self.group.attrs.update({
            "model": model, "run": rid, "steps": self.steps, "complete": False,
            "attribution": attribution, "variables": self.variables,
            "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        })
        self.group.create_array("step", data=np.asarray(self.steps, dtype=np.int32),
                                dimension_names=("step",))
        self.group.create_array("latitude", data=LATS, dimension_names=("latitude",))
        self.group.create_array("longitude", data=LONS, dimension_names=("longitude",))
        codec = BloscCodec(cname="zstd", clevel=3, shuffle="bitshuffle")
        for var in self.variables:
            dtype = "float16" if var.startswith(HALF_PRECISION_PREFIXES) else "float32"
            arr = self.group.create_array(
                var, shape=(len(self.steps), GRID_LAT_N, GRID_LON_N), dtype=dtype,
                chunks=(1, GRID_LAT_N, GRID_LON_N), compressors=codec,
                fill_value=np.nan, dimension_names=("step", "latitude", "longitude"),
            )
            arr.attrs["units"] = _UNITS.get(var, {"u": "m s-1", "v": "m s-1", "t": "K", "gh": "m"}.get(var.split("_")[0], ""))
        self._written: dict[str, set[int]] = {v: set() for v in self.variables}

    def write(self, var: str, step: int, values: np.ndarray) -> None:
        if var not in self.variables:
            return
        idx = self.steps.index(step)
        self.group[var][idx] = np.asarray(values, dtype=self.group[var].dtype)
        self._written[var].add(step)

    def has(self, var: str, step: int) -> bool:
        return step in self._written.get(var, ())

    def read(self, var: str, step: int) -> np.ndarray:
        return np.asarray(self.group[var][self.steps.index(step)])

    def finish(self) -> dict[str, int]:
        """Mark complete; returns per-variable count of steps actually written."""
        counts = {v: len(s) for v, s in self._written.items()}
        # A variable no step ever delivered (e.g. gust on a model without it)
        # is dropped from the manifest so the API never advertises it.
        present = [v for v, n in counts.items() if n > 0]
        self.group.attrs.update({"complete": True, "variables": present, "coverage": counts})
        return counts


_UNITS = {"u10": "m s-1", "v10": "m s-1", "t2m": "K", "msl": "Pa", "tp6": "mm", "gust": "m s-1",
          "tcc": "1", "cape": "J kg-1"}


class RunReader:
    def __init__(self, model: str, rid: str, root: Path = STORE_DIR) -> None:
        self.model, self.rid = model, rid
        self.path = run_path(model, rid, root)
        if not self.path.exists():
            raise FileNotFoundError(f"no run {model}/{rid}")
        self.group = zarr.open_group(self.path, mode="r")
        self.steps: list[int] = list(self.group.attrs["steps"])
        self.variables: list[str] = list(self.group.attrs.get("variables", []))
        self.attrs = dict(self.group.attrs)

    def slab(self, var: str, step: int) -> np.ndarray:
        """One (721, 1440) float32 field."""
        return np.asarray(self.group[var][self.steps.index(step)], dtype=np.float32)

    def point(self, var: str, lat: float, lon: float) -> np.ndarray:
        """Nearest-gridpoint series over all steps, shape (n,)."""
        i = int(round((90.0 - lat) / GRID_RES))
        j = int(round((lon + 180.0) / GRID_RES)) % GRID_LON_N
        i = min(max(i, 0), GRID_LAT_N - 1)
        return np.asarray(self.group[var][:, i, j], dtype=np.float32)

    def manifest(self) -> dict:
        return {"model": self.model, "run": self.rid, "steps": self.steps,
                "variables": self.variables, "attribution": self.attrs.get("attribution", ""),
                "coverage": self.attrs.get("coverage", {})}


def prune(model: str, keep: int = KEEP_RUNS, root: Path = STORE_DIR) -> list[str]:
    """Delete all but the newest `keep` complete runs (and any incomplete
    run older than the newest complete one — a fetch that died mid-way)."""
    mdir = root / model
    if not mdir.is_dir():
        return []
    complete = list_runs(model, root, complete_only=True)
    everything = list_runs(model, root, complete_only=False)
    keepers = set(complete[:keep])
    if complete:
        newest = complete[0]
        keepers |= {r for r in everything if r > newest}   # in-flight newer fetch
    removed = []
    for rid in everything:
        if rid not in keepers:
            shutil.rmtree(run_path(model, rid, root), ignore_errors=True)
            removed.append(rid)
    return removed


def store_summary(root: Path = STORE_DIR) -> dict:
    out = {}
    if root.is_dir():
        for mdir in sorted(root.iterdir()):
            if mdir.is_dir():
                out[mdir.name] = list_runs(mdir.name, root)
    return out


def dumps(obj) -> str:
    return json.dumps(obj, default=str)
