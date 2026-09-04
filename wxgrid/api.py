"""FastAPI: the store → the browser.

GET /api/models                                   models, runs, steps, layers, levels
GET /api/layer/{model}/{run}/{step}/{layer}.png   Mercator PNG; ?level=850 for wind/temp aloft
GET /api/field/{model}/{run}/{step}/{layer}.png   the same field as 16-bit data, coloured in the browser
GET /api/wind/{model}/{run}/{step}.json           coarse u/v for particles; ?level=850
GET /api/point?lat=&lon=&model=&run=              every variable at every step + derived products
GET /api/legend/{layer}
GET /                                             the front end (front/)

Layers: wind, temp (surface = 2 m; with ?level = that isobaric level), gust,
msl, tp6, tcc, cape. Rendered layers are cached on disk under data/cache; a
run's cache dies with the run. Routes stay thin — rendering is wxgrid.render.
"""
from __future__ import annotations

import json
import logging
import time
import os
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

import numpy as np
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.encoders import jsonable_encoder
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from wxgrid import coast, render
from wxgrid.config import CACHE_DIR, FRONT_DIR, PUBLIC
from wxgrid.models import LEVEL_EVERY, LEVELS, MODELS
from wxgrid.store import RunReader, list_runs, parse_run_id, run_path, store_summary

log = logging.getLogger("wxgrid.api")
app = FastAPI(title="wxgrid", docs_url="/api/docs", redoc_url=None)
app.add_middleware(GZipMiddleware, minimum_size=2048)   # wind JSON shrinks ~5x

LAYERS = ("wind", "temp", "feels", "wbt", "dt24", "gust", "msl", "ptend", "gh", "tp6", "tp24", "tp72", "sf6", "sf24", "sf72", "sd_cm", "tcc", "cloudlow", "cloudmid", "cloudhigh", "fog", "solar", "cape", "d2m", "rh", "cbase", "uvi", "frz", "waves", "wperiod", "wavepower", "swell", "windsea", "pp1d", "prob_rain", "prob_gust", "gfactor", "vis", "sst", "ptype", "vort500")
LEVEL_LAYERS = ("wind", "temp", "gh")
_ALIAS = {"t2m": "temp", "snow": "sf6", "snowdepth": "sd_cm", "dewpt": "d2m", "swh": "waves", "mwp": "wperiod"}
# Layers computed from several store variables at request time.
_DERIVED = {"frz": tuple(f"{p}_{l}" for l in LEVELS for p in ("t", "gh")),
            "rh": ("t2m", "d2m"), "tp24": ("tp6",), "tp72": ("tp6",), "sf24": ("sf6",), "sf72": ("sf6",),
            "waves": ("swh",), "wperiod": ("mwp",), "uvi": ("tcc",),
            "feels": ("t2m", "u10", "v10", "d2m"),
            "ptype": ("tp6", "t2m"), "vort500": ("u_500", "v_500"),
            "ptend": ("msl",), "cbase": ("t2m", "d2m"), "gfactor": ("gust", "u10", "v10"),
            "wbt": ("t2m", "d2m"), "dt24": ("t2m",), "solar": ("tcc",),
            "wavepower": ("swh", "mwp"), "windsea": ("swh", "swell")}
_CLOUD_BANDS = {"cloudlow": ("lcc", (1000, 925, 850)),
                "cloudmid": ("mcc", (700, 600, 500)),
                "cloudhigh": ("hcc", (400, 300, 250, 200))}
# Accumulation windows (hours) for the derived precip/snow layers.
_ACCUM = {"tp24": ("tp6", 24), "tp72": ("tp6", 72), "sf24": ("sf6", 24), "sf72": ("sf6", 72)}
# Layers that live only on LEVEL_EVERY steps (like the pressure levels).
_SIX_HOURLY = ("frz", "waves", "wperiod", "wavepower", "swell", "windsea", "pp1d", "prob_rain", "prob_gust", "vort500", "gh")
_readers: dict[tuple[str, str], tuple[float, RunReader]] = {}
_pool = ThreadPoolExecutor(max_workers=8)
# Striped, not per-key: a lock per distinct cache path lived for the life of
# the process, and cache paths are per (model, run, step, layer, level,
# format), so the dict grew with every frame ever requested. 256 stripes keep
# the "one renderer per key" guarantee (two keys on one stripe merely queue).
_CACHE_STRIPES = 256
_cache_locks: tuple[threading.Lock, ...] = tuple(threading.Lock() for _ in range(_CACHE_STRIPES))
# How many cold renders may run at once, across all keys. The per-key lock
# stops the same image rendering twice; this stops six different images
# rendering together — each is a global-grid upscale and encode, and a burst
# of misses from one scrub used to take the box with it (2026-08-22).
RENDER_SLOTS = 2
_render_slots = threading.BoundedSemaphore(RENDER_SLOTS)


def _cache_lock(path) -> threading.Lock:
    """One renderer per immutable cache key; concurrent clients wait for it.

    Private temp names prevent collisions, but without this lock a cold image
    requested four times still did four global-grid renders and exhausted the
    worker's memory before any caller received the shared result.
    """
    import zlib
    return _cache_locks[zlib.crc32(str(path).encode()) % _CACHE_STRIPES]


def _reader(model: str, run: str) -> RunReader:
    if model not in MODELS:
        raise HTTPException(404, f"unknown model {model}")
    if run == "latest":
        runs = list_runs(model)
        if not runs:
            raise HTTPException(404, f"no runs for {model}")
        run = runs[0]
    key = (model, run)
    # A run can be rewritten under us (re-ingest); key the cache on the group
    # metadata's mtime so a rebuilt run is reopened, not served from a stale
    # handle.
    meta = run_path(model, run) / "zarr.json"
    try:
        stamp = meta.stat().st_mtime
    except FileNotFoundError:
        _readers.pop(key, None)
        raise HTTPException(404, f"no run {model}/{run}")
    hit = _readers.get(key)
    if hit is None or hit[0] != stamp:
        try:
            _readers[key] = (stamp, RunReader(model, run))
        except FileNotFoundError:
            raise HTTPException(404, f"no run {model}/{run}")
        if len(_readers) > 12:      # runs are pruned underneath us anyway
            _readers.pop(next(iter(_readers)))
    return _readers[key][1]


def _vars_for(layer: str, level: int | None) -> tuple[str, ...]:
    """Store variables a layer needs at a level (None = surface)."""
    if layer == "wind":
        return ("u10", "v10") if level is None else (f"u_{level}", f"v_{level}")
    if layer == "temp":
        return ("t2m",) if level is None else (f"t_{level}",)
    if layer == "gh":
        # Height has no surface value; with no level asked for it is the
        # 500 hPa chart, which is what "one more pressure" means to a forecaster.
        return (f"gh_{level or render.GH_DEFAULT_LEVEL}",)
    if layer in _CLOUD_BANDS:
        return (_CLOUD_BANDS[layer][0],)
    if layer in _DERIVED:
        return _DERIVED[layer]
    return (layer,)


