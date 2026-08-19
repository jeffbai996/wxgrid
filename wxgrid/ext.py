"""Small server-side proxies for the free external services the front end
leans on, so the browser never needs their CORS policies or user-agent
rules, and so a hundred taps become one upstream request:

  Nominatim (OpenStreetMap)      place search / reverse geocode  (UA + 1 req/s etiquette)
  aviationweather.gov            METAR / TAF nearest station     (NOAA, public)
  Open-Meteo elevation           terrain height at a point       (free, keyless)
  Avalanche Canada + avalanche.org  danger ratings, problems, regions (public JSON)
  MeteoAlarm                     European warnings (Atom/CAP per country, EMMA_ID regions)
  Bureau of Meteorology (AU)     Australian warnings (CAP-AU + AMOC district shapefiles)

Every call is cached in memory with a TTL. Nothing here touches the store.
"""
from __future__ import annotations

import logging
import math
import re
import threading
import time
import uuid
from typing import Any, Callable

import requests

log = logging.getLogger("wxgrid.ext")
UA = "wxgrid/0.2 (+https://github.com/jeffbai996/wxgrid)"
_session = requests.Session()
_session.headers["User-Agent"] = UA


class _Cache:
    """TTL cache; mirrored to disk so a restart doesn't re-hit every upstream
    (station lists alone are megabytes). Written at most every 30 s."""

    def __init__(self, path: "Path | None" = None) -> None:
        self._d: dict[str, tuple[float, Any]] = {}
        self._lock = threading.Lock()
        self._path = path
        self._dirty = False
        self._last_flush = 0.0
        if path and path.exists():
            try:
                import json
                raw = json.loads(path.read_text())
                self._d = {k: (v[0], v[1]) for k, v in raw.items()}
            except Exception:
                self._d = {}

    def get(self, key: str, ttl: float, fn: Callable[[], Any]) -> Any:
        now = time.time()
        with self._lock:
            hit = self._d.get(key)
            if hit and now - hit[0] < ttl:
                return hit[1]
        val = fn()
        with self._lock:
            self._d[key] = (now, val)
            self._dirty = True
            if len(self._d) > 4000:            # crude bound; oldest first
                for k in sorted(self._d, key=lambda k: self._d[k][0])[:1000]:
                    self._d.pop(k, None)
            if self._path and now - self._last_flush > 30:
                self._flush(now)
        return val

    def _flush(self, now: float) -> None:
        import json
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._path.with_suffix(f".part-{uuid.uuid4().hex[:8]}")
            tmp.write_text(json.dumps({k: [t, v] for k, (t, v) in self._d.items() if now - t < 7 * 24 * 3600}))
            tmp.replace(self._path)
            self._last_flush, self._dirty = now, False
        except Exception as exc:               # a cache that fails to persist is still a cache
            log.debug("ext cache flush failed: %s", exc)


from pathlib import Path as _Path
from wxgrid.config import CACHE_DIR as _CACHE_DIR
cache = _Cache(_Path(_CACHE_DIR) / "ext.json")
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
    return _get_json(f"https://nominatim.openstreetmap.org/{path}", {
        **params, "format": "jsonv2", "accept-language": "en",
    })


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
    return cache.get(f"geo-en:{q.lower()}:{limit}", 24 * 3600, fetch)


def _reverse_place_name(address: dict, fallback: str = "") -> str:
    """Prefer a real settlement; B.C. electoral areas fall back to their
    regional district instead of presenting an administrative letter as a
    place name."""
    settlement = (address.get("city") or address.get("town") or address.get("village")
                  or address.get("hamlet"))
    municipality = address.get("municipality") or ""
    county = address.get("county") or ""
    administrative_name = settlement or municipality
    if address.get("state") == "British Columbia" and (
            re.match(r"^(?:Electoral )?Area\s+[A-Z0-9]\b", administrative_name, re.I)
            or "electoral area" in administrative_name.lower()):
        district = county if "regional district" in county.lower() else ""
        if district.lower().startswith("regional district of "):
            district = district[len("Regional District of "):] + " Regional District"
        return district or fallback
    return settlement or municipality or county or fallback


# Named water bodies, from OSM `place=ocean|sea` nodes: about a thousand points
# for the whole planet, fetched once and kept for a month. A pin dropped at sea
# has no address, but it is still somewhere — "North Pacific Ocean" beats a pair
# of coordinates.
_WATER_QL = '[out:json][timeout:90];node["place"~"^(ocean|sea)$"]["name"];out qt;'


def water_nodes() -> list[dict]:
    def fetch():
        try:
            r = requests.post("https://overpass-api.de/api/interpreter", data={"data": _WATER_QL},
                              headers={"User-Agent": UA}, timeout=120)
            r.raise_for_status()
            els = r.json().get("elements", [])
        except Exception as exc:                       # noqa: BLE001
            log.debug("overpass water nodes failed: %s", exc)
            return []
        out = []
        for e in els:
            tags = e.get("tags") or {}
            name = tags.get("name:en") or tags.get("name")
            if not name or e.get("lat") is None or e.get("lon") is None:
                continue
            out.append({"name": name, "lat": float(e["lat"]), "lon": float(e["lon"]), "kind": tags.get("place")})
        return out
    return cache.get("water-nodes-v1", 30 * 24 * 3600, fetch)


