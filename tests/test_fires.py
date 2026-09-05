"""Parsers, size cap and point lookup in wxgrid.fires — no network."""
import json

import pytest

from wxgrid import fires


# ── fixtures ──────────────────────────────────────────────────────────────

CIFFC_FC = {"type": "FeatureCollection", "features": [
    {"type": "Feature", "id": "ytd_fires.1", "geometry": {"type": "Point", "coordinates": [-123.5, 50.1]},
     "properties": {"field_system_fire_id": "2026_BC_C50123", "field_agency_fire_id": "C50123",
                    "field_fire_size": 1240.5, "field_agency_fire_cause": "Lightning",
                    "field_situation_report_date": "2026-07-22T02:00:00Z",
                    "field_status_date": "2026-08-18T20:00:15Z",
                    "field_stage_of_control_status": "OC", "field_percent_contained": -1,
                    "field_agency_code": "bc"}},
    {"type": "Feature", "id": "ytd_fires.2", "geometry": {"type": "Point", "coordinates": [-73.1, 48.9]},
     "properties": {"field_system_fire_id": "2026_QC_442", "field_agency_fire_id": "442",
                    "field_fire_size": 12, "field_stage_of_control_status": "BH",
                    "field_percent_contained": 60, "field_agency_code": "qc"}},
    {"type": "Feature", "id": "ytd_fires.3", "geometry": None,
     "properties": {"field_system_fire_id": "2026_ZZ_1", "field_agency_code": "zz",
                    "field_stage_of_control_status": "UC"}},
]}

WFIGS_LOC = {"type": "FeatureCollection", "features": [
    {"type": "Feature", "geometry": {"type": "Point", "coordinates": [-145.39, 64.40]},
     "properties": {"UniqueFireIdentifier": "2026-AKDNS-612226", "IrwinID": "{A0}", "IncidentName": "SHAW",
                    "IncidentSize": 3459.2, "PercentContained": 0, "FireDiscoveryDateTime": 1781996460000,
                    "ModifiedOnDateTime_dt": 1786937959000, "POOState": "US-AK",
                    "POOProtectingAgency": "DNR", "FireCause": "Natural", "FireOutDateTime": None}},
    {"type": "Feature", "geometry": {"type": "Point", "coordinates": [-120.0, 39.0]},
     "properties": {"UniqueFireIdentifier": "2026-CANEU-000123", "IncidentName": "little creek",
                    "IncidentSize": 24.71, "PercentContained": 100, "POOState": "US-CA",
                    "POOJurisdictionalAgency": "CALFIRE", "FireOutDateTime": None}},
]}


def _ring(n, cx=-120.0, cy=40.0, r=0.2):
    import math
    pts = [[round(cx + r * math.cos(2 * math.pi * i / n), 6), round(cy + r * math.sin(2 * math.pi * i / n), 6)]
           for i in range(n)]
    return pts + [pts[0]]


WFIGS_PERIM = {"type": "FeatureCollection", "features": [
    {"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [_ring(500)]},
     "properties": {"attr_IncidentName": "shaw", "attr_UniqueFireIdentifier": "2026-AKDNS-612226",
                    "attr_PercentContained": 0, "poly_GISAcres": 3459.19, "attr_POOState": "US-AK",
                    "attr_POOProtectingAgency": "DNR", "poly_DateCurrent": 1786931720000,
                    "attr_FireDiscoveryDateTime": 1781996460000}},
]}

M3_FC = {"type": "FeatureCollection", "features": [
    {"type": "Feature", "id": "m3_polygons_current.9", "geometry": {"type": "Polygon", "coordinates": [_ring(300, -113.0, 55.0)]},
     "properties": {"hcount": 44, "firstdate": "2026-08-01T00:00:00Z", "lastdate": "2026-08-18T00:00:00Z", "area": 8123.0}},
]}


@pytest.fixture(autouse=True)
def _clear_cache():
    fires.cache.clear()
    yield
    fires.cache.clear()


def _route(monkeypatch, **by_host):
    """Stub ext._get_json as wxgrid.fires imported it, dispatching on the URL."""
    def fake(url, params=None, timeout=20):
        for frag, payload in by_host.items():
            if frag in url:
                return payload
        raise AssertionError(f"unexpected upstream {url}")
    monkeypatch.setattr(fires, "_get_json", fake)


# ── Canadian parser ───────────────────────────────────────────────────────

def test_ciffc_parser_maps_agency_stage_and_drops_geometryless(monkeypatch):
    _route(monkeypatch, ciffc=CIFFC_FC)
    got = fires._ca_incidents()
    assert len(got) == 2                                   # the null-geometry fire is dropped
    bc = got[0]["properties"]
    assert bc["agency"] == "BC Wildfire Service" and bc["country"] == "CA" and bc["kind"] == "incident"
    assert bc["status"] == "Out of control" and bc["area_ha"] == 1240.5
    assert bc["contained_pct"] is None                     # CIFFC's -1 means "not reported"
    assert bc["url"].startswith("https://wildfiresituation.nrs.gov.bc.ca")
    qc = got[1]["properties"]
    assert qc["agency"] == "SOPFEU" and qc["status"] == "Being held" and qc["contained_pct"] == 60


