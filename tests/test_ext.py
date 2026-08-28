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
    from wxgrid import ext_api, liveness
    monkeypatch.setattr(liveness, "ensure_fresh",
                        lambda: {"sources": {}, "sources_down": [], "checked_at": None})
    ext.upstream_health.clear()
    ext._mark("https://api.example.com/x", True)
    ext._mark("https://dead.example.com/y", False, "boom")
    h = ext_api.api_health()
    assert h["down"] == ["dead.example.com"]
    assert h["upstreams"]["api.example.com"]["down"] is False
    # recovery clears it
    ext._mark("https://dead.example.com/y", True)
    assert ext_api.api_health()["down"] == []


def test_storm_category_labels_are_title_case():
    # the label is the TYPE row of the storm card: "Category 1 Hurricane",
    # "Tropical Storm" (Jeff 2026-08-22)
    assert ext.storm_category(70, 30.5, -172.4)["label"] == "Category 1 Hurricane"
    assert ext.storm_category(45, 30.5, -172.4)["label"] == "Tropical Storm"
    assert ext.storm_category(140, 20, 140)["label"] == "Super Typhoon"
    assert ext.storm_category(115, 20, 143)["label"] == "Typhoon"
    for kt, lat, lon in ((30, 10, -40), (50, -15, 150), (70, 15, 88), (100, 20, 130)):
        lab = ext.storm_category(kt, lat, lon)["label"]
        assert lab == " ".join(w if w == "·" else w.capitalize() for w in lab.split()), lab


_JTWC_RSS = """<rss><channel><item><title>Current Northwest Pacific/North Indian Ocean* Tropical Systems</title>
<description><![CDATA[<p><b>Typhoon  17W (Saudel) Warning #18 </b><br>
<b>Issued at 22/2100Z<b>
<ul><li><a href='https://www.metoc.navy.mil/jtwc/products/wp1726web.txt' target='newwin'>TC Warning Text </a></li>
<li><a href='https://www.metoc.navy.mil/jtwc/products/wp1726.kmz' target='newwin'>Google Earth Overlay</a></li></ul>
<p><b>Tropical Depression  19W (Nineteen) Warning #01 </b><br>
<ul><li><a href='https://www.metoc.navy.mil/jtwc/products/wp1926web.txt' target='newwin'>TC Warning Text </a></li></ul>
<a href='https://www.metoc.navy.mil/jtwc/products/abpwweb.txt'>ABPW10</a> ]]></description></item>
<item><title>Current Central/Eastern Pacific Tropical Systems</title>
<description><![CDATA[ <b>Hurricane 01C (Lala)</b> Warning #41 <a href="https://www.metoc.navy.mil/jtwc/products/cp0126web.txt">TC Warning Text</a> ]]></description></item>
<item><title>Current Southern Hemisphere Tropical Systems</title><description><![CDATA[ No Current Tropical Cyclone Warnings. ]]></description></item>
</channel></rss>"""

_JTWC_WARN = """WTPN31 PGTW 222100
SUBJ/TYPHOON 17W (SAUDEL) WARNING NR 018//
   WARNING POSITION:
   221800Z --- NEAR 20.4N 143.6E
     MOVEMENT PAST SIX HOURS - 305 DEGREES AT 15 KTS
   PRESENT WIND DISTRIBUTION:
   MAX SUSTAINED WINDS - 115 KT, GUSTS 140 KT
   REPEAT POSIT: 20.4N 143.6E
   FORECASTS:
   12 HRS, VALID AT:
   230600Z --- 21.8N 141.1E
   MAX SUSTAINED WINDS - 115 KT, GUSTS 140 KT
   24 HRS, VALID AT:
   231800Z --- 23.0N 138.3E
   MAX SUSTAINED WINDS - 125 KT, GUSTS 150 KT
   EXTENDED OUTLOOK:
   120 HRS, VALID AT:
   271800Z --- 33.0S 130.0W
   MAX SUSTAINED WINDS - 45 KT, GUSTS 55 KT
"""