def _freezing_level_grid(r: RunReader, step: int) -> np.ndarray:
    """Height (m) of the 0 °C isotherm on the whole grid, interpolated between
    stored levels bottom-up; NaN where the column never crosses (all frozen
    at 925 hPa, or still above 0 °C at 250 hPa)."""
    lv = sorted([l for l in _levels_for(r) if f"gh_{l}" in r.variables], reverse=True)
    out = np.full(r.grid_shape, np.nan, dtype=np.float32)
    done = np.zeros(out.shape, dtype=bool)
    prev_t = prev_gh = None
    for lvl in lv:
        t = r.slab(f"t_{lvl}", step) - 273.15
        gh = r.slab(f"gh_{lvl}", step)
        if prev_t is not None:
            cross = (prev_t >= 0) & (t < 0) & ~done
            with np.errstate(divide="ignore", invalid="ignore"):
                fl = prev_gh + (gh - prev_gh) * prev_t / (prev_t - t)
            out[cross] = fl[cross]
            done |= cross
        prev_t, prev_gh = t, gh
    return out


def _accumulate(r: RunReader, var: str, step: int, hours: int) -> np.ndarray:
    """Sum of the per-step buckets that fall in (step, step + hours]: the
    total that will fall in the next `hours` after the selected time. NaN if
    no bucket at all lands in the window (run ends before then)."""
    acc = np.zeros(r.grid_shape, dtype=np.float32)
    n = 0
    for h in r.steps:
        if step < h <= step + hours:
            acc += np.nan_to_num(r.slab(var, h))
            n += 1
    if n == 0:
        acc[:] = np.nan
    return acc


def field_for(r: RunReader, layer: str, level: int | None, step: int) -> np.ndarray:
    """The model-grid field a layer shows at a step, in STORE units. One
    place for the layer/level → array logic, shared by the PNG route and the
    static build."""
    vars_ = _vars_for(layer, level)
    if layer == "wind":
        return render.wind_speed(r.slab(vars_[0], step), r.slab(vars_[1], step))
    if layer == "frz":
        return _freezing_level_grid(r, step)
    if layer == "rh":
        return render.relative_humidity(r.slab("t2m", step), r.slab("d2m", step))
    if layer in _CLOUD_BANDS:
        direct, levels = _CLOUD_BANDS[layer]
        if direct in r.variables:
            return r.slab(direct, step)
        return np.nanmax(np.stack([r.slab(f"cc_{lvl}", step) for lvl in levels]), axis=0).astype(np.float32)
    if layer == "fog":
        rh = render.relative_humidity(r.slab("t2m", step), r.slab("d2m", step))
        low = field_for(r, "cloudlow", None, step) if _available(r, "cloudlow") else r.slab("tcc", step)
        return render.fog_potential(rh, low)
    if layer == "solar":
        return render.solar_power(r.slab("tcc", step), parse_run_id(r.rid) + timedelta(hours=step),
                                  lat0=r.lat0, lon0=r.lon0, dlat=r.dlat, dlon=r.dlon)
    if layer == "wavepower":
        return render.wave_power(r.slab("swh", step), r.slab("mwp", step))
    if layer == "windsea":
        return render.wind_sea(r.slab("swh", step), r.slab("swell", step))
    if layer in _ACCUM:
        var, hours = _ACCUM[layer]
        return _accumulate(r, var, step, hours)
    if layer == "uvi":
        return render.uv_index(r.slab("tcc", step), parse_run_id(r.rid) + timedelta(hours=step),
                               lat0=r.lat0, lon0=r.lon0, dlat=r.dlat, dlon=r.dlon)
    if layer == "feels":
        return _feels_grid(r, step)
    if layer == "ptype":
        return _ptype_grid(r, step)
    if layer == "vort500":
        return _vort500_grid(r, step)
    if layer == "gfactor":
        # gust minus mean wind: where the air is churning. Flat flow reads
        # near zero even in a gale; convective mixing and rotor read high.
        mean = render.wind_speed(r.slab("u10", step), r.slab("v10", step))
        return np.clip(r.slab("gust", step) - mean, 0, None).astype(np.float32)
    if layer == "ptend":
        # pressure change over the PREVIOUS window, normalised to a 3 h rate —
        # the falling-glass signal a barometer gives, on the whole map
        prevs = [h for h in r.steps if h < step]
        if not prevs:
            return np.full(r.grid_shape, np.nan, dtype=np.float32)
        prev = prevs[-1]
        return ((r.slab("msl", step) - r.slab("msl", prev)) * (3.0 / max(1, step - prev))).astype(np.float32)
    if layer == "wbt":
        # Stull's wet-bulb approximation from T and RH: within ~0.3 °C in the
        # range weather happens. The heat-stress number — 35 °C wet-bulb is
        # the physiological wall.
        t = r.slab("t2m", step) - 273.15
        d = r.slab("d2m", step) - 273.15
        rh = np.clip(100.0 * np.exp(17.625 * d / (243.04 + d)) / np.exp(17.625 * t / (243.04 + t)), 1, 100)
        wbt = (t * np.arctan(0.151977 * np.sqrt(rh + 8.313659)) + np.arctan(t + rh)
               - np.arctan(rh - 1.676331) + 0.00391838 * rh ** 1.5 * np.arctan(0.023101 * rh) - 4.686035)
        return (wbt + 273.15).astype(np.float32)
    if layer == "dt24":
        # warmer or colder than the same hour yesterday: the front-finder
        prev = step - 24
        if prev not in r.steps:
            return np.full(r.grid_shape, np.nan, dtype=np.float32)
        return (r.slab("t2m", step) - r.slab("t2m", prev)).astype(np.float32)
    if layer == "cbase":
        # lifted-condensation cloud base, metres AGL: ~125 m per °C of dew-point
        # spread. An estimate, honest to ±20 %, and exactly what glider pilots use.
        return (125.0 * np.clip(r.slab("t2m", step) - r.slab("d2m", step), 0, None)).astype(np.float32)
    return r.slab(vars_[0], step)


def _ptype_grid(r: RunReader, step: int) -> np.ndarray:
    """What falls, where anything falls: 1 rain · 2 mixed · 3 snow, 0 dry.
    By 2 m temperature around the freezing point — the same rule the elevation
    board uses per point, so the map and the board never disagree."""
    tp = r.slab("tp6", step)
    t = r.slab("t2m", step) - 273.15
    out = np.zeros(tp.shape, dtype=np.float32)
    wet = np.nan_to_num(tp) > 0.1
    out[wet & (t > 1.5)] = 1.0
    out[wet & (t <= 1.5) & (t > -0.5)] = 2.0
    out[wet & (t <= -0.5)] = 3.0
    return out


def _vort500_grid(r: RunReader, step: int) -> np.ndarray:
    """Relative vorticity at 500 hPa on the sphere: ∂v/∂x − ∂u/∂y, with the
    ∂x spacing shrinking by cos(lat). The poles divide by ~zero and mean
    nothing on a lat-lon grid; they go NaN rather than screaming red."""
    u = r.slab("u_500", step)
    v = r.slab("v_500", step)
    lat = np.deg2rad(r.lats.astype(np.float64))[:, None]
    a = 6.371e6
    dlon = np.deg2rad(abs(r.dlon))
    dlat = np.deg2rad(abs(r.dlat))
    with np.errstate(invalid="ignore", divide="ignore"):
        dvdx = (np.roll(v, -1, axis=1) - np.roll(v, 1, axis=1)) / (2 * dlon * a * np.cos(lat))
        dudy = np.gradient(u, axis=0) / (-dlat * a)          # latitude axis runs north → south
    z = (dvdx - dudy).astype(np.float32)
    z[np.abs(np.cos(lat))[:, 0] < 0.05] = np.nan
    return z


