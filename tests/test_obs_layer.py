"""METAR stations as a map layer: box snapping, decoding, caching seams."""
from wxgrid import obs


def test_bbox_snaps_outward_to_whole_degrees():
    assert obs.snap_bbox(48.2, -124.9, 50.7, -121.1) == (48, -125, 51, -121)


def test_bbox_too_wide_is_refused_rather_than_asking_for_a_continent():
    assert obs.snap_bbox(20, -130, 60, -60) is None      # 70° of longitude
    assert obs.snap_bbox(10, -100, 40, -70) is None      # 30° of latitude
    assert obs.snap_bbox(50, 10, 40, 20) is None         # inverted


def _ob(icao="CYVR", **kw):
    base = {"icaoId": icao, "name": "Vancouver Intl", "lat": 49.19, "lon": -123.18, "reportTime": "2026-09-01 22:00:00",
            "temp": 16.0, "dewp": 12.0, "wdir": 270, "wspd": 12, "wgst": None, "visib": "10+", "altim": 1016.2,
            "wxString": None, "fltCat": "VFR", "clouds": [{"cover": "FEW", "base": 2500}, {"cover": "BKN", "base": 4000}],
            "rawOb": "CYVR 012200Z 27012KT 15SM FEW025 BKN040 16/12 A3001"}
    base.update(kw)
    return base


def test_features_keep_the_newest_report_per_station_and_read_the_ceiling():
    older = _ob(reportTime="2026-09-01 21:00:00", temp=14.0)
    fc = obs.metar_features([older, _ob(), _ob("KSEA", lat=47.45, lon=-122.31, wdir="VRB", wspd=3)])
    by = {f["id"]: f["properties"] for f in fc["features"]}
    assert len(fc["features"]) == 2
    assert by["CYVR"]["temp_c"] == 16.0
    assert by["CYVR"]["ceiling_ft"] == 4000.0
    assert by["CYVR"]["fltcat"] == "VFR"
    assert by["KSEA"]["wdir"] is None and by["KSEA"]["wspd_kt"] == 3.0
    assert fc["features"][0]["geometry"]["coordinates"] == [-123.18, 49.19]


def test_features_skip_stations_without_a_position():
    fc = obs.metar_features([_ob(lat=None), {"icaoId": None}])
    assert fc["features"] == []


def test_layer_goes_through_the_shared_cache_with_a_snapped_key():
    calls = []
    def get_json(url, params, timeout):
        calls.append(params["bbox"])
        return [_ob()]
    store = {}
    def cache_get(key, ttl, fn):
        if key not in store:
            store[key] = fn()
        return store[key]
    out = obs.metar_layer(48.2, -124.9, 50.7, -121.1, get_json=get_json, cache_get=cache_get)
    obs.metar_layer(48.4, -124.5, 50.9, -121.3, get_json=get_json, cache_get=cache_get)   # same snapped box
    assert calls == ["48,-125,51,-121"]
    assert out["bbox"] == [-125, 48, -121, 51]
    assert out["features"][0]["id"] == "CYVR"


def test_layer_is_none_for_a_view_too_wide_and_empty_when_upstream_fails():
    assert obs.metar_layer(0, -180, 80, 180, get_json=lambda *a, **k: [], cache_get=lambda k, t, fn: fn()) is None
    def boom(*a, **k):
        raise RuntimeError("down")
    out = obs.metar_layer(48, -125, 50, -122, get_json=boom, cache_get=lambda k, t, fn: fn())
    assert out["features"] == []