def nearest_water(lat: float, lon: float, nodes: list[dict], sea_km: float = 1500.0) -> str:
    """The name of the water at a point: the nearest named sea if one is close,
    otherwise the nearest ocean. Seas are small and specific and their labelling
    node can sit well off centre, so they only win inside `sea_km`; the oceans
    are the fallback that always answers."""
    best_sea = best_ocean = None
    for n in nodes:
        d = _haversine_km(lat, lon, n["lat"], n["lon"])
        if n.get("kind") == "sea":
            if d <= sea_km and (best_sea is None or d < best_sea[0]):
                best_sea = (d, n)
        elif best_ocean is None or d < best_ocean[0]:
            best_ocean = (d, n)
    pick = best_sea or best_ocean
    return pick[1]["name"] if pick else ""


def reverse(lat: float, lon: float) -> dict:
    key = f"rgeo-en-v3:{lat:.2f}:{lon:.2f}"
    def fetch():
        try:
            h = _nominatim("reverse", {"lat": lat, "lon": lon, "zoom": 10, "addressdetails": 1})
        except requests.RequestException:
            h = {}
        a = h.get("address") or {}
        place = _reverse_place_name(a, h.get("name") or "")
        region = a.get("state") or a.get("province") or ""
        country = a.get("country_code", "").upper()
        if not place and not country:
            # No address at all means open water.
            return {"name": nearest_water(lat, lon, water_nodes()), "region": "", "country": "",
                    "display": "", "water": True}
        return {"name": place, "region": region, "country": country,
                "display": h.get("display_name", "")}
    return cache.get(key, 24 * 3600, fetch)


def station_info(ids: str) -> list[dict]:
    """Airport/station metadata by ICAO, IATA or WMO id (aviationweather.gov).
    Used by search so `CYVR` finds the field rather than a street in Vancouver."""
    ids = ",".join(i.strip().upper() for i in ids.split(",") if i.strip())[:60]
    if not ids:
        return []
    def fetch():
        try:
            j = _get_json("https://aviationweather.gov/api/data/stationinfo", {"ids": ids, "format": "json"}, timeout=15)
        except Exception as exc:                              # noqa: BLE001
            log.debug("stationinfo failed: %s", exc)
            return []
        out = []
        for st in j if isinstance(j, list) else []:
            if st.get("lat") is None:
                continue
            out.append({"icao": st.get("icaoId"), "iata": st.get("iataId"), "name": st.get("site"),
                        "lat": float(st["lat"]), "lon": float(st["lon"]),
                        "elev_m": st.get("elev"), "country": st.get("country"), "region": st.get("state")})
        return out
    return cache.get(f"station:{ids}", 30 * 24 * 3600, fetch)


def timezone(lat: float, lon: float) -> dict:
    """The IANA zone and current UTC offset at a point, so the app can show a
    forecast in the *place's* clock rather than the reader's. Open-Meteo's
    forecast endpoint resolves the zone with `timezone=auto`; the longitude
    hour is the fallback when it is unreachable."""
    key = f"tz:{lat:.1f}:{lon:.1f}"
    def fetch():
        try:
            j = _get_json("https://api.open-meteo.com/v1/forecast",
                          {"latitude": round(lat, 3), "longitude": round(lon, 3),
                           "timezone": "auto", "forecast_days": 1, "daily": "sunrise"})
            return {"tz": j.get("timezone"), "abbr": j.get("timezone_abbreviation"),
                    "offset_s": j.get("utc_offset_seconds"), "source": "open-meteo"}
        except Exception as exc:                       # noqa: BLE001 - any failure falls back
            log.debug("timezone lookup failed: %s", exc)
            return {"tz": None, "abbr": None, "offset_s": int(round(lon / 15.0)) * 3600, "source": "longitude"}
    return cache.get(key, 30 * 24 * 3600, fetch)


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


# ── alerts (NWS) ─────────────────────────────────────────────────────────

NWS = "https://api.weather.gov"
_SEV = {"Extreme": 4, "Severe": 3, "Moderate": 2, "Minor": 1, "Unknown": 0}
_SEV_COLOR = {4: "#b30000", 3: "#e8590c", 2: "#f0a020", 1: "#f5d33c", 0: "#8a8f98"}


def _simplify_ring(ring: list, step: int) -> list:
    return ring if len(ring) <= 30 else ring[::step] + [ring[0]]


def nws_alerts_layer() -> dict:
    """Active NWS alerts that carry their own polygon (storm-based warnings,
    most marine and winter products). Zone-only alerts have no geometry in
    this feed and are skipped for the map — the point endpoint still finds
    them. Cached 5 min; ~1-3 MB upstream, ~200 KB out."""
    def fetch():
        feats = []
        try:
            j = _get_json(f"{NWS}/alerts/active", {"status": "actual", "message_type": "alert"}, timeout=40)
        except Exception as exc:
            log.warning("nws alerts failed: %s", exc)
            return {"type": "FeatureCollection", "features": []}
        for f in j.get("features", []):
            g = f.get("geometry")
            p = f.get("properties", {})
            if not g:
                continue
            if g["type"] == "Polygon":
                g = {"type": "Polygon", "coordinates": [[[round(x, 3), round(y, 3)] for x, y in _simplify_ring(r, 3)] for r in g["coordinates"]]}
            sev = _SEV.get(p.get("severity"), 0)
            feats.append({"type": "Feature", "geometry": g, "properties": {
                "id": p.get("id"), "event": p.get("event"), "severity": p.get("severity"), "sev": sev,
                "color": _SEV_COLOR[sev], "headline": p.get("headline"), "area": p.get("areaDesc"),
                "onset": p.get("onset"), "ends": p.get("ends") or p.get("expires"), "sender": p.get("senderName"),
                "source": "NWS"}})
        return {"type": "FeatureCollection", "features": feats}
    return cache.get("alerts:layer", 300, fetch)