def _feels_grid(r: RunReader, step: int) -> np.ndarray:
    """Apparent temperature, the same blend the tape uses per point: wind
    chill below 10 °C with wind, humidex above 20 °C, the air itself between.
    Returned in kelvin so the display transform matches temp's."""
    t = r.slab("t2m", step) - 273.15
    w = render.wind_speed(r.slab("u10", step), r.slab("v10", step)) * 3.6
    out = t.copy()
    chill = (t <= 10) & (w >= 4.8)
    v = np.power(w, 0.16, where=chill, out=np.ones_like(w))
    out[chill] = (13.12 + 0.6215 * t + (0.3965 * t - 11.37) * v)[chill]
    d = r.slab("d2m", step)
    warm = (t >= 20) & np.isfinite(d)
    e = 6.11 * np.exp(5417.753 * (1 / 273.16 - 1 / np.where(warm, d, 273.16)))
    out[warm] = (t + 0.5555 * (e - 10))[warm]
    return (out + 273.15).astype(np.float32)


def _available(reader: RunReader, layer: str, level: int | None = None) -> bool:
    if layer == "frz":
        # needs at least two levels with both temperature and height
        return len([l for l in _levels_for(reader) if f"gh_{l}" in reader.variables]) >= 2
    if layer in _CLOUD_BANDS:
        direct, levels = _CLOUD_BANDS[layer]
        return direct in reader.variables or all(f"cc_{lvl}" in reader.variables for lvl in levels)
    if layer == "fog":
        return all(v in reader.variables for v in ("t2m", "d2m")) and (_available(reader, "cloudlow") or "tcc" in reader.variables)
    return all(v in reader.variables for v in _vars_for(layer, level))


def _levels_for(reader: RunReader) -> list[int]:
    return [lvl for lvl in LEVELS if f"u_{lvl}" in reader.variables and f"t_{lvl}" in reader.variables]


def _tmp_for(path):
    """A private temp name per writer. Two requests for the same uncached
    layer used to share one `.part` file: the first rename won, the second
    raised FileNotFoundError and 500ed (seen 2026-08-18 with the tape
    prefetching the next step while the map fetched the current one)."""
    return path.with_suffix(f".part-{os.getpid()}-{uuid.uuid4().hex[:8]}")


def _wrap_lon(lon: float) -> float:
    """Longitudes arrive from a map that renders world copies, so a permalink
    can legitimately carry 200 or -200. Wrap instead of rejecting."""
    return (lon + 180.0) % 360.0 - 180.0


def _norm_layer(layer: str) -> str:
    layer = _ALIAS.get(layer, layer)
    if layer not in LAYERS:
        raise HTTPException(404, "unknown layer")
    return layer


def _level_step(r: RunReader, step: int, needs_levels: bool) -> int:
    """Pressure levels live on 6 h steps; for a 3 h surface step, aloft
    products come from the nearest 6 h step that exists in the run."""
    if not needs_levels or step % LEVEL_EVERY == 0:
        return step
    cands = [x for x in r.steps if x % LEVEL_EVERY == 0]
    return min(cands, key=lambda x: abs(x - step)) if cands else step


def _norm_level(level: int | None, layer: str) -> int | None:
    if level is None or level == 0:
        return None
    if layer not in LEVEL_LAYERS or level not in LEVELS:
        raise HTTPException(404, "layer has no such level")
    return level


def _render_plan(model: str, tag: str) -> tuple[str, int]:
    """Cache tag and value-space scale for a model layer.

    The 2x pass earns its keep on the 0.25 degree global fields. Regional
    grids already arrive near display resolution; doubling them manufactures
    no forecast detail and turns a 2.5 km layer into a 50-megapixel image.
    Give native regional rasters their own cache namespace so an oversized
    frame made by an older worker can never be served after this change.
    """
    if MODELS[model].regional:
        return f"{tag}-native", 1
    return tag, 2


_models_cache: dict = {"key": None, "payload": None}


def _models_key(summary: dict) -> tuple:
    """What the catalog depends on: which runs exist and when each was last
    (re)written. Same key, same answer — the catalog used to be rebuilt from
    every run's metadata on every request, 1.5-3 s that every other request
    of a cold visit queued behind (2026-08-28)."""
    parts = []
    for key, rids in sorted(summary.items()):
        for rid in rids:
            try:
                parts.append((key, rid, run_path(key, rid).joinpath("zarr.json").stat().st_mtime_ns))
            except FileNotFoundError:
                parts.append((key, rid, 0))
    return tuple(parts)


@app.get("/api/models")
def api_models() -> dict:
    summary = store_summary()
    k = _models_key(summary)
    if _models_cache["key"] == k and _models_cache["payload"] is not None:
        return _models_cache["payload"]
    payload = _build_models(summary)
    _models_cache["key"], _models_cache["payload"] = k, payload
    return payload


def _build_models(summary: dict) -> dict:
    out = []
    for key, m in MODELS.items():
        if m.optional and not summary.get(key):
            continue
        entry = {"key": key, "label": m.label, "short": m.short, "grid": m.grid,
                 "attribution": m.attribution, "domain": list(m.domain),
                 "grid_shape": list(m.grid_shape), "regional": m.regional,
                 # the store grid the field files are on: row 0 is lat0, column 0 is lon0
                 "grid_spec": {"lat0": m.lat0, "lon0": m.lon0, "dlat": m.dlat, "dlon": m.dlon,
                               "ny": m.grid_shape[0], "nx": m.grid_shape[1]},
                 "runs": []}
        for rid in summary.get(key, []):
            r = _reader(key, rid)
            entry["runs"].append({
                "run": rid, "steps": r.steps,
                "layers": [l for l in LAYERS if _available(r, l)],
                "levels": _levels_for(r),
                "valid_from": parse_run_id(rid).isoformat(),
            })
        out.append(entry)
    return {"models": out, "layers": [render.legend(l) for l in LAYERS], "levels": list(LEVELS),
            # the front end colours fields on the GPU when this is present;
            # the version rides in every field URL so a re-encode is a new key
            "field": {"v": render.FIELD_VERSION}}


@app.get("/api/layer/{model}/{run}/{step}/{layer}.png")
def api_layer(request: Request, model: str, run: str, step: int, layer: str, level: int | None = None):
    layer = _norm_layer(layer)
    level = _norm_level(level, layer)
    r = _reader(model, run)
    if step not in r.steps or not _available(r, layer, level):
        raise HTTPException(404, "step, layer or level not in run")
    cloud_from_levels = layer in _CLOUD_BANDS and _CLOUD_BANDS[layer][0] not in r.variables
    step = _level_step(r, step, level is not None or layer in _SIX_HOURLY or cloud_from_levels)
    tag = f"{layer}{'' if level is None else '-' + str(level)}"
    # WebP where the client takes it (~22 % smaller overall, up to 40 % on the
    # alpha layers), PNG otherwise. `Vary: Accept` is load-bearing: without it
    # a shared cache hands a WebP to a client that asked for PNG.
    cache_tag, scale = _render_plan(model, tag)
    name, fmt, media = render.layer_cache_name(step, cache_tag, request.headers.get("accept"))
    path = CACHE_DIR / model / r.rid / name
    request.state.cache = "hit" if path.exists() else "miss"
    if not path.exists():
        with _cache_lock(path), _render_slots:
            if not path.exists():
                path.parent.mkdir(parents=True, exist_ok=True)
                field = field_for(r, layer, level, step)
                disp = render.upscale_values(render.DISPLAY[layer](render.to_mercator(
                    field, lat0=r.lat0, lon0=r.lon0, dlat=r.dlat, dlon=r.dlon)),
                    layer, factor=scale)
                tmp = _tmp_for(path)
                tmp.write_bytes(render.colorize(disp, layer, fmt=fmt, level=level))
                tmp.replace(path)
    return FileResponse(path, media_type=media,
                        headers={"Cache-Control": "public, max-age=31536000, immutable", "Vary": "Accept"})


