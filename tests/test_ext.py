"""Parsers and geometry in wxgrid.ext — no network: upstream calls are stubbed."""
import numpy as np

from wxgrid import ext


def test_point_in_multipolygon_and_haversine():
    ring = [[-123, 49], [-122, 49], [-122, 50], [-123, 50], [-123, 49]]
    assert ext._in_geom(-122.5, 49.5, {"type": "Polygon", "coordinates": [ring]})
    assert not ext._in_geom(-121.5, 49.5, {"type": "MultiPolygon", "coordinates": [[ring]]})
    assert abs(ext._haversine_km(49.28, -123.12, 49.28, -122.12) - 72.7) < 1.5


def test_geocoding_requests_english_names(monkeypatch):
    calls = []

    def fake_get(url, params=None, timeout=20):
        calls.append((url, params))
        if url.endswith("/search"):
            return [{"name": "Al Aflaj", "display_name": "Al Aflaj, Riyadh Region, Saudi Arabia",
                     "lat": "22.282", "lon": "46.683", "type": "administrative",
                     "address": {"country_code": "sa"}}]
        return {"address": {"county": "Al Aflaj", "state": "Riyadh Region", "country_code": "sa"},
                "display_name": "Al Aflaj, Riyadh Region, Saudi Arabia"}

    monkeypatch.setattr(ext, "_get_json", fake_get)
    monkeypatch.setattr(ext.time, "sleep", lambda _: None)
    ext.cache._d.clear()
    assert ext.geocode("Al Aflaj", 1)[0]["name"] == "Al Aflaj"
    assert ext.reverse(22.282, 46.683)["name"] == "Al Aflaj"
    assert len(calls) == 2
    assert all(params["accept-language"] == "en" for _, params in calls)


def test_bc_electoral_area_uses_regional_district_name():
    assert ext._reverse_place_name({
        "city": "Area C (Pemberton Valley/Mount Currie/D'Arcy)",
        "county": "Squamish-Lillooet Regional District",
        "state": "British Columbia",
    }) == "Squamish-Lillooet Regional District"
    assert ext._reverse_place_name({
        "municipality": "Electoral Area A",
        "county": "Regional District of Okanagan-Similkameen",
        "state": "British Columbia",
    }) == "Okanagan-Similkameen Regional District"
    assert ext._reverse_place_name({
        "city": "Kelowna", "municipality": "Central Okanagan",
        "county": "Regional District of Central Okanagan", "state": "British Columbia",
    }) == "Kelowna"


def test_reverse_prefers_containing_water_over_distant_admin_boundary(monkeypatch):
    monkeypatch.setattr(ext, "_nominatim", lambda *a, **k: {
        "name": "Bainbridge Island", "category": "boundary", "type": "administrative",
        "address": {"town": "Bainbridge Island", "county": "Kitsap County",
                    "state": "Washington", "country": "United States"},
    })
    monkeypatch.setattr(ext, "elevation", lambda *a: 0.0)
    monkeypatch.setattr(ext, "nearby_named_water", lambda *a: "Puget Sound")
    ext.cache._d.clear()
    assert ext.reverse(47.7, -122.45) == {
        "name": "Puget Sound", "region": "", "country": "", "display": "", "water": True,
    }


def test_reverse_keeps_land_when_no_water_area_contains_point(monkeypatch):
    monkeypatch.setattr(ext, "_nominatim", lambda *a, **k: {
        "name": "Lowland", "category": "boundary",
        "address": {"town": "Lowland", "state": "Washington", "country": "United States"},
    })
    monkeypatch.setattr(ext, "elevation", lambda *a: 0.0)
    monkeypatch.setattr(ext, "nearby_named_water", lambda *a: "")
    ext.cache._d.clear()
    assert ext.reverse(47.0, -122.0)["name"] == "Lowland"