def _nws_point(lat: float, lon: float) -> list[dict]:
    """NWS alerts at a point, zone- and polygon-based. Outside the US the API
    404s and we return []."""
    try:
        r = _session.get(f"{NWS}/alerts/active", params={"point": f"{lat:.4f},{lon:.4f}"}, timeout=20)
        if r.status_code != 200:
            return []
        out = []
        for f in r.json().get("features", []):
            p = f.get("properties", {})
            sev = _SEV.get(p.get("severity"), 0)
            out.append({"id": p.get("id"), "event": p.get("event"), "severity": p.get("severity"), "sev": sev, "color": _SEV_COLOR[sev],
                        "headline": p.get("headline"), "area": p.get("areaDesc"), "onset": p.get("onset"), "ends": p.get("ends") or p.get("expires"),
                        "description": (p.get("description") or "")[:900], "instruction": (p.get("instruction") or "")[:400],
                        "sender": p.get("senderName"), "url": f.get("id"), "source": "NWS"})
        return out
    except Exception as exc:
        log.info("nws point alerts: %s", exc)
        return []


# ── region-code → geometry indexes ───────────────────────────────────────

_idx: dict[str, dict] = {}
_idx_lock = threading.Lock()
_idx_building: set[str] = set()
_idx_retry: dict[str, float] = {}


def _tag(el) -> str:
    """Local name of an XML element, namespace or not — these feeds mix a
    default Atom namespace with CAP children, and ElementTree makes the
    prefixed form of every lookup unreadable."""
    return el.tag.split("}")[-1]


def _kid(parent, name):
    return next((c for c in parent if _tag(c) == name), None)


def _kids(parent, name) -> list:
    return [c for c in parent if _tag(c) == name]


def _txt(parent, name, default: str = "") -> str:
    c = _kid(parent, name)
    return (c.text or "").strip() if c is not None and c.text else default