def test_jtwc_active_lists_wpac_and_skips_nhc_basins():
    got = ext._jtwc_active(_JTWC_RSS)
    assert [s["id"] for s in got] == ["17W", "19W"]          # 01C is NHC/CPHC's storm
    assert got[0]["name"] == "Saudel" and got[0]["class"] == "Typhoon"
    assert got[0]["url"].endswith("wp1726web.txt")


def test_jtwc_warning_parses_position_winds_and_track():
    w = ext._parse_jtwc_warning(_JTWC_WARN)
    assert w["lat"] == 20.4 and w["lon"] == 143.6
    assert w["intensity_kt"] == 115 and w["gusts"] == 140
    assert w["movement_dir"] == 305 and w["movement_kt"] == 15
    assert w["updated"].endswith("T18:00:00Z") and w["advisory"] == 18
    assert [p[:2] for p in w["track"]] == [[143.6, 20.4], [141.1, 21.8], [138.3, 23.0], [-130.0, -33.0]]


def test_storms_merges_jtwc_into_nhc_feed(monkeypatch):
    monkeypatch.setattr(ext, "_get_json", lambda *a, **k: {"activeStorms": []})
    monkeypatch.setattr(ext, "_get_text", lambda url, **k: _JTWC_RSS if url.endswith(".rss") else _JTWC_WARN)
    monkeypatch.setattr(ext.cache, "get", lambda key, ttl, fn: fn())
    out = ext.storms()
    cur = [f for f in out["features"] if f["properties"]["kind"] == "current"]
    assert len(cur) == 2 and cur[0]["properties"]["category"] == "TY"
    assert cur[0]["properties"]["agency"] == "JTWC · Pearl Harbor"
    assert cur[0]["properties"]["class"] == "Typhoon" and cur[0]["properties"]["eye"] == "TY"
    track = [f for f in out["features"] if f["properties"].get("layer") == "track" and f["geometry"]["type"] == "LineString"]
    assert track and track[0]["properties"]["id"] == "17W"
    assert [s["id"] for s in out["storms"]] == ["17W", "19W"]


def test_caspian_is_named_even_when_overpass_answers_thin(monkeypatch):
    # 85 nodes and no Caspian is what a hurried Overpass gave us; the seeds
    # cover the landlocked seas regardless
    monkeypatch.setattr(ext, "_water_nodes_fetched", lambda: [{"name": "Black Sea", "lat": 43.5, "lon": 34.0, "kind": "sea"}])
    nodes = ext.water_nodes()
    assert sum(1 for n in nodes if n["name"] == "Black Sea") == 1        # fetched name wins, not doubled
    assert ext.nearest_water(41.5, 50.5, nodes) == "Caspian Sea"
    assert ext.nearest_water(47.5, -87.0, nodes) == "Lake Superior"


_BDECK = """CP, 01, 2026082212,   , BEST,   0, 305N, 1724W,  70,  979, HU,  34, NEQ,  150,  130,  100,  150,
CP, 01, 2026082218,   , BEST,   0, 310N, 1727W,  65,  981, HU,  34, NEQ,  150,  130,  100,  150,
CP, 01, 2026082300,   , BEST,   0, 314N, 1731W,  60,  984, TS,  34, NEQ,  150,  130,  100,  150,
CP, 01, 2026082300,   , BEST,   0, 314N, 1731W,  60,  984, TS,  50, NEQ,   60,   40,   30,   60,
"""

_RAMMB = """<h3>Track History</h3><table>
<tr><td>Synoptic Time</td><td>Latitude</td><td>Longitude</td><td>Intensity</td></tr>
<tr><td>2026-08-23 18:00</td><td>23.2</td><td>137.9</td><td>110</td></tr>
<tr><td>2026-08-23 12:00</td><td>22.6</td><td>139.4</td><td>110</td></tr>
<tr><td>2026-08-22 18:00</td><td>20.4</td><td>143.6</td><td>115</td></tr>
</table>"""


