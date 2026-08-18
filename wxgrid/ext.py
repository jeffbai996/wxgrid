"""Small server-side proxies for the free external services the front end
leans on, so the browser never needs their CORS policies or user-agent
rules, and so a hundred taps become one upstream request:

  Nominatim (OpenStreetMap)      place search / reverse geocode  (UA + 1 req/s etiquette)
  aviationweather.gov            METAR / TAF nearest station     (NOAA, public)
  Open-Meteo elevation           terrain height at a point       (free, keyless)
  Avalanche Canada + avalanche.org  danger ratings, problems, regions (public JSON)

Every call is cached in memory with a TTL. Nothing here touches the store.
"""
from __future__ import annotations

import logging
import math
import threading
import time
from typing import Any, Callable

import requests

log = logging.getLogger("wxgrid.ext")
UA = "wxgrid/0.2 (+https://github.com/jeffbai996/wxgrid)"
_session = requests.Session()
_session.headers["User-Agent"] = UA


class _Cache:
    def __init__(self) -> None:
        self._d: dict[str, tuple[float, Any]] = {}
        self._lock = threading.Lock()

    def get(self, key: str, ttl: float, fn: Callable[[], Any]) -> Any:
        now = time.time()
        with self._lock:
            hit = self._d.get(key)
            if hit and now - hit[0] < ttl:
                return hit[1]
        val = fn()
        with self._lock:
            self._d[key] = (now, val)
            if len(self._d) > 4000:            # crude bound; oldest first
                for k in sorted(self._d, key=lambda k: self._d[k][0])[:1000]:
                    self._d.pop(k, None)
        return val


cache = _Cache()
_nominatim_lock = threading.Lock()
_nominatim_last = 0.0


def _get_json(url: str, params: dict | None = None, timeout: int = 20) -> Any:
    r = _session.get(url, params=params, timeout=timeout)
    r.raise_for_status()
    return r.json()


# ── geocoding ─────────────────────────────────────────────────────────────

def _nominatim(path: str, params: dict) -> Any:
    global _nominatim_last
    with _nominatim_lock:                        # their usage policy: max 1 request/s
        wait = 1.05 - (time.time() - _nominatim_last)
        if wait > 0:
            time.sleep(wait)
        _nominatim_last = time.time()
    return _get_json(f"https://nominatim.openstreetmap.org/{path}", {**params, "format": "jsonv2"})


def geocode(q: str, limit: int = 6) -> list[dict]:
    q = q.strip()
    if not q:
        return []
    def fetch():
        hits = _nominatim("search", {"q": q, "limit": limit, "addressdetails": 1})
        return [{"name": h.get("name") or h.get("display_name", "").split(",")[0],
                 "display": h.get("display_name", ""), "lat": float(h["lat"]), "lon": float(h["lon"]),
                 "type": h.get("type"), "country": (h.get("address") or {}).get("country_code", "").upper()}
                for h in hits]
    return cache.get(f"geo:{q.lower()}:{limit}", 24 * 3600, fetch)


def reverse(lat: float, lon: float) -> dict:
    key = f"rgeo:{lat:.2f}:{lon:.2f}"
    def fetch():
        try:
            h = _nominatim("reverse", {"lat": lat, "lon": lon, "zoom": 10, "addressdetails": 1})
        except requests.RequestException:
            return {}
        a = h.get("address") or {}
        place = a.get("city") or a.get("town") or a.get("village") or a.get("hamlet") or a.get("municipality") or a.get("county") or h.get("name") or ""
        region = a.get("state") or a.get("province") or ""
        return {"name": place, "region": region, "country": a.get("country_code", "").upper(),
                "display": h.get("display_name", "")}
    return cache.get(key, 24 * 3600, fetch)


# ── elevation ─────────────────────────────────────────────────────────────

def elevation(lat: float, lon: float) -> float | None:
    key = f"elev:{lat:.3f}:{lon:.3f}"
    def fetch():
        try:
            j = _get_json("https://api.open-meteo.com/v1/elevation", {"latitude": lat, "longitude": lon}, timeout=10)
            return float(j["elevation"][0])
        except Exception:
            return None
    return cache.get(key, 30 * 24 * 3600, fetch)


