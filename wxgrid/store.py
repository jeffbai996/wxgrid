"""Zarr store: one group per (model, run), arrays per canonical variable.

Layout:  STORE_DIR/<model>/<run>.zarr
           attrs: model, run (ISO), steps [h], complete (bool), attribution
           step (int32[n]), latitude (f32[ny]), longitude (f32[nx])
           <var> (f32[n, ny, nx]) chunked one step at a time, zstd

Chunking one step per chunk means the API reads exactly one 4 MB chunk per
layer request and a point query touches n small slices — both cheap.
Arrays carry `dimension_names`, so `xarray.open_zarr` sees proper coords.
"""
from __future__ import annotations

import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

import os
import time
import numpy as np
import zarr
from zarr.codecs import BloscCodec

from wxgrid.config import CACHE_DIR, GRID_LAT_N, GRID_LON_N, GRID_RES, KEEP_RUNS, STORE_DIR
from wxgrid.models import HALF_PRECISION_PREFIXES, get_model

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


# ── on-disk encoding ────────────────────────────────────────────────────
# Every field is stored float16 (half the bytes of float32, and the pt/ cube
# mirrors it, so a run shrinks by half twice). float16 keeps ~3 significant
# digits, so fields that live far from zero are stored as an OFFSET from a
# reference (temperatures in °C, pressure as Pa above 100 000) and wide
# fields are SCALED down (geopotential height in 4 m units, visibility in
# decametres) — worst-case errors land in the hundredths, measured on real
# GFS fields 2026-08-22 (t2m 0.03 K, msl 2 Pa, u10 0.016 m/s). The reader
# undoes it from the array attrs, so runs written before this (no attrs)
# decode as identity and keep working.
def encoding_for(var: str) -> tuple[float, float]:
    """(offset, scale): stored = (value - offset) / scale, as float16."""
    base = var.split("_")[0]
    if var in ("t2m", "d2m", "sst") or base == "t":
        return 273.15, 1.0
    if var == "msl":
        return 100000.0, 1.0
    if base == "gh":
        return 0.0, 4.0
    if var == "vis":
        return 0.0, 10.0
    return 0.0, 1.0


def encode_values(var: str, values: np.ndarray) -> np.ndarray:
    off, sc = encoding_for(var)
    v = np.asarray(values, dtype=np.float32)
    if off or sc != 1.0:
        v = (v - off) / sc
    return v.astype(np.float16, copy=False)


def decode_values(arr_attrs: dict, values: np.ndarray) -> np.ndarray:
    off = float(arr_attrs.get("offset", 0.0)); sc = float(arr_attrs.get("scale", 1.0))
    v = np.asarray(values, dtype=np.float32)
    return v * sc + off if (off or sc != 1.0) else v


