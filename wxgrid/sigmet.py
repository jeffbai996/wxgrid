"""SIGMETs, AIRMETs and G-AIRMETs from the NOAA Aviation Weather Center's
keyless JSON API, merged into one GeoJSON layer.

  /api/data/airsigmet   US domestic SIGMET / AIRMET / convective SIGMET / outlook
  /api/data/isigmet     international SIGMETs, one per issuing FIR
  /api/data/gairmet     graphical AIRMETs (SIERRA / TANGO / ZULU), US only

The three feeds disagree about everything except that a hazard is a ring of
lat/lon points: altitudes are called base/top here and altitudeLow1/altitudeHi1
there, severity is a number in one feed, a qualifier word in the second and a
free-text band in the third, and G-AIRMET freezing levels are lines rather than
areas. Everything below normalises them onto one feature shape so the map and
the point lookup only ever see one vocabulary.

Cache/session conventions come from wxgrid.ext — same TTL cache, same session
and User-Agent, same ring thinning and point-in-polygon.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from wxgrid import ext

log = logging.getLogger("wxgrid.sigmet")

AWC = "https://aviationweather.gov/api/data"
TTL = 300                                      # AWC republishes on the hour and on issue

# The hazard vocabulary we publish. Everything upstream folds into one of these.
HAZARDS = ("TURB", "ICE", "IFR", "MTW", "CONVECTIVE", "TS", "ASH", "TC", "OTHER")
_HAZARD_MAP = {
    "TURB": "TURB", "TURB-HI": "TURB", "TURB-LO": "TURB", "TURBULENCE": "TURB",
    "ICE": "ICE", "ICING": "ICE", "ICE-HI": "ICE", "ICE-LO": "ICE",
    "IFR": "IFR", "MT_OBSC": "IFR", "MTN OBSCN": "IFR",
    "MTW": "MTW", "MT_WAVE": "MTW", "MOUNTAIN WAVE": "MTW",
    "CONVECTIVE": "CONVECTIVE", "CONV": "CONVECTIVE",
    "TS": "TS", "TSGR": "TS", "THUNDERSTORM": "TS",
    "VA": "ASH", "ASH": "ASH", "VOLCANIC_ASH": "ASH",
    "TC": "TC", "CYCLONE": "TC", "TROPICAL_CYCLONE": "TC",
}
# Warm for convection, blue-white for ice, grey-green for the visibility
# products — deliberately distinct at 30 % fill opacity over both basemaps.
HAZARD_COLOR = {
    "CONVECTIVE": "#ff3a1d", "TS": "#ff6b35", "TURB": "#c77dff", "ICE": "#5bc8ff",
    "IFR": "#9aa7b4", "MTW": "#ffd166", "ASH": "#b07d4a", "TC": "#ff4fa3", "OTHER": "#8a8f98",
}
# Severity words that upstream actually uses, mapped onto a 1-4 ramp we can sort
# and fade by. Order matters: the first hit wins.
_SEV_WORDS = ((4, ("EXTRM", "EXTREME", "SEV", "SEVERE", "HVY", "HEAVY", "FRQ", "OBSC")),
              (3, ("MOD/SEV", "EMBD", "EMBEDDED", "MOD-SEV", "SQL", "SQUALL")),
              (2, ("MOD", "MODERATE", "OCNL", "LGT-MOD", "OCCASIONAL")),
              (1, ("LGT", "LIGHT", "ISOL", "ISOLATED", "NRML")))


def _sev(*words: str | None) -> int:
    text = " ".join(w for w in words if w).upper()
    if "CONVECTIVE" in text:                   # a convective SIGMET is never routine
        return 4
    for level, keys in _SEV_WORDS:
        if any(k in text for k in keys):
            return level
    return 2


def _sev_num(n, *words: str | None) -> int:
    """The domestic feed grades severity as an integer instead of a word (a
    convective SIGMET comes through as 5). Fold it onto the same 1-4 ramp;
    fall back to the words when the field is empty, as it is for AIRMETs."""
    try:
        v = int(n)
    except (TypeError, ValueError):
        return _sev(*words)
    return 4 if v >= 5 else 3 if v >= 3 else 2 if v >= 1 else _sev(*words)


def _hazard(raw: str | None) -> str:
    key = (raw or "").strip().upper()
    return _HAZARD_MAP.get(key, "OTHER")


def _iso(epoch) -> str | None:
    """AWC hands out epoch seconds in most fields and ISO strings in a few."""
    if epoch in (None, "", 0):
        return None
    if isinstance(epoch, str):
        return epoch
    try:
        return datetime.fromtimestamp(int(epoch), timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except (TypeError, ValueError, OSError):
        return None


def _ft(v) -> int | None:
    try:
        return int(round(float(v)))
    except (TypeError, ValueError):
        return None


def _geom(coords: list | None, kind: str) -> dict | None:
    """[{lat, lon}, …] → Polygon or LineString. G-AIRMET sends the numbers as
    strings; SIGMET rings are not always closed. Rings are thinned the same way
    the warning layers are — 48 points is more than any of these need."""
    pts = []
    for c in coords or []:
        try:
            pts.append([float(c["lon"]), float(c["lat"])])
        except (KeyError, TypeError, ValueError):
            continue
    if (kind or "").upper() == "LINE":
        return {"type": "LineString", "coordinates": [[round(x, 3), round(y, 3)] for x, y in pts]} if len(pts) >= 2 else None
    if len(pts) < 3:
        return None
    return {"type": "Polygon", "coordinates": [ext._thin(pts)]}


def _feature(props: dict, geom: dict | None) -> dict | None:
    if not geom:
        return None
    haz = props["hazard"]
    return {"type": "Feature", "geometry": geom,
            "properties": {**props, "color": HAZARD_COLOR.get(haz, HAZARD_COLOR["OTHER"])}}


def _expired(valid_to: str | None) -> bool:
    if not valid_to:
        return False
    try:
        return datetime.fromisoformat(valid_to.replace("Z", "+00:00")) < datetime.now(timezone.utc)
    except ValueError:
        return False


# ── the three feeds ───────────────────────────────────────────────────────

def parse_airsigmet(rows: list) -> list[dict]:
    """US domestic SIGMET / AIRMET. Convective SIGMETs carry a bare top
    (altitudeHi1) with no base, which means surface-to-top."""
    out = []
    for r in rows or []:
        kind = (r.get("airSigmetType") or "SIGMET").upper()
        haz = _hazard(r.get("hazard"))
        props = {
            "id": f"{r.get('icaoId') or 'US'}:{r.get('seriesId') or r.get('alphaChar') or ''}:{r.get('validTimeFrom')}",
            "hazard": haz, "hazard_raw": (r.get("hazard") or "").upper(), "kind": kind,
            "severity": str(r.get("severity")) if r.get("severity") is not None else None,
            "sev": _sev_num(r.get("severity"), r.get("hazard"), kind),
            "base_ft": _ft(r.get("altitudeLow1")), "top_ft": _ft(r.get("altitudeHi1")),
            "valid_from": _iso(r.get("validTimeFrom")), "valid_to": _iso(r.get("validTimeTo")),
            "area": r.get("icaoId"), "movement": (f"{r['movementDir']}° at {r['movementSpd']} kt"
                                                  if r.get("movementDir") is not None and r.get("movementSpd") is not None else None),
            "raw": (r.get("rawAirSigmet") or "").strip()[:1200],
            "source": "AWC AIRSIGMET (US)",
        }
        if _expired(props["valid_to"]):
            continue
        f = _feature(props, _geom(r.get("coords"), r.get("geom") or "AREA"))
        if f:
            out.append(f)
    return out


def parse_isigmet(rows: list) -> list[dict]:
    """International SIGMETs. `qualifier` is the severity word (SEV, EMBD,
    ISOL …) except for volcanic ash, where it is the volcano's name."""
    out = []
    for r in rows or []:
        haz = _hazard(r.get("hazard"))
        qual = (r.get("qualifier") or "").strip()
        props = {
            "id": f"{r.get('firId') or r.get('icaoId') or 'INTL'}:{r.get('seriesId') or ''}:{r.get('validTimeFrom')}",
            "hazard": haz, "hazard_raw": (r.get("hazard") or "").upper(), "kind": "SIGMET",
            "severity": qual or None, "sev": _sev(qual, r.get("hazard")),
            "base_ft": _ft(r.get("base")), "top_ft": _ft(r.get("top")),
            "valid_from": _iso(r.get("validTimeFrom")), "valid_to": _iso(r.get("validTimeTo")),
            "area": r.get("firName") or r.get("firId"),
            "movement": (f"{r['dir']} at {r['spd']} kt" if r.get("dir") and r.get("spd") else None),
            "raw": (r.get("rawSigmet") or "").strip()[:1200],
            "source": "AWC ISIGMET (international)",
        }
        if _expired(props["valid_to"]):
            continue
        f = _feature(props, _geom(r.get("coords"), r.get("geom") or "AREA"))
        if f:
            out.append(f)
    return out