def test_ciffc_failure_is_caught_and_logged(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("geoserver on fire, ironically")
    monkeypatch.setattr(fires, "_get_json", boom)
    assert fires._ca_incidents() == []
    assert fires._ca_perimeters() == []


def test_m3_perimeters_carry_area_and_dates(monkeypatch):
    _route(monkeypatch, cwfis=M3_FC)
    got = fires._ca_perimeters()
    assert len(got) == 1
    p = got[0]["properties"]
    assert p["kind"] == "perimeter" and p["country"] == "CA" and p["area_ha"] == 8123.0
    assert p["source"] == "CWFIS M3" and p["updated"] == "2026-08-18T00:00:00Z"


# ── US parser ─────────────────────────────────────────────────────────────

def test_wfigs_parser_converts_acres_and_epochs(monkeypatch):
    _route(monkeypatch, WFIGS_Incident_Locations_Current=WFIGS_LOC)
    got = fires._us_incidents()
    assert len(got) == 2
    shaw = got[0]["properties"]
    assert shaw["name"] == "Shaw" and shaw["agency"] == "DNR" and shaw["state"] == "AK"
    assert abs(shaw["area_ha"] - 3459.2 / 2.4710538) < 0.2
    assert shaw["started"].startswith("2026-") and shaw["started"].endswith("Z")
    assert shaw["status"] == "Active"
    lc = got[1]["properties"]
    assert lc["name"] == "Little Creek" and lc["status"] == "Contained" and lc["agency"] == "CALFIRE"


def test_wfigs_arcgis_error_payload_is_not_parsed_as_features(monkeypatch):
    _route(monkeypatch, WFIGS_Incident_Locations_Current={"error": {"code": 400, "message": "bad"}})
    assert fires._us_incidents() == []


def test_wfigs_perimeter_parser(monkeypatch):
    _route(monkeypatch, WFIGS_Interagency_Perimeters_Current=WFIGS_PERIM)
    got = fires._us_perimeters()
    p = got[0]["properties"]
    assert p["kind"] == "perimeter" and p["name"] == "Shaw" and p["country"] == "US"
    assert abs(p["area_ha"] - 3459.19 / 2.4710538) < 0.2


# ── geometry thinning + size cap ──────────────────────────────────────────

def test_thin_geom_reduces_vertices_and_closes_ring():
    g = fires._thin_geom({"type": "Polygon", "coordinates": [_ring(500)]}, 48, 3)
    ring = g["coordinates"][0]
    assert len(ring) <= 49 and ring[0] == ring[-1]


def test_thin_geom_drops_degenerate_polygons():
    assert fires._thin_geom({"type": "Polygon", "coordinates": [[[1, 1], [1, 1], [1, 1]]]}, 48, 3) is None
    assert fires._thin_geom(None, 48, 3) is None


def _fat_perimeter(i, area):
    return {"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [_ring(600, -120 + i * 0.01, 40)]},
            "properties": {"id": f"p{i}", "name": "Big", "agency": "A", "source": "S", "country": "US",
                           "kind": "perimeter", "area_ha": area, "contained_pct": None, "status": "Active",
                           "cause": None, "started": None, "updated": None, "url": "u"}}


def _point(i, area):
    return {"type": "Feature", "geometry": {"type": "Point", "coordinates": [-120 + i * 0.01, 40]},
            "properties": {"id": f"i{i}", "name": "Spot", "agency": "A", "source": "S", "country": "CA",
                           "kind": "incident", "area_ha": area, "contained_pct": None, "status": "Active",
                           "cause": None, "started": None, "updated": None, "url": "u"}}


def test_pack_stays_under_the_byte_budget_and_keeps_the_biggest_fires():
    perims = [_fat_perimeter(i, 5000 - i) for i in range(900)]
    pts = [_point(i, 0.1 if i else 90000.0) for i in range(3000)]
    fc = fires._pack(pts, perims, limit=1_500_000)
    raw = json.dumps(fc, separators=(",", ":")).encode()
    assert len(raw) <= 1_500_000
    names = [f["properties"]["area_ha"] for f in fc["features"] if f["properties"]["kind"] == "incident"]
    assert 90000.0 in names                                # the one that matters survived


def test_pack_untouched_when_small():
    fc = fires._pack([_point(0, 5.0)], [_fat_perimeter(0, 900.0)])
    assert len(fc["features"]) == 2
    assert len(fc["features"][0]["geometry"]["coordinates"][0]) <= 257


# ── layer + point lookup ──────────────────────────────────────────────────

def test_fires_layer_merges_sources_and_counts(monkeypatch):
    _route(monkeypatch, ciffc=CIFFC_FC, cwfis=M3_FC,
           WFIGS_Incident_Locations_Current=WFIGS_LOC, WFIGS_Interagency_Perimeters_Current=WFIGS_PERIM)
    fc = fires.fires_layer()
    assert fc["counts"] == {"CA:incident": 2, "US:incident": 2, "CA:perimeter": 1, "US:perimeter": 1}
    assert all("kind" in f["properties"] for f in fc["features"])


def test_fires_layer_survives_one_dead_upstream(monkeypatch):
    def fake(url, params=None, timeout=20):
        if "ciffc" in url:
            raise RuntimeError("down")
        if "WFIGS_Incident_Locations_Current" in url:
            return WFIGS_LOC
        return {"type": "FeatureCollection", "features": []}
    monkeypatch.setattr(fires, "_get_json", fake)
    fc = fires.fires_layer()
    assert fc["counts"] == {"US:incident": 2}


def test_fires_point_returns_nearest_incidents_only(monkeypatch):
    _route(monkeypatch, ciffc=CIFFC_FC, cwfis=M3_FC,
           WFIGS_Incident_Locations_Current=WFIGS_LOC, WFIGS_Interagency_Perimeters_Current=WFIGS_PERIM)
    near = fires.fires_point(50.15, -123.55, radius_km=50)
    assert len(near) == 1 and near[0]["name"] == "C50123" and near[0]["distance_km"] < 10
    assert all(h["kind"] == "incident" for h in near)
    assert fires.fires_point(0.0, 0.0, radius_km=50) == []
