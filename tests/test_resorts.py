"""No network here: normalize_element/_merge_seed/search/nearest are pure
functions over fixture data, and the router is exercised against a
catalog + detail cache written straight to disk (WXGRID_DATA_DIR points at
a per-session tmp dir, set in conftest.py before any wxgrid import)."""
import json

from fastapi.testclient import TestClient

from wxgrid import api, resorts
from wxgrid.config import DATA_DIR
from wxgrid.resorts_seed import SEED_RESORTS

FAKE_ELEMENT = {
    "type": "way",
    "id": 123456789,
    "center": {"lat": 50.1163, "lon": -122.9574},
    "tags": {
        "name": "Whistler Blackcomb",
        "landuse": "winter_sports",
        "ele:min": "675",
        "ele:max": "2284 m",
        "addr:province": "British Columbia",
        "website": "https://www.whistlerblackcomb.com",
    },
}


def _write_catalog(entries: list[dict]) -> None:
    path = DATA_DIR / "resorts" / "catalog.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"built": "2026-01-01T00:00:00+00:00", "resorts": entries}))
    resorts._catalog_cache = None   # force reload from what we just wrote


def _write_detail_cache(resort_id: str, detail: dict) -> None:
    path = DATA_DIR / "resorts" / f"{resort_id}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(detail))


def _resort(id_, name, lat, lon, ele_base=None, ele_summit=None, osm_type=None, osm_id=None):
    return {"id": id_, "name": name, "lat": lat, "lon": lon, "country": "CA", "region": None,
            "website": None, "ele_base_m": ele_base, "ele_summit_m": ele_summit,
            "osm_type": osm_type, "osm_id": osm_id}


# ── normalize_element ────────────────────────────────────────────────────

def test_normalize_element_maps_overpass_tags_to_catalog_fields():
    r = resorts.normalize_element(FAKE_ELEMENT)
    assert r == {
        "id": "whistler-blackcomb-5012-n12296",
        "name": "Whistler Blackcomb",
        "lat": 50.1163,
        "lon": -122.9574,
        "country": "CA",
        "region": "British Columbia",
        "website": "https://www.whistlerblackcomb.com",
        "ele_base_m": 675,
        "ele_summit_m": 2284,
        "osm_type": "way",
        "osm_id": 123456789,
    }


def test_normalize_element_drops_unnamed():
    el = {"type": "way", "id": 1, "center": {"lat": 40.0, "lon": -110.0}, "tags": {}}
    assert resorts.normalize_element(el) is None


def test_normalize_element_country_heuristic_without_addr_tag():
    el = {"type": "way", "id": 2, "center": {"lat": 20.0, "lon": -99.0}, "tags": {"name": "Some Mexican Resort"}}
    assert resorts.normalize_element(el)["country"] == "MX"


def test_normalize_element_never_invents_missing_elevation():
    el = {"type": "way", "id": 3, "center": {"lat": 45.0, "lon": -110.0},
          "tags": {"name": "No Elevation Tags Resort", "ele": "2000"}}   # bare `ele`, no min/max
    r = resorts.normalize_element(el)
    assert r["ele_base_m"] is None and r["ele_summit_m"] is None


# ── seed merge ────────────────────────────────────────────────────────────

def test_merge_seed_appends_unmatched_curated_resorts():
    merged = resorts._merge_seed([])
    assert len(merged) == len(SEED_RESORTS)
    whistler = next(r for r in merged if r["name"] == "Whistler Blackcomb")
    assert whistler["ele_base_m"] == 675 and whistler["ele_summit_m"] == 2284
    assert whistler["osm_type"] is None    # seed-only entry, no OSM identity


def test_merge_seed_fills_missing_elevation_on_near_match_without_duplicating():
    osm_entry = _resort("whistler-blackcomb-mountain-resort-5012-n12296",
                         "Whistler Blackcomb Mountain Resort", 50.1163, -122.9574,
                         osm_type="relation", osm_id=999)
    merged = resorts._merge_seed([osm_entry])
    hits = [r for r in merged if "whistler" in r["name"].lower() and "blackcomb" in r["name"].lower()]
    assert len(hits) == 1                          # matched, not duplicated
    assert hits[0]["ele_base_m"] == 675
    assert hits[0]["ele_summit_m"] == 2284
    assert hits[0]["osm_type"] == "relation"        # OSM identity kept; only elevation was filled