def _iso(s: str):
    """CAP timestamps → aware datetime, or None when absent/mangled."""
    from datetime import datetime
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def _thin(ring: list, maxpts: int = 48) -> list:
    """Drop points evenly to at most `maxpts` and round to ~100 m. Source
    boundaries carry 1000+ vertices each; at map zooms this is invisible and
    it is the difference between a 40 MB index and a 1.3 MB one."""
    ring = _simplify_ring([[round(float(x), 3), round(float(y), 3)] for x, y in ring], len(ring) // maxpts + 1)
    if len(ring) >= 3 and ring[0] != ring[-1]:
        ring.append(ring[0])
    return ring


def _rings_geom(rings: list) -> dict | None:
    """Outer rings → Polygon/MultiPolygon, biggest six kept, holes dropped
    (a hole in a warning area is not worth the payload)."""
    keep = [[_thin(r)] for r in sorted(rings, key=len, reverse=True)[:6] if len(r) >= 4]
    keep = [p for p in keep if len(p[0]) >= 4]
    if not keep:
        return None
    return {"type": "Polygon", "coordinates": keep[0]} if len(keep) == 1 else {"type": "MultiPolygon", "coordinates": keep}


def _outer_rings(geom: dict) -> list:
    if not geom:
        return []
    if geom.get("type") == "Polygon":
        return [geom["coordinates"][0]] if geom.get("coordinates") else []
    if geom.get("type") == "MultiPolygon":
        return [p[0] for p in geom.get("coordinates") or [] if p]
    return []


def _region_index(name: str, ttl: float, build: Callable[[], dict]) -> dict:
    """A code → geometry lookup that is far too big for the TTL cache's single
    JSON file (MeteoAlarm's geocodes are a 39 MB download, BoM's districts are
    shapefiles). Each gets its own file beside the ext cache and is rebuilt in
    a background thread, so the request that finds it stale is answered without
    geometry instead of being held for a minute. Returns {} until it's ready."""
    import json
    path = _Path(_CACHE_DIR) / f"{name}.json"
    with _idx_lock:
        hit = _idx.get(name)
        if hit is not None:
            return hit
        try:
            if path.exists() and time.time() - path.stat().st_mtime < ttl:
                _idx[name] = json.loads(path.read_text())
                return _idx[name]
        except Exception as exc:
            log.warning("region index %s unreadable: %s", name, exc)
        if name in _idx_building or time.time() < _idx_retry.get(name, 0.0):
            return {}
        _idx_building.add(name)

    def work() -> None:
        try:
            built = build()
            if not built:
                raise ValueError("empty index")
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(f".part-{uuid.uuid4().hex[:8]}")
            tmp.write_text(json.dumps(built, separators=(",", ":")))
            tmp.replace(path)
            with _idx_lock:
                _idx[name] = built
            log.info("region index %s built: %d regions", name, len(built))
        except Exception as exc:
            log.warning("region index %s build failed: %s", name, exc)
            with _idx_lock:
                _idx_retry[name] = time.time() + 1800
        finally:
            with _idx_lock:
                _idx_building.discard(name)

    threading.Thread(target=work, name=f"wxgrid-idx-{name}", daemon=True).start()
    return {}


# ── alerts (MeteoAlarm, Europe) ──────────────────────────────────────────

MA_ATOM = "https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-{}"
MA_GEOCODES = "https://drive.google.com/uc?export=download&id=16s24hYHfYQhKMNcP1hpgQmg13Yb8j0hV"
MA_COUNTRIES = (
    "andorra", "austria", "belgium", "bosnia-herzegovina", "bulgaria", "croatia", "cyprus", "czechia",
    "denmark", "estonia", "finland", "france", "germany", "greece", "hungary", "iceland", "ireland",
    "israel", "italy", "latvia", "lithuania", "luxembourg", "malta", "moldova", "montenegro",
    "netherlands", "norway", "poland", "portugal", "republic-of-north-macedonia", "romania", "serbia",
    "slovakia", "slovenia", "spain", "sweden", "switzerland", "ukraine", "united-kingdom",
)
# MeteoAlarm's awareness colours, which are the scale the national services
# actually agree on — CAP severity from the same message is looser.
_AWARE_LEVEL = {"yellow": 2, "orange": 3, "red": 4}
_AWARE_TYPE = {"wind": "wind", "snow-ice": "snow-ice", "snow/ice": "snow-ice", "thunderstorm": "thunderstorm",
               "thunderstorms": "thunderstorm", "fog": "fog", "high-temperature": "high-temp",
               "low-temperature": "low-temp", "coastal-event": "coastal", "coastalevent": "coastal",
               "forest-fire": "forestfire", "forestfire": "forestfire", "avalanches": "avalanche",
               "avalanche": "avalanche", "rain": "rain", "flood": "flood", "flooding": "flood", "rain-flood": "flood"}
_SEV_NAME = {4: "Extreme", 3: "Severe", 2: "Moderate", 1: "Minor", 0: "Unknown"}
# "Yellow Thunderstorm Warning issued for Austria - Salzburg-Umgebung"
_MA_TITLE = re.compile(r"^(\w+)\s+(.+?)\s+Warning issued for\s+(.+?)\s+-\s+(.+)$")


def _emma_regions() -> dict:
    """EMMA_ID → geometry. MeteoAlarm publishes one 39 MB GeoJSON of all 2195
    warning regions (linked from their re-users page); we decode it a feature
    at a time so the whole thing never lands in memory as objects, and keep a
    simplified ring per region — 1.3 MB on disk, rebuilt monthly."""
    def build() -> dict:
        import json
        r = _session.get(MA_GEOCODES, timeout=180)
        r.raise_for_status()
        text = r.text
        i = text.index('"features"')
        i = text.index("[", i) + 1
        dec, out = json.JSONDecoder(), {}
        while True:
            while i < len(text) and text[i] in " \t\r\n,":
                i += 1
            if i >= len(text) or text[i] == "]":
                break
            feat, i = dec.raw_decode(text, i)
            code = (feat.get("properties") or {}).get("code")
            geom = _rings_geom(_outer_rings(feat.get("geometry") or {}))
            if code and geom:
                out[code] = geom
        return out
    return _region_index("meteoalarm_emma", 30 * 24 * 3600, build)


def _ma_parse(xml: str) -> list[dict]:
    """One country's legacy Atom feed → live warnings. The feed is a rolling
    archive: most entries have already expired, and a region that has been
    re-warned five times appears five times, so we keep the newest per
    (area, event) and drop anything past its expiry."""
    import xml.etree.ElementTree as ET
    from datetime import datetime, timezone
    root = ET.fromstring(xml)
    now = datetime.now(timezone.utc)
    seen: dict[tuple, dict] = {}
    for e in _kids(root, "entry"):
        if _txt(e, "status") != "Actual" or _txt(e, "message_type") == "Cancel":
            continue
        ends = _txt(e, "expires")
        end_dt = _iso(ends)
        if end_dt and end_dt < now:
            continue
        title = _txt(e, "title")
        m = _MA_TITLE.match(title)
        colour = (m.group(1) if m else "").lower()
        awareness = (m.group(2) if m else "").lower()
        country = m.group(3) if m else ""
        sev = _AWARE_LEVEL.get(colour) or _SEV.get(_txt(e, "severity"), 0)
        event = _AWARE_TYPE.get(awareness, awareness or _txt(e, "event").lower() or "warning")
        area = _txt(e, "areaDesc") or (m.group(4) if m else "")
        code = ""
        for gc in _kids(e, "geocode"):
            if _txt(gc, "valueName") == "EMMA_ID":
                code = _txt(gc, "value")
        rings = []
        for poly in _kids(e, "polygon"):
            pts = [p.split(",") for p in (poly.text or "").split() if "," in p]
            ring = [[float(lon), float(lat)] for lat, lon in pts]
            if len(ring) >= 4:
                rings.append(ring)
        cap_url = ""
        for ln in _kids(e, "link"):
            if ln.get("type") == "application/cap+xml":
                cap_url = ln.get("href") or ""
        sent = _txt(e, "sent")
        key = (country, code or area, event)
        prev = seen.get(key)
        if prev and (prev["_sent"] or "") >= sent:
            continue
        seen[key] = {
            "id": f"{_txt(e, 'identifier')}:{code or area}", "event": event, "severity": _SEV_NAME.get(sev, "Unknown"),
            "sev": sev, "color": _SEV_COLOR[sev], "headline": title,
            "area": f"{area}, {country}".strip(", "), "onset": _txt(e, "onset") or _txt(e, "effective"), "ends": ends,
            "sender": None, "source": "MeteoAlarm", "url": cap_url, "code": code,
            "geometry": _rings_geom(rings), "_sent": sent,
        }
    return list(seen.values())


def _ma_warnings() -> list[dict]:
    """Live European warnings from all 39 national feeds, fetched in parallel
    (~5 MB upstream, one country per request, failures skipped). Cached 10 min.
    Geometry is the CAP polygon where the service publishes one (Norway,
    Sweden, the UK) and the EMMA_ID region otherwise."""
    def fetch():
        from concurrent.futures import ThreadPoolExecutor
        def one(slug: str) -> list[dict]:
            try:
                r = _session.get(MA_ATOM.format(slug), timeout=30)
                r.raise_for_status()
                return _ma_parse(r.text)
            except Exception as exc:
                log.info("meteoalarm %s: %s", slug, exc)
                return []
        out: list[dict] = []
        with ThreadPoolExecutor(max_workers=8) as pool:
            for got in pool.map(one, MA_COUNTRIES):
                out.extend(got)
        regions = _emma_regions()
        for w in out:
            if not w["geometry"] and w["code"]:
                w["geometry"] = regions.get(w["code"])
            w.pop("_sent", None)
        out.sort(key=lambda w: -w["sev"])
        return out[:1200]
    return cache.get("alerts:meteoalarm", 600, fetch)


def _ma_detail(url: str) -> dict:
    """The Atom entry is a summary; the CAP message behind it carries the
    issuing service, the text and the advice. Fetched only for the handful of
    warnings a point lookup actually hits."""
    def fetch():
        import xml.etree.ElementTree as ET
        try:
            r = _session.get(url, timeout=20)
            r.raise_for_status()
            root = ET.fromstring(r.text)
        except Exception as exc:
            log.info("meteoalarm cap %s: %s", url, exc)
            return {}
        infos = _kids(root, "info")
        info = next((i for i in infos if _txt(i, "language", "").lower().startswith("en")), infos[0] if infos else None)
        if info is None:
            return {}
        return {"sender": _txt(info, "senderName") or None, "description": _txt(info, "description")[:900],
                "instruction": _txt(info, "instruction")[:400], "web": _txt(info, "web") or url}
    return cache.get(f"alerts:ma:cap:{url}", 900, fetch)


# ── alerts (BoM, Australia) ──────────────────────────────────────────────

BOM_FTP_HOST = "ftp.bom.gov.au"
BOM_CAP_DIR = "anon/gen/fwo"
# BoM's CAP-AU messages carry no polygon, only AMOC area codes; the matching
# district boundaries are these shapefiles (public forecast / marine wind /
# fire weather / metropolitan). River-catchment sets exist too but are 8 MB for
# flood warnings that are really line features, so they are left out and those
# warnings come back without a shape.
BOM_SPATIAL = ("IDM00001", "IDM00003", "IDM00007", "IDM00014")
BOM_SPATIAL_DIR = "anon/home/adfd/spatial"
_BOM_SEV = ((4, ("tropical cyclone", "destructive", "catastrophic", "tsunami", "hurricane force", "major flood", "extreme fire")),
            (3, ("severe", "damaging", "fire weather", "storm force", "extreme heat", "moderate flood")),
            (2, ("gale", "strong wind", "marine wind", "minor flood", "flood", "frost", "surf", "sheep graziers", "heat", "wind")))


def _shp_regions(blob: bytes) -> dict:
    """AAC code → geometry from a BoM shapefile zip, with stdlib struct: the
    .shp is a flat list of polygon records and the .dbf a fixed-width table,
    which is far less trouble than adding a shapefile dependency for three
    files that change once a year."""
    import io
    import struct
    import zipfile
    z = zipfile.ZipFile(io.BytesIO(blob))
    shp_name = next(n for n in z.namelist() if n.lower().endswith(".shp"))
    dbf_name = next(n for n in z.namelist() if n.lower().endswith(".dbf"))
    dbf = z.read(dbf_name)
    n_rec = struct.unpack_from("<I", dbf, 4)[0]
    hdr_len, rec_len = struct.unpack_from("<H", dbf, 8)[0], struct.unpack_from("<H", dbf, 10)[0]
    fields, off = [], 32
    while dbf[off] != 0x0D:                      # 0x0D terminates the field descriptor array
        fields.append((dbf[off:off + 11].split(b"\0")[0].decode("latin1"), dbf[off + 16]))
        off += 32
    codes = []
    for i in range(n_rec):
        p, code = hdr_len + i * rec_len + 1, ""
        for fname, flen in fields:
            if fname == "AAC":
                code = dbf[p:p + flen].decode("latin1").strip()
            p += flen
        codes.append(code)
    shp, pos, out, k = z.read(shp_name), 100, {}, 0
    while pos + 8 <= len(shp):
        content_len = struct.unpack_from(">I", shp, pos + 4)[0]
        body = pos + 8
        if struct.unpack_from("<i", shp, body)[0] == 5:            # 5 = polygon
            n_parts, n_points = struct.unpack_from("<ii", shp, body + 36)
            parts = list(struct.unpack_from(f"<{n_parts}i", shp, body + 44))
            pts_at = body + 44 + 4 * n_parts
            rings = []
            for j, start in enumerate(parts):
                stop = parts[j + 1] if j + 1 < n_parts else n_points
                xy = struct.unpack_from(f"<{2 * (stop - start)}d", shp, pts_at + 16 * start)
                rings.append([[xy[m], xy[m + 1]] for m in range(0, len(xy), 2)])
            geom = _rings_geom(rings)
            if geom and k < len(codes) and codes[k]:
                out[codes[k]] = geom
        pos = body + content_len * 2
        k += 1
    return out


def _bom_regions() -> dict:
    """AMOC-AreaCode → geometry, built once a month from BoM's public spatial
    zips (~7 MB total, anonymous FTP)."""
    def build() -> dict:
        import ftplib
        import io
        out: dict = {}
        ftp = ftplib.FTP(BOM_FTP_HOST, timeout=60)
        try:
            ftp.login()
            ftp.cwd(BOM_SPATIAL_DIR)
            for dataset in BOM_SPATIAL:
                buf = io.BytesIO()
                ftp.retrbinary(f"RETR {dataset}.zip", buf.write)
                out.update(_shp_regions(buf.getvalue()))
        finally:
            try:
                ftp.quit()
            except Exception:
                ftp.close()
        return out
    return _region_index("bom_amoc", 30 * 24 * 3600, build)


def _bom_sev(text: str, cap_severity: str) -> int:
    sev = _SEV.get(cap_severity, 0)
    if sev:
        return sev
    low = text.lower()
    for level, words in _BOM_SEV:                 # CAP-AU usually says "Unknown"
        if any(w in low for w in words):
            return level
    return 2


def _bom_parse(xml: str, regions: dict) -> dict | None:
    import xml.etree.ElementTree as ET
    from datetime import datetime, timezone
    root = ET.fromstring(xml)
    if _txt(root, "status") != "Actual" or _txt(root, "msgType") == "Cancel":
        return None
    infos = _kids(root, "info")
    info = next((i for i in infos if _txt(i, "language", "").lower().startswith("en")), infos[0] if infos else None)
    if info is None:
        return None
    ends = _txt(info, "expires")
    end_dt = _iso(ends)
    if end_dt and end_dt < datetime.now(timezone.utc):
        return None
    headline = _txt(info, "headline")
    sev = _bom_sev(f"{headline} {_txt(info, 'event')} {_txt(info, 'description')[:200]}", _txt(info, "severity"))
    areas, rings = [], []
    for area in _kids(info, "area"):
        areas.append(_txt(area, "areaDesc"))
        for poly in _kids(area, "polygon"):
            pts = [p.split(",") for p in (poly.text or "").split() if "," in p]
            ring = [[float(lon), float(lat)] for lat, lon in pts]
            if len(ring) >= 4:
                rings.append(ring)
        for gc in _kids(area, "geocode"):
            if _txt(gc, "valueName") == "AMOC-AreaCode":
                rings.extend(_outer_rings(regions.get(_txt(gc, "value")) or {}))
    return {"id": _txt(root, "identifier"), "event": headline.split(" for ")[0] or _txt(info, "event"),
            "severity": _SEV_NAME.get(sev, "Unknown"), "sev": sev, "color": _SEV_COLOR[sev], "headline": headline,
            "area": "; ".join(a for a in areas if a), "onset": _txt(info, "onset") or _txt(info, "effective"),
            "ends": ends, "sender": _txt(info, "senderName") or "Bureau of Meteorology", "source": "BoM",
            "description": _txt(info, "description")[:900], "instruction": _txt(info, "instruction")[:400],
            "url": _txt(info, "web"), "geometry": _rings_geom(rings)}


def _bom_cap_files() -> dict[str, str]:
    """The active CAP-AU products, listed and pulled straight off BoM's
    anonymous FTP: they publish no HTTP index of them, and their web front end
    answers 403 to anything that isn't a browser user agent. A busy day is a
    few dozen small files, so one sequential session is enough."""
    def fetch():
        import ftplib
        out: dict[str, str] = {}
        try:
            ftp = ftplib.FTP(BOM_FTP_HOST, timeout=45)
            try:
                ftp.login()
                ftp.cwd(BOM_CAP_DIR)
                names = sorted({n.rsplit("/", 1)[-1] for n in ftp.nlst() if n.endswith(".cap.xml")})
                for name in names[:80]:
                    buf = bytearray()
                    ftp.retrbinary(f"RETR {name}", buf.extend)
                    out[name] = buf.decode("utf-8", "replace")
            finally:
                try:
                    ftp.quit()
                except Exception:
                    ftp.close()
        except Exception as exc:
            log.warning("bom ftp failed: %s", exc)
        return out
    return cache.get("alerts:bom:cap", 600, fetch)


def _bom_warnings() -> list[dict]:
    """Active Australian warnings from the CAP-AU products. Cached 10 min.
    Land and marine warnings get a shape from the district index; river-flood
    warnings, whose catchments we don't carry, come back without one."""
    def fetch():
        files = _bom_cap_files()
        if not files:
            return []
        regions = _bom_regions()
        out = []
        for name, xml in files.items():
            try:
                w = _bom_parse(xml, regions)
            except Exception as exc:
                log.info("bom cap %s: %s", name, exc)
                continue
            if w:
                out.append(w)
        out.sort(key=lambda w: -w["sev"])
        return out
    return cache.get("alerts:bom", 600, fetch)


# ── alerts (merged) ──────────────────────────────────────────────────────

_LAYER_KEYS = ("id", "event", "severity", "sev", "color", "headline", "area", "onset", "ends", "sender", "source")


def _features(warnings: list[dict]) -> list[dict]:
    return [{"type": "Feature", "geometry": w["geometry"], "properties": {k: w.get(k) for k in _LAYER_KEYS}}
            for w in warnings if w.get("geometry")]


def alerts_layer() -> dict:
    """Every warning source that gives us a shape, in one FeatureCollection:
    NWS (US), MeteoAlarm (Europe), BoM (Australia). Each source is cached and
    guarded on its own — one dead upstream costs its own features, not the
    endpoint."""
    feats = list(nws_alerts_layer().get("features") or [])
    for name, source in (("meteoalarm", _ma_warnings), ("bom", _bom_warnings)):
        try:
            feats.extend(_features(source()))
        except Exception as exc:
            log.warning("%s alerts layer failed: %s", name, exc)
    return {"type": "FeatureCollection", "features": feats}


def _bbox_hit(lon: float, lat: float, geom: dict) -> bool:
    xs, ys = [], []
    for ring in _outer_rings(geom):
        for x, y in ring:
            xs.append(x)
            ys.append(y)
    return bool(xs) and min(xs) <= lon <= max(xs) and min(ys) <= lat <= max(ys)


def alerts_point(lat: float, lon: float) -> list[dict]:
    """Alerts in force at a point. The NWS answers point queries itself; for
    MeteoAlarm and BoM we test the point against the polygons we already hold,
    which costs nothing extra upstream. A MeteoAlarm hit then pulls its CAP
    message for the text the Atom summary doesn't carry."""
    key = f"alerts:pt:{lat:.2f}:{lon:.2f}"
    def fetch():
        out = _nws_point(lat, lon)
        for name, source in (("meteoalarm", _ma_warnings), ("bom", _bom_warnings)):
            try:
                for w in source():
                    geom = w.get("geometry")
                    if not geom or not _bbox_hit(lon, lat, geom) or not _in_geom(lon, lat, geom):
                        continue
                    hit = {k: w.get(k) for k in (*_LAYER_KEYS, "description", "instruction", "url")}
                    if w["source"] == "MeteoAlarm" and w.get("url"):
                        detail = _ma_detail(w["url"])
                        hit.update({k: v for k, v in detail.items() if k != "web"})
                        hit["url"] = detail.get("web") or w["url"]
                    out.append(hit)
            except Exception as exc:
                log.warning("%s point alerts failed: %s", name, exc)
        out.sort(key=lambda a: -(a["sev"] or 0))
        return out
    return cache.get(key, 300, fetch)

# ── tropical systems (NHC) ────────────────────────────────────────────────

NHC = "https://www.nhc.noaa.gov/CurrentStorms.json"


def _kmz_features(url: str) -> list[dict]:
    """Placemarks from an NHC KMZ → GeoJSON features (Point / LineString / Polygon)."""
    import io
    import re
    import zipfile
    import xml.etree.ElementTree as ET
    r = _session.get(url, timeout=30)
    r.raise_for_status()
    z = zipfile.ZipFile(io.BytesIO(r.content))
    kml = next((n for n in z.namelist() if n.lower().endswith(".kml")), None)
    if not kml:
        return []
    root = ET.fromstring(z.read(kml))
    ns = {"k": root.tag.split("}")[0].strip("{")} if "}" in root.tag else {}
    q = (lambda t: f"k:{t}") if ns else (lambda t: t)
    feats = []
    for pm in root.iter(f"{{{ns['k']}}}Placemark" if ns else "Placemark"):
        name = (pm.findtext(q("name"), default="", namespaces=ns) or "").strip()
        desc = re.sub(r"<[^>]+>", " ", pm.findtext(q("description"), default="", namespaces=ns) or "")
        desc = re.sub(r"\s+", " ", desc).strip()[:300]
        for tag, gtype in (("Point", "Point"), ("LineString", "LineString"), ("Polygon", "Polygon")):
            for geom in pm.iter(f"{{{ns['k']}}}{tag}" if ns else tag):
                coords_el = geom.find(f".//{q('coordinates')}", ns)
                if coords_el is None or not coords_el.text:
                    continue
                pts = [[float(c.split(",")[0]), float(c.split(",")[1])] for c in coords_el.text.split() if "," in c]
                if gtype == "Point":
                    g = {"type": "Point", "coordinates": pts[0]}
                elif gtype == "LineString":
                    g = {"type": "LineString", "coordinates": pts}
                else:
                    g = {"type": "Polygon", "coordinates": [pts]}
                feats.append({"type": "Feature", "geometry": g, "properties": {"name": name, "desc": desc, "kind": tag.lower()}})
    return feats


def storms() -> dict:
    """Active tropical cyclones (NHC/CPHC): current position + intensity from
    CurrentStorms.json, forecast track and cone from the advisory KMZs."""
    def fetch():
        try:
            j = _get_json(NHC, timeout=20)
        except Exception as exc:
            log.warning("nhc failed: %s", exc)
            return {"type": "FeatureCollection", "features": [], "storms": []}
        feats, meta = [], []
        for s in j.get("activeStorms", []):
            base = {"id": s.get("id"), "name": s.get("name"), "class": s.get("classification"), "intensity_kt": s.get("intensity"),
                    "pressure_mb": s.get("pressure"), "movement": f"{s.get('movementDir')}° at {s.get('movementSpeed')} kt",
                    "updated": s.get("lastUpdate"), "advisory": (s.get("publicAdvisory") or {}).get("advNum"),
                    "url": (s.get("publicAdvisory") or {}).get("url")}
            meta.append(base)
            feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [s.get("longitudeNumeric"), s.get("latitudeNumeric")]},
                          "properties": {**base, "kind": "current"}})
            for key, kind in (("trackCone", "cone"), ("forecastTrack", "track")):
                url = (s.get(key) or {}).get("kmzFile") if isinstance(s.get(key), dict) else None
                if not url:
                    continue
                try:
                    for f in _kmz_features(url):
                        f["properties"].update({"storm": s.get("name"), "id": s.get("id"), "layer": kind})
                        feats.append(f)
                except Exception as exc:
                    log.info("nhc %s %s: %s", s.get("id"), kind, exc)
        return {"type": "FeatureCollection", "features": feats, "storms": meta}
    return cache.get("storms", 900, fetch)


