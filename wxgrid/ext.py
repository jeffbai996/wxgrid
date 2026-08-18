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


def alerts_point(lat: float, lon: float) -> list[dict]:
    """Alerts in force at a point (NWS: zone- and polygon-based). Outside the
    US the NWS API 404s and we return []."""
    key = f"alerts:pt:{lat:.2f}:{lon:.2f}"
    def fetch():
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
            out.sort(key=lambda a: -a["sev"])
            return out
        except Exception as exc:
            log.info("nws point alerts: %s", exc)
            return []
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
