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

import logging
from datetime import timedelta

import numpy as np
from fastapi import FastAPI, HTTPException, Query
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

LAYERS = ("wind", "temp", "gust", "msl", "tp6", "sf6", "sd_cm", "tcc", "cape", "d2m", "frz")
LEVEL_LAYERS = ("wind", "temp")
_ALIAS = {"t2m": "temp", "snow": "sf6", "snowdepth": "sd_cm", "dewpt": "d2m"}
# Layers computed from several store variables at request time.
_DERIVED = {"frz": tuple(f"{p}_{l}" for l in LEVELS for p in ("t", "gh"))}
_readers: dict[tuple[str, str], RunReader] = {}


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


def _available(reader: RunReader, layer: str, level: int | None = None) -> bool:
    if layer == "frz":
        # needs at least two levels with both temperature and height
        return len([l for l in _levels_for(reader) if f"gh_{l}" in reader.variables]) >= 2
    return all(v in reader.variables for v in _vars_for(layer, level))


def _levels_for(reader: RunReader) -> list[int]:
    return [lvl for lvl in LEVELS if f"u_{lvl}" in reader.variables and f"t_{lvl}" in reader.variables]


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
        entry = {"key": key, "label": m.label, "short": m.short, "attribution": m.attribution, "runs": []}
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
def api_layer(model: str, run: str, step: int, layer: str, level: int | None = None):
    layer = _norm_layer(layer)
    level = _norm_level(level, layer)
    r = _reader(model, run)
    if step not in r.steps or not _available(r, layer, level):
        raise HTTPException(404, "step, layer or level not in run")
    step = _level_step(r, step, level is not None or layer == "frz")
    tag = f"{layer}{'' if level is None else '-' + str(level)}"
    path = CACHE_DIR / model / r.rid / f"{step:03d}-{tag}.png"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        vars_ = _vars_for(layer, level)
        if layer == "wind":
            field = render.wind_speed(r.slab(vars_[0], step), r.slab(vars_[1], step))
        elif layer == "frz":
            field = _freezing_level_grid(r, step)
        else:
            field = r.slab(vars_[0], step)
        disp = render.DISPLAY[layer](render.to_mercator(field))
        tmp = path.with_suffix(".part")
        tmp.write_bytes(render.colorize(disp, layer))
        tmp.replace(path)
    return FileResponse(path, media_type="image/png",
                        headers={"Cache-Control": "public, max-age=31536000, immutable"})


@app.get("/api/wind/{model}/{run}/{step}.json")
def api_wind(model: str, run: str, step: int, level: int | None = None):
    level = _norm_level(level, "wind")
    r = _reader(model, run)
    if step not in r.steps or not _available(r, "wind", level):
        raise HTTPException(404, "step or level not in run")
    step = _level_step(r, step, level is not None)
    tag = "wind" if level is None else f"wind-{level}"
    path = CACHE_DIR / model / r.rid / f"{step:03d}-{tag}.json"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        u, v = _vars_for("wind", level)
        tmp = path.with_suffix(".part")
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
def api_point(lat: float = Query(..., ge=-90, le=90), lon: float = Query(..., ge=-180, le=180),
              model: str = "aifs", run: str = "latest"):
    r = _reader(model, run)
    t0 = parse_run_id(r.rid)
    n = len(r.steps)
    series: dict[str, list] = {var: _clean(r.point(var, lat, lon)) for var in r.variables}
    # Levels are stored on 6 h steps; the surface tier can be 3 h. Fill the
    # in-between steps by linear interpolation so aloft/freezing-level read
    # at every column of the tape.
    for var in list(series):
        if var.split("_")[0] in ("u", "v", "t", "gh") and "_" in var:
            series[var] = _fill_gaps(series[var])
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


ISOLINE_SPECS = {   # var → (interval, display transform, unit)
    "msl": (4.0, lambda x: x / 100.0, "hPa"),
    "gh_500": (60.0, lambda x: x, "m"),
    "temp": (5.0, lambda x: x - 273.15, "°C"),
    "frz": (500.0, lambda x: x, "m"),
}


