"""Routes for the wildfire layer in wxgrid.fires."""
from __future__ import annotations

from fastapi import APIRouter, Query

from wxgrid import fires

router = APIRouter(prefix="/api/fires")


@router.get("/layer")
def api_fires_layer():
    return fires.fires_layer()


@router.get("/near")
def api_fires_near(lat: float = Query(..., ge=-90, le=90), lon: float = Query(..., ge=-180, le=180),
                   radius_km: float = Query(50.0, gt=0, le=500)):
    return {"fires": fires.fires_point(lat, lon, radius_km)}