# ── write pacing ────────────────────────────────────────────────────────
# The ingest used to fire a whole run at the disk as fast as it decoded, and
# the live API's cold point reads queued behind it (35 s, 2026-08-21).
# cgroup io.max would be the right tool, but WSL's user manager has no `io`
# controller delegated, so IOWeight/IOWriteBandwidthMax on a user unit are
# silently inert. Pacing in userland works everywhere: a token bucket on
# bytes handed to zarr, default 60 MB/s (WXGRID_WRITE_MBPS), which stretches
# a run's writes over minutes instead of seconds and leaves the disk idle
# gaps for the server. Costs nothing when the disk is the bottleneck anyway.
class _Pacer:
    def __init__(self, mbps: float | None = None, env: str = "WXGRID_WRITE_MBPS",
                 default: float = 60.0) -> None:
        rate = float(os.environ.get(env, str(default))) if mbps is None else mbps
        self.rate = rate * 1e6
        self.t = time.monotonic()
        self.budget = self.rate           # one second of credit to start

    def spend(self, nbytes: int) -> None:
        if self.rate <= 0:
            return
        now = time.monotonic()
        self.budget = min(self.rate, self.budget + (now - self.t) * self.rate)
        self.t = now
        self.budget -= nbytes
        if self.budget < 0:
            time.sleep(-self.budget / self.rate)
            # the sleep must not count as refill time, or the bucket pays
            # every debt twice and the real rate doubles (measured 2026-08-22)
            self.t = time.monotonic()
            self.budget = 0.0


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
        grid = get_model(model)
        self.grid_shape = grid.grid_shape
        self.lats = (grid.lat0 + np.arange(grid.grid_shape[0], dtype=np.float64) * grid.dlat).astype(np.float32)
        self.lons = (grid.lon0 + np.arange(grid.grid_shape[1], dtype=np.float64) * grid.dlon).astype(np.float32)
        self.group = zarr.open_group(self.path, mode="w")
        self.group.attrs.update({
            "model": model, "run": rid, "steps": self.steps, "complete": False,
            "attribution": attribution, "variables": self.variables,
            "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "grid_shape": list(grid.grid_shape), "lat0": grid.lat0, "lon0": grid.lon0,
            "dlat": grid.dlat, "dlon": grid.dlon, "domain": list(grid.domain),
        })
        self.group.create_array("step", data=np.asarray(self.steps, dtype=np.int32),
                                dimension_names=("step",))
        self.group.create_array("latitude", data=self.lats, dimension_names=("latitude",))
        self.group.create_array("longitude", data=self.lons, dimension_names=("longitude",))
        codec = BloscCodec(cname="zstd", clevel=3, shuffle="bitshuffle")
        for var in self.variables:
            arr = self.group.create_array(
                var, shape=(len(self.steps), *self.grid_shape), dtype="float16",
                chunks=(1, *self.grid_shape), compressors=codec,
                fill_value=np.nan, dimension_names=("step", "latitude", "longitude"),
            )
            off, sc = encoding_for(var)
            arr.attrs.update({"units": _UNITS.get(var, {"u": "m s-1", "v": "m s-1", "t": "K", "gh": "m"}.get(var.split("_")[0], "")),
                              "offset": off, "scale": sc})
        self._written: dict[str, set[int]] = {v: set() for v in self.variables}
        self._pacer = _Pacer()

    def write(self, var: str, step: int, values: np.ndarray) -> None:
        if var not in self.variables:
            return
        idx = self.steps.index(step)
        values = np.asarray(values)
        if values.shape != self.grid_shape:
            raise ValueError(f"{self.group.attrs['model']} grid expects {self.grid_shape}, got {values.shape}")
        enc = encode_values(var, values)
        self._pacer.spend(enc.nbytes)
        self.group[var][idx] = enc
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
        fallback = get_model(model)
        self.grid_shape = tuple(self.attrs.get("grid_shape", fallback.grid_shape))
        self.lat0 = float(self.attrs.get("lat0", fallback.lat0))
        self.lon0 = float(self.attrs.get("lon0", fallback.lon0))
        self.dlat = float(self.attrs.get("dlat", fallback.dlat))
        self.dlon = float(self.attrs.get("dlon", fallback.dlon))
        self.domain = tuple(self.attrs.get("domain", fallback.domain))
        self.lats = np.asarray(self.group["latitude"][:], dtype=np.float32)
        self.lons = np.asarray(self.group["longitude"][:], dtype=np.float32)

    def decode(self, var: str, values: np.ndarray) -> np.ndarray:
        """Undo the on-disk encoding (see encoding_for) for raw reads of `var`."""
        return decode_values(dict(self.group[var].attrs), values)

    def slab(self, var: str, step: int) -> np.ndarray:
        """One (ny, nx) float32 field on this model's regular lat/lon grid."""
        return self.decode(var, self.group[var][self.steps.index(step)])

    def contains(self, lat: float, lon: float) -> bool:
        west, south, east, north = self.domain
        return south <= lat <= north and west <= lon <= east

    def indices(self, lat, lon) -> tuple[np.ndarray, np.ndarray]:
        """Nearest row/column indices for scalar or array coordinates."""
        lats = np.asarray(lat, dtype=np.float64)
        lons = np.asarray(lon, dtype=np.float64)
        i = np.rint((lats - self.lat0) / self.dlat).astype(int)
        j = np.rint((lons - self.lon0) / self.dlon).astype(int)
        i = np.clip(i, 0, self.grid_shape[0] - 1)
        if self.domain == (-180.0, -90.0, 180.0, 90.0):
            j %= self.grid_shape[1]
        else:
            j = np.clip(j, 0, self.grid_shape[1] - 1)
        return i, j

    def point(self, var: str, lat: float, lon: float) -> np.ndarray:
        """Nearest-gridpoint series over all steps, shape (n,). Reads the
        point cube (all steps × a small tile per chunk) when the run has one;
        the step-per-chunk layout means decompressing every step otherwise."""
        if not self.contains(lat, lon):
            raise ValueError(f"point ({lat}, {lon}) is outside {self.model} domain")
        ii, jj = self.indices(lat, lon)
        i, j = int(ii), int(jj)
        pt = self._pt.get(var)
        raw = pt[:, i, j] if pt is not None else self.group[var][:, i, j]
        return self.decode(var, raw)

    @property
    def _pt(self) -> dict:
        if not hasattr(self, "_pt_cache"):
            self._pt_cache = {}
            if "pt" in self.group:
                g = self.group["pt"]
                self._pt_cache = {name: g[name] for name in g.array_keys()}
        return self._pt_cache

    def manifest(self) -> dict:
        return {"model": self.model, "run": self.rid, "steps": self.steps,
                "variables": self.variables, "attribution": self.attrs.get("attribution", ""),
                "coverage": self.attrs.get("coverage", {}), "grid_shape": list(self.grid_shape),
                "domain": list(self.domain)}


