"""Routes for the external-service proxies in wxgrid.ext."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from wxgrid import ext

router = APIRouter(prefix="/api")


@router.get("/geo")
def api_geo(q: str = Query(..., min_length=1, max_length=120), limit: int = Query(6, ge=1, le=10)):
    return {"hits": ext.geocode(q, limit)}


@router.get("/geo/reverse")
def api_reverse(lat: float = Query(..., ge=-90, le=90), lon: float = Query(..., ge=-180, le=180)):
    return {"place": ext.reverse(lat, lon), "elevation_m": ext.elevation(lat, lon)}


@router.get("/obs")
def api_obs(lat: float = Query(..., ge=-90, le=90), lon: float = Query(..., ge=-180, le=180), taf: bool = True):
    m = ext.nearest_metar(lat, lon)
    return {"metar": m, "taf": ext.taf(m["station"]) if (m and taf) else None}


@router.get("/avy/layer")
def api_avy_layer():
    return ext.avy_layer()


@router.get("/avy/point")
def api_avy_point(lat: float = Query(..., ge=-90, le=90), lon: float = Query(..., ge=-180, le=180)):
    p = ext.avy_point(lat, lon)
    if p is None:
        raise HTTPException(404, "no avalanche forecast region covers this point")
    return p
