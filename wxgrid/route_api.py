"""Routes for the route forecast (wxgrid.route).

  GET  /api/route?path=lon,lat;lon,lat&depart=…&speed_kmh=…   short paths, permalinkable
  POST /api/route                                             long paths, JSON body
  GET  /api/route/thresholds                                  the hazard defaults

Both verbs answer with the same payload. The GET form exists so a route
survives a copy-pasted URL; the POST form exists because a traced path can be
hundreds of points and query strings have limits.

Elevation (for the freezing-level-below-the-ground hazard) and warning
polygons come from wxgrid.ext, so they are cached there and shared with the
rest of the app — this module fetches, wxgrid.route stays network-free.
"""
from __future__ import annotations

import hashlib
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from wxgrid import ext, route

# wxgrid.api's `_reader` is fetched inside _run(), not imported here: api.py
# ends by importing THIS module to mount the router, so importing it back at
# module scope would mean `import wxgrid.route_api` first finds a half-built
# wxgrid.api (or vice versa). Every other router in the app sidesteps this by
# never needing anything from api; this one needs the run-reader cache.

log = logging.getLogger("wxgrid.route_api")
router = APIRouter(prefix="/api/route")

THRESHOLD_KEYS = tuple(route.THRESHOLDS)


class RouteRequest(BaseModel):
    """POST body. `path` is [[lon, lat], …] — GeoJSON order, like everything
    else the front end hands us."""
    path: list[list[float]] = Field(..., min_length=2, max_length=route.MAX_PATH_POINTS)
    depart: str | None = None
    speed_kmh: float | None = None
    legs_h: list[float] | None = None
    samples: int | None = None
    every_km: float | None = None
    model: str = "aifs"
    run: str = "latest"
    terrain: bool = True
    alerts: bool = True
    elevs: list[float] | None = None
    thresholds: dict[str, float] | None = None


def _parse_depart(raw: str | None) -> datetime:
    if not raw:
        return datetime.now(timezone.utc)
    try:
        d = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(400, "depart must be ISO 8601 (2026-08-18T14:00Z)")
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def _parse_path(raw: str) -> list[list[float]]:
    """`lon,lat;lon,lat;…` — semicolons between points, so the whole thing
    survives being pasted into a URL bar."""
    pts = []
    for chunk in raw.replace("|", ";").split(";"):
        chunk = chunk.strip()
        if not chunk:
            continue
        bits = chunk.split(",")
        if len(bits) != 2:
            raise HTTPException(400, "path points look like lon,lat")
        try:
            pts.append([float(bits[0]), float(bits[1])])
        except ValueError:
            raise HTTPException(400, "path points must be numbers")
    if len(pts) < 2:
        raise HTTPException(400, "a route needs at least two points")
    return pts[:route.MAX_PATH_POINTS]


EPOCH = datetime(2000, 1, 1, tzinfo=timezone.utc)   # plan() wants a departure; terrain does not care
TERRAIN_POINTS = 96                                 # one Open-Meteo batch (their cap is 100)


def _elevations(points: list[tuple[float, float]]) -> list:
    """Ground height at a set of points, batched through Open-Meteo and parked
    in the ext cache. Terrain does not move, so the TTL is a month."""
    key = "route:elev:" + hashlib.sha1(
        ";".join(f"{la:.3f},{lo:.3f}" for la, lo in points).encode()).hexdigest()[:16]
    def fetch():
        try:
            return ext.elevations(points)
        except Exception as exc:                      # a route without terrain is still a route
            log.info("route elevation lookup failed: %s", exc)
            return [None] * len(points)
    return ext.cache.get(key, 30 * 24 * 3600, fetch)


def _lerp_profile(xs: list[float], ys: list, at: float):
    """Linear interpolation of a (distance, height) profile, skipping gaps."""
    if not xs:
        return None
    if at <= xs[0]:
        return ys[0]
    for k in range(1, len(xs)):
        if at <= xs[k]:
            a, b = ys[k - 1], ys[k]
            if a is None or b is None:
                return b if a is None else a
            span = xs[k] - xs[k - 1]
            return a if span <= 0 else a + (b - a) * (at - xs[k - 1]) / span
    return ys[-1]