def test_reverse_does_not_name_the_ocean_when_the_geocoder_is_down(monkeypatch):
    """A 429 or a timeout is not "no address"; it must not become a sea name
    that then sits in the cache for a day."""
    import requests
    def boom(*a, **k):
        raise requests.ConnectionError("rate limited")
    monkeypatch.setattr(ext, "_nominatim", boom)
    monkeypatch.setattr(ext, "nearest_water", lambda *a: "North Pacific Ocean")
    monkeypatch.setattr(ext, "water_nodes", lambda: [])
    ext.cache._d.clear()
    r = ext.reverse(50.116, -122.957)
    assert r["name"] == "" and not r.get("water")
    assert not any(k.startswith("rgeo") for k in ext.cache._d)
    # and the next call asks again instead of replaying the failure
    monkeypatch.setattr(ext, "_nominatim", lambda *a, **k: {
        "name": "Whistler", "category": "place", "type": "town",
        "address": {"town": "Whistler", "state": "British Columbia", "country": "Canada"}})
    assert ext.reverse(50.116, -122.957)["name"] == "Whistler"


def test_nearest_metar_picks_closest_station(monkeypatch):
    fake = [{"icaoId": "CYVR", "lat": 49.19, "lon": -123.18, "temp": 17.0, "rawOb": "METAR CYVR", "reportTime": "t"},
            {"icaoId": "CWWA", "lat": 49.347, "lon": -123.193, "temp": 17.4, "rawOb": "METAR CWWA", "reportTime": "t"}]
    monkeypatch.setattr(ext, "_get_json", lambda *a, **k: fake)
    ext.cache._d.clear()
    o = ext.nearest_metar(49.34, -123.19)
    assert o["station"] == "CWWA" and o["distance_km"] < 2


def test_avalanche_ca_point_shape(monkeypatch):
    class R:
        status_code = 200
        text = "{}"
        def json(self):
            return {"url": "u", "report": {"title": "Sea to Sky", "dateIssued": "2026-01-01T00:00:00Z", "validUntil": "2026-01-02T00:00:00Z",
                    "confidence": {"rating": {"display": "Moderate"}}, "highlights": "<p>Wind slabs.</p>",
                    "dangerRatings": [{"date": {"value": "2026-01-01", "display": "Thursday"}, "ratings": {
                        "alp": {"rating": {"value": "considerable", "display": "Considerable"}},
                        "tln": {"rating": {"value": "moderate", "display": "Moderate"}},
                        "btl": {"rating": {"value": "low", "display": "Low"}}}}],
                    "problems": [{"type": {"display": "Wind Slab"}, "likelihood": {"display": "Likely"}, "expectedSize": {"min": "1"},
                                  "data": {"elevations": [{"display": "Alp"}], "aspects": [{"display": "N"}]}, "comment": "<b>x</b>"}],
                    "summaries": []}}
    monkeypatch.setattr(ext._session, "get", lambda *a, **k: R())
    ext.cache._d.clear()
    p = ext.avy_point(50.1, -122.9)
    assert p["source"] == "avalanche.ca" and p["days"][0]["alp"]["level"] == 3 and p["days"][0]["btl"]["level"] == 1
    assert p["problems"][0]["type"] == "Wind Slab" and p["highlights"] == "Wind slabs."
    assert p["off_season"] is False


def test_nws_alerts_layer_keeps_only_geometry_and_colours_by_severity(monkeypatch):
    j = {"features": [
        {"geometry": {"type": "Polygon", "coordinates": [[[-100, 40], [-99, 40], [-99, 41], [-100, 40]]]}, "properties": {"id": "a", "event": "Flood Warning", "severity": "Severe", "areaDesc": "X"}},
        {"geometry": None, "properties": {"id": "b", "event": "Heat Advisory", "severity": "Minor"}}]}
    monkeypatch.setattr(ext, "_get_json", lambda *a, **k: j)
    ext.cache._d.clear()
    lay = ext.nws_alerts_layer()
    assert len(lay["features"]) == 1 and lay["features"][0]["properties"]["sev"] == 3