def elevations(points: list[tuple[float, float]]) -> list[float | None]:
    """Batch (≤100 per call) — used for resort base/summit from lift ends."""
    out: list[float | None] = []
    for i in range(0, len(points), 100):
        chunk = points[i:i + 100]
        try:
            j = _get_json("https://api.open-meteo.com/v1/elevation",
                          {"latitude": ",".join(f"{p[0]:.4f}" for p in chunk),
                           "longitude": ",".join(f"{p[1]:.4f}" for p in chunk)}, timeout=15)
            out.extend(float(x) if x is not None else None for x in j["elevation"])
        except Exception:
            out.extend([None] * len(chunk))
    return out


# ── observations (METAR / TAF) ────────────────────────────────────────────

def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p = math.pi / 180
    a = 0.5 - math.cos((lat2 - lat1) * p) / 2 + math.cos(lat1 * p) * math.cos(lat2 * p) * (1 - math.cos((lon2 - lon1) * p)) / 2
    return 12742 * math.asin(math.sqrt(a))


def nearest_metar(lat: float, lon: float, max_km: float = 120.0) -> dict | None:
    """Closest station with a METAR in the last few hours, decoded by NOAA."""
    key = f"metar:{round(lat)}:{round(lon)}"
    def fetch():
        try:
            return _get_json("https://aviationweather.gov/api/data/metar",
                             {"bbox": f"{lat - 1.5},{lon - 2},{lat + 1.5},{lon + 2}", "format": "json", "hours": 3}, timeout=15)
        except Exception as exc:
            log.warning("metar fetch failed: %s", exc)
            return []
    obs = cache.get(key, 300, fetch) or []
    best, best_d = None, max_km
    seen = set()
    for o in obs:
        if o.get("icaoId") in seen or o.get("lat") is None:
            continue
        seen.add(o["icaoId"])
        d = _haversine_km(lat, lon, o["lat"], o["lon"])
        if d < best_d:
            best, best_d = o, d
    if not best:
        return None
    return {
        "station": best.get("icaoId"), "name": best.get("name"), "distance_km": round(best_d, 1),
        "lat": best.get("lat"), "lon": best.get("lon"), "elev_m": best.get("elev"),
        "time": best.get("reportTime"), "temp_c": best.get("temp"), "dewpoint_c": best.get("dewp"),
        "wdir": best.get("wdir"), "wspd_kt": best.get("wspd"), "wgst_kt": best.get("wgst"),
        "visib": best.get("visib"), "altim_hpa": best.get("altim"), "slp_hpa": best.get("slp"),
        "clouds": best.get("clouds") or [], "wx": best.get("wxString"), "flight_category": best.get("fltCat"),
        "raw": best.get("rawOb"),
    }


def taf(icao: str) -> dict | None:
    key = f"taf:{icao}"
    def fetch():
        try:
            j = _get_json("https://aviationweather.gov/api/data/taf", {"ids": icao, "format": "json"}, timeout=15)
        except Exception:
            return None
        if not j:
            return None
        t = j[0]
        return {"station": t.get("icaoId"), "issue": t.get("issueTime"), "valid_from": t.get("validTimeFrom"),
                "valid_to": t.get("validTimeTo"), "raw": t.get("rawTAF"),
                "periods": [{"from": f.get("timeFrom"), "to": f.get("timeTo"), "change": f.get("fcstChange"),
                             "wdir": f.get("wdir"), "wspd_kt": f.get("wspd"), "wgst_kt": f.get("wgst"),
                             "visib": f.get("visib"), "wx": f.get("wxString"), "clouds": f.get("clouds") or []}
                            for f in (t.get("fcsts") or [])]}
    return cache.get(key, 900, fetch)


# ── avalanche ─────────────────────────────────────────────────────────────

AVCAN = "https://api.avalanche.ca/forecasts/en"
AVORG = "https://api.avalanche.org/v2/public"
_DANGER = {"low": 1, "moderate": 2, "considerable": 3, "high": 4, "extreme": 5}
_DANGER_COLOR = {0: "#8a8f98", 1: "#50b848", 2: "#fff200", 3: "#f7941e", 4: "#ed1c24", 5: "#231f20"}