def _terrain(path: list[list[float]], samples: list) -> list:
    """The ground profile under the PATH, sampled on a fixed spacing and then
    interpolated onto wherever the timing put the samples.

    Keyed on the path alone, so changing the speed or the departure — which
    moves every sample — costs nothing: the elevation call is the slow part of
    a route request (one Open-Meteo round trip), and the terrain under a road
    does not depend on how fast you drive it.
    """
    total = samples[-1].dist_km
    if total <= 0:
        return [None] * len(samples)
    spacing = max(0.5, total / (TERRAIN_POINTS - 1))
    probe = route.plan([(p[0], p[1]) for p in path], EPOCH, speed_kmh=1.0, every_km=spacing)
    zs = _elevations([(p.lat, p.lon) for p in probe])
    xs = [p.dist_km for p in probe]
    return [_lerp_profile(xs, zs, s.dist_km) for s in samples]


def _run(req: RouteRequest) -> dict:
    from wxgrid.api import _reader          # see the note by the imports
    reader = _reader(req.model, req.run)
    depart = _parse_depart(req.depart)
    try:
        pts = route.plan([(p[0], p[1]) for p in req.path], depart,
                         speed_kmh=req.speed_kmh if req.speed_kmh is not None else (None if req.legs_h else 80.0),
                         legs_h=req.legs_h, samples=req.samples, every_km=req.every_km)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    elevs = req.elevs if req.elevs and len(req.elevs) == len(pts) else None
    if elevs is None and req.terrain:
        elevs = _terrain(req.path, pts)
    alerts = None
    if req.alerts:
        try:
            alerts = ext.alerts_layer()
        except Exception as exc:                      # one dead upstream is not a 500
            log.warning("route alerts lookup failed: %s", exc)
    bad = set(req.thresholds or {}) - set(THRESHOLD_KEYS)
    if bad:
        raise HTTPException(400, f"unknown threshold(s): {', '.join(sorted(bad))}")
    return route.forecast(reader, pts, elevs=elevs, thresholds=req.thresholds, alerts=alerts)


@router.get("")
def api_route(path: str = Query(..., min_length=5, max_length=20000),
              depart: str | None = None,
              speed_kmh: float | None = Query(None, gt=0, le=3000),
              legs_h: str | None = None,
              samples: int | None = Query(None, ge=2, le=route.MAX_SAMPLES),
              every_km: float | None = Query(None, gt=0),
              model: str = "aifs", run: str = "latest",
              terrain: bool = True, alerts: bool = True,
              gust_ms: float | None = None, precip_mm_h: float | None = None,
              snow_mm_h: float | None = None, vis_km: float | None = None,
              freezing_margin_m: float | None = None) -> dict:
    thr = {k: v for k, v in (("gust_ms", gust_ms), ("precip_mm_h", precip_mm_h), ("snow_mm_h", snow_mm_h),
                             ("vis_km", vis_km), ("freezing_margin_m", freezing_margin_m)) if v is not None}
    legs = None
    if legs_h:
        try:
            legs = [float(x) for x in legs_h.split(",") if x.strip()]
        except ValueError:
            raise HTTPException(400, "legs_h must be comma-separated hours")
    return _run(RouteRequest(path=_parse_path(path), depart=depart, speed_kmh=speed_kmh, legs_h=legs,
                             samples=samples, every_km=every_km, model=model, run=run,
                             terrain=terrain, alerts=alerts, thresholds=thr or None))


@router.post("")
def api_route_post(req: RouteRequest) -> dict:
    if any(len(p) != 2 for p in req.path):
        raise HTTPException(400, "path points look like [lon, lat]")
    return _run(req)


@router.get("/thresholds")
def api_route_thresholds() -> dict:
    """Hazard defaults, so the UI can label its sliders before a route exists."""
    return {"thresholds": route.THRESHOLDS,
            "flags": {"gust": "gusts above the threshold", "rain": "heavy rain",
                      "snow": "snow falling", "ice": "freezing rain (liquid into sub-zero air)",
                      "freezing": "freezing level at or below the ground",
                      "vis": "visibility proxy below the threshold"},
            "max_samples": route.MAX_SAMPLES, "max_path_points": route.MAX_PATH_POINTS}