def test_bdeck_parses_one_fix_per_time_oldest_first():
    fixes = ext._parse_bdeck(_BDECK)
    assert [f["kt"] for f in fixes] == [70, 65, 60]           # duplicate radii rows collapse
    assert fixes[0]["lat"] == 30.5 and fixes[0]["lon"] == -172.4
    assert fixes[0]["t"] == "2026-08-22T12:00:00Z"


def test_rammb_history_parses_oldest_first():
    fixes = ext._parse_rammb_history(_RAMMB)
    assert [f["kt"] for f in fixes] == [115, 110, 110]
    assert fixes[0]["lat"] == 20.4 and fixes[0]["lon"] == 143.6
    assert fixes[-1]["t"] == "2026-08-23T18:00:00Z"


def test_storm_history_routes_by_basin(monkeypatch):
    calls = []
    monkeypatch.setattr(ext, "_get_text", lambda url, **k: calls.append(url) or (_BDECK if "nhc" in url else _RAMMB))
    monkeypatch.setattr(ext.cache, "get", lambda key, ttl, fn: fn())
    assert ext.storm_history("cp012026")[0]["kt"] == 70
    assert "ftp.nhc.noaa.gov/atcf/btk/bcp012026.dat" in calls[0]
    assert ext.storm_history("17W", year=2026)[0]["kt"] == 115
    assert "storm_identifier=wp172026" in calls[1]


def test_history_features_line_plus_coloured_points(monkeypatch):
    monkeypatch.setattr(ext, "storm_history", lambda sid, year=None: [
        {"t": "2026-08-22T12:00:00Z", "lat": 30.5, "lon": -172.4, "kt": 70},
        {"t": "2026-08-22T18:00:00Z", "lat": 31.0, "lon": -172.7, "kt": 65},
        {"t": "2026-08-23T00:00:00Z", "lat": 31.4, "lon": -173.1, "kt": 55}])
    feats = ext._history_features("cp012026", "Lala")
    assert feats[0]["geometry"]["type"] == "LineString" and len(feats[0]["geometry"]["coordinates"]) == 3
    pts = [f for f in feats if f["geometry"]["type"] == "Point"]
    assert len(pts) == 3 and pts[0]["properties"]["badge"] == "1" and pts[2]["properties"]["badge"] == "TS"
    assert all(f["properties"]["layer"] == "past" and f["properties"]["id"] == "cp012026" for f in feats)


def test_history_features_need_two_fixes(monkeypatch):
    monkeypatch.setattr(ext, "storm_history", lambda sid, year=None: [{"t": "x", "lat": 1, "lon": 2, "kt": 30}])
    assert ext._history_features("cp012026", "Lala") == []


# Two cycles, three techniques, the radii rows repeated the way a real a-deck
# repeats them: 34/50/64 kt rows for the same forecast hour.
_ADECK = """\
EP, 09, 2026082412, 03, AP01,   0, 200N, 1100W,  35, 1005, XX,  34, NEQ,    0,    0,    0,    0,
EP, 09, 2026082418, 03, AP01,   0, 191N, 1173W,  35, 1005, XX,  34, NEQ,    0,    0,    0,    0,
EP, 09, 2026082418, 03, AP01,   0, 191N, 1173W,  35, 1005, XX,  50, NEQ,    0,    0,    0,    0,
EP, 09, 2026082418, 03, AP01,  12, 206N, 1184W,  38, 1003, XX,  34, NEQ,    0,    0,    0,    0,
EP, 09, 2026082418, 03, AP01, 240, 300N, 1400W,  20, 1010, XX,  34, NEQ,    0,    0,    0,    0,
EP, 09, 2026082418, 03, AEMN,   0, 190N, 1170W,  36, 1004, XX,  34, NEQ,    0,    0,    0,    0,
EP, 09, 2026082418, 03, AEMN,  12, 204N, 1181W,  37, 1003, XX,  34, NEQ,    0,    0,    0,    0,
EP, 09, 2026082418, 03, AVNO,   0, 191N, 1173W,  35, 1005, XX,  34, NEQ,    0,    0,    0,    0,
EP, 09, 2026082418, 03, AP02,  12, 210S, 1190E,  30, 1006, XX,  34, NEQ,    0,    0,    0,    0,
"""


