"""Active wildfires with the agency metadata behind them, from the two open
interagency feeds that publish it without a key:

  CIFFC (Canada)   geoserver.ciffc.net WFS `ciffc:ytd_fires` — every fire the
                   provincial/territorial agencies have reported this year, with
                   the agency's own fire number, size in hectares, stage of
                   control and status date. Filtered to the ones still burning.
  CWFIS (NRCan)    cwfis.cfs.nrcan.gc.ca WFS `public:m3_polygons_current` — the
                   M3 hotspot-derived perimeters. No names, but they are the
                   only free Canada-wide polygons.
  NIFC WFIGS (US)  services3.arcgis.com/T4QMspbfLg3qTGWY — current incident
                   locations and current interagency perimeters, the IRWIN
                   record every US federal/state agency writes into.

Europe (EFFIS/GWIS) is deliberately absent: its WFS is the only keyless GeoJSON
path and its backend answers every GetFeature with an Oracle connection error,
so there is nothing to parse. The raster hotspot layers the front end already
draws cover it visually.

One FeatureCollection out, points (kind="incident") and polygons
(kind="perimeter") sharing one property schema, cached 10 min and size-capped:
a fire map that costs 4 MB is a fire map nobody waits for.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Iterable

from wxgrid.ext import _get_json, _haversine_km, cache

log = logging.getLogger("wxgrid.fires")

CIFFC_WFS = "https://geoserver.ciffc.net/geoserver/wfs"
CWFIS_WFS = "https://cwfis.cfs.nrcan.gc.ca/geoserver/public/wfs"
WFIGS = "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services"

TTL = 600                       # 10 min; the agencies update hourly at best
MAX_BYTES = 1_500_000           # the payload budget the front end will wear
ACRES_PER_HA = 2.4710538

# CIFFC's agency codes are the province/territory (plus `pc` for Parks Canada).
# The URLs are the public incident maps those agencies actually run — the same
# ones CIFFC's own site links out to.
CA_AGENCY = {
    "ab": ("Alberta Wildfire", "https://srd.web.alberta.ca/wildfires-of-note"),
    "bc": ("BC Wildfire Service", "https://wildfiresituation.nrs.gov.bc.ca/map"),
    "mb": ("Manitoba Wildfire Service", "https://www.gov.mb.ca/nrnd/wildfire_program/index.html"),
    "nb": ("New Brunswick DNRED", "https://www2.gnb.ca/content/gnb/en/news/public_alerts/forest_fire_watch.html"),
    "nl": ("Newfoundland and Labrador FFA", "https://www.gov.nl.ca/ffa/public-education/forestry/forest-fires/"),
    "ns": ("Nova Scotia DNRR", "https://novascotia.ca/natr/forestprotection/wildfire/"),
    "nt": ("NWT Environment and Climate Change", "https://www.enr.gov.nt.ca/en/services/wildfire-update"),
    "on": ("Ontario MNR Aviation, Forest Fire and Emergency Services", "https://www.ontario.ca/page/forest-fires"),
    "pc": ("Parks Canada", "https://parks.canada.ca/nature/science/conservation/feu-fire/incendies-wildfires"),
    "pe": ("Prince Edward Island", "https://www.princeedwardisland.ca/en/topic/fire-information"),
    "qc": ("SOPFEU", "https://sopfeu.qc.ca"),
    "sk": ("Saskatchewan Public Safety Agency", "https://www.saskpublicsafety.ca/emergencies-and-response/active-incidents"),
    "yt": ("Yukon Wildland Fire Management", "https://wildfires.service.yukon.ca/"),
}
CA_FALLBACK_URL = "https://cwfis.cfs.nrcan.gc.ca/interactive-map"
US_URL = "https://inciweb.wildfire.gov/"
# CIFFC stage-of-control codes.
CA_STAGE = {"OC": "Out of control", "BH": "Being held", "UC": "Under control", "OUT": "Out"}


# ── shaping ───────────────────────────────────────────────────────────────

def _feature(geom: dict | None, props: dict) -> dict | None:
    return {"type": "Feature", "geometry": geom, "properties": props} if geom else None


def _epoch_iso(ms: Any) -> str | None:
    """ArcGIS hands out epoch milliseconds; the rest of the app speaks ISO."""
    if ms in (None, ""):
        return None
    try:
        from datetime import datetime, timezone
        return datetime.fromtimestamp(float(ms) / 1000, timezone.utc).isoformat().replace("+00:00", "Z")
    except (TypeError, ValueError, OSError):
        return None


def _num(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if f < 0 else f


def _thin_ring(ring: list, maxpts: int, ndigits: int) -> list:
    """Round to a fixed precision, drop the points that survive rounding as
    duplicates, then stride down to `maxpts`. A perimeter drawn at zoom 8 does
    not need 4000 vertices, and the difference is a megabyte."""
    out: list = []
    for pt in ring:
        try:
            p = [round(float(pt[0]), ndigits), round(float(pt[1]), ndigits)]
        except (TypeError, ValueError, IndexError):
            continue
        if not out or out[-1] != p:
            out.append(p)
    if len(out) > maxpts:
        step = len(out) // maxpts + 1
        out = out[::step]
    if len(out) >= 3 and out[0] != out[-1]:
        out.append(out[0])
    return out if len(out) >= 4 else []


def _thin_geom(geom: dict | None, maxpts: int, ndigits: int) -> dict | None:
    """Polygon/MultiPolygon thinned; holes dropped (a hole in a fire perimeter
    is unburnt island, and at these zooms it is one pixel)."""
    if not geom:
        return None
    t = geom.get("type")
    if t == "Polygon":
        ring = _thin_ring((geom.get("coordinates") or [[]])[0], maxpts, ndigits)
        return {"type": "Polygon", "coordinates": [ring]} if ring else None
    if t == "MultiPolygon":
        polys = [[_thin_ring(p[0], maxpts, ndigits)] for p in geom.get("coordinates") or [] if p]
        polys = [p for p in polys if p[0]]
        if not polys:
            return None
        return {"type": "Polygon", "coordinates": polys[0]} if len(polys) == 1 else {"type": "MultiPolygon", "coordinates": polys}
    return None


# ── Canada: CIFFC incidents ───────────────────────────────────────────────

def _ca_incidents() -> list[dict]:
    """Fires the Canadian agencies currently report as burning. `ytd_fires`
    holds the whole season, so the CQL filter drops the ones already out —
    ~500 live out of ~5000 year-to-date."""
    try:
        j = _get_json(CIFFC_WFS, {
            "service": "WFS", "version": "2.0.0", "request": "GetFeature",
            "typeNames": "ciffc:ytd_fires", "outputFormat": "application/json",
            "srsName": "EPSG:4326", "CQL_FILTER": "field_stage_of_control_status<>'OUT'",
        }, timeout=45)
    except Exception as exc:
        log.warning("ciffc active fires failed: %s", exc)
        return []
    out = []
    for f in j.get("features") or []:
        p = f.get("properties") or {}
        code = (p.get("field_agency_code") or "").lower()
        agency, url = CA_AGENCY.get(code, (code.upper() or "Canada", CA_FALLBACK_URL))
        out.append(_feature(f.get("geometry"), {
            "id": p.get("field_system_fire_id") or f.get("id"),
            "name": p.get("field_agency_fire_id") or p.get("field_system_fire_id") or "Unnamed fire",
            "agency": agency, "source": "CIFFC", "country": "CA", "kind": "incident",
            "area_ha": _num(p.get("field_fire_size")),
            "contained_pct": _num(p.get("field_percent_contained")),
            "status": CA_STAGE.get(p.get("field_stage_of_control_status"), p.get("field_stage_of_control_status") or "Active"),
            "cause": p.get("field_agency_fire_cause") or None,
            "started": p.get("field_situation_report_date"),
            "updated": p.get("field_status_date"),
            "url": url,
        }))
    return [f for f in out if f]


# ── Canada: CWFIS M3 perimeters ───────────────────────────────────────────

def _ca_perimeters() -> list[dict]:
    """NRCan's M3 polygons: perimeters grown from satellite hotspot clusters,
    the only free Canada-wide fire shapes. They carry no name or agency — the
    CIFFC point sitting inside one supplies that."""
    try:
        j = _get_json(CWFIS_WFS, {
            "service": "WFS", "version": "2.0.0", "request": "GetFeature",
            "typeNames": "public:m3_polygons_current", "outputFormat": "application/json",
            "srsName": "EPSG:4326",
        }, timeout=60)
    except Exception as exc:
        log.warning("cwfis m3 perimeters failed: %s", exc)
        return []
    out = []
    for f in j.get("features") or []:
        p = f.get("properties") or {}
        out.append({"type": "Feature", "geometry": f.get("geometry"), "properties": {
            "id": f.get("id"), "name": "M3 fire perimeter", "agency": "NRCan CWFIS",
            "source": "CWFIS M3", "country": "CA", "kind": "perimeter",
            "area_ha": _num(p.get("area")), "contained_pct": None,
            "status": "Satellite-mapped perimeter", "cause": None,
            "started": p.get("firstdate"), "updated": p.get("lastdate"),
            "url": CA_FALLBACK_URL,
        }})
    return [f for f in out if f.get("geometry")]


# ── USA: NIFC WFIGS ───────────────────────────────────────────────────────

_US_LOC_FIELDS = ("IrwinID,UniqueFireIdentifier,IncidentName,IncidentSize,PercentContained,"
                  "FireDiscoveryDateTime,ModifiedOnDateTime_dt,POOState,POOProtectingAgency,"
                  "POOJurisdictionalAgency,IncidentTypeCategory,FireCause,FireOutDateTime,"
                  "IncidentShortDescription")


def _us_status(p: dict) -> str:
    if p.get("FireOutDateTime"):
        return "Out"
    pct = _num(p.get("PercentContained"))
    if pct is not None and pct >= 100:
        return "Contained"
    if pct:
        return f"{int(pct)}% contained"
    return "Active"


def _us_incidents() -> list[dict]:
    """Current WFIGS incident locations, wildfires only (the service also
    carries prescribed burns, which are not what a fire map is for)."""
    try:
        j = _get_json(f"{WFIGS}/WFIGS_Incident_Locations_Current/FeatureServer/0/query", {
            "where": "IncidentTypeCategory='WF' AND FireOutDateTime IS NULL",
            "outFields": _US_LOC_FIELDS, "f": "geojson", "outSR": 4326,
            "returnGeometry": "true", "geometryPrecision": 5, "resultRecordCount": 2000,
        }, timeout=45)
    except Exception as exc:
        log.warning("wfigs incident locations failed: %s", exc)
        return []
    if isinstance(j, dict) and j.get("error"):
        log.warning("wfigs incident locations error: %s", j["error"])
        return []
    out = []
    for f in j.get("features") or []:
        p = f.get("properties") or {}
        acres = _num(p.get("IncidentSize"))
        out.append(_feature(f.get("geometry"), {
            "id": p.get("UniqueFireIdentifier") or p.get("IrwinID"),
            "name": (p.get("IncidentName") or "Unnamed fire").title(),
            "agency": p.get("POOProtectingAgency") or p.get("POOJurisdictionalAgency") or "NIFC",
            "source": "NIFC WFIGS", "country": "US", "kind": "incident",
            "area_ha": round(acres / ACRES_PER_HA, 1) if acres is not None else None,
            "contained_pct": _num(p.get("PercentContained")),
            "status": _us_status(p), "cause": p.get("FireCause") or None,
            "started": _epoch_iso(p.get("FireDiscoveryDateTime")),
            "updated": _epoch_iso(p.get("ModifiedOnDateTime_dt")),
            "state": (p.get("POOState") or "").replace("US-", "") or None,
            "url": US_URL,
        }))
    return [f for f in out if f]


def _us_perimeters() -> list[dict]:
    """Current interagency perimeters. `maxAllowableOffset` is in the output
    SR's units — degrees here — so the server does the generalisation and we
    never download the full-resolution rings."""
    try:
        j = _get_json(f"{WFIGS}/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query", {
            "where": "1=1",
            "outFields": ("attr_IncidentName,attr_IncidentSize,attr_PercentContained,attr_FireDiscoveryDateTime,"
                          "attr_POOState,attr_POOProtectingAgency,attr_IrwinID,attr_UniqueFireIdentifier,"
                          "attr_FireCause,poly_GISAcres,poly_DateCurrent"),
            "f": "geojson", "outSR": 4326, "returnGeometry": "true",
            "maxAllowableOffset": 0.002, "geometryPrecision": 4, "resultRecordCount": 1000,
        }, timeout=60)
    except Exception as exc:
        log.warning("wfigs perimeters failed: %s", exc)
        return []
    if isinstance(j, dict) and j.get("error"):
        log.warning("wfigs perimeters error: %s", j["error"])
        return []
    out = []
    for f in j.get("features") or []:
        p = f.get("properties") or {}
        acres = _num(p.get("poly_GISAcres")) or _num(p.get("attr_IncidentSize"))
        pct = _num(p.get("attr_PercentContained"))
        out.append(_feature(f.get("geometry"), {
            "id": p.get("attr_UniqueFireIdentifier") or p.get("attr_IrwinID"),
            "name": (p.get("attr_IncidentName") or "Unnamed fire").title(),
            "agency": p.get("attr_POOProtectingAgency") or "NIFC",
            "source": "NIFC WFIGS", "country": "US", "kind": "perimeter",
            "area_ha": round(acres / ACRES_PER_HA, 1) if acres is not None else None,
            "contained_pct": pct,
            "status": "Contained" if (pct or 0) >= 100 else "Active perimeter",
            "cause": p.get("attr_FireCause") or None,
            "started": _epoch_iso(p.get("attr_FireDiscoveryDateTime")),
            "updated": _epoch_iso(p.get("poly_DateCurrent")),
            "state": (p.get("attr_POOState") or "").replace("US-", "") or None,
            "url": US_URL,
        }))
    return [f for f in out if f]


# ── size cap ──────────────────────────────────────────────────────────────

def _size(fc: dict) -> int:
    return len(json.dumps(fc, separators=(",", ":")).encode())


def _area(f: dict) -> float:
    return f["properties"].get("area_ha") or 0.0


def _pack(incidents: list[dict], perimeters: list[dict], limit: int = MAX_BYTES) -> dict:
    """Fit under the byte budget by giving up detail before giving up fires:
    thin the perimeters harder, then keep fewer of them, then drop the smallest
    incidents. A 0.1 ha spot fire in the Yukon is not what anyone opened the
    layer for; the 40 000 ha one is."""
    incidents = sorted(incidents, key=_area, reverse=True)
    perimeters = sorted(perimeters, key=_area, reverse=True)
    for maxpts, ndigits, keep_perim, min_ha in ((256, 4, 900, 0.0), (128, 4, 900, 0.0),
                                                (64, 4, 900, 0.0), (48, 3, 900, 0.0),
                                                (40, 3, 600, 0.0), (32, 3, 400, 1.0),
                                                (24, 3, 200, 10.0), (20, 3, 100, 100.0)):
        perims = []
        for f in perimeters[:keep_perim]:
            g = _thin_geom(f["geometry"], maxpts, ndigits)
            if g:
                perims.append({**f, "geometry": g})
        pts = [f for f in incidents if _area(f) >= min_ha] or incidents[:200]
        fc = {"type": "FeatureCollection", "features": perims + pts}
        if _size(fc) <= limit:
            return fc
    fc = {"type": "FeatureCollection", "features": incidents[:300]}
    log.warning("fires layer over budget even after simplification; points only")
    return fc


# ── public ────────────────────────────────────────────────────────────────

def fires_layer() -> dict:
    """Active fires from every source that answers, in one FeatureCollection.
    Perimeters come first so the front end can draw fills under the points
    without a second source. Cached 10 min; each upstream fails on its own."""
    def fetch() -> dict:
        incidents: list[dict] = []
        perimeters: list[dict] = []
        for name, fn, bucket in (("ciffc", _ca_incidents, incidents), ("wfigs-loc", _us_incidents, incidents),
                                 ("cwfis-m3", _ca_perimeters, perimeters), ("wfigs-perim", _us_perimeters, perimeters)):
            try:
                got = fn()
            except Exception as exc:                 # a parser bug must not take the layer down
                log.warning("fires source %s failed: %s", name, exc)
                continue
            log.info("fires source %s: %d features", name, len(got))
            bucket.extend(got)
        fc = _pack(incidents, perimeters)
        fc["counts"] = _counts(fc["features"])
        return fc
    return cache.get("fires:layer", TTL, fetch)


def _counts(features: Iterable[dict]) -> dict:
    out: dict[str, int] = {}
    for f in features:
        p = f["properties"]
        out[f"{p['country']}:{p['kind']}"] = out.get(f"{p['country']}:{p['kind']}", 0) + 1
    return out


def fires_point(lat: float, lon: float, radius_km: float = 50.0) -> list[dict]:
    """Incidents within `radius_km` of a point, nearest first. Reads the cached
    layer, so it costs nothing upstream."""
    out = []
    for f in fires_layer().get("features") or []:
        if f["properties"].get("kind") != "incident" or (f.get("geometry") or {}).get("type") != "Point":
            continue
        try:
            flon, flat = f["geometry"]["coordinates"][:2]
            d = _haversine_km(lat, lon, float(flat), float(flon))
        except (KeyError, TypeError, ValueError, IndexError):
            continue
        if d <= radius_km:
            out.append({**f["properties"], "lat": flat, "lon": flon, "distance_km": round(d, 1)})
    out.sort(key=lambda h: h["distance_km"])
    return out[:25]
