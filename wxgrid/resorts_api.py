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