@app.get("/api/isolines/{model}/{run}/{step}/{var}.json")
def api_isolines(model: str, run: str, step: int, var: str, level: int | None = None):
    """Contour lines (GeoJSON) for pressure, 500 hPa height, temperature or
    freezing level — the classic isobar/isohypse overlay. Computed on a 2×
    coarsened grid; that's ~1° lines, plenty for a screen and cheap."""
    if var not in ISOLINE_SPECS:
        raise HTTPException(404, "no isolines for that variable")
    r = _reader(model, run)
    if step not in r.steps:
        raise HTTPException(404, "step not in run")
    step = _level_step(r, step, level is not None or var in ("frz", "gh_500"))
    tag = f"{var}{'' if level is None else '-' + str(level)}"
    path = CACHE_DIR / model / r.rid / f"{step:03d}-iso-{tag}.json"
    if not path.exists():
        import contourpy
        interval, disp, unit = ISOLINE_SPECS[var]
        if var == "temp":
            src = r.slab("t2m" if not level else f"t_{level}", step)
        elif var == "frz":
            src = _freezing_level_grid(r, step)
        else:
            if var not in r.variables:
                raise HTTPException(404, "variable not in run")
            src = r.slab(var, step)
        z = disp(src[::2, ::2]).astype(np.float64)
        lats = np.linspace(90, -90, z.shape[0]); lons = np.linspace(-180, 179.5, z.shape[1])
        finite = np.isfinite(z)
        if not finite.any():
            raise HTTPException(404, "field is empty")
        lo = np.floor(np.nanmin(z) / interval) * interval; hi = np.ceil(np.nanmax(z) / interval) * interval
        levels_ = np.arange(lo, hi + interval, interval)
        gen = contourpy.contour_generator(lons, lats, np.where(finite, z, np.nan), name="serial", corner_mask=True, line_type=contourpy.LineType.Separate)
        feats = []
        for lv in levels_:
            for line in gen.lines(lv):
                if len(line) < 6:
                    continue
                coords = [[round(float(x), 2), round(float(y), 2)] for x, y in line[::2]]
                feats.append({"type": "Feature", "properties": {"value": float(lv), "label": f"{lv:g}"},
                              "geometry": {"type": "LineString", "coordinates": coords}})
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".part")
        import json as _json
        tmp.write_text(_json.dumps({"type": "FeatureCollection", "unit": unit, "interval": interval, "features": feats}, separators=(",", ":")))
        tmp.replace(path)
    return FileResponse(path, media_type="application/json",
                        headers={"Cache-Control": "public, max-age=31536000, immutable"})


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
def api_profile(lat: float = Query(..., ge=-90, le=90), lon: float = Query(..., ge=-180, le=180),
                elevs: str = Query("0,1000,2000,3000"), model: str = "aifs", run: str = "latest"):
    """Temperature and wind at arbitrary altitudes (m ASL) — the elevation-band
    forecast a ski resort wants (valley / mid / alpine / peak)."""
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
        # precip type at this altitude: snow when the band is below ~1 °C
        ptype = [None if (col["temp"][i] is None or not series.get("tp6")) else
                 ("snow" if col["temp"][i] - 273.15 < 1.0 else "rain" if col["temp"][i] - 273.15 > 2.5 else "mixed")
                 for i in range(n)]
        bands.append({"elev_m": z, "temp": col["temp"], "wind": spd, "wdir": dr, "ptype": ptype})
    return {"model": model, "run": r.rid, "lat": lat, "lon": lon, "steps": r.steps,
            "valid": [(t0 + timedelta(hours=h)).isoformat() for h in r.steps],
            "bands": bands, "tp6": series.get("tp6"), "sf6": series.get("sf6"),
            "freezing_level_m": fl, "levels": levels}


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


from wxgrid.resorts_api import router as _resorts_router  # noqa: E402
from wxgrid.ext_api import router as _ext_router  # noqa: E402
app.include_router(_resorts_router)
app.include_router(_ext_router)

if FRONT_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(FRONT_DIR), html=True), name="front")