@app.get("/api/field/{model}/{run}/{step}/{layer}.png")
def api_field(request: Request, model: str, run: str, step: int, layer: str, level: int | None = None):
    """The field the layer draws, as data: one Mercator image per
    (model, run, step, layer, level), 16 bits per pixel over the range the
    catalog publishes (render.encode_field). The browser colourises it on the
    GPU, mixes neighbouring steps, and reads the probe value from the same
    bytes. The grid goes out as stored, not reprojected: the shader projects
    every screen pixel back onto it and interpolates there, which is what
    the Mercator resample and the 2x value-space upscale did for the PNG."""
    layer = _norm_layer(layer)
    level = _norm_level(level, layer)
    r = _reader(model, run)
    if step not in r.steps or not _available(r, layer, level):
        raise HTTPException(404, "step, layer or level not in run")
    cloud_from_levels = layer in _CLOUD_BANDS and _CLOUD_BANDS[layer][0] not in r.variables
    step = _level_step(r, step, level is not None or layer in _SIX_HOURLY or cloud_from_levels)
    tag = f"{layer}{'' if level is None else '-' + str(level)}"
    fmt = render.field_format(request.headers.get("accept"))
    path = CACHE_DIR / model / r.rid / render.field_cache_name(step, tag, fmt)
    request.state.cache = "hit" if path.exists() else "miss"
    if not path.exists():
        with _cache_lock(path), _render_slots:
            if not path.exists():
                path.parent.mkdir(parents=True, exist_ok=True)
                tmp = _tmp_for(path)
                tmp.write_bytes(render.encode_field(
                    render.DISPLAY[layer](field_for(r, layer, level, step)), layer, level=level, fmt=fmt))
                tmp.replace(path)
    # `Vary: Accept` is load-bearing: a shared cache must not hand a WebP to a
    # client that only asked for PNG.
    return FileResponse(path, media_type=render.FIELD_FORMATS[fmt],
                        headers={"Cache-Control": "public, max-age=31536000, immutable", "Vary": "Accept"})


@app.get("/api/wind/{model}/{run}/{step}.json")
def api_wind(model: str, run: str, step: int, level: int | None = None, field: str = "wind"):
    """Coarse u/v for the particle layer. ?field=waves gives wave-propagation
    vectors instead (mean direction × height, so bigger seas move faster)."""
    r = _reader(model, run)
    if field == "waves":
        if step not in r.steps or not _available(r, "waves"):
            raise HTTPException(404, "no waves in run")
        step = _level_step(r, step, True)
        path = CACHE_DIR / model / r.rid / f"{step:03d}-wavevec-v2.json"
        if not path.exists():
            with _cache_lock(path):
                if not path.exists():
                    path.parent.mkdir(parents=True, exist_ok=True)
                    swh = r.slab("swh", step); mwd_raw = r.slab("mwd", step)
                    valid = np.isfinite(swh) & np.isfinite(mwd_raw) & (swh > 0.05)
                    mwd = np.deg2rad(mwd_raw)
                    # mwd is the direction waves come FROM (met convention): propagation is the opposite way
                    u = -np.sin(mwd) * swh * 3.0; v = -np.cos(mwd) * swh * 3.0
                    tmp = _tmp_for(path)
                    factor = max(1, int(round(1.0 / abs(r.dlon))))
                    tmp.write_bytes(render.wind_json(
                        u, v, factor=factor, mask=valid, lat0=r.lat0, lon0=r.lon0,
                        dlat=r.dlat, dlon=r.dlon, wrap=not MODELS[model].regional))
                    tmp.replace(path)
        return FileResponse(path, media_type="application/json", headers={"Cache-Control": "public, max-age=31536000, immutable"})
    level = _norm_level(level, "wind")
    if step not in r.steps or not _available(r, "wind", level):
        raise HTTPException(404, "step or level not in run")
    step = _level_step(r, step, level is not None)
    tag = "wind" if level is None else f"wind-{level}"
    path = CACHE_DIR / model / r.rid / f"{step:03d}-{tag}.json"
    if not path.exists():
        with _cache_lock(path):
            if not path.exists():
                path.parent.mkdir(parents=True, exist_ok=True)
                u, v = _vars_for("wind", level)
                tmp = _tmp_for(path)
                uu, vv = r.slab(u, step), r.slab(v, step)
                factor = max(1, int(round(1.0 / abs(r.dlon))))
                valid = np.isfinite(uu) & np.isfinite(vv) if MODELS[model].regional else None
                tmp.write_bytes(render.wind_json(
                    uu, vv, factor=factor, mask=valid, lat0=r.lat0, lon0=r.lon0,
                    dlat=r.dlat, dlon=r.dlon, wrap=not MODELS[model].regional))
                tmp.replace(path)
    return FileResponse(path, media_type="application/json",
                        headers={"Cache-Control": "public, max-age=31536000, immutable"})


def _fill_gaps(vals: list) -> list:
    """Linear fill of None runs between known values (ends stay None)."""
    out = list(vals)
    n = len(out)
    i = 0
    while i < n:
        if out[i] is None:
            j = i
            while j < n and out[j] is None:
                j += 1
            if 0 < i and j < n:
                a, b = out[i - 1], out[j]
                for k in range(i, j):
                    out[k] = round(a + (b - a) * (k - i + 1) / (j - i + 1), 2)
            i = j
        else:
            i += 1
    return out


def _clean(vals: np.ndarray, nd: int = 2) -> list:
    return [None if np.isnan(x) else round(float(x), nd) for x in vals]


def _wind_pair(u: list, v: list) -> tuple[list, list]:
    spd = [None if (a is None or b is None) else round(float(np.hypot(a, b)), 2) for a, b in zip(u, v)]
    dr = [None if (a is None or b is None) else round((270 - float(np.degrees(np.arctan2(b, a)))) % 360)
          for a, b in zip(u, v)]
    return spd, dr


def _freezing_level(series: dict, levels: list[int], n: int) -> list:
    """Height (m) where temperature crosses 0 °C, interpolated between the
    stored isobaric levels (bottom-up). None when the whole column is below
    freezing at the lowest stored level (i.e. it's lower than we can see) or
    never freezes up to the top one."""
    out = []
    lv = sorted(levels, reverse=True)          # 925 (low) → 250 (high)
    for i in range(n):
        fl = None
        prev = None
        for lvl in lv:
            t = series.get(f"t_{lvl}", [None] * n)[i]
            gh = series.get(f"gh_{lvl}", [None] * n)[i]
            if t is None or gh is None:
                continue
            if prev is not None:
                t0, gh0 = prev
                if (t0 - 273.15) >= 0 > (t - 273.15):
                    fl = gh0 + (gh - gh0) * (t0 - 273.15) / (t0 - t)
                    break
            prev = (t, gh)
        out.append(None if fl is None else round(fl))
    return out