def test_kmz_features_parses_kml_placemarks(monkeypatch, tmp_path):
    import io, zipfile
    kml = """<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>
      <Placemark><name>Cone</name><Polygon><outerBoundaryIs><LinearRing><coordinates>-160,20,0 -161,21,0 -159,21,0 -160,20,0</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
      <Placemark><name>Track</name><LineString><coordinates>-160,20,0 -161,21,0</coordinates></LineString></Placemark>
      <Placemark><name>12h</name><Point><coordinates>-161,21,0</coordinates></Point></Placemark></Document></kml>"""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("doc.kml", kml)
    class R:
        content = buf.getvalue()
        def raise_for_status(self): pass
    monkeypatch.setattr(ext._session, "get", lambda *a, **k: R())
    feats = ext._kmz_features("http://x/cone.kmz")
    kinds = sorted(f["geometry"]["type"] for f in feats)
    assert kinds == ["LineString", "Point", "Polygon"]
    assert feats[0]["geometry"]["coordinates"][0][0] == [-160.0, 20.0]


# ── MeteoAlarm (Europe) ───────────────────────────────────────────────────

MA_ATOM_FIXTURE = """<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:cap="urn:oasis:names:tc:emergency:cap:1.2">
  <id>tag:meteoalarm.org,2021-02-19:XX</id>
  <title>MeteoAlarm - Alerting Europe for Extreme Weather</title>
  <entry>
    <cap:geocode><valueName>EMMA_ID</valueName><value>AT503</value></cap:geocode>
    <cap:areaDesc>Salzburg-Umgebung</cap:areaDesc>
    <cap:event>Thunderstormwarning</cap:event>
    <cap:sent>2099-01-01T10:00:00+00:00</cap:sent>
    <cap:onset>2099-01-01T10:00:00+00:00</cap:onset>
    <cap:expires>2099-01-01T18:00:00+00:00</cap:expires>
    <cap:severity>Moderate</cap:severity>
    <cap:message_type>Alert</cap:message_type>
    <cap:status>Actual</cap:status>
    <cap:identifier>ID-A</cap:identifier>
    <link type="application/cap+xml" href="https://feeds.example/cap/a"/>
    <title>Yellow Thunderstorm Warning issued for Austria - Salzburg-Umgebung</title>
  </entry>
  <entry>
    <cap:polygon>49.0,-2.0 49.0,-1.0 50.0,-1.0 50.0,-2.0 49.0,-2.0</cap:polygon>
    <cap:areaDesc>Skomvaer - Andenes</cap:areaDesc>
    <cap:event>Gale</cap:event>
    <cap:sent>2099-01-01T09:00:00+00:00</cap:sent>
    <cap:onset>2099-01-01T09:00:00+00:00</cap:onset>
    <cap:expires>2099-01-02T03:00:00+00:00</cap:expires>
    <cap:severity>Moderate</cap:severity>
    <cap:message_type>Update</cap:message_type>
    <cap:status>Actual</cap:status>
    <cap:identifier>ID-B</cap:identifier>
    <link type="application/cap+xml" href="https://feeds.example/cap/b"/>
    <title>Orange Wind Warning issued for Norway - Skomvaer - Andenes</title>
  </entry>
  <entry>
    <cap:geocode><valueName>EMMA_ID</valueName><value>AT100</value></cap:geocode>
    <cap:areaDesc>Wien</cap:areaDesc>
    <cap:event>Hitzewarnung</cap:event>
    <cap:sent>2020-06-01T00:00:00+00:00</cap:sent>
    <cap:expires>2020-06-01T12:00:00+00:00</cap:expires>
    <cap:severity>Severe</cap:severity>
    <cap:message_type>Alert</cap:message_type>
    <cap:status>Actual</cap:status>
    <cap:identifier>ID-C</cap:identifier>
    <title>Orange High-temperature Warning issued for Austria - Wien</title>
  </entry>
</feed>"""


def test_meteoalarm_atom_drops_expired_and_maps_awareness_colour_and_type():
    got = {w["event"]: w for w in ext._ma_parse(MA_ATOM_FIXTURE)}
    assert set(got) == {"thunderstorm", "wind"}          # the 2020 heat warning has expired
    assert got["thunderstorm"]["sev"] == 2 and got["thunderstorm"]["severity"] == "Moderate"
    assert got["thunderstorm"]["color"] == ext._SEV_COLOR[2]
    assert got["thunderstorm"]["geometry"] is None and got["thunderstorm"]["code"] == "AT503"
    assert got["thunderstorm"]["area"] == "Salzburg-Umgebung, Austria"
    assert got["wind"]["sev"] == 3                        # orange outranks the CAP "Moderate"
    # CAP polygons are lat,lon; GeoJSON is lon,lat
    assert got["wind"]["geometry"]["coordinates"][0][0] == [-2.0, 49.0]
    assert got["wind"]["source"] == "MeteoAlarm" and got["wind"]["url"].endswith("/cap/b")