def test_adeck_keeps_the_newest_cycle_and_one_row_per_hour():
    m = ext._parse_adeck_members(_ADECK.encode())
    # AVNO is the deterministic GFS, not a member; AP02 has one hour, so no line
    assert sorted(m) == ["AEMN", "AP01"]
    # the 2026082412 cycle is history, and the repeated 50 kt row collapses
    assert m["AP01"] == [[-117.3, 19.1], [-118.4, 20.6]]
    assert m["AEMN"] == [[-117.0, 19.0], [-118.1, 20.4]]


def test_adeck_drops_forecast_hours_past_the_useful_window():
    m = ext._parse_adeck_members(_ADECK.encode())
    assert all(lon > -140 for lon, _ in m["AP01"])          # the tau 240 row is gone


def test_adeck_reads_gzip_and_hemispheres():
    import gzip as _gz
    m = ext._parse_adeck_members(_gz.compress(_ADECK.encode()))
    assert m["AP01"][0] == [-117.3, 19.1]                    # W is negative
    # a southern/eastern member is signed the other way; it needs two hours to
    # become a line, so check the parser on its own row
    one = ext._parse_adeck_members(
        (_ADECK + "EP, 09, 2026082418, 03, AP02,  24, 215S, 1195E,  30, 1006, XX,  34, NEQ,\n").encode())
    assert one["AP02"] == [[119.0, -21.0], [119.5, -21.5]]


def test_storm_ensemble_ignores_ids_the_public_adeck_does_not_carry():
    assert ext.storm_ensemble("17W") == {}
    assert ext.storm_ensemble("") == {}


def test_ensemble_features_are_one_line_per_member(monkeypatch):
    monkeypatch.setattr(ext, "storm_ensemble", lambda sid: {
        "AEMN": [[-100.0, 20.0], [-101.0, 21.0]],
        "AP01": [[-100.2, 20.1], [-101.4, 21.2]],
        "AP02": [[-100.4, 20.2]],                            # one fix is not a track
    })
    feats = ext._ensemble_features("ep092026", "Iselle")
    assert [f["properties"]["member"] for f in feats] == ["AEMN", "AP01"]
    assert feats[0]["properties"]["mean"] is True and feats[1]["properties"]["mean"] is False
    assert all(f["properties"]["layer"] == "ens" and f["properties"]["id"] == "ep092026" for f in feats)
    assert feats[0]["geometry"]["type"] == "LineString"


def test_ec_alerts_point_asks_geomet_about_one_pixel_and_normalises_it(monkeypatch):
    seen = {}
    payload = {"features": [{"properties": {
        "id": "622294761785688038202608250501", "alert_name_en": "air quality warning",
        "alert_short_name_en": "Air quality", "risk_colour_en": "yellow",
        "validity_datetime": "2026-08-25T10:47:00.000Z", "expiration_datetime": "2026-08-26T02:51:34.559Z",
        "alert_text_en": "Wildfire smoke.\n\n\n\nStay indoors.", "feature_name_en": "Mackenzie Co.",
        "province": "AB", "confidence_en": "High", "impact_en": "Moderate", "display_status": "visible"}}]}

    def fake(url, params=None, timeout=20):
        seen.update({"url": url, **(params or {})})
        return payload
    monkeypatch.setattr(ext, "_get_json", fake)
    ext.cache._d.clear()
    got = ext.ec_alerts_point(58.7, -118.0)
    assert seen["REQUEST"] == "GetFeatureInfo" and seen["QUERY_LAYERS"] == "Current-Alerts"
    assert seen["INFO_FORMAT"] == "application/json" and (seen["I"], seen["J"]) == (1, 1)
    a = got[0]
    assert a["event"] == "Air quality warning" and a["sev"] == 2 and a["source"] == "Environment Canada"
    assert a["area"] == "Mackenzie Co., AB" and a["impact"] == "Moderate"
    # paragraphs survive, the run of blank lines does not
    assert a["description"] == "Wildfire smoke.\n\nStay indoors."


