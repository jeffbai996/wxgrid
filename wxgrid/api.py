"""FastAPI: the store → the browser.

GET /api/models                       models, their runs, steps, variables
GET /api/layer/{model}/{run}/{step}/{layer}.png   Mercator RGBA (layer ∈ t2m|wind|gust|msl|tp6)
GET /api/wind/{model}/{run}/{step}.json           coarse u/v for particles
GET /api/point?lat=&lon=&model=&run=  every variable at every step, nearest gridpoint
GET /api/legend/{layer}
GET /                                 the front end (front/)

Rendered layers are cached on disk under data/cache; a run's cache dies
with the run. Routes stay thin — rendering lives in wxgrid.render.
"""
from __future__ import annotations

import logging
from datetime import timedelta
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles

from wxgrid import render
from wxgrid.config import CACHE_DIR, FRONT_DIR
from wxgrid.models import MODELS
from wxgrid.store import RunReader, list_runs, parse_run_id, store_summary

log = logging.getLogger("wxgrid.api")
app = FastAPI(title="wxgrid", docs_url="/api/docs", redoc_url=None)
app.add_middleware(GZipMiddleware, minimum_size=2048)   # wind JSON shrinks ~5x

LAYERS = ("t2m", "wind", "gust", "msl", "tp6")
_readers: dict[tuple[str, str], RunReader] = {}


def _reader(model: str, run: str) -> RunReader:
    key = (model, run)
    if key not in _readers:
        if model not in MODELS:
            raise HTTPException(404, f"unknown model {model}")
        if run == "latest":
            runs = list_runs(model)
            if not runs:
                raise HTTPException(404, f"no runs for {model}")
            return _reader(model, runs[0])
        try:
            _readers[key] = RunReader(model, run)
        except FileNotFoundError:
            raise HTTPException(404, f"no run {model}/{run}")
        # Cap the cache of open readers; runs are pruned underneath us anyway.
        if len(_readers) > 12:
            _readers.pop(next(iter(_readers)))
    return _readers[key]


def _layer_available(reader: RunReader, layer: str) -> bool:
    need = {"wind": ("u10", "v10")}.get(layer, (layer,))
    return all(v in reader.variables for v in need)


@app.get("/api/models")
def api_models() -> dict:
    out = []
    summary = store_summary()
    for key, m in MODELS.items():
        runs = summary.get(key, [])
        entry = {"key": key, "label": m.label, "attribution": m.attribution, "runs": []}
        for rid in runs:
            r = _reader(key, rid)
            entry["runs"].append({
                "run": rid, "steps": r.steps,
                "layers": [l for l in LAYERS if _layer_available(r, l)],
                "valid_from": parse_run_id(rid).isoformat(),
            })
        out.append(entry)
    return {"models": out, "layers": [render.legend(l) for l in LAYERS]}


@app.get("/api/layer/{model}/{run}/{step}/{layer}.png")
def api_layer(model: str, run: str, step: int, layer: str):
    if layer not in LAYERS:
        raise HTTPException(404, "unknown layer")
    r = _reader(model, run)
    if step not in r.steps or not _layer_available(r, layer):
        raise HTTPException(404, "step or layer not in run")
    path = CACHE_DIR / model / r.rid / f"{step:03d}-{layer}.png"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        if layer == "wind":
            field = render.wind_speed(r.slab("u10", step), r.slab("v10", step))
        else:
            field = r.slab(layer, step)
        disp = render.DISPLAY[layer](render.to_mercator(field))
        tmp = path.with_suffix(".part")
        tmp.write_bytes(render.colorize(disp, layer))
        tmp.replace(path)
    return FileResponse(path, media_type="image/png",
                        headers={"Cache-Control": "public, max-age=31536000, immutable"})


@app.get("/api/wind/{model}/{run}/{step}.json")
def api_wind(model: str, run: str, step: int):
    r = _reader(model, run)
    if step not in r.steps or not _layer_available(r, "wind"):
        raise HTTPException(404, "step not in run")
    path = CACHE_DIR / model / r.rid / f"{step:03d}-wind.json"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".part")
        tmp.write_bytes(render.wind_json(r.slab("u10", step), r.slab("v10", step)))
        tmp.replace(path)
    return FileResponse(path, media_type="application/json",
                        headers={"Cache-Control": "public, max-age=31536000, immutable"})


@app.get("/api/point")
def api_point(lat: float = Query(..., ge=-90, le=90), lon: float = Query(..., ge=-180, le=180),
              model: str = "aifs", run: str = "latest"):
    r = _reader(model, run)
    t0 = parse_run_id(r.rid)
    series: dict[str, list] = {}
    for var in r.variables:
        vals = r.point(var, lat, lon)
        series[var] = [None if np.isnan(x) else round(float(x), 2) for x in vals]
    if "u10" in series and "v10" in series:
        series["wind"] = [None if (u is None or v is None) else round(float(np.hypot(u, v)), 2)
                          for u, v in zip(series["u10"], series["v10"])]
        series["wdir"] = [None if (u is None or v is None) else round((270 - float(np.degrees(np.arctan2(v, u)))) % 360)
                          for u, v in zip(series["u10"], series["v10"])]
    return {"model": model, "run": r.rid, "lat": lat, "lon": lon, "steps": r.steps,
            "valid": [(t0 + timedelta(hours=h)).isoformat() for h in r.steps],
            "series": series, "units": {"t2m": "K", "msl": "Pa", "tp6": "mm", "wind": "m/s",
                                        "gust": "m/s", "u10": "m/s", "v10": "m/s", "wdir": "deg"}}


@app.get("/api/legend/{layer}")
def api_legend(layer: str):
    if layer not in LAYERS:
        raise HTTPException(404, "unknown layer")
    return render.legend(layer)


@app.get("/healthz")
def healthz():
    return {"ok": True, "store": store_summary()}


if FRONT_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(FRONT_DIR), html=True), name="front")