# ── search / nearest ────────────────────────────────────────────────────

def test_search_prefix_then_substring_case_insensitive():
    _write_catalog([
        _resort("a", "Whistler Blackcomb", 50.1, -123.0, 675, 2284),
        _resort("b", "Big White", 49.7, -118.9, 1508, 2319),
        _resort("c", "Sun Peaks Whistler Lodge", 50.9, -119.9),
    ])
    hits = resorts.search("WHISTLER")
    assert [r["id"] for r in hits] == ["a", "c"]    # prefix match ranks before substring match
    assert resorts.search("") == []


def test_nearest_sorts_by_distance_and_respects_max_km():
    _write_catalog([
        _resort("near", "Near Resort", 50.10, -122.95),
        _resort("far", "Far Resort", 51.5, -114.0),
    ])
    hits = resorts.nearest(50.1163, -122.9574, max_km=60)
    assert [r["id"] for r in hits] == ["near"]
    assert "distance_km" in hits[0]


# ── router ────────────────────────────────────────────────────────────────

def test_api_resorts_search_and_nearest_and_400():
    _write_catalog([_resort("whistler-blackcomb-5012-n12296", "Whistler Blackcomb", 50.1163, -122.9574, 675, 2284)])
    c = TestClient(api.app)

    r = c.get("/api/resorts", params={"q": "whistler"})
    assert r.status_code == 200
    body = r.json()
    assert body["mode"] == "search"
    assert body["resorts"][0]["id"] == "whistler-blackcomb-5012-n12296"

    r = c.get("/api/resorts", params={"lat": 50.12, "lon": -122.95})
    assert r.json()["mode"] == "nearest"

    assert c.get("/api/resorts").status_code == 400


def test_api_resort_detail_served_from_cache_no_network(monkeypatch):
    resort_id = "whistler-blackcomb-5012-n12296"
    _write_catalog([_resort(resort_id, "Whistler Blackcomb", 50.1163, -122.9574, 675, 2284, "way", 123456789)])
    _write_detail_cache(resort_id, {
        "resort": resorts._find_resort(resort_id),
        "lifts": {"type": "FeatureCollection", "features": []},
        "pistes": {"type": "FeatureCollection", "features": []},
        "boundary": None,
        "elevation": {"base_m": 675, "summit_m": 2284},
    })

    def _no_network(*a, **k):
        raise AssertionError("resort_detail should have served from cache, not hit the network")
    monkeypatch.setattr(resorts.requests.Session, "post", _no_network)

    c = TestClient(api.app)
    r = c.get(f"/api/resorts/{resort_id}")
    assert r.status_code == 200
    assert r.json()["elevation"] == {"base_m": 675, "summit_m": 2284}
    assert c.get("/api/resorts/does-not-exist").status_code == 404


def test_api_resorts_rebuild_reports_counts(monkeypatch):
    fake = [
        _resort("x", "X", 1, 1, 100, 200),
        _resort("y", "Y", 2, 2),   # no elevation
    ]
    monkeypatch.setattr(resorts, "build_catalog", lambda session=None: fake)
    c = TestClient(api.app)
    r = c.post("/api/resorts/rebuild")
    assert r.status_code == 200
    assert r.json() == {"count": 2, "with_elevation": 1}


def test_detail_cache_written_before_pistes_existed_is_refetched(monkeypatch, tmp_path):
    """A cache from an older build has no runs in it. Serving it would leave the
    resort permanently without a trail map, so it has to be treated as a miss."""
    resort_id = "whistler-blackcomb-5013-n12297"
    _write_catalog([_resort(resort_id, "Whistler Blackcomb", 50.1163, -122.9574, 675, 2284, "way", 123456790)])
    _write_detail_cache(resort_id, {
        "resort": resorts._find_resort(resort_id),
        "lifts": {"type": "FeatureCollection", "features": []},
        "boundary": None,
        "elevation": {"base_m": 675, "summit_m": 2284},
    })
    hits = []
    monkeypatch.setattr(resorts, "_overpass_query", lambda *a, **k: hits.append(1) or [])
    monkeypatch.setattr(resorts.time, "sleep", lambda *_: None)
    monkeypatch.setattr(resorts, "_boundary_feature", lambda *a, **k: None)
    detail = resorts.resort_detail(resort_id)
    assert hits, "the stale cache should have been refetched"
    assert "pistes" in detail