def prob_point(lat: float, lon: float) -> dict | None:
    """The GEFS member probabilities at a point, whichever model the card is
    on — the chance of rain does not care which deterministic run you read."""
    runs = list_runs("gefs")
    for rid in runs:                       # newest first; fall back if the
        r = _reader("gefs", rid)           # newest cycle has no counts yet
        if "prob_rain" not in r.variables:
            continue
        t0 = parse_run_id(r.rid)
        series = {v: _clean(r.point(v, lat, lon)) for v in ("prob_rain", "prob_gust", "prob_frost") if v in r.variables}
        if not any(x is not None for x in series.get("prob_rain", [])):
            continue
        return {"run": r.rid, "steps": r.steps, "members": 30,
                "valid": [(t0 + timedelta(hours=h)).isoformat() for h in r.steps], "series": series}
    return None


@app.get("/api/discussion")
def api_discussion(lat: float = Query(..., ge=-90, le=90), lon: float = Query(..., ge=-540, le=540),
                   model: str = "gfs", run: str = "latest"):
    """The written forecast discussion for a point: which system is driving,
    what it does here, the vertical story, and how sure the members are."""
    lon = _wrap_lon(lon)
    def build():
        r = _reader(model, run)
        point = point_series(lat=lat, lon=lon, model=model, run=run)
        try:
            prob = prob_point(lat, lon)
        except FileNotFoundError:
            prob = None
        from wxgrid import discussion
        return discussion.compose(r, lat, lon, point, prob)
    from wxgrid.ext import cache as _ext_cache
    return _ext_cache.get(f"disc-v4:{model}:{lat:.1f}:{lon:.1f}", 900, build)


@app.get("/api/prob")
def api_prob(lat: float = Query(..., ge=-90, le=90), lon: float = Query(..., ge=-540, le=540)):
    p = prob_point(lat, _wrap_lon(lon))
    if p is None:
        raise HTTPException(404, "no probability fields in the store yet")
    return p


@app.get("/api/point")
def api_point(request: Request, lat: float = Query(..., ge=-90, le=90), lon: float = Query(..., ge=-540, le=540),
              model: str = "aifs", run: str = "latest"):
    """HTTP face of `point_series`: the same body, plus cache semantics. The
    series for a (run, cell) never changes; what changes is which run is
    "latest". A short public max-age lets an edge and a browser share the
    answer across users, and the ETag turns the re-ask into a 304."""
    r = _reader(model, run)
    etag = f'"{model}:{r.rid}:{lat:.3f}:{_wrap_lon(lon):.3f}"'
    if request.headers.get("if-none-match") == etag:
        return _Response(status_code=304, headers={"ETag": etag})
    return JSONResponse(jsonable_encoder(point_series(lat=lat, lon=lon, model=model, run=run)),
                        headers={"ETag": etag, "Cache-Control": "public, max-age=300"})


def point_series(lat: float, lon: float, model: str = "aifs", run: str = "latest") -> dict:
    """The point forecast as data. The card stream and the route both call
    this; the route is the only place that knows about HTTP (2026-08-22: a
    `request` parameter added to the route broke every internal caller —
    the card went "unavailable" while the route itself still answered)."""
    lon = _wrap_lon(lon)
    r = _reader(model, run)
    return _point_body(r, model, lat, lon)


# Which runs know where the water is. Only the ECMWF wave stream carries
# swh/mwp/mwd, and only GFS carries a sea-surface temperature, so a card on
# any other model borrows both.
WAVE_MODEL = "ifs"
SST_MODEL = "gfs"


def _sea_readers(r, model: str) -> list:
    """Runs that can see the sea, best first.

    The wave model leads even when the card's own run has a marine field:
    its mask is open water, where an SST mask counts any wet gridpoint, and
    at Biarritz that difference is the estuary five kilometres inland versus
    the Atlantic fifteen kilometres west. The waves are what the beach block
    is for, so the waves choose the spot."""
    out = []
    if model == WAVE_MODEL:
        out.append(r)
    else:
        try:
            out.append(_reader(WAVE_MODEL, "latest"))
        except Exception:                      # noqa: BLE001 - not in the store
            pass
        if coast.sea_var(r):
            out.append(r)
    if model != SST_MODEL:
        try:
            out.append(_reader(SST_MODEL, "latest"))
        except Exception:                      # noqa: BLE001
            pass
    return out


def _coast(r, model: str, lat: float, lon: float, valid: list) -> dict | None:
    """Nearest open water and the sea state there. A failure here costs the
    beach block, never the forecast the card is actually for."""
    try:
        return coast.probe(r, lat, lon, valid, _sea_readers(r, model))
    except Exception as exc:                   # noqa: BLE001
        log.warning("coast probe at %.2f,%.2f: %s", lat, lon, exc)
        return None


def _point_body(r, model: str, lat: float, lon: float) -> dict:
    if not r.contains(lat, lon):
        return {"available": False, "model": model, "run": r.rid, "lat": lat, "lon": lon,
                "reason": f"Point is outside the {MODELS[model].label} forecast domain."}
    t0 = parse_run_id(r.rid)
    n = len(r.steps)
    # One step per chunk means a point series decompresses every step of every
    # variable; blosc releases the GIL, so read the variables in parallel.
    series: dict[str, list] = dict(zip(r.variables, _pool.map(lambda v: _clean(r.point(v, lat, lon)), r.variables)))
    # Levels are stored on 6 h steps; the surface tier can be 3 h. Fill the
    # in-between steps by linear interpolation so aloft/freezing-level read
    # at every column of the tape.
    for var in list(series):
        if (var.split("_")[0] in ("u", "v", "t", "gh", "cc") and "_" in var) or var in ("swh", "mwd", "mwp"):
            series[var] = _fill_gaps(series[var])
    if "tcc" in series:
        series["uvi"] = render.uv_index_point(series["tcc"], [t0 + timedelta(hours=h) for h in r.steps], lat, lon)
    if "t2m" in series and "d2m" in series:
        series["rh"] = [None if (a is None or b is None) else round(float(render.relative_humidity(np.array([a]), np.array([b]))[0]), 1)
                        for a, b in zip(series["t2m"], series["d2m"])]
    if "u10" in series and "v10" in series:
        series["wind"], series["wdir"] = _wind_pair(series["u10"], series["v10"])
    levels = _levels_for(r)
    aloft = {}
    for lvl in levels:
        spd, dr = _wind_pair(series[f"u_{lvl}"], series[f"v_{lvl}"])
        aloft[str(lvl)] = {"wind": spd, "wdir": dr, "temp": series[f"t_{lvl}"], "gh": series.get(f"gh_{lvl}")}
    derived = {"freezing_level_m": _freezing_level(series, levels, n) if levels else None}
    valid = [t0 + timedelta(hours=h) for h in r.steps]
    # Where the sea is, and what it is doing there. The card's beach and surf
    # blocks used to need the wave field to land on the pin's own gridpoint,
    # which on a 0.25° grid means the pin has to be up to 28 km offshore.
    sea = _coast(r, model, lat, lon, valid)
    if sea:
        derived["coast"] = sea
    return {"available": True, "model": model, "run": r.rid, "lat": lat, "lon": lon,
            "steps": r.steps,
            "valid": [v.isoformat() for v in valid],
            "series": series, "aloft": aloft, "derived": derived, "levels": levels,
            "units": {"t2m": "K", "msl": "Pa", "tp6": "mm", "wind": "m/s", "gust": "m/s",
                      "u10": "m/s", "v10": "m/s", "wdir": "deg", "tcc": "fraction", "cape": "J/kg",
                      "aloft.temp": "K", "aloft.gh": "m", "freezing_level_m": "m"}}


