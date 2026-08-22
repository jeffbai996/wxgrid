"""Python-side access for other projects (signal engines and the like): the same store the
map reads, as xarray.

    from wxgrid.reader import open_run, latest, series, region_mean

    ds = open_run("aifs")                        # latest complete AIFS run
    ds = open_run("gfs", "2026-08-18T00")
    ds.t2m.sel(step=24).values                   # (721, 1440) K
    series("aifs", "u10", lat=49.3, lon=-123.1)  # (steps,) at a point
    region_mean("ifs", "tp6", lat=(35, 45), lon=(-100, -85))   # e.g. corn belt rain, mm/6h per step

Model agreement is the interesting product for a signal engine: fetch the
same variable from two models and compare (both share the grid and steps).

Nothing here imports the API or the fetchers; a consumer can vendor this
file or `pip install -e ~/local-projects/wxgrid`.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import xarray as xr

from wxgrid.config import STORE_DIR
from wxgrid.store import list_runs, run_path


def latest(model: str, root: Path = STORE_DIR) -> str | None:
    runs = list_runs(model, root)
    return runs[0] if runs else None


def open_run(model: str, run: str | None = None, root: Path = STORE_DIR) -> xr.Dataset:
    rid = run or latest(model, root)
    if rid is None:
        raise FileNotFoundError(f"no complete runs for {model}")
    ds = xr.open_zarr(run_path(model, rid, root), consolidated=False)
    ds.attrs.setdefault("run", rid)
    # Fields are stored float16 against an offset/scale (wxgrid.store
    # encoding_for); hand consumers real units, lazily.
    for v in list(ds.data_vars):
        a = ds[v].attrs
        off, sc = float(a.get("offset", 0.0)), float(a.get("scale", 1.0))
        if off or sc != 1.0 or ds[v].dtype == np.float16:
            units = a.get("units", "")
            ds[v] = ds[v].astype("float32") * sc + off
            ds[v].attrs["units"] = units
    return ds


def series(model: str, var: str, lat: float, lon: float, run: str | None = None,
           root: Path = STORE_DIR) -> xr.DataArray:
    ds = open_run(model, run, root)
    return ds[var].sel(latitude=lat, longitude=lon, method="nearest")


def region_mean(model: str, var: str, lat: tuple[float, float], lon: tuple[float, float],
                run: str | None = None, root: Path = STORE_DIR) -> xr.DataArray:
    """Area mean over a lat/lon box, cos-latitude weighted. lat=(south, north)."""
    ds = open_run(model, run, root)
    south, north = sorted(lat)
    box = ds[var].sel(latitude=slice(north, south), longitude=slice(lon[0], lon[1]))
    w = np.cos(np.deg2rad(box.latitude))
    return box.weighted(w).mean(("latitude", "longitude"))


def spread(models: list[str], var: str, lat: float, lon: float, root: Path = STORE_DIR) -> xr.Dataset:
    """Same point, several models, aligned on valid time. Returns a Dataset
    with one variable per model plus 'mean' and 'range' — the disagreement
    signal a downstream engine wants."""
    parts = {}
    for m in models:
        ds = open_run(m, root=root)
        t0 = np.datetime64(ds.attrs["run"] + ":00")
        s = ds[var].sel(latitude=lat, longitude=lon, method="nearest")
        parts[m] = s.assign_coords(valid=("step", t0 + ds.step.values.astype("timedelta64[h]"))).swap_dims(step="valid").drop_vars("step")
    out = xr.Dataset(parts)
    stack = out.to_array("model")
    out["mean"] = stack.mean("model")
    out["range"] = stack.max("model") - stack.min("model")
    return out
