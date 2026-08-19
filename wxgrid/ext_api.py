"""Routes for the external-service proxies in wxgrid.ext."""
from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor

from fastapi import APIRouter, HTTPException, Query
from starlette.responses import StreamingResponse

from wxgrid import ext

router = APIRouter(prefix="/api")

# The card's context calls all wait on other people's servers; keep them off
# the event loop and off each other's backs.
_card_pool = ThreadPoolExecutor(max_workers=8, thread_name_prefix="card")


@router.get("/card")
def api_card(lat: float = Query(..., ge=-90, le=90), lon: float = Query(..., ge=-180, le=180),
             model: str = "aifs", run: str = "latest"):
    """Everything the location card opens with, as one NDJSON stream.

    The card used to fire six requests on open, and over HTTP/1.1 they queued
    behind the map's tiles on the browser's per-origin connection cap. One
    response, one connection slot: the forecast line lands first (it is a local
    Zarr read), the external lookups follow in completion order, and a line
    whose upstream fails is a {"error": ...} rather than a dropped connection.
    """
    from wxgrid.api import api_point, prob_point   # circular at module load, fine at call

    def _prob(la, lo):
        try:
            return prob_point(la, lo)
        except FileNotFoundError:
            return None

    def line(kind, fn):
        try:
            return json.dumps({"kind": kind, "data": fn()}, separators=(",", ":"),
                              allow_nan=False) + "\n"
        except Exception as exc:                                   # noqa: BLE001
            return json.dumps({"kind": kind, "error": str(exc)[:120]}) + "\n"

    def gen():
        yield line("point", lambda: api_point(lat=lat, lon=lon, model=model, run=run))
        jobs = {
            "local": lambda: {"place": ext.reverse(lat, lon), "elevation_m": ext.elevation(lat, lon),
                              "timezone": ext.timezone(lat, lon)},
            "obs": lambda: (lambda m: {"metar": m, "taf": ext.taf(m["station"]) if m else None})(ext.nearest_metar(lat, lon)),
            "alerts": lambda: {"alerts": ext.alerts_point(lat, lon)},
            "air": lambda: ext.air(lat, lon),
            "tides": lambda: ext.tides(lat, lon),
            "prob": lambda: _prob(lat, lon),
        }
        futures = {_card_pool.submit(line, k, fn): k for k, fn in jobs.items()}
        from concurrent.futures import as_completed
        for fut in as_completed(futures, timeout=25):
            yield fut.result()

    return StreamingResponse(gen(), media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-store"})


@router.get("/health")
def api_health():
    """Which upstreams are answering. An upstream is "down" when its last
    failure is newer than its last success and less than 30 min old."""
    import time as _t
    now = _t.time()
    out = {}
    for host, h in sorted(ext.upstream_health.items()):
        down = h["fail"] > h["ok"] and now - h["fail"] < 1800
        out[host] = {"down": down, "last_ok_s": round(now - h["ok"]) if h["ok"] else None,
                     "error": h["error"] if down else ""}
    return {"upstreams": out, "down": sorted(k for k, v in out.items() if v["down"])}


@router.get("/geo")
def api_geo(q: str = Query(..., min_length=1, max_length=120), limit: int = Query(6, ge=1, le=10)):
    return {"hits": ext.geocode(q, limit)}


@router.get("/station")
def api_station(ids: str = Query(..., min_length=3, max_length=60)):
    """Airports/stations by ICAO, IATA or WMO id."""
    return {"stations": ext.station_info(ids)}


@router.get("/geo/reverse")
def api_reverse(lat: float = Query(..., ge=-90, le=90), lon: float = Query(..., ge=-180, le=180)):
    return {"place": ext.reverse(lat, lon), "elevation_m": ext.elevation(lat, lon),
            "timezone": ext.timezone(lat, lon)}


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
    return ext.alerts_layer()


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
