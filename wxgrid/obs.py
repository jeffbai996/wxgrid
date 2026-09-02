"""Observed conditions across the map: METAR stations as a GeoJSON layer.

The point card already shows the nearest station's METAR. This is the same
feed asked for a whole view at once, so the map can carry observed wind
barbs, temperatures and flight categories the way it carries model fields —
and so the two can be compared at a glance, which is the entire point of
putting observations on a forecast map.

aviationweather.gov answers a bounding box in one request; the box is
snapped to whole degrees and capped so a zoomed-out view asks for a region,
not the planet, and so neighbouring pans share one cached answer.
"""
from __future__ import annotations

import logging
from typing import Any, Callable

log = logging.getLogger("wxgrid.obs")

METAR_URL = "https://aviationweather.gov/api/data/metar"
# A view wider than this gets nothing: thousands of pins on a continent are
# noise, and the upstream answer would be megabytes every five minutes.
MAX_SPAN_DEG = (24.0, 40.0)          # (lat, lon)
CACHE_TTL_S = 300
HOURS_BACK = 2


def snap_bbox(south: float, west: float, north: float, east: float) -> tuple[int, int, int, int] | None:
    """Whole-degree box around the view, or None when the view is too wide
    to serve. Keeps the request count low across a pan and the cache warm."""
    import math
    s, w = math.floor(max(-90.0, south)), math.floor(max(-180.0, west))
    n, e = math.ceil(min(90.0, north)), math.ceil(min(180.0, east))
    if n <= s or e <= w:
        return None
    if n - s > MAX_SPAN_DEG[0] or e - w > MAX_SPAN_DEG[1]:
        return None
    return s, w, n, e


def _num(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f else None


def metar_features(obs: list[dict]) -> dict:
    """NOAA's decoded METAR list → a GeoJSON FeatureCollection, one feature per
    station (the newest report wins), with the fields the pins and their card
    read. Wind is kept in knots as reported; the front end converts."""
    newest: dict[str, dict] = {}
    for o in obs or []:
        icao = o.get("icaoId")
        if not icao or o.get("lat") is None or o.get("lon") is None:
            continue
        prev = newest.get(icao)
        if prev is None or str(o.get("reportTime") or "") > str(prev.get("reportTime") or ""):
            newest[icao] = o
    feats = []
    for icao, o in newest.items():
        clouds = o.get("clouds") or []
        feats.append({
            "type": "Feature", "id": icao,
            "geometry": {"type": "Point", "coordinates": [float(o["lon"]), float(o["lat"])]},
            "properties": {
                "id": icao, "name": o.get("name") or icao, "time": o.get("reportTime"),
                "temp_c": _num(o.get("temp")), "dewpoint_c": _num(o.get("dewp")),
                "wdir": _num(o.get("wdir")) if o.get("wdir") != "VRB" else None,
                "wspd_kt": _num(o.get("wspd")), "wgst_kt": _num(o.get("wgst")),
                "visib": o.get("visib"), "altim_hpa": _num(o.get("altim")),
                "wx": o.get("wxString"), "fltcat": o.get("fltCat"),
                "ceiling_ft": next((_num(c.get("base")) for c in clouds if c.get("cover") in ("BKN", "OVC", "VV")), None),
                "raw": o.get("rawOb"),
            },
        })
    return {"type": "FeatureCollection", "features": feats}


def metar_layer(south: float, west: float, north: float, east: float, *,
                get_json: Callable[..., Any], cache_get: Callable[..., Any]) -> dict | None:
    """The observed layer for a view. `get_json` and `cache_get` are the
    shared ext.py helpers, passed in so this module stays testable without
    a network; None means the view is too wide to serve."""
    box = snap_bbox(south, west, north, east)
    if box is None:
        return None
    s, w, n, e = box
    key = f"metar-layer:{s}:{w}:{n}:{e}"

    def fetch():
        try:
            return get_json(METAR_URL, {"bbox": f"{s},{w},{n},{e}", "format": "json", "hours": HOURS_BACK}, timeout=20)
        except Exception as exc:                      # the map keeps its last pins; the health dot notices
            log.warning("metar layer fetch failed: %s", exc)
            return []
    obs = cache_get(key, CACHE_TTL_S, fetch) or []
    out = metar_features(obs)
    out["bbox"] = [w, s, e, n]
    return out