@app.get("/api/thunder/{model}/{run}/{step}.json")
def api_thunder(model: str, run: str, step: int):
    """Points where the model has convective energy AND precipitation at the
    step: CAPE ≥ 800 J/kg and ≥ 0.5 mm in the bucket, sampled every 1°.
    A cheap thunderstorm mask: the forecast analogue of a lightning-strike
    map, which shows observations."""
    r = _reader(model, run)
    if step not in r.steps or "cape" not in r.variables or "tp6" not in r.variables:
        raise HTTPException(404, "model has no CAPE")
    path = CACHE_DIR / model / r.rid / f"{step:03d}-thunder.json"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        stride = max(1, int(round(1.0 / abs(r.dlat))))
        cape = r.slab("cape", step)[::stride, ::stride]
        tp = r.slab("tp6", step)[::stride, ::stride]
        mask = (cape >= 800) & (tp >= 0.5)
        ys, xs = np.nonzero(mask)
        feats = [{"type": "Feature", "geometry": {"type": "Point", "coordinates": [
                  round(r.lon0 + x * stride * r.dlon, 3), round(r.lat0 + y * stride * r.dlat, 3)]},
                  "properties": {"cape": int(cape[y, x]), "mm": round(float(tp[y, x]), 1)}} for y, x in zip(ys.tolist(), xs.tolist())]
        tmp = _tmp_for(path)
        tmp.write_text(json.dumps({"type": "FeatureCollection", "features": feats}, separators=(",", ":")))
        tmp.replace(path)
    return FileResponse(path, media_type="application/json", headers={"Cache-Control": "public, max-age=31536000, immutable"})


ISOLINE_SPECS = {   # var → (interval, display transform, unit)
    "msl": (2.0, lambda x: x / 100.0, "hPa"),
    "gh_500": (30.0, lambda x: x, "m"),
    "temp": (2.0, lambda x: x - 273.15, "°C"),
    "frz": (250.0, lambda x: x, "m"),
}


def _isoline_geojson(src: np.ndarray, interval: float, disp, unit: str, *,
                     lat0: float = 90.0, lon0: float = -180.0,
                     dlat: float = -0.25, dlon: float = 0.25,
                     wrap: bool = True) -> dict:
    """Trace contours on the stored grid without inventing extra resolution.

    contourpy linearly locates crossings inside each native/common-grid cell.
    Keeping the full grid and every returned vertex removes the old 0.5° input
    decimation plus every-other-vertex decimation that made fronts look blocky.
    """
    import contourpy

    z = disp(src).astype(np.float64)
    # A 0.25° temperature field wiggles cell to cell over terrain and the
    # contours inherit every wiggle. A light nan-aware blur (~1 cell) keeps
    # the synoptic shape and loses the sawtooth; pressure needs less.
    from scipy.ndimage import gaussian_filter
    sigma = 0.7 if interval >= 2.0 and unit == "hPa" else 1.1
    good = np.isfinite(z)
    filled = np.where(good, z, 0.0)
    weight = gaussian_filter(good.astype(np.float64), sigma)
    with np.errstate(invalid="ignore", divide="ignore"):
        z = np.where(good, gaussian_filter(filled, sigma) / np.maximum(weight, 1e-9), np.nan)
    ny, nx = z.shape
    lats = lat0 + np.arange(ny) * dlat
    lons = lon0 + np.arange(nx) * dlon
    finite = np.isfinite(z)
    if not finite.any():
        raise ValueError("field is empty")
    lo = np.floor(np.nanmin(z) / interval) * interval
    hi = np.ceil(np.nanmax(z) / interval) * interval
    gen = contourpy.contour_generator(
        lons, lats, np.where(finite, z, np.nan), name="serial",
        corner_mask=True, line_type=contourpy.LineType.Separate,
    )
    feats = []
    for lv in np.arange(lo, hi + interval, interval):
        for line in gen.lines(lv):
            if len(line) < 4:
                continue
            coords = [[round(float(x), 3), round(float(y), 3)] for x, y in line]
            label = f"{lv:g}°" if unit.startswith("°") else f"{lv:g}"
            feats.append({"type": "Feature", "properties": {"value": float(lv), "label": label},
                          "geometry": {"type": "LineString", "coordinates": coords}})
    # Pressure charts mark their centres: an H or L where the smoothed field
    # is the extremum of its ~15° neighbourhood AND far enough from 1013 to
    # be a system, not a col (same thresholds as the discussion writer).
    if unit == "hPa":
        from scipy.ndimage import maximum_filter, minimum_filter
        win = max(9, int(round(15.0 / abs(dlon))) | 1)
        zc = np.where(finite, z, 1013.0)
        edge_mode = ("nearest", "wrap" if wrap else "nearest")
        for kind, mask in (
            ("L", (zc == minimum_filter(zc, size=win, mode=edge_mode)) & (zc <= 1011.0)),
            ("H", (zc == maximum_filter(zc, size=win, mode=edge_mode)) & (zc >= 1017.0)),
        ):
            ii, jj = np.nonzero(mask & finite)
            for i, j in zip(ii.tolist(), jj.tolist()):
                if abs(lats[i]) > 80.0:
                    continue                      # polar plateaus are not systems
                feats.append({"type": "Feature",
                              "properties": {"kind": kind, "label": kind, "value": round(float(z[i, j]))},
                              "geometry": {"type": "Point", "coordinates": [round(float(lons[j]), 3), round(float(lats[i]), 3)]}})
    return {"type": "FeatureCollection", "unit": unit, "interval": interval,
            "grid_degrees": round(abs(dlon), 4), "features": feats}


@app.get("/api/isolines/{model}/{run}/{step}/{var}.json")
def api_isolines(model: str, run: str, step: int, var: str, level: int | None = None):
    """Contour lines (GeoJSON) for pressure, 500 hPa height, temperature or
    freezing level — the classic isobar/isohypse overlay. Crossings are
    interpolated on every cell of the stored grid; the source resolution is
    reported in the response and is not presented as higher-resolution data."""
    if var not in ISOLINE_SPECS:
        raise HTTPException(404, "no isolines for that variable")
    r = _reader(model, run)
    if step not in r.steps:
        raise HTTPException(404, "step not in run")
    step = _level_step(r, step, level is not None or var in ("frz", "gh_500"))
    tag = f"{var}{'' if level is None else '-' + str(level)}"
    path = CACHE_DIR / model / r.rid / f"{step:03d}-iso-v3-{tag}.json"
    if not path.exists():
        interval, disp, unit = ISOLINE_SPECS[var]
        if var == "temp":
            src = r.slab("t2m" if not level else f"t_{level}", step)
        elif var == "frz":
            src = _freezing_level_grid(r, step)
        else:
            if var not in r.variables:
                raise HTTPException(404, "variable not in run")
            src = r.slab(var, step)
        try:
            payload = _isoline_geojson(src, interval, disp, unit, lat0=r.lat0, lon0=r.lon0,
                                       dlat=r.dlat, dlon=r.dlon, wrap=not MODELS[model].regional)
        except ValueError:
            raise HTTPException(404, "field is empty")
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = _tmp_for(path)
        import json as _json
        tmp.write_text(_json.dumps(payload, separators=(",", ":")))
        tmp.replace(path)
    return FileResponse(path, media_type="application/json",
                        headers={"Cache-Control": "public, max-age=31536000, immutable"})