def test_ec_alerts_point_never_leaves_the_process_outside_canada(monkeypatch):
    def boom(*a, **k):
        raise AssertionError("GeoMet asked about a point it does not cover")
    monkeypatch.setattr(ext, "_get_json", boom)
    ext.cache._d.clear()
    assert ext.ec_alerts_point(48.8, 2.3) == []          # Paris


def test_alerts_point_carries_environment_canada(monkeypatch):
    monkeypatch.setattr(ext, "_nws_point", lambda lat, lon: [])
    monkeypatch.setattr(ext, "_ma_warnings", lambda: [])
    monkeypatch.setattr(ext, "_bom_warnings", lambda: [])
    monkeypatch.setattr(ext, "ec_alerts_point", lambda lat, lon: [
        {"id": "x", "event": "Snowfall warning", "severity": "Severe", "sev": 3, "color": "#e8590c",
         "headline": "h", "area": "Vancouver", "onset": None, "ends": None, "sender": "Environment Canada",
         "source": "Environment Canada", "description": "d", "instruction": "", "url": "u"}])
    ext.cache._d.clear()
    assert [a["source"] for a in ext.alerts_point(49.3, -123.1)] == ["Environment Canada"]


def test_alert_detail_reads_meteoalarm_cap_without_touching_the_layer(monkeypatch):
    ring = [[13.0, 47.0], [14.0, 47.0], [14.0, 48.0], [13.0, 48.0], [13.0, 47.0]]
    w = _fake_warning("MeteoAlarm", 3, ring, url="https://feeds.example/cap/a")
    monkeypatch.setattr(ext, "_ma_warnings", lambda: [w])
    monkeypatch.setattr(ext, "_bom_warnings", lambda: [])
    monkeypatch.setattr(ext, "_ma_detail", lambda url: {"sender": "GeoSphere Austria", "description": "Thunderstorms.",
                                                        "instruction": "Take care.", "web": "http://x/en"})
    ext.cache._d.clear()
    d = ext.alert_detail(w["id"], "MeteoAlarm")
    assert d["description"] == "Thunderstorms." and d["sender"] == "GeoSphere Austria" and d["url"] == "http://x/en"
    assert ext.alert_detail("no-such-id", "MeteoAlarm") is None


def test_alert_detail_resolves_an_nws_id_to_its_own_document(monkeypatch):
    seen = {}

    def fake(url, params=None, timeout=20):
        seen["url"] = url
        return {"properties": {"event": "Flood Warning", "severity": "Severe", "urgency": "Expected",
                               "certainty": "Likely", "areaDesc": "Union, NM", "senderName": "NWS Albuquerque NM",
                               "description": "The river is up.", "instruction": "Move to higher ground.",
                               "expires": "2026-08-26T02:00:00+00:00"}}
    monkeypatch.setattr(ext, "_get_json", fake)
    monkeypatch.setattr(ext, "_ma_warnings", lambda: [])
    monkeypatch.setattr(ext, "_bom_warnings", lambda: [])
    ext.cache._d.clear()
    d = ext.alert_detail("urn:oid:2.49.0.1.840.0.abc.001.1", "NWS")
    assert seen["url"].endswith("/alerts/urn:oid:2.49.0.1.840.0.abc.001.1")
    assert d["sev"] == 3 and d["urgency"] == "Expected" and d["description"] == "The river is up."
    # the id resolves to raw CAP JSON, which is not a page to send a reader to
    assert d["url"] is None