def _pip(lon: float, lat: float, ring: list) -> bool:
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if ((yi > lat) != (yj > lat)) and (lon < (xj - xi) * (lat - yi) / ((yj - yi) or 1e-12) + xi):
            inside = not inside
        j = i
    return inside


def _in_geom(lon: float, lat: float, geom: dict) -> bool:
    if geom["type"] == "Polygon":
        return _pip(lon, lat, geom["coordinates"][0])
    if geom["type"] == "MultiPolygon":
        return any(_pip(lon, lat, poly[0]) for poly in geom["coordinates"])
    return False


def avy_layer() -> dict:
    """One GeoJSON of forecast regions from both networks, each feature with
    {name, center, danger_level (0-5, -1 unknown), danger, color, link,
    off_season, source}. Cached 30 min."""
    def fetch():
        feats = []
        try:
            us = _get_json(f"{AVORG}/products/map-layer", timeout=30)
            for f in us.get("features", []):
                p = f.get("properties", {})
                lvl = p.get("danger_level", -1)
                feats.append({"type": "Feature", "geometry": f.get("geometry"), "properties": {
                    "source": "avalanche.org", "id": str(f.get("id")), "name": p.get("name"), "center": p.get("center"),
                    "center_id": p.get("center_id"), "danger": p.get("danger"), "danger_level": lvl if isinstance(lvl, int) else -1,
                    "color": p.get("color") or _DANGER_COLOR.get(lvl, "#8a8f98"), "link": p.get("link"),
                    "off_season": bool(p.get("off_season")), "state": p.get("state")}})
        except Exception as exc:
            log.warning("avalanche.org layer failed: %s", exc)
        try:
            areas = _get_json(f"{AVCAN}/areas", timeout=30)
            ratings: dict[str, tuple[int, str, str, str]] = {}
            try:
                prods = _get_json(f"{AVCAN}/products", timeout=30)
                for pr in prods if isinstance(prods, list) else []:
                    area_id = (pr.get("area") or {}).get("id")
                    rep = pr.get("report") or {}
                    dr = (rep.get("dangerRatings") or [{}])[0].get("ratings", {})
                    vals = [((dr.get(k) or {}).get("rating") or {}).get("value", "") for k in ("alp", "tln", "btl")]
                    lvls = [_DANGER.get(v, 0 if v in ("norating", "offseason", "spring", "early_season", "") else -1) for v in vals]
                    if area_id:
                        ratings[area_id] = (max(lvls) if lvls else -1, "/".join(v or "—" for v in vals), pr.get("url", ""), rep.get("title") or "")
            except Exception as exc:
                log.warning("avalanche.ca products failed: %s", exc)
            for f in areas.get("features", []):
                aid = str(f.get("id"))
                lvl, dtxt, url, title = ratings.get(aid, (-1, "", "", ""))
                feats.append({"type": "Feature", "geometry": f.get("geometry"), "properties": {
                    "source": "avalanche.ca", "id": aid, "name": title or (f.get("properties") or {}).get("name") or "Avalanche Canada region",
                    "center": "Avalanche Canada", "danger": dtxt, "danger_level": lvl,
                    "color": _DANGER_COLOR.get(lvl, "#8a8f98"), "link": url or "https://avalanche.ca/map",
                    "off_season": lvl == 0}})
        except Exception as exc:
            log.warning("avalanche.ca areas failed: %s", exc)
        return {"type": "FeatureCollection", "features": feats}
    return cache.get("avy:layer", 1800, fetch)


