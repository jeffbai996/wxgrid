"""FastAPI: the store → the browser.

GET /api/models                                   models, runs, steps, layers, levels
GET /api/layer/{model}/{run}/{step}/{layer}.png   Mercator PNG; ?level=850 for wind/temp aloft
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
import os
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

import numpy as np
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from wxgrid import render
from wxgrid.config import CACHE_DIR, FRONT_DIR, GRID_LAT_N, GRID_LON_N, PUBLIC
from wxgrid.models import LEVEL_EVERY, LEVELS, MODELS
from wxgrid.store import RunReader, list_runs, parse_run_id, run_path, store_summary

log = logging.getLogger("wxgrid.api")
app = FastAPI(title="wxgrid", docs_url="/api/docs", redoc_url=None)
app.add_middleware(GZipMiddleware, minimum_size=2048)   # wind JSON shrinks ~5x

LAYERS = ("wind", "temp", "gust", "msl", "tp6", "tp24", "tp72", "sf6", "sf24", "sf72", "sd_cm", "tcc", "cape", "d2m", "rh", "uvi", "frz", "waves", "wperiod")
LEVEL_LAYERS = ("wind", "temp")
_ALIAS = {"t2m": "temp", "snow": "sf6", "snowdepth": "sd_cm", "dewpt": "d2m", "swh": "waves", "mwp": "wperiod"}
# Layers computed from several store variables at request time.
_DERIVED = {"frz": tuple(f"{p}_{l}" for l in LEVELS for p in ("t", "gh")),
            "rh": ("t2m", "d2m"), "tp24": ("tp6",), "tp72": ("tp6",), "sf24": ("sf6",), "sf72": ("sf6",),
            "waves": ("swh",), "wperiod": ("mwp",), "uvi": ("tcc",)}
# Accumulation windows (hours) for the derived precip/snow layers.
_ACCUM = {"tp24": ("tp6", 24), "tp72": ("tp6", 72), "sf24": ("sf6", 24), "sf72": ("sf6", 72)}
# Layers that live only on LEVEL_EVERY steps (like the pressure levels).
_SIX_HOURLY = ("frz", "waves", "wperiod")
_readers: dict[tuple[str, str], RunReader] = {}
_pool = ThreadPoolExecutor(max_workers=8)
_cache_locks: dict[str, threading.Lock] = {}
_cache_locks_guard = threading.Lock()


def _cache_lock(path) -> threading.Lock:
    """One renderer per immutable cache key; concurrent clients wait for it.

    Private temp names prevent collisions, but without this lock a cold image
    requested four times still did four global-grid renders and exhausted the
    worker's memory before any caller received the shared result.
    """
    key = str(path)
    with _cache_locks_guard:
        return _cache_locks.setdefault(key, threading.Lock())


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
    if layer in _DERIVED:
        return _DERIVED[layer]
    return (layer,)


def _freezing_level_grid(r: RunReader, step: int) -> np.ndarray:
    """Height (m) of the 0 °C isotherm on the whole grid, interpolated between
    stored levels bottom-up; NaN where the column never crosses (all frozen
    at 925 hPa, or still above 0 °C at 250 hPa)."""
    lv = sorted([l for l in _levels_for(r) if f"gh_{l}" in r.variables], reverse=True)
    out = np.full((GRID_LAT_N, GRID_LON_N), np.nan, dtype=np.float32)
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
    acc = np.zeros((GRID_LAT_N, GRID_LON_N), dtype=np.float32)
    n = 0
    for h in r.steps:
        if step < h <= step + hours:
            acc += np.nan_to_num(r.slab(var, h))
            n += 1
    if n == 0:
        acc[:] = np.nan
    return acc


def field_for(r: RunReader, layer: str, level: int | None, step: int) -> np.ndarray:
    """The (721, 1440) field a layer shows at a step, in STORE units. One
    place for the layer/level → array logic, shared by the PNG route and the
    static build."""
    vars_ = _vars_for(layer, level)
    if layer == "wind":
        return render.wind_speed(r.slab(vars_[0], step), r.slab(vars_[1], step))
    if layer == "frz":
        return _freezing_level_grid(r, step)
    if layer == "rh":
        return render.relative_humidity(r.slab("t2m", step), r.slab("d2m", step))
    if layer in _ACCUM:
        var, hours = _ACCUM[layer]
        return _accumulate(r, var, step, hours)
    if layer == "uvi":
        return render.uv_index(r.slab("tcc", step), parse_run_id(r.rid) + timedelta(hours=step))
    return r.slab(vars_[0], step)


def _available(reader: RunReader, layer: str, level: int | None = None) -> bool:
    if layer == "frz":
        # needs at least two levels with both temperature and height
        return len([l for l in _levels_for(reader) if f"gh_{l}" in reader.variables]) >= 2
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


@app.get("/api/models")
def api_models() -> dict:
    out = []
    summary = store_summary()
    for key, m in MODELS.items():
        entry = {"key": key, "label": m.label, "short": m.short, "grid": m.grid, "attribution": m.attribution, "runs": []}
        for rid in summary.get(key, []):
            r = _reader(key, rid)
            entry["runs"].append({
                "run": rid, "steps": r.steps,
                "layers": [l for l in LAYERS if _available(r, l)],
                "levels": _levels_for(r),
                "valid_from": parse_run_id(rid).isoformat(),
            })
        out.append(entry)
    return {"models": out, "layers": [render.legend(l) for l in LAYERS], "levels": list(LEVELS)}


@app.get("/api/layer/{model}/{run}/{step}/{layer}.png")
def api_layer(request: Request, model: str, run: str, step: int, layer: str, level: int | None = None):
    layer = _norm_layer(layer)
    level = _norm_level(level, layer)
    r = _reader(model, run)
    if step not in r.steps or not _available(r, layer, level):
        raise HTTPException(404, "step, layer or level not in run")
    step = _level_step(r, step, level is not None or layer in _SIX_HOURLY)
    tag = f"{layer}{'' if level is None else '-' + str(level)}"
    # WebP where the client takes it (~22 % smaller overall, up to 40 % on the
    # alpha layers), PNG otherwise. `Vary: Accept` is load-bearing: without it
    # a shared cache hands a WebP to a client that asked for PNG.
    name, fmt, media = render.layer_cache_name(step, tag, request.headers.get("accept"))
    path = CACHE_DIR / model / r.rid / name
    if not path.exists():
        with _cache_lock(path):
            if not path.exists():
                path.parent.mkdir(parents=True, exist_ok=True)
                field = field_for(r, layer, level, step)
                disp = render.DISPLAY[layer](render.to_mercator(field))
                tmp = _tmp_for(path)
                tmp.write_bytes(render.colorize(disp, layer, fmt=fmt))
                tmp.replace(path)
    return FileResponse(path, media_type=media,
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
                    tmp.write_bytes(render.wind_json(u, v, mask=valid))
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
                tmp.write_bytes(render.wind_json(r.slab(u, step), r.slab(v, step)))
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


@app.get("/api/point")
def api_point(lat: float = Query(..., ge=-90, le=90), lon: float = Query(..., ge=-540, le=540),
              model: str = "aifs", run: str = "latest"):
    lon = _wrap_lon(lon)
    r = _reader(model, run)
    t0 = parse_run_id(r.rid)
    n = len(r.steps)
    # One step per chunk means a point series decompresses every step of every
    # variable; blosc releases the GIL, so read the variables in parallel.
    series: dict[str, list] = dict(zip(r.variables, _pool.map(lambda v: _clean(r.point(v, lat, lon)), r.variables)))
    # Levels are stored on 6 h steps; the surface tier can be 3 h. Fill the
    # in-between steps by linear interpolation so aloft/freezing-level read
    # at every column of the tape.
    for var in list(series):
        if (var.split("_")[0] in ("u", "v", "t", "gh") and "_" in var) or var in ("swh", "mwd", "mwp"):
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
    return {"model": model, "run": r.rid, "lat": lat, "lon": lon, "steps": r.steps,
            "valid": [(t0 + timedelta(hours=h)).isoformat() for h in r.steps],
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
        cape = r.slab("cape", step)[::4, ::4]
        tp = r.slab("tp6", step)[::4, ::4]
        mask = (cape >= 800) & (tp >= 0.5)
        ys, xs = np.nonzero(mask)
        feats = [{"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(-180 + x * 1.0, 2), round(90 - y * 1.0, 2)]},
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


def _isoline_geojson(src: np.ndarray, interval: float, disp, unit: str) -> dict:
    """Trace contours on the stored grid without inventing extra resolution.

    contourpy linearly locates crossings inside each native/common-grid cell.
    Keeping the full grid and every returned vertex removes the old 0.5° input
    decimation plus every-other-vertex decimation that made fronts look blocky.
    """
    import contourpy

    z = disp(src).astype(np.float64)
    ny, nx = z.shape
    lats = np.linspace(90.0, -90.0, ny)
    lons = -180.0 + np.arange(nx) * (360.0 / nx)
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
            feats.append({"type": "Feature", "properties": {"value": float(lv), "label": f"{lv:g}"},
                          "geometry": {"type": "LineString", "coordinates": coords}})
    return {"type": "FeatureCollection", "unit": unit, "interval": interval,
            "grid_degrees": round(360.0 / nx, 3), "features": feats}


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
    path = CACHE_DIR / model / r.rid / f"{step:03d}-iso-v2-{tag}.json"
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
            payload = _isoline_geojson(src, interval, disp, unit)
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
        i = np.clip(np.rint((90.0 - lats) / 0.25).astype(int), 0, GRID_LAT_N - 1)
        j = (np.rint((lons + 180.0) / 0.25).astype(int)) % GRID_LON_N
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
from wxgrid.hires_api import router as _hires_router  # noqa: E402
app.include_router(_resorts_router)
app.include_router(_ext_router)
app.include_router(_fires_router)
app.include_router(_sigmet_router)
app.include_router(_cams_router)
app.include_router(_radar_router)
app.include_router(_ens_router)
app.include_router(_route_router)
app.include_router(_sonde_router)
app.include_router(_hires_router)

if FRONT_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(FRONT_DIR), html=True), name="front")