def test_meteoalarm_keeps_only_newest_update_per_area_and_event():
    """The feed is a rolling archive: a re-warned region appears once per
    update, and the map wants the latest, not five stacked polygons."""
    first = MA_ATOM_FIXTURE[MA_ATOM_FIXTURE.index("<entry>"):MA_ATOM_FIXTURE.index("</entry>") + 8]
    newer = first.replace("2099-01-01T10:00:00", "2099-01-01T11:30:00").replace("ID-A", "ID-A2")
    got = [w for w in ext._ma_parse(MA_ATOM_FIXTURE.replace("</feed>", newer + "</feed>"))
           if w["event"] == "thunderstorm"]
    assert len(got) == 1 and got[0]["id"] == "ID-A2:AT503"


def test_meteoalarm_warnings_fill_geometry_from_emma_regions(monkeypatch):
    square = {"type": "Polygon", "coordinates": [[[13.0, 47.0], [14.0, 47.0], [14.0, 48.0], [13.0, 48.0], [13.0, 47.0]]]}
    class R:
        text = MA_ATOM_FIXTURE
        def raise_for_status(self): pass
    monkeypatch.setattr(ext._session, "get", lambda *a, **k: R())
    monkeypatch.setattr(ext, "MA_COUNTRIES", ("austria",))
    monkeypatch.setattr(ext, "_emma_regions", lambda: {"AT503": square})
    ext.cache._d.clear()
    ws = {w["event"]: w for w in ext._ma_warnings()}
    assert ws["thunderstorm"]["geometry"] == square
    assert ws["wind"]["sev"] == 3 and "_sent" not in ws["wind"]


def test_meteoalarm_detail_prefers_the_english_cap_info(monkeypatch):
    cap = """<?xml version="1.0"?><alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
      <identifier>ID-A</identifier>
      <info><language>de-DE</language><senderName>GeoSphere Austria</senderName>
        <description>Gewitter</description><instruction>Vorsicht</instruction><web>http://x/de</web></info>
      <info><language>en-GB</language><senderName>GeoSphere Austria</senderName>
        <description>Thunderstorms are possible.</description><instruction>Take care.</instruction><web>http://x/en</web></info>
    </alert>"""
    class R:
        text = cap
        def raise_for_status(self): pass
    monkeypatch.setattr(ext._session, "get", lambda *a, **k: R())
    ext.cache._d.clear()
    d = ext._ma_detail("https://feeds.example/cap/a")
    assert d["sender"] == "GeoSphere Austria" and d["description"].startswith("Thunderstorms")
    assert d["instruction"] == "Take care." and d["web"] == "http://x/en"


# ── BoM (Australia) ───────────────────────────────────────────────────────

BOM_CAP_FIXTURE = """<?xml version="1.0" encoding="UTF-8"?>
<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
    <identifier>AusBoM-IDV21037-2099-01-01T00:00:00+00:00</identifier>
    <sender>CAP.Message@bom.gov.au</sender>
    <status>Actual</status>
    <msgType>Update</msgType>
    <info>
        <language>en-AU</language>
        <event>Weather</event>
        <severity>Unknown</severity>
        <effective>2099-01-01T00:00:00+00:00</effective>
        <expires>2099-01-02T00:00:00+00:00</expires>
        <senderName>Australian Government Bureau of Meteorology</senderName>
        <headline>Severe Weather Warning for North Central forecast district</headline>
        <description>DAMAGING WINDS averaging 60 to 70 km/h.</description>
        <instruction>Avoid travel if possible.</instruction>
        <web>http://www.bom.gov.au/vic/warnings/</web>
        <area>
            <areaDesc>Victoria: North Central</areaDesc>
            <geocode><valueName>AMOC-AreaCode</valueName><value>VIC_PW008</value></geocode>
            <geocode><valueName>AMOC-AreaCode</valueName><value>VIC_PW999</value></geocode>
        </area>
    </info>
</alert>"""