# ── air quality / UV (Open-Meteo) ────────────────────────────────────────

def air(lat: float, lon: float) -> dict:
    key = f"air:{lat:.2f}:{lon:.2f}"
    def fetch():
        out: dict = {}
        try:
            j = _get_json("https://air-quality-api.open-meteo.com/v1/air-quality",
                          {"latitude": lat, "longitude": lon, "current": "us_aqi,european_aqi,pm2_5,pm10,ozone,nitrogen_dioxide,uv_index,uv_index_clear_sky",
                           "hourly": "us_aqi,pm2_5,uv_index", "forecast_days": 2, "timezone": "UTC"}, timeout=15)
            c = j.get("current", {})
            out = {"time": c.get("time"), "us_aqi": c.get("us_aqi"), "eu_aqi": c.get("european_aqi"), "pm2_5": c.get("pm2_5"), "pm10": c.get("pm10"),
                   "ozone": c.get("ozone"), "no2": c.get("nitrogen_dioxide"), "uv": c.get("uv_index"), "uv_clear": c.get("uv_index_clear_sky"),
                   "hourly": {"time": j.get("hourly", {}).get("time", [])[:48], "us_aqi": j.get("hourly", {}).get("us_aqi", [])[:48],
                              "pm2_5": j.get("hourly", {}).get("pm2_5", [])[:48], "uv": j.get("hourly", {}).get("uv_index", [])[:48]}}
        except Exception as exc:
            log.info("open-meteo air: %s", exc)
        return out
    return cache.get(key, 1800, fetch)