POINT_TILE = 24    # point-cube spatial chunk (24 × 24 gridpoints = 6° × 6°)


def build_point_cube(model: str, rid: str, root: Path = STORE_DIR, variables: list[str] | None = None) -> int:
    """Re-chunk a run for point reads: pt/<var> with chunks (all steps, 24, 24),
    so a point series decompresses one small chunk instead of every step.
    Roughly doubles the run on disk. Idempotent per variable; returns the
    number of variables written."""
    g = zarr.open_group(run_path(model, rid, root), mode="r+")
    pt = g.require_group("pt")
    codec = BloscCodec(cname="zstd", clevel=3, shuffle="bitshuffle")
    n = 0
    for var in (variables or list(g.attrs.get("variables", []))):
        if var in pt or var not in g:
            continue
        src = g[var]
        arr = pt.create_array(var, shape=src.shape, dtype=src.dtype,
                              chunks=(src.shape[0], POINT_TILE, POINT_TILE), compressors=codec,
                              fill_value=np.nan, dimension_names=("step", "latitude", "longitude"))
        arr.attrs.update({k: src.attrs[k] for k in ("offset", "scale", "units") if k in src.attrs})
        # Copy one latitude band at a time. Reading the whole variable would be
        # ~250 MB resident per variable and, with several ingests and the API
        # in flight, that was enough to put fragserv into swap (2026-08-18).
        pacer = _Pacer()
        # One read of the whole variable. The map chunks span the full grid
        # per step, so reading in bands decompressed every chunk once per
        # band — thirty times over for a global run, 400 GB of reads and
        # most of the ingest's CPU per cycle (2026-08-22). A global variable
        # is ~270 MB in float16; the writes stay banded for the pacer.
        full = src[:]
        for y0 in range(0, src.shape[1], POINT_TILE):
            y1 = min(y0 + POINT_TILE, src.shape[1])
            band = full[:, y0:y1, :]
            pacer.spend(band.nbytes)
            arr[:, y0:y1, :] = band
        del full
        n += 1
    return n


def prune(model: str, keep: int | None = None, root: Path = STORE_DIR) -> list[str]:
    """Delete all but the newest `keep` complete runs (and any incomplete
    run older than the newest complete one — a fetch that died mid-way)."""
    if keep is None:
        keep = get_model(model).keep_runs or KEEP_RUNS
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
    strip_stale_point_cubes(model, root)
    # The render cache is keyed by run too; renders of a run that no longer
    # exists can never be served again. Only whole run directories go — the
    # model-level JSON caches live beside them and stay.
    cdir = CACHE_DIR / model
    if cdir.is_dir():
        live = set(everything) - set(removed)
        for sub in cdir.iterdir():
            if sub.is_dir() and sub.name not in live and sub.name < (complete[0] if complete else ""):
                shutil.rmtree(sub, ignore_errors=True)
    return removed


def strip_stale_point_cubes(model: str, root: Path = STORE_DIR) -> list[str]:
    """Drop pt/ from every complete run except the newest. The app reads
    points only from the newest run (the run picker retired 2026-08-21), so
    a superseded run's cube is dead weight — it was half of every run, and
    99 GB of a 200 GB store when this landed. Older runs still answer point
    queries through the step layout, just slower. Rebuildable any time with
    `python -m wxgrid.ingest --model <m> --point-cube`."""
    complete = list_runs(model, root, complete_only=True)
    stripped = []
    for rid in complete[1:]:
        p = run_path(model, rid, root)
        pt = p / "pt"
        if pt.is_dir():
            shutil.rmtree(pt, ignore_errors=True)
            # the API caches readers keyed on the group's zarr.json mtime; a
            # reader holding handles to the deleted cube must be reopened
            meta = p / "zarr.json"
            if meta.exists():
                meta.touch()
            stripped.append(rid)
    return stripped


def store_summary(root: Path = STORE_DIR) -> dict:
    out = {}
    if root.is_dir():
        for mdir in sorted(root.iterdir()):
            if mdir.is_dir():
                out[mdir.name] = list_runs(mdir.name, root)
    return out


def dumps(obj) -> str:
    return json.dumps(obj, default=str)
