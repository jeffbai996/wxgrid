"""Routes for the external-service proxies in wxgrid.ext."""
from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor

from fastapi import APIRouter, HTTPException, Query
from starlette.responses import StreamingResponse

from wxgrid import ext, liveness

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
    from wxgrid.api import point_series, prob_point   # circular at module load, fine at call

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
        yield line("point", lambda: point_series(lat=lat, lon=lon, model=model, run=run))
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
        from concurrent.futures import TimeoutError as FutTimeout, as_completed
        # A straggler must not hold this connection: the browser gives an
        # HTTP/1.1 origin six slots, and a stream pinned open on a slow
        # geocoder queues every other request behind it (seen 2026-08-19,
        # "takes ages to load anything"). Ship what landed within the budget,
        # name the rest "pending", close; the client fetches those alone.
        try:
            for fut in as_completed(futures, timeout=6):
                yield fut.result()
        except FutTimeout:
            for fut, kind in futures.items():
                if not fut.done():
                    yield json.dumps({"kind": kind, "pending": True}) + "\n"

    return StreamingResponse(gen(), media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-store"})


@router.get("/health")
def api_health():
    """Which upstreams are answering, plus which of them are actually LIVE.

    `upstreams`/`down` are the passive, host-level view: an upstream is "down"
    when its last failure is newer than its last success and less than 30 min
    old. That view only knows about a host once ordinary traffic has hit it,
    and it counts an HTTP 200 as success even when the body is an error
    document — see wxgrid.liveness for why that is not the same question as
    "is this source live". `sources`/`sources_down` are that module's active,
    scheduled answer: a per-source record last refreshed on its own TTL,
    never inline on this request (ensure_fresh serves the stored result and,
    only if it is stale, kicks a background refresh for next time)."""
    import time as _t
    now = _t.time()
    out = {}
    for host, h in sorted(ext.upstream_health.items()):
        down = h["fail"] > h["ok"] and now - h["fail"] < 1800
        out[host] = {"down": down, "last_ok_s": round(now - h["ok"]) if h["ok"] else None,
                     "error": h["error"] if down else ""}
    live = liveness.ensure_fresh()
    from wxgrid.freshness import run_ages
    runs = run_ages()
    return {"upstreams": out, "down": sorted(k for k, v in out.items() if v["down"]),
            "sources": live["sources"], "sources_down": live["sources_down"],
            "sources_checked_at": live["checked_at"],
            "runs": runs, "stale": [r["model"] for r in runs if r["stale"]]}


@router.get("/health/sources")
def api_health_sources():
    """The active liveness registry on its own: one record per external
    source, each carrying whether it is currently live, the detail string its
    content assertion measured, and how long it has been down if it is not.
    Never probes inline — see wxgrid.liveness.ensure_fresh."""
    return liveness.ensure_fresh()


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


@router.get("/alerts/detail")
def api_alert_detail(id: str = Query(..., min_length=3, max_length=200), source: str = ""):
    """The prose behind one polygon on the alerts layer. The layer ships
    shapes and labels; the card asks for this when a reader opens one."""
    d = ext.alert_detail(id, source)
    if d is None:
        raise HTTPException(404, "no detail for this alert")
    return d


@router.get("/alerts/ec")
def api_alerts_ec(lat: float = Query(..., ge=-90, le=90), lon: float = Query(..., ge=-180, le=180)):
    """Environment Canada alerts under a point. The EC layer is a raster, so a
    tap on it has no feature to read: this asks GeoMet what it painted there."""
    return {"alerts": ext.ec_alerts_point(lat, lon)}


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
