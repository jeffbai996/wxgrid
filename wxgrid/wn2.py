"""WeatherNext 2 (Google DeepMind FGN) from its Zarr, into the store.

Google publishes the operational WeatherNext 2 forecasts as Zarr on GCS
(`gs://weathernext/weathernext_2_0_0_mean/zarr` for the ensemble mean,
`…/weathernext_2_0_0/zarr` for all 64 members), 0.25°, four inits a day,
6 h steps to 15 days, about two hours after init. Access is gated: a GCP
project plus Google's data-request form, then `gcsfs` credentials on this
box. The collection contains year partitions, timestamped run directories,
and a `predictions.zarr` store per completed run. Direct Zarr URLs remain
supported. `WXGRID_WN2_ZARR` unset means the model is simply not ingested.

Nothing GRIB here: the source is already an array store, so this bypasses
the GRIB fetch/decode path and writes straight through RunWriter.
"""
from __future__ import annotations

import logging
import os
import posixpath
import re
from collections.abc import Iterator
from datetime import datetime, timedelta, timezone
from itertools import islice
from pathlib import Path
from typing import Any

import numpy as np

from wxgrid.config import STORE_DIR
from wxgrid.models import LEVEL_EVERY, Model
from wxgrid.store import RunWriter, build_point_cube, list_runs, run_id, run_lock

log = logging.getLogger("wxgrid.wn2")

ENV_ZARR = "WXGRID_WN2_ZARR"
# The dataset's own names → our canonical store variables.
SURFACE = {
    "2m_temperature": "t2m", "10m_u_component_of_wind": "u10", "10m_v_component_of_wind": "v10",
    "mean_sea_level_pressure": "msl", "total_precipitation_6hr": "tp6", "sea_surface_temperature": "sst",
    # Google's model page spells the 6 h bucket `total_precipitation`; the
    # WeatherBench-style name above is what the evaluation datasets use. The
    # first one present wins, so either spelling is a no-op here.
    "total_precipitation": "tp6",
}
LEVELS_VARS = {"temperature": "t", "u_component_of_wind": "u", "v_component_of_wind": "v", "geopotential": "gh"}
G = 9.80665
# Dimension names as WeatherBench-style Zarr publishes them; the first one
# present wins, so a renamed dimension is a one-line fix here, not a rewrite.
DIM_INIT = ("time", "init_time")
DIM_LEAD = ("prediction_timedelta", "lead_time")
DIM_LEVEL = ("level", "isobaricInhPa")
DIM_LAT = ("latitude", "lat")
DIM_LON = ("longitude", "lon")
DIM_MEMBER = ("sample", "member", "number")
MAX_LATEST_CANDIDATES = 8
_PARTITION = re.compile(r"(\d{4})_to_(?:\d{4}|present)")
_PUBLISHED_RUN = re.compile(r"(\d{8})_(\d{2})hr_(\d+)_preds")


def zarr_url() -> str | None:
    return os.environ.get(ENV_ZARR, "").strip() or None


def _published_init(path: str) -> datetime | None:
    match = _PUBLISHED_RUN.fullmatch(posixpath.basename(path.rstrip("/")))
    if match is None or int(match[3]) < 1:
        return None
    try:
        return datetime.strptime(f"{match[1]}_{match[2]}", "%Y%m%d_%H").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _is_zarr(fs, path: str) -> bool:
    return any(fs.isfile(f"{path}/{name}") for name in (".zmetadata", ".zgroup", "zarr.json"))


def discover_sources(url: str, run: datetime | None = None) -> Iterator[tuple[datetime | None, str]]:
    """Newest completed per-run stores, using directory listings and metadata only.

    Accept a collection root, year partition, run directory, or direct store.
    A published run needs Google's `success` marker and Zarr metadata. No
    recursive walk of the arrays is needed. A direct legacy store may carry
    multiple inits, so its initialization is left to the dataset reader.
    """
    import fsspec

    fs, root = fsspec.core.url_to_fs(url, skip_instance_cache=True)
    root = root.rstrip("/")
    if _is_zarr(fs, root):
        yield None, url
        return
    if run is not None:
        run = run.replace(tzinfo=timezone.utc) if run.tzinfo is None else run.astimezone(timezone.utc)

    def children(path):
        return [name.rstrip("/") for name in fs.ls(path, detail=False)
                if name.rstrip("/") != path]

    def published(paths):
        candidates = [(init, path) for path in paths if (init := _published_init(path)) is not None]
        for init, path in sorted(candidates, reverse=True):
            if run is not None and init != run:
                continue
            store = f"{path}/predictions.zarr"
            if fs.isfile(f"{path}/success") and _is_zarr(fs, store):
                relative = posixpath.relpath(store, root)
                yield init, url.rstrip("/") + "/" + relative

    if _published_init(root) is not None:
        yield from published([root])
        return
    entries = children(root)
    yield from published(entries)
    partitions = [path for path in entries if _PARTITION.fullmatch(posixpath.basename(path))]
    for partition in sorted(partitions, reverse=True):
        yield from published(children(partition))