# ── tides: DFO (Canada) + NOAA CO-OPS (US) ───────────────────────────────

def _dfo_stations() -> list[dict]:
    def fetch():
        try:
            return _get_json("https://api-iwls.dfo-mpo.gc.ca/api/v1/stations", timeout=30)
        except Exception as exc:
            log.warning("dfo stations: %s", exc)
            return []
    return cache.get("tides:dfo:stations", 7 * 24 * 3600, fetch)


def _noaa_stations() -> list[dict]:
    def fetch():
        try:
            j = _get_json("https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json", {"type": "tidepredictions"}, timeout=40)
            return j.get("stations", [])
        except Exception as exc:
            log.warning("noaa stations: %s", exc)
            return []
    return cache.get("tides:noaa:stations", 7 * 24 * 3600, fetch)


def tides(lat: float, lon: float, max_km: float = 60.0) -> dict | None:
    """Next high/low water at the nearest tide station (Canadian DFO or US
    NOAA CO-OPS), 48 h, metres. None when no station is within reach."""
    key = f"tides:{lat:.2f}:{lon:.2f}"
    def fetch():
        from datetime import datetime, timedelta, timezone
        best = None
        for st in _dfo_stations():
            if not st.get("operating") or not any(ts.get("code") == "wlp-hilo" for ts in st.get("timeSeries", [])):
                continue
            d = _haversine_km(lat, lon, st["latitude"], st["longitude"])
            if d < (best[0] if best else max_km):
                best = (d, "dfo", st)
        for st in _noaa_stations():
            try:
                d = _haversine_km(lat, lon, float(st["lat"]), float(st["lng"]))
            except (KeyError, TypeError, ValueError):
                continue
            if d < (best[0] if best else max_km):
                best = (d, "noaa", st)
        if not best:
            return None
        d, src, st = best
        now = datetime.now(timezone.utc)
        events = []
        try:
            if src == "dfo":
                j = _get_json(f"https://api-iwls.dfo-mpo.gc.ca/api/v1/stations/{st['id']}/data",
                              {"time-series-code": "wlp-hilo", "from": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
                               "to": (now + timedelta(hours=48)).strftime("%Y-%m-%dT%H:%M:%SZ")}, timeout=20)
                vals = [(e["eventDate"], float(e["value"])) for e in j]
                for k, (t, v) in enumerate(vals):
                    prev = vals[k - 1][1] if k else None
                    nxt = vals[k + 1][1] if k + 1 < len(vals) else None
                    kind = "H" if (prev is None or v >= prev) and (nxt is None or v >= nxt) else "L"
                    events.append({"time": t, "height_m": round(v, 2), "type": kind})
                name, sid = st.get("officialName"), st.get("code")
            else:
                j = _get_json("https://api.tidesandcurrents.noaa.gov/api/prod/datagetter",
                              {"product": "predictions", "datum": "MLLW", "station": st["id"], "time_zone": "gmt", "units": "metric",
                               "interval": "hilo", "format": "json", "begin_date": now.strftime("%Y%m%d %H:%M"),
                               "range": 48}, timeout=20)
                for e in j.get("predictions", []):
                    events.append({"time": e["t"].replace(" ", "T") + "Z", "height_m": round(float(e["v"]), 2), "type": e["type"]})
                name, sid = st.get("name"), st.get("id")
        except Exception as exc:
            log.info("tides %s %s: %s", src, st.get("id"), exc)
            return None
        return {"source": "DFO CHS" if src == "dfo" else "NOAA CO-OPS", "station": name, "station_id": sid, "distance_km": round(d, 1),
                "datum": "chart datum" if src == "dfo" else "MLLW", "events": events[:8]}
    return cache.get(key, 3600, fetch)
