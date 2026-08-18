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
from wxgrid.config import CACHE_DIR, FRONT_DIR, PUBLIC
from wxgrid.models import LEVELS, MODELS
from wxgrid.store import RunReader, list_runs, parse_run_id, store_summary

log = logging.getLogger("wxgrid.api")
app = FastAPI(title="wxgrid", docs_url="/api/docs", redoc_url=None)
app.add_middleware(GZipMiddleware, minimum_size=2048)   # wind JSON shrinks ~5x

LAYERS = ("wind", "temp", "gust", "msl", "tp6", "tcc", "cape")
LEVEL_LAYERS = ("wind", "temp")
_ALIAS = {"t2m": "temp"}
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
    if key not in _readers:
        try:
            _readers[key] = RunReader(model, run)
        except FileNotFoundError:
            raise HTTPException(404, f"no run {model}/{run}")
        if len(_readers) > 12:      # runs are pruned underneath us anyway
            _readers.pop(next(iter(_readers)))
    return _readers[key]


def _vars_for(layer: str, level: int | None) -> tuple[str, ...]:
    """Store variables a layer needs at a level (None = surface)."""
    if layer == "wind":
        return ("u10", "v10") if level is None else (f"u_{level}", f"v_{level}")
    if layer == "temp":
        return ("t2m",) if level is None else (f"t_{level}",)
    return (layer,)


def _available(reader: RunReader, layer: str, level: int | None = None) -> bool:
    return all(v in reader.variables for v in _vars_for(layer, level))


def _levels_for(reader: RunReader) -> list[int]:
    return [lvl for lvl in LEVELS if f"u_{lvl}" in reader.variables and f"t_{lvl}" in reader.variables]


def _norm_layer(layer: str) -> str:
    layer = _ALIAS.get(layer, layer)
    if layer not in LAYERS:
        raise HTTPException(404, "unknown layer")
    return layer


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
    tag = f"{layer}{'' if level is None else '-' + str(level)}"
    path = CACHE_DIR / model / r.rid / f"{step:03d}-{tag}.png"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        vars_ = _vars_for(layer, level)
        if layer == "wind":
            field = render.wind_speed(r.slab(vars_[0], step), r.slab(vars_[1], step))
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


if FRONT_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(FRONT_DIR), html=True), name="front")