def normalize_dataset(ds):
    """Give Google's single-init store the legacy init/lead dimensions.

    Published `init_time` is a scalar datetime; `time` is the lead-time axis.
    Only those small coordinate arrays are materialized here. Field arrays
    retain xarray's lazy Zarr-backed storage, and legacy datasets are unchanged.
    """
    if "init_time" not in ds or ds["init_time"].ndim != 0 or "time" not in ds.dims:
        return ds
    if _dim(ds, DIM_LEAD) is not None:
        return ds
    if not np.issubdtype(ds["init_time"].dtype, np.datetime64):
        raise ValueError("WeatherNext scalar init_time must decode to a datetime")
    init = np.asarray(ds["init_time"].values).astype("datetime64[ns]")[()]
    if np.isnat(init):
        raise ValueError("WeatherNext init_time is missing")
    if np.issubdtype(ds["time"].dtype, np.timedelta64):
        leads = ds["time"].values
    elif np.issubdtype(ds["time"].dtype, np.datetime64):
        leads = ds["time"].values - init
    else:
        raise ValueError("WeatherNext time must decode to lead timedeltas or valid datetimes")
    normalized = ds.drop_vars("init_time").rename({"time": "prediction_timedelta"})
    # expand_dims broadcasts data variables and eagerly reads Zarr-backed
    # fields with chunks=None. A separate init coordinate is sufficient for
    # dataset-level selection; the per-run fields keep only their lead axis.
    normalized = normalized.assign_coords(prediction_timedelta=leads, time=[init])
    normalized.set_close(ds.close)
    return normalized


def _open_store(url: str):
    import xarray as xr

    ds = xr.open_zarr(url, consolidated=None, chunks=None, decode_timedelta=True)
    try:
        return normalize_dataset(ds)
    except Exception:
        ds.close()
        raise


def open_dataset(url: str, run: datetime | None = None):
    """Open a direct store or the requested/newest completed collection run."""
    source = next(discover_sources(url, run), None)
    if source is None:
        requested = f" for {run.isoformat()}" if run is not None else ""
        raise FileNotFoundError(f"no published WeatherNext Zarr store{requested} under {url}")
    return _open_store(source[1])


def _dim(ds, names: tuple[str, ...]) -> str | None:
    return next((n for n in names if n in ds.dims), None)


def latest_init(ds, steps: list[int]) -> datetime | None:
    """Newest init whose final lead is present (not all-NaN at one gridpoint).
    None when the store is empty."""
    ds = normalize_dataset(ds)
    di, dl = _dim(ds, DIM_INIT), _dim(ds, DIM_LEAD)
    if di is None or dl is None or ds.sizes[di] == 0:
        return None
    var = next((v for v in SURFACE if v in ds), None)
    if var is None:
        return None
    for i in range(ds.sizes[di] - 1, -1, -1):
        init = _to_dt(ds[di].values[i])
        arr = ds[var]
        if di in arr.dims:
            arr = arr.isel({di: i})
        if _dim(arr, DIM_MEMBER):
            arr = arr.isel({_dim(arr, DIM_MEMBER): 0})
        last = _lead_index(arr, dl, steps[-1])
        if last is None:
            continue
        probe = arr.isel({dl: last, _dim(arr, DIM_LAT): 0, _dim(arr, DIM_LON): 0}).values
        if np.isfinite(probe).any():
            return init
    return None


def _to_dt(v: Any) -> datetime:
    ts = np.datetime64(v, "s").astype("datetime64[s]").astype(int)
    return datetime.fromtimestamp(int(ts), tz=timezone.utc)


def _lead_index(arr, dl: str, hours: int) -> int | None:
    leads = arr[dl].values
    want = np.timedelta64(hours, "h")
    hits = np.where(leads.astype("timedelta64[h]") == want)[0]
    return int(hits[0]) if hits.size else None


def _regrid_to_store(values: np.ndarray, lats: np.ndarray, lons: np.ndarray, model: Model) -> np.ndarray:
    """Onto the store's 0.25° layout (row 0 = 90°N, column 0 = 180°W). The
    dataset is already 0.25°, so this is a flip and a roll, not an interpolation."""
    out = np.asarray(values, dtype=np.float32)
    if lats[0] < lats[-1]:
        out = out[::-1]
    # longitude 0…360 → −180…180
    if lons.min() >= 0.0 and lons.max() > 180.0:
        shift = int(np.argmin(np.abs(((lons + 180.0) % 360.0) - 180.0 + 180.0)))
        out = np.roll(out, -shift, axis=1)
    if out.shape != model.grid_shape:
        raise ValueError(f"WeatherNext grid {out.shape} is not the store grid {model.grid_shape}")
    return out


