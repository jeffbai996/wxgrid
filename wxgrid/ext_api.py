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


@router.get("/alerts/layer")
def api_alerts_layer():
    return ext.nws_alerts_layer()


@router.get("/alerts/point")
def api_alerts_point(lat: float = Query(..., ge=-90, le=90), lon: float = Query(..., ge=-180, le=180)):
    return {"alerts": ext.alerts_point(lat, lon)}


@router.get("/storms")
def api_storms():
    return ext.storms()


@router.get("/air")
def api_air(lat: float = Query(..., ge=-90, le=90), lon: float = Query(..., ge=-180, le=180)):
    return ext.air(lat, lon)


@router.get("/tides")
def api_tides(lat: float = Query(..., ge=-90, le=90), lon: float = Query(..., ge=-180, le=180)):
    t = ext.tides(lat, lon)
    if t is None:
        raise HTTPException(404, "no tide station within reach")
    return t
