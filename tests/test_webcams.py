"""Nearby webcams: provider parsers, geometry, and the cache seam."""
from wxgrid import webcams


def _dbc(id_, lon, lat, **kw):
    o = {"id": id_, "name": f"Hwy {id_}", "caption": "looking west", "is_on": True, "should_appear": True,
         "location": {"type": "Point", "coordinates": [lon, lat]}, "elevation": 1200,
         "last_update_modified": "2026-09-02T00:15:13-07:00", "marked_stale": False, "marked_delayed": False}
    o.update(kw); return o


def test_drivebc_parser_keeps_live_cams_with_a_position_and_builds_image_urls():
    cams = webcams.parse_drivebc([_dbc(5, -121.0, 49.6), _dbc(6, -121.1, 49.7, is_on=False),
                                  _dbc(7, None, 49.0), {"junk": True}, _dbc(8, -120.0, 50.0, marked_stale=True)])
    ids = [c.id for c in cams]
    assert ids == ["drivebc:5", "drivebc:8"]
    assert cams[0].image == "https://www.drivebc.ca/images/5.jpg"                # id fallback
    with_link = webcams.parse_drivebc([_dbc(9, -121.0, 49.6, links={"imageDisplay": "/images/9.jpg?t=1788334179"})])
    assert with_link[0].image == "https://www.drivebc.ca/images/9.jpg"           # the site's own path, un-busted
    assert cams[0].lat == 49.6 and cams[0].lon == -121.0 and cams[0].elevation_m == 1200
    assert cams[1].stale is True
    assert "OGL" in cams[0].credit


def test_nearest_orders_by_distance_within_the_radius_and_reports_bearing():
    cams = webcams.parse_drivebc([_dbc(1, -123.1, 49.3), _dbc(2, -123.1, 50.3), _dbc(3, -110.0, 49.3)])
    out = webcams.nearest(cams, 49.28, -123.12, n=5)
    assert [c["id"] for c in out] == ["drivebc:1", "drivebc:2"]     # cam 3 is ~950 km east
    assert out[0]["distance_km"] < 3 and 0 <= out[1]["bearing_deg"] <= 5   # cam 2 is due north
    assert len(webcams.nearest(cams, 49.28, -123.12, n=1)) == 1


def test_catalogue_caches_each_provider_and_survives_a_dead_feed():
    calls = []
    def get_json(url, params, timeout):
        calls.append(url)
        if "drivebc" in url:
            return [_dbc(1, -123.1, 49.3)]
        raise RuntimeError("511 down")
    store = {}
    def cache_get(key, ttl, fn):
        if key not in store:
            store[key] = fn()
        return store[key]
    cams = webcams.catalogue(get_json=get_json, cache_get=cache_get)
    webcams.catalogue(get_json=get_json, cache_get=cache_get)
    assert [c.id for c in cams] == ["drivebc:1"]
    assert len(calls) == len(webcams.PROVIDERS)          # one fetch per provider, then cached
    assert sorted(store) == sorted(f"webcams:{p[0]}" for p in webcams.PROVIDERS)


def test_near_point_shape():
    out = webcams.near_point(49.28, -123.12, 3, get_json=lambda *a, **k: [_dbc(1, -123.1, 49.3)],
                             cache_get=lambda k, t, fn: fn())
    assert out["cams"][0]["provider"] == "DriveBC" and "providers" in out