def _snow_ratio(temp_c: float | None) -> float:
    """Snow-to-liquid ratio from the temperature the snow falls through. Cold
    powder stacks far higher than the 10:1 rule of thumb; warm snow settles
    below it. Same ladder the winter pane uses, so one number never disagrees
    with the other."""
    if temp_c is None:
        return 10.0
    if temp_c < -12:
        return 15.0
    if temp_c < -6:
        return 12.0
    if temp_c < 0:
        return 10.0
    if temp_c < 1.5:
        return 7.0
    return 5.0


def _band_precip(tp6: list | None, temps: list, ptype: list, n: int) -> tuple[list, list]:
    """Split the column's precipitation into what reaches THIS band as snow
    (cm of settled depth) and what reaches it as rain (mm). The model gives one
    liquid-equivalent total per step; which form it takes depends on the
    temperature at the height you are standing, which is the whole point of an
    elevation-band forecast."""
    snow_cm: list[float | None] = []
    rain_mm: list[float | None] = []
    for i in range(n):
        total = (tp6[i] if tp6 and i < len(tp6) else None)
        if total is None:
            snow_cm.append(None); rain_mm.append(None); continue
        kind = ptype[i]
        share = 1.0 if kind == "snow" else 0.5 if kind == "mixed" else 0.0
        we = total * share
        t_c = None if temps[i] is None else temps[i] - 273.15
        snow_cm.append(round(we * _snow_ratio(t_c) / 10.0, 2))
        rain_mm.append(round(total - we, 2))
    return snow_cm, rain_mm


def _interp_column(series: dict, levels: list[int], n: int, z_m: float) -> dict:
    """Temperature (K) and wind (u, v) at height z above sea level, by linear
    interpolation in geopotential height between stored levels; below the
    lowest stored level we blend toward the surface (t2m, u10, v10) using the
    standard lapse rate for temperature. Returns per-step lists."""
    lv = sorted(levels, reverse=True)
    t_out, u_out, v_out = [], [], []
    for i in range(n):
        col = [(series[f"gh_{l}"][i], series[f"t_{l}"][i], series[f"u_{l}"][i], series[f"v_{l}"][i]) for l in lv
               if series.get(f"gh_{l}") and series[f"gh_{l}"][i] is not None and series[f"t_{l}"][i] is not None]
        col = [c for c in col if None not in c]
        if not col:
            t_out.append(None); u_out.append(None); v_out.append(None); continue
        col.sort()
        if z_m <= col[0][0]:
            # Below the lowest level: use the surface values lapsed up to z if the
            # surface is lower — we don't know model orography, so lapse from
            # sea level with 6.5 K/km toward the first level.
            gh0, t0, u0, v0 = col[0]
            ts = series.get("t2m", [None] * n)[i]
            if ts is not None:
                # linear between (0 m, t2m-ish at sea level) and level 0
                frac = z_m / gh0 if gh0 > 0 else 1.0
                t = ts + (t0 - ts) * frac
                us_, vs_ = series.get("u10", [None] * n)[i], series.get("v10", [None] * n)[i]
                u = us_ + (u0 - us_) * frac if us_ is not None else u0
                v = vs_ + (v0 - vs_) * frac if vs_ is not None else v0
            else:
                t, u, v = t0 + 0.0065 * (gh0 - z_m), u0, v0
        elif z_m >= col[-1][0]:
            gh1, t1, u1, v1 = col[-1]
            t, u, v = t1 - 0.0065 * (z_m - gh1), u1, v1
        else:
            for (g0, t0, u0, v0), (g1, t1, u1, v1) in zip(col, col[1:]):
                if g0 <= z_m <= g1:
                    f = (z_m - g0) / (g1 - g0) if g1 > g0 else 0.0
                    t, u, v = t0 + (t1 - t0) * f, u0 + (u1 - u0) * f, v0 + (v1 - v0) * f
                    break
        t_out.append(round(t, 2)); u_out.append(round(u, 2)); v_out.append(round(v, 2))
    return {"temp": t_out, "u": u_out, "v": v_out}


@app.get("/api/profile")
def api_profile(lat: float = Query(..., ge=-90, le=90), lon: float = Query(..., ge=-540, le=540),
                elevs: str = Query("0,1000,2000,3000"), model: str = "aifs", run: str = "latest"):
    """Temperature and wind at arbitrary altitudes (m ASL) — the elevation-band
    forecast a ski resort wants (valley / mid / alpine / peak)."""
    lon = _wrap_lon(lon)
    r = _reader(model, run)
    levels = _levels_for(r)
    if not levels:
        raise HTTPException(404, "run has no pressure levels")
    try:
        zs = [float(z) for z in elevs.split(",") if z.strip()][:12]
    except ValueError:
        raise HTTPException(400, "elevs must be comma-separated metres")
    n = len(r.steps)
    need = ["t2m", "u10", "v10", "tp6", "sf6"] + [f"{p}_{l}" for l in levels for p in ("t", "u", "v", "gh")]
    series = {var: _clean(r.point(var, lat, lon)) for var in need if var in r.variables}
    for var in list(series):
        if "_" in var and var.split("_")[0] in ("u", "v", "t", "gh"):
            series[var] = _fill_gaps(series[var])
    t0 = parse_run_id(r.rid)
    bands = []
    fl = _freezing_level(series, levels, n)
    for z in zs:
        col = _interp_column(series, levels, n, z)
        spd, dr = _wind_pair(col["u"], col["v"])
        # What precipitation WOULD fall as at this altitude — a property of the
        # band's temperature, not of whether the model happens to be raining.
        # The amounts below carry the zeros; this says what form they take.
        ptype = [None if col["temp"][i] is None else
                 ("snow" if col["temp"][i] - 273.15 < 1.0 else "rain" if col["temp"][i] - 273.15 > 2.5 else "mixed")
                 for i in range(n)]
        snow_cm, rain_mm = _band_precip(series.get("tp6"), col["temp"], ptype, n)
        bands.append({"elev_m": z, "temp": col["temp"], "wind": spd, "wdir": dr, "ptype": ptype,
                      "snow_cm": snow_cm, "rain_mm": rain_mm})
    return {"model": model, "run": r.rid, "lat": lat, "lon": lon, "steps": r.steps,
            "valid": [(t0 + timedelta(hours=h)).isoformat() for h in r.steps],
            "bands": bands, "tp6": series.get("tp6"), "sf6": series.get("sf6"),
            "freezing_level_m": fl, "levels": levels}