def avy_point(lat: float, lon: float) -> dict | None:
    """Forecast for the region containing a point: Avalanche Canada's point
    product first (Canada), else the avalanche.org zone whose polygon holds
    the point. Normalised to one shape."""
    key = f"avy:pt:{lat:.2f}:{lon:.2f}"
    def fetch():
        # Canada
        try:
            r = _session.get(f"{AVCAN}/products/point", params={"lat": lat, "long": lon}, timeout=20)
            if r.status_code == 200 and r.text.strip():
                p = r.json()
                rep = p.get("report") or {}
                days = []
                for d in rep.get("dangerRatings") or []:
                    rt = d.get("ratings") or {}
                    days.append({"date": (d.get("date") or {}).get("value"), "label": (d.get("date") or {}).get("display"),
                                 "alp": _rate(rt.get("alp")), "tln": _rate(rt.get("tln")), "btl": _rate(rt.get("btl"))})
                return {"source": "avalanche.ca", "region": rep.get("title") or "Avalanche Canada region",
                        "url": p.get("url"), "issued": rep.get("dateIssued"), "valid_until": rep.get("validUntil"),
                        "confidence": ((rep.get("confidence") or {}).get("rating") or {}).get("display"),
                        "highlights": _strip(rep.get("highlights") or ""),
                        "days": days,
                        "problems": [{"type": ((pb.get("type") or {}).get("display")), "likelihood": ((pb.get("likelihood") or {}).get("display")),
                                      "size": pb.get("expectedSize", {}).get("min") if isinstance(pb.get("expectedSize"), dict) else None,
                                      "elevations": [e.get("display") for e in pb.get("data", {}).get("elevations", [])] if isinstance(pb.get("data"), dict) else [],
                                      "aspects": [a.get("display") for a in pb.get("data", {}).get("aspects", [])] if isinstance(pb.get("data"), dict) else [],
                                      "comment": _strip(pb.get("comment") or "")} for pb in rep.get("problems") or []],
                        "summaries": {(s.get("type") or {}).get("value"): _strip(s.get("content") or "") for s in rep.get("summaries") or []},
                        "off_season": any(dd["alp"]["value"] in ("offseason", "spring") for dd in days) if days else False}
        except Exception as exc:
            log.info("avalanche.ca point: %s", exc)
        # USA
        try:
            layer = avy_layer()
            for f in layer["features"]:
                if f["properties"]["source"] != "avalanche.org" or not f.get("geometry"):
                    continue
                if _in_geom(lon, lat, f["geometry"]):
                    p = f["properties"]
                    detail = {}
                    try:
                        detail = _get_json(f"{AVORG}/product", {"type": "forecast", "center_id": p["center_id"], "zone_id": p["id"]}, timeout=20) or {}
                    except Exception:
                        pass
                    days = []
                    for d in detail.get("danger") or []:
                        days.append({"date": d.get("valid_day"), "label": d.get("valid_day"),
                                     "alp": {"value": _lvl_name(d.get("upper")), "level": d.get("upper")},
                                     "tln": {"value": _lvl_name(d.get("middle")), "level": d.get("middle")},
                                     "btl": {"value": _lvl_name(d.get("lower")), "level": d.get("lower")}})
                    return {"source": "avalanche.org", "region": p.get("name"), "center": p.get("center"), "url": p.get("link"),
                            "issued": detail.get("published_time"), "valid_until": detail.get("expires_time"),
                            "confidence": None, "highlights": _strip(detail.get("bottom_line") or ""),
                            "days": days,
                            "problems": [{"type": pb.get("name"), "likelihood": pb.get("likelihood"), "size": (pb.get("size") or [None])[0],
                                          "elevations": [], "aspects": [], "comment": _strip(pb.get("discussion") or "")}
                                         for pb in detail.get("forecast_avalanche_problems") or []],
                            "summaries": {"discussion": _strip(detail.get("hazard_discussion") or "")},
                            "danger_level": p.get("danger_level"), "danger": p.get("danger"),
                            "off_season": bool(p.get("off_season")) or p.get("danger_level", -1) < 0}
        except Exception as exc:
            log.info("avalanche.org point: %s", exc)
        return None
    return cache.get(key, 900, fetch)


def _rate(r: dict | None) -> dict:
    v = ((r or {}).get("rating") or {})
    val = v.get("value") or ""
    return {"value": val, "display": v.get("display") or "", "level": _DANGER.get(val, 0 if val else -1)}


def _lvl_name(n) -> str:
    return {1: "low", 2: "moderate", 3: "considerable", 4: "high", 5: "extreme"}.get(n, "norating" if n in (0, -1, None) else str(n))


def _strip(html: str) -> str:
    import re
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html or "")).strip()