def test_bom_cap_parse_uses_district_geometry_and_infers_severity():
    ring = [[144.0, -38.0], [145.0, -38.0], [145.0, -37.0], [144.0, -37.0], [144.0, -38.0]]
    w = ext._bom_parse(BOM_CAP_FIXTURE, {"VIC_PW008": {"type": "Polygon", "coordinates": [ring]}})
    assert w["source"] == "BoM" and w["sev"] == 3 and w["severity"] == "Severe"   # CAP said "Unknown"
    assert w["event"] == "Severe Weather Warning" and w["area"] == "Victoria: North Central"
    assert w["geometry"]["type"] == "Polygon" and w["geometry"]["coordinates"][0][0] == [144.0, -38.0]
    assert w["instruction"] == "Avoid travel if possible." and w["sender"].endswith("Bureau of Meteorology")


def test_bom_cap_parse_skips_expired_and_cancelled():
    assert ext._bom_parse(BOM_CAP_FIXTURE.replace("<msgType>Update</msgType>", "<msgType>Cancel</msgType>"), {}) is None
    assert ext._bom_parse(BOM_CAP_FIXTURE.replace("2099-01-02T00:00:00", "2020-01-02T00:00:00"), {}) is None
    # an unknown district just means no shape, not a dropped warning
    assert ext._bom_parse(BOM_CAP_FIXTURE, {})["geometry"] is None


def _shapefile_zip(code: str, ring: list) -> bytes:
    """Minimal ESRI shapefile zip (one polygon + a one-column dBASE table)."""
    import io, struct, zipfile
    n = len(ring)
    body = struct.pack("<i", 5) + struct.pack("<4d", min(x for x, _ in ring), min(y for _, y in ring),
                                              max(x for x, _ in ring), max(y for _, y in ring))
    body += struct.pack("<ii", 1, n) + struct.pack("<i", 0)
    for x, y in ring:
        body += struct.pack("<2d", x, y)
    shp = b"\x00" * 100 + struct.pack(">II", 1, len(body) // 2) + body
    hdr = bytearray(32)
    hdr[0] = 0x03
    struct.pack_into("<I", hdr, 4, 1)          # one record
    struct.pack_into("<HH", hdr, 8, 65, 13)    # header length, record length
    field = b"AAC".ljust(11, b"\0") + b"C" + b"\0" * 4 + bytes([12, 0]) + b"\0" * 14
    dbf = bytes(hdr) + field + b"\x0d" + b" " + code.encode().ljust(12)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("IDM00001.shp", shp)
        z.writestr("IDM00001.dbf", dbf)
    return buf.getvalue()


def test_shp_regions_reads_shapefile_with_stdlib_only():
    ring = [[144.0, -38.0], [145.0, -38.0], [145.0, -37.0], [144.0, -37.0], [144.0, -38.0]]
    regions = ext._shp_regions(_shapefile_zip("VIC_PW008", ring))
    assert list(regions) == ["VIC_PW008"]
    assert regions["VIC_PW008"] == {"type": "Polygon", "coordinates": [ring]}


# ── merged alerts ─────────────────────────────────────────────────────────

def _fake_warning(source, sev, ring, **kw):
    w = {"id": f"{source}-1", "event": "wind", "severity": "Moderate", "sev": sev, "color": ext._SEV_COLOR[sev],
         "headline": "h", "area": "a", "onset": None, "ends": None, "sender": None, "source": source,
         "description": "d", "instruction": "i", "url": "u",
         "geometry": {"type": "Polygon", "coordinates": [ring]}}
    w.update(kw)
    return w


def test_alerts_layer_merges_all_three_sources_and_survives_a_dead_one(monkeypatch):
    ring = [[13.0, 47.0], [14.0, 47.0], [14.0, 48.0], [13.0, 48.0], [13.0, 47.0]]
    monkeypatch.setattr(ext, "nws_alerts_layer", lambda: {"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": {}, "properties": {"source": "NWS"}}]})
    monkeypatch.setattr(ext, "_ma_warnings", lambda: [_fake_warning("MeteoAlarm", 3, ring)])
    def boom():
        raise RuntimeError("bom is down")
    monkeypatch.setattr(ext, "_bom_warnings", boom)
    lay = ext.alerts_layer()
    assert [f["properties"]["source"] for f in lay["features"]] == ["NWS", "MeteoAlarm"]
    assert "description" not in lay["features"][1]["properties"]   # layer stays lean