def ingest_wn2(model: Model, run: datetime, store_root: Path = STORE_DIR, url: str | None = None,
               ds=None) -> dict:
    """One init of the ensemble mean → a complete run in the store. Members,
    when the dataset carries them, become `_sd` spread variables the Spread
    pane reads exactly as it reads GEFS's."""
    rid = run_id(run)
    if rid in list_runs(model.key, store_root):
        return {"model": model.key, "run": rid, "skipped": True}
    if ds is None:
        url = url or zarr_url()
        if not url:
            return {"model": model.key, "run": rid, "skipped": "no WXGRID_WN2_ZARR"}
        ds = open_dataset(url, run=run)
    ds = normalize_dataset(ds)
    di, dl = _dim(ds, DIM_INIT), _dim(ds, DIM_LEAD)
    dlev, dlat, dlon = _dim(ds, DIM_LEVEL), _dim(ds, DIM_LAT), _dim(ds, DIM_LON)
    dmem = _dim(ds, DIM_MEMBER)
    inits = np.asarray(ds[di].values).astype("datetime64[s]")
    where = np.where(inits == np.datetime64(run.replace(tzinfo=None), "s"))[0]
    if not where.size:
        raise FileNotFoundError(f"init {rid} not in {url or 'dataset'}")
    sel = ds.isel({di: int(where[0])})
    lats, lons = np.asarray(sel[dlat].values), np.asarray(sel[dlon].values)
    with run_lock(model.key, rid, store_root) as held:
        if not held:
            return {"model": model.key, "run": rid, "skipped": "locked"}
        variables = model.store_variables()
        writer = RunWriter(model.key, rid, model.steps, variables, attribution=model.attribution, root=store_root)
        written = 0
        for step in model.steps:
            li = _lead_index(sel, dl, step)
            if li is None:
                continue
            at = sel.isel({dl: li})
            def emit(canon: str, arr) -> None:
                nonlocal written
                data = np.asarray(arr.values, dtype=np.float32)
                if dmem and dmem in arr.dims:
                    mean = np.nanmean(data, axis=arr.dims.index(dmem))
                    sd = np.nanstd(data, axis=arr.dims.index(dmem), ddof=0)
                    writer.write(canon, step, _regrid_to_store(mean, lats, lons, model))
                    if f"{canon}_sd" in writer.variables:
                        writer.write(f"{canon}_sd", step, _regrid_to_store(sd, lats, lons, model))
                else:
                    writer.write(canon, step, _regrid_to_store(data, lats, lons, model))
                written += 1
            done: set[str] = set()
            for src, canon in SURFACE.items():
                if src not in at or canon not in writer.variables or canon in done:
                    continue
                arr = at[src]
                if canon == "tp6":
                    arr = arr * 1000.0                     # m → mm
                emit(canon, arr)
                done.add(canon)
            if step % LEVEL_EVERY == 0:
                for src, prefix in LEVELS_VARS.items():
                    for lvl in model.levels:
                        canon = f"{prefix}_{lvl}"
                        if canon not in writer.variables:
                            continue
                        arr = _level_field(at, src, lvl, dlev)
                        if arr is None:
                            continue
                        if prefix == "gh":
                            arr = arr / G                          # m²/s² → m
                        emit(canon, arr)
            log.info("%s %s step %03d written", model.key, rid, step)
        counts = writer.finish()
        try:
            build_point_cube(model.key, rid, store_root)
        except Exception:
            log.exception("%s %s point cube failed (run still serves)", model.key, rid)
    return {"model": model.key, "run": rid, "fields": written, "counts": counts}


def _level_field(at, src: str, lvl: int, dlev: str | None):
    """One pressure level of `src`: sliced off a `level` dimension when the
    dataset has one, else the flattened `{level}_{name}` variable the model
    page documents. None when this run carries neither."""
    if dlev and src in at:
        hits = np.where(np.asarray(at[dlev].values) == lvl)[0]
        return at[src].isel({dlev: int(hits[0])}) if hits.size else None
    flat = f"{lvl}_{src}"
    return at[flat] if flat in at else None


def resolve_latest(model: Model, url: str | None = None, ds=None) -> datetime:
    if ds is not None:
        init = latest_init(ds, model.steps)
        if init is not None:
            return init
    else:
        url = url or zarr_url()
        if not url:
            raise RuntimeError(f"{ENV_ZARR} is not set; WeatherNext is not configured on this box")
        for _, source_url in islice(discover_sources(url), MAX_LATEST_CANDIDATES):
            source = _open_store(source_url)
            try:
                init = latest_init(source, model.steps)
                if init is not None:
                    return init
            finally:
                source.close()
    raise RuntimeError("no complete WeatherNext init in the dataset")