# ── tides ──────────────────────────────────────────────────────────────

def _noaa_station_list():
    return {"stations": [{"id": "9447130", "name": "SEATTLE (Madison St.), Elliott Bay", "lat": 47.6026, "lng": -122.3393}]}


def test_a_failed_tide_prediction_is_not_remembered_as_no_station(monkeypatch):
    # Seattle 404'd for an hour on 2026-08-26 after ONE CO-OPS timeout: the
    # None from the failed prediction fetch was cached like a real answer.
    calls = {"pred": 0}

    def fake_get(url, params=None, timeout=20):
        if url.endswith("stations.json"):
            return _noaa_station_list()
        if "api-iwls" in url:
            return []
        calls["pred"] += 1
        if calls["pred"] == 1:
            raise TimeoutError("read timed out")
        return {"predictions": [{"t": "2026-08-27 01:00", "v": "3.1", "type": "H"}]}

    monkeypatch.setattr(ext, "_get_json", fake_get)
    ext.cache._d.clear()
    assert ext.tides(47.6, -122.34) is None
    assert ext.tides(47.6, -122.34)["station"].startswith("SEATTLE")
    assert calls["pred"] == 2


def test_a_failed_station_list_is_not_cached_for_a_week(monkeypatch):
    calls = {"list": 0}

    def fake_get(url, params=None, timeout=20):
        if url.endswith("stations.json"):
            calls["list"] += 1
            if calls["list"] == 1:
                raise ConnectionError("down")
            return _noaa_station_list()
        if "api-iwls" in url:
            return []
        return {"predictions": []}

    monkeypatch.setattr(ext, "_get_json", fake_get)
    ext.cache._d.clear()
    assert ext._noaa_stations() == []
    assert len(ext._noaa_stations()) == 1
    assert calls["list"] == 2


def test_tide_window_starts_before_now_so_the_curve_has_a_left_anchor(monkeypatch):
    seen = {}

    def fake_get(url, params=None, timeout=20):
        if url.endswith("stations.json"):
            return _noaa_station_list()
        if "api-iwls" in url:
            return []
        seen.update(params)
        return {"predictions": []}

    monkeypatch.setattr(ext, "_get_json", fake_get)
    ext.cache._d.clear()
    ext.tides(47.6, -122.34)
    from datetime import datetime, timezone
    begin = datetime.strptime(seen["begin_date"], "%Y%m%d %H:%M").replace(tzinfo=timezone.utc)
    assert (datetime.now(timezone.utc) - begin).total_seconds() > 6 * 3600
    assert int(seen["range"]) >= 60



def test_a_small_sea_does_not_claim_the_open_ocean_from_750_km_out():
    nodes = [{"name": "Salish Sea", "lat": 48.5, "lon": -123.0, "kind": "sea"},
             {"name": "Gulf of Alaska", "lat": 56.0, "lon": -145.0, "kind": "sea"}]
    assert ext.nearest_water(44.01, -130.21, nodes) == "North Pacific Ocean"   # was "Salish Sea"
    assert ext.nearest_water(48.6, -123.2, nodes) == "Salish Sea"
    assert ext.nearest_water(52.0, -150.0, nodes) == "Gulf of Alaska"           # a big gulf reaches
    assert ext.sea_reach_km("Some Bay Nobody Listed") == ext._SEA_REACH_DEFAULT_KM



def test_storm_tracks_stay_continuous_across_the_dateline():
    pts = [[-179.0, 37.0], [-179.8, 37.5], [179.9, 38.0], [179.2, 38.4], [-179.6, 39.0]]
    out = ext._unwrap_lons(pts)
    assert out == [[-179.0, 37.0], [-179.8, 37.5], [-180.1, 38.0], [-180.8, 38.4], [-179.6, 39.0]]
    assert all(abs(b[0] - a[0]) < 180 for a, b in zip(out, out[1:]))