def test_alerts_point_adds_hits_from_meteoalarm_and_bom(monkeypatch):
    eu = [[13.0, 47.0], [14.0, 47.0], [14.0, 48.0], [13.0, 48.0], [13.0, 47.0]]
    au = [[144.0, -38.0], [145.0, -38.0], [145.0, -37.0], [144.0, -37.0], [144.0, -38.0]]
    monkeypatch.setattr(ext, "_nws_point", lambda lat, lon: [])
    monkeypatch.setattr(ext, "_ma_warnings", lambda: [_fake_warning("MeteoAlarm", 2, eu, url="https://feeds.example/cap/a")])
    monkeypatch.setattr(ext, "_bom_warnings", lambda: [_fake_warning("BoM", 4, au)])
    monkeypatch.setattr(ext, "_ma_detail", lambda url: {"sender": "GeoSphere Austria", "description": "Thunderstorms.",
                                                       "instruction": "Take care.", "web": "http://x/en"})
    ext.cache._d.clear()
    inside_eu = ext.alerts_point(47.5, 13.5)
    assert [a["source"] for a in inside_eu] == ["MeteoAlarm"]
    assert inside_eu[0]["sender"] == "GeoSphere Austria" and inside_eu[0]["url"] == "http://x/en"
    ext.cache._d.clear()
    assert [a["source"] for a in ext.alerts_point(-37.5, 144.5)] == ["BoM"]
    ext.cache._d.clear()
    assert ext.alerts_point(0.0, 0.0) == []


def test_open_water_gets_a_name_from_the_seas_then_the_oceans():
    nodes = [{"name": "South China Sea", "lat": 15.0, "lon": 114.0, "kind": "sea"}]
    # a named sea wins when it is close
    assert ext.nearest_water(15.0, 115.0, nodes) == "South China Sea"
    # far from any of them, the ocean answers rather than nothing
    assert ext.nearest_water(35.0, -150.0, nodes) == "North Pacific Ocean"
    assert ext.nearest_water(-40.0, -30.0, []) == "South Atlantic Ocean"
    assert ext.nearest_water(-70.0, 100.0, []) == "Southern Ocean"
    # longitudes arrive wrapped past the antimeridian from the map
    assert ext.ocean_name(35.0, 210.0) == "North Pacific Ocean"


def test_place_names_prefer_a_latin_script():
    # an English exonym wins over the local script
    assert ext._latin_first("Moscow", "Москва") == "Moscow"
    assert ext._latin_first(None, "Tehran") == "Tehran"
    # accented Latin is still Latin
    assert ext._latin_first("Zürich") == "Zürich"
    assert ext._latin_first("Genève", "Geneva") == "Genève"
    # OSM has no English tag for many Siberian districts: transliterate the
    # supplied name instead of putting Cyrillic back into the card.
    assert ext._latin_first("Тындинский муниципальный округ") == "Tyndinskiy munitsipalnyy okrug"
    assert ext._latin_first("Амурская область") == "Amurskaya oblast"
    assert ext._latin_first("Өлөксөй") == "Oloksoy"
    # Scripts without a deterministic fallback stay truthful rather than being
    # guessed or dropped.
    assert ext._latin_first("北京") == "北京"
    assert ext._latin_first(None, "") == ""


def test_health_marks_a_failing_upstream_down(monkeypatch):
    import time as _t
    ext.upstream_health.clear()
    ext._mark("https://api.example.com/x", True)
    ext._mark("https://dead.example.com/y", False, "boom")
    from wxgrid.ext_api import api_health
    h = api_health()
    assert h["down"] == ["dead.example.com"]
    assert h["upstreams"]["api.example.com"]["down"] is False
    # recovery clears it
    ext._mark("https://dead.example.com/y", True)
    assert api_health()["down"] == []
