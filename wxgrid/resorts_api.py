"""FastAPI router: ski-resort catalog + detail for the ski-mode overlay.

GET  /api/resorts?q=&lat=&lon=      search (q) or nearest (lat & lon)
GET  /api/resorts/{id}              lifts + boundary + elevation
POST /api/resorts/rebuild           re-run the Overpass catalog build

Routes stay thin — everything lives in wxgrid.resorts. Mounted from the end
of wxgrid/api.py, above the `/` static-file mount, so a StaticFiles mount at
"/" registered first doesn't shadow these routes.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Query

from wxgrid import resorts

log = logging.getLogger("wxgrid.resorts_api")
router = APIRouter(prefix="/api/resorts", tags=["resorts"])


@router.get("")
def list_resorts(
    q: str | None = Query(None, description="name search"),
    lat: float | None = Query(None, ge=-90, le=90),
    lon: float | None = Query(None, ge=-180, le=180),
    limit: int = Query(8, ge=1, le=50),
) -> dict:
    if lat is not None and lon is not None:
        return {"mode": "nearest", "resorts": resorts.nearest(lat, lon, limit=limit)}
    if q:
        return {"mode": "search", "resorts": resorts.search(q, limit=limit)}
    raise HTTPException(400, "pass q= (search) or lat=&lon= (nearest)")


@router.get("/all")
def all_resorts() -> dict:
    """The whole catalog, minimal fields — for the map's resort pins."""
    return {"resorts": [{"id": r["id"], "name": r["name"], "lat": r["lat"], "lon": r["lon"],
                         "country": r.get("country"), "ele_summit_m": r.get("ele_summit_m")}
                        for r in resorts.load_catalog()]}


_snow_cache: dict[tuple, dict] = {}


@router.get("/snow")
def resorts_snow(model: str = "ifs", run: str = "latest", step: int = 0, hours: int = Query(72, ge=6, le=240)) -> dict:
    """Forecast snowfall at every resort in the window (step, step + hours]:
    the OpenSnow-style map. Model snowfall water-equivalent at 1 cm/mm at the
    nearest 0.25° gridpoint. Cached per (model, run, step, hours)."""
    from wxgrid.api import _reader          # lazy: api imports this module
    import numpy as np
    r = _reader(model, run)
    if "sf6" not in r.variables:
        raise HTTPException(404, "model has no snowfall")
    if step not in r.steps:
        step = min(r.steps, key=lambda x: abs(x - step))
    key = (model, r.rid, step, hours)
    hit = _snow_cache.get(key)
    if hit is None:
        idx = [k for k, h in enumerate(r.steps) if step < h <= step + hours]
        out = {}
        for res in resorts.load_catalog():
            series = r.point("sf6", res["lat"], res["lon"])
            v = float(np.nansum(series[idx])) if idx else float("nan")
            out[res["id"]] = None if np.isnan(v) else round(v, 1)
        hit = {"model": model, "run": r.rid, "step": step, "hours": hours, "snow_cm": out}
        if len(_snow_cache) > 24:
            _snow_cache.pop(next(iter(_snow_cache)))
        _snow_cache[key] = hit
    return hit


@router.get("/{resort_id}")
def get_resort(resort_id: str) -> dict:
    try:
        return resorts.resort_detail(resort_id)
    except ValueError:
        raise HTTPException(404, f"unknown resort {resort_id}")


@router.post("/rebuild")
def rebuild() -> dict:
    built = resorts.build_catalog()
    with_ele = sum(1 for r in built if r.get("ele_base_m") is not None and r.get("ele_summit_m") is not None)
    return {"count": len(built), "with_elevation": with_ele}
