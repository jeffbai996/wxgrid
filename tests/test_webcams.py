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
    assert sorted(store) == sorted(f"webcams:{p[0]}:{webcams.CATALOG_VERSION}" for p in webcams.PROVIDERS)


def test_near_point_shape():
    out = webcams.near_point(49.28, -123.12, 3, get_json=lambda *a, **k: [_dbc(1, -123.1, 49.3)],
                             cache_get=lambda k, t, fn: fn())
    assert out["cams"][0]["provider"] == "DriveBC" and "providers" in out


def _windy(id_, lat, lon, **kw):
    o = {"webcamId": id_, "title": f"Cam {id_}", "status": "active", "lastUpdatedOn": "2026-09-02T07:50:00.000Z",
         "location": {"latitude": lat, "longitude": lon, "city": "Whistler", "region": "British Columbia", "country": "Canada"},
         "images": {"current": {"preview": f"https://images-webcams.windy.com/{id_}/preview.jpg", "thumbnail": "x"}},
         "urls": {"detail": f"https://windy.com/webcams/{id_}"}}
    o.update(kw); return o


def test_windy_parser_reads_v3_records_and_skips_inactive_or_imageless():
    cams = webcams.parse_windy({"total": 3, "webcams": [_windy(1, 50.11, -122.95), _windy(2, 50.1, -122.9, status="inactive"),
                                                        _windy(3, 50.1, -122.9, images={"current": {}})]})
    assert [c.id for c in cams] == ["windy:1"]
    assert cams[0].image.endswith("/1/preview.jpg") and cams[0].page == "https://windy.com/webcams/1"
    assert cams[0].caption == "Whistler, British Columbia, Canada" and cams[0].provider == "Windy"


def test_windy_is_queried_per_point_with_the_key_in_a_header_and_merged_by_distance(monkeypatch):
    seen = {}
    def get_json(url, params, timeout, headers=None):
        if "windy" in url:
            seen.update(params=params, headers=headers)
            return {"webcams": [_windy(9, 49.31, -123.10)]}
        return [_dbc(1, -123.0, 49.9)]
    out = webcams.near_point(49.28, -123.12, 4, get_json=get_json, cache_get=lambda k, t, fn: fn(), windy="k3y")
    assert seen["headers"] == {"X-WINDY-API-KEY": "k3y"} and seen["params"]["nearby"].startswith("49.280,-123.120,")
    assert [c["id"] for c in out["cams"]] == ["windy:9", "drivebc:1"]           # nearer first, providers mixed
    assert out["providers"] == ["drivebc", "windy"]


def test_without_a_key_windy_is_not_called(monkeypatch):
    monkeypatch.delenv(webcams.WINDY_ENV, raising=False)
    calls = []
    out = webcams.near_point(49.28, -123.12, 4, get_json=lambda url, *a, **k: calls.append(url) or [], cache_get=lambda k, t, fn: fn())
    assert all("windy" not in u for u in calls) and out["providers"] == ["drivebc"]


def test_a_dead_catalogue_is_remembered_briefly_not_for_the_catalogue_ttl():
    # The failure path returned [] into cache_get, so one DriveBC timeout
    # hid every BC cam for the 20-minute catalogue TTL. Now the fetch raises
    # (nothing stored) and the empty list is remembered for FAIL_TTL_S.
    calls, remembered, store = [], [], {}
    def get_json(url, params, timeout):
        calls.append(url); raise RuntimeError("read timed out")
    def cache_get(key, ttl, fn):
        if key in store: return store[key]
        return fn()
    def cache_remember(key, ttl, value):
        remembered.append((key, ttl, value)); store[key] = value
    assert webcams.catalogue(get_json=get_json, cache_get=cache_get, cache_remember=cache_remember) == []
    assert webcams.catalogue(get_json=get_json, cache_get=cache_get, cache_remember=cache_remember) == []
    assert len(calls) == len(webcams.PROVIDERS)
    assert remembered and all(ttl == webcams.FAIL_TTL_S and value == [] for _, ttl, value in remembered)
    assert webcams.FAIL_TTL_S < webcams.CATALOG_TTL_S


def test_upstream_timeouts_fit_the_card_budget():
    seen = []
    def get_json(url, params=None, timeout=None, headers=None):
        seen.append(timeout); return []
    webcams.catalogue(get_json=get_json, cache_get=lambda k, t, fn: fn())
    webcams.windy_near(49.28, -123.12, 4, key="k", get_json=lambda url, params, timeout, headers: seen.append(timeout) or {"webcams": []},
                       cache_get=lambda k, t, fn: fn())
    assert seen and max(seen) <= 12


def test_windy_twins_of_a_catalogue_cam_are_dropped():
    # Windy mirrors the DOT feeds, so a DriveBC cam came back twice: once as
    # itself and once as "Coquihalla Summit" from windy.com 40 m away. The
    # provider's own record wins; the mirror within WINDY_TWIN_M goes.
    twin = _windy(1, 49.3003, -123.1002)             # ~40 m from drivebc:1
    other = _windy(2, 49.32, -123.10)                 # 2 km away: a different cam
    def get_json(url, params=None, timeout=None, headers=None):
        return {"webcams": [twin, other]} if "windy" in url else [_dbc(1, -123.1, 49.3)]
    out = webcams.near_point(49.28, -123.12, 6, get_json=get_json, cache_get=lambda k, t, fn: fn(), windy="k3y")
    ids = [c["id"] for c in out["cams"]]
    assert ids == ["drivebc:1", "windy:2"] and 0 < webcams.WINDY_TWIN_M <= 150