def parse_gairmet(rows: list) -> list[dict]:
    """Graphical AIRMETs. The feed carries a forecast every 3 h out to 12 h and
    they overlap on the map, so only the nearest issuance (forecastHour 0) is
    kept. Freezing-level products put their altitudes in fzlbase/fzltop and
    their geometry in a line rather than an area."""
    out = []
    for r in rows or []:
        if (r.get("forecastHour") or 0) != 0:
            continue
        raw_haz = (r.get("hazard") or "").upper()
        haz = _hazard(raw_haz)
        sev_txt = r.get("severity") or r.get("frequency")
        props = {
            "id": f"GAIRMET:{r.get('product')}:{raw_haz}:{r.get('tag')}:{r.get('issueTime')}",
            "hazard": haz, "hazard_raw": raw_haz, "kind": f"G-AIRMET {r.get('product') or ''}".strip(),
            "severity": sev_txt, "sev": _sev(sev_txt, raw_haz),
            "base_ft": _ft(r.get("base") if r.get("base") is not None else r.get("fzlbase")),
            "top_ft": _ft(r.get("top") if r.get("top") is not None else r.get("fzltop")),
            "valid_from": _iso(r.get("issueTime")), "valid_to": _iso(r.get("expireTime")),
            "area": r.get("due_to"), "movement": None,
            "raw": " ".join(x for x in [raw_haz, r.get("severity"), r.get("due_to"), r.get("status")] if x)[:1200],
            "source": "AWC G-AIRMET (US)",
        }
        if _expired(props["valid_to"]):
            continue
        f = _feature(props, _geom(r.get("coords"), r.get("geom") or r.get("geometryType") or "AREA"))
        if f:
            out.append(f)
    return out