@app.get("/api/xsection")
def api_xsection(lat1: float = Query(..., ge=-90, le=90), lon1: float = Query(..., ge=-540, le=540),
                 lat2: float = Query(..., ge=-90, le=90), lon2: float = Query(..., ge=-540, le=540),
                 step: int = 0, n: int = Query(80, ge=8, le=200), model: str = "ifs", run: str = "latest"):
    """Vertical slice along a great-circle path: temperature, wind and
    geopotential height at every stored pressure level, sampled at `n` points
    between the ends, for one forecast step. The front end draws the classic
    cross-section from this."""
    lon1, lon2 = _wrap_lon(lon1), _wrap_lon(lon2)
    r = _reader(model, run)
    if step not in r.steps:
        step = min(r.steps, key=lambda x: abs(x - step))
    levels = _levels_for(r)
    if not levels:
        raise HTTPException(404, "run has no pressure levels")
    lstep = _level_step(r, step, True)      # aloft products live on 6 h steps

    # great-circle interpolation, so a long slice does not drift off the path
    p1 = np.deg2rad([lat1, lon1]); p2 = np.deg2rad([lat2, lon2])
    d = 2 * np.arcsin(np.sqrt(np.sin((p2[0] - p1[0]) / 2) ** 2 + np.cos(p1[0]) * np.cos(p2[0]) * np.sin((p2[1] - p1[1]) / 2) ** 2))
    fs = np.linspace(0, 1, n)
    if d < 1e-9:
        lats = np.full(n, lat1); lons = np.full(n, lon1)
    else:
        a_ = np.sin((1 - fs) * d) / np.sin(d); b_ = np.sin(fs * d) / np.sin(d)
        x = a_ * np.cos(p1[0]) * np.cos(p1[1]) + b_ * np.cos(p2[0]) * np.cos(p2[1])
        y = a_ * np.cos(p1[0]) * np.sin(p1[1]) + b_ * np.cos(p2[0]) * np.sin(p2[1])
        z = a_ * np.sin(p1[0]) + b_ * np.sin(p2[0])
        lats = np.rad2deg(np.arctan2(z, np.hypot(x, y))); lons = np.rad2deg(np.arctan2(y, x))

    def rows(var: str, at: int) -> list:
        if var not in r.variables:
            return [None] * n
        sl = r.slab(var, at)
        i, j = r.indices(lats, lons)
        vals = sl[i, j]
        return [None if np.isnan(v) else round(float(v), 2) for v in vals]

    out_levels = []
    for lvl in levels:
        t = rows(f"t_{lvl}", lstep); u = rows(f"u_{lvl}", lstep); v = rows(f"v_{lvl}", lstep)
        spd, dr = _wind_pair(u, v)
        out_levels.append({"level": lvl, "temp": t, "wind": spd, "wdir": dr, "gh": rows(f"gh_{lvl}", lstep)})
    km = float(6371.0 * d)
    return {"model": model, "run": r.rid, "step": step, "level_step": lstep,
            "valid": (parse_run_id(r.rid) + timedelta(hours=step)).isoformat(),
            "n": n, "length_km": round(km, 1), "levels": levels,
            "lats": [round(float(x), 3) for x in lats], "lons": [round(float(x), 3) for x in lons],
            "dist_km": [round(km * f, 1) for f in fs.tolist()],
            "surface": {"t2m": rows("t2m", step), "msl": rows("msl", step), "tp6": rows("tp6", step),
                        "tcc": rows("tcc", step), "wind": _wind_pair(rows("u10", step), rows("v10", step))[0]},
            "profile": out_levels}


@app.get("/api/legend/{layer}")
def api_legend(layer: str):
    return render.legend(_norm_layer(layer))


_access = logging.getLogger("wxgrid.access")
# uvicorn configures only its own loggers; ours would otherwise fall to the
# silent root. One stderr handler, no propagation, and the unit runs uvicorn
# with --no-access-log so each request is logged once, with its timing.
if not _access.handlers:
    _h = logging.StreamHandler()
    _h.setFormatter(logging.Formatter("%(asctime)s %(message)s", "%H:%M:%S"))
    _access.addHandler(_h)
    _access.setLevel(logging.INFO)
    _access.propagate = False


@app.middleware("http")
async def _access_and_defaults(request: Request, call_next):
    """One line per request — method, path, status, wall time, cache outcome
    — so the next bottleneck is measured, not guessed. And a default: any
    response that did not choose its own caching revalidates (`no-cache`
    with the ETag StaticFiles/FileResponse already set). Without it the
    shell was heuristically cached off Last-Modified and a fix could take
    hours to reach a device (2026-08-22)."""
    t0 = time.perf_counter()
    response = await call_next(request)
    if "cache-control" not in response.headers:
        response.headers["Cache-Control"] = "no-cache"
    ms = (time.perf_counter() - t0) * 1000
    _access.info("%s %s %d cache=%s %.0fms", request.method, request.url.path, response.status_code,
                 getattr(request.state, "cache", "-"), ms)
    return response


@app.get("/healthz")
def healthz():
    return {"ok": True, "public": PUBLIC, "store": store_summary()}


if PUBLIC:
    from starlette.requests import Request
    from starlette.responses import PlainTextResponse

    @app.middleware("http")
    async def _no_private(request: Request, call_next):
        # front/private/ holds a proprietary font + theme overlay for the
        # operator's own instance; a public instance never serves it.
        if request.url.path.startswith("/private/"):
            return PlainTextResponse("not found", status_code=404)
        return await call_next(request)


from starlette.responses import Response as _Response  # noqa: E402


from wxgrid.bundle import Bundler as _Bundler  # noqa: E402

_bundler = _Bundler(FRONT_DIR)


@app.get("/bundle.js", include_in_schema=False)
def bundle_js(request: Request):
    """The eager front-end scripts as one body. ETag'd on content: one
    request per load, normally a 304."""
    body, etag = _bundler.get()
    if request.headers.get("if-none-match") == etag:
        return _Response(status_code=304, headers={"ETag": etag})
    return _Response(body, media_type="application/javascript",
                     headers={"ETag": etag, "Cache-Control": "no-cache"})


@app.get("/private/theme.js", include_in_schema=False)
def private_theme_js():
    """The optional private overlay script. Empty (not 404) when there is no
    overlay, so the page never logs a missing script."""
    path = FRONT_DIR / "private" / "theme.js"
    if path.is_file() and not PUBLIC:
        return FileResponse(path, media_type="application/javascript")
    return _Response("", media_type="application/javascript")


from wxgrid.resorts_api import router as _resorts_router  # noqa: E402
from wxgrid.ext_api import router as _ext_router  # noqa: E402
from wxgrid.fires_api import router as _fires_router  # noqa: E402
from wxgrid.sigmet_api import router as _sigmet_router  # noqa: E402
from wxgrid.cams_api import router as _cams_router  # noqa: E402
from wxgrid.radar_api import router as _radar_router  # noqa: E402
from wxgrid.ens_api import router as _ens_router  # noqa: E402
from wxgrid.route_api import router as _route_router  # noqa: E402
from wxgrid.sonde_api import router as _sonde_router  # noqa: E402
app.include_router(_resorts_router)
app.include_router(_ext_router)
app.include_router(_fires_router)
app.include_router(_sigmet_router)
app.include_router(_cams_router)
app.include_router(_radar_router)
app.include_router(_ens_router)
app.include_router(_route_router)
app.include_router(_sonde_router)

if FRONT_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(FRONT_DIR), html=True), name="front")
