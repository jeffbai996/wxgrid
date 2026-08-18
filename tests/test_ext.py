"""Parsers and geometry in wxgrid.ext — no network: upstream calls are stubbed."""
import numpy as np

from wxgrid import ext


def test_point_in_multipolygon_and_haversine():
    ring = [[-123, 49], [-122, 49], [-122, 50], [-123, 50], [-123, 49]]
    assert ext._in_geom(-122.5, 49.5, {"type": "Polygon", "coordinates": [ring]})
    assert not ext._in_geom(-121.5, 49.5, {"type": "MultiPolygon", "coordinates": [[ring]]})
    assert abs(ext._haversine_km(49.28, -123.12, 49.28, -122.12) - 72.7) < 1.5


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