_FEEDS = (("airsigmet", parse_airsigmet), ("isigmet", parse_isigmet), ("gairmet", parse_gairmet))


def sigmet_layer() -> dict:
    """Every in-force SIGMET / AIRMET with a shape, in one FeatureCollection.
    Each feed is fetched and parsed under its own guard: one dead upstream costs
    its own features, not the endpoint. Cached 5 min."""
    def fetch():
        feats: list[dict] = []
        counts: dict[str, int] = {}
        for name, parse in _FEEDS:
            try:
                rows = ext._get_json(f"{AWC}/{name}", {"format": "json"}, timeout=30)
                got = parse(rows if isinstance(rows, list) else [])
            except Exception as exc:
                log.warning("awc %s failed: %s", name, exc)
                continue
            counts[name] = len(got)
            feats.extend(got)
        for haz in HAZARDS:
            n = sum(1 for f in feats if f["properties"]["hazard"] == haz)
            if n:
                counts[haz] = n
        feats.sort(key=lambda f: -f["properties"]["sev"])
        return {"type": "FeatureCollection", "features": feats, "counts": counts,
                "colors": HAZARD_COLOR}
    return ext.cache.get("sigmet:layer", TTL, fetch)


def sigmet_point(lat: float, lon: float) -> list[dict]:
    """The hazards in force over a point, worst first. Tested against the
    polygons the layer already holds, so it costs nothing extra upstream;
    line features (G-AIRMET freezing levels) have no interior and are skipped."""
    key = f"sigmet:pt:{lat:.2f}:{lon:.2f}"
    def fetch():
        out = []
        for f in sigmet_layer().get("features") or []:
            g = f.get("geometry") or {}
            if g.get("type") not in ("Polygon", "MultiPolygon"):
                continue
            if not ext._bbox_hit(lon, lat, g) or not ext._in_geom(lon, lat, g):
                continue
            out.append(dict(f["properties"]))
        out.sort(key=lambda p: -(p.get("sev") or 0))
        return out
    return ext.cache.get(key, TTL, fetch)
