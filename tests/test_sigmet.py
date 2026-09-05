"""Parsers and point lookup in wxgrid.sigmet — no network: AWC is stubbed."""
from datetime import datetime, timedelta, timezone

from wxgrid import ext, sigmet


def _epoch(hours: float) -> int:
    return int((datetime.now(timezone.utc) + timedelta(hours=hours)).timestamp())


BOX = [{"lat": 40.0, "lon": -100.0}, {"lat": 40.0, "lon": -98.0},
       {"lat": 42.0, "lon": -98.0}, {"lat": 42.0, "lon": -100.0}]

AIRSIGMET = [{
    "icaoId": "KKCI", "alphaChar": "C", "seriesId": "12C", "airSigmetType": "SIGMET",
    "hazard": "CONVECTIVE", "severity": 5, "altitudeLow1": None, "altitudeHi1": 45000,
    "movementDir": 270, "movementSpd": 10, "validTimeFrom": _epoch(-1), "validTimeTo": _epoch(1),
    "rawAirSigmet": "CONVECTIVE SIGMET 12C\nAREA TS MOV FROM 27010KT.", "coords": BOX,
}, {                                        # expired: must be dropped
    "icaoId": "KKCI", "seriesId": "OLD", "airSigmetType": "AIRMET", "hazard": "IFR",
    "validTimeFrom": _epoch(-8), "validTimeTo": _epoch(-4), "rawAirSigmet": "old", "coords": BOX,
}]

ISIGMET = [{
    "icaoId": "FAOR", "firId": "FAJA", "firName": "FAJA JOHANNESBURG", "seriesId": "B01",
    "hazard": "TURB", "qualifier": "SEV", "base": 0, "top": 8000, "geom": "AREA",
    "validTimeFrom": _epoch(-1), "validTimeTo": _epoch(2), "dir": None, "spd": None,
    "rawSigmet": "FAJA SIGMET B01 SEV TURB SFC/FL080=",
    "coords": [{"lon": 26.0, "lat": -31.0}, {"lon": 27.0, "lat": -31.0}, {"lon": 27.0, "lat": -30.0}, {"lon": 26.0, "lat": -30.0}],
}, {
    "icaoId": "UHPP", "firId": "UHPP", "hazard": "VA", "qualifier": "KLYUCHEVSKOY", "base": None, "top": 20000,
    "geom": "AREA", "validTimeFrom": _epoch(-1), "validTimeTo": _epoch(3), "rawSigmet": "VA CLD OBS",
    "coords": [{"lon": 160.0, "lat": 56.0}, {"lon": 161.0, "lat": 56.0}, {"lon": 161.0, "lat": 57.0}],
}]

GAIRMET = [{
    "tag": "2E", "forecastHour": 0, "hazard": "IFR", "geometryType": "AREA", "geom": "AREA",
    "severity": None, "frequency": None, "due_to": "CIG BLW 010 VIS BLW 3SM BR FG", "status": "NRML",
    "base": None, "top": None, "fzlbase": None, "fzltop": None, "product": "SIERRA",
    "issueTime": _epoch(-0.5), "expireTime": _epoch(5),
    "coords": [{"lat": "40.5", "lon": "-99.5"}, {"lat": "40.5", "lon": "-98.5"},
               {"lat": "41.5", "lon": "-98.5"}, {"lat": "41.5", "lon": "-99.5"}],
}, {                                        # a later forecast hour of the same product
    "tag": "2F", "forecastHour": 3, "hazard": "IFR", "geom": "AREA", "product": "SIERRA",
    "issueTime": _epoch(-0.5), "expireTime": _epoch(8),
    "coords": [{"lat": "40.5", "lon": "-99.5"}, {"lat": "40.5", "lon": "-98.5"}, {"lat": "41.5", "lon": "-98.5"}],
}, {                                        # freezing level: a line, with fzl altitudes
    "tag": "Z1", "forecastHour": 0, "hazard": "FZLVL", "geom": "LINE", "geometryType": "LINE",
    "product": "ZULU", "base": None, "top": None, "fzlbase": 4000, "fzltop": 4000,
    "issueTime": _epoch(-0.5), "expireTime": _epoch(5),
    "coords": [{"lat": "45.0", "lon": "-120.0"}, {"lat": "45.5", "lon": "-118.0"}],
}]


def _stub(monkeypatch, air=AIRSIGMET, isig=ISIGMET, gair=GAIRMET):
    def fake(url, params=None, timeout=20):
        if url.endswith("/airsigmet"):
            return air
        if url.endswith("/isigmet"):
            return isig
        if url.endswith("/gairmet"):
            return gair
        raise AssertionError(f"unexpected url {url}")
    monkeypatch.setattr(ext, "_get_json", fake)
    ext.cache.clear()


# ── parsers ───────────────────────────────────────────────────────────────

def test_airsigmet_parse_normalises_hazard_altitudes_and_drops_expired():
    feats = sigmet.parse_airsigmet(AIRSIGMET)
    assert len(feats) == 1                                     # the expired AIRMET is gone
    p = feats[0]["properties"]
    assert p["hazard"] == "CONVECTIVE" and p["kind"] == "SIGMET" and p["sev"] == 4
    assert p["base_ft"] is None and p["top_ft"] == 45000
    assert p["color"] == sigmet.HAZARD_COLOR["CONVECTIVE"]
    assert p["movement"] == "270° at 10 kt"
    assert p["source"].startswith("AWC AIRSIGMET")
    assert feats[0]["geometry"]["type"] == "Polygon"
    ring = feats[0]["geometry"]["coordinates"][0]
    assert ring[0] == ring[-1]                                 # closed
    assert ring[0] == [-100.0, 40.0]                           # [lon, lat] order


def test_isigmet_parse_maps_qualifier_to_severity_and_va_to_ash():
    feats = sigmet.parse_isigmet(ISIGMET)
    turb, ash = feats[0]["properties"], feats[1]["properties"]
    assert turb["hazard"] == "TURB" and turb["severity"] == "SEV" and turb["sev"] == 4
    assert turb["base_ft"] == 0 and turb["top_ft"] == 8000
    assert turb["area"] == "FAJA JOHANNESBURG"
    assert ash["hazard"] == "ASH" and ash["hazard_raw"] == "VA"
    assert ash["color"] == sigmet.HAZARD_COLOR["ASH"]
    assert turb["valid_from"].endswith("Z") and turb["valid_to"].endswith("Z")


def test_gairmet_parse_keeps_hour_zero_and_handles_lines_and_fzl_altitudes():
    feats = sigmet.parse_gairmet(GAIRMET)
    assert len(feats) == 2                                     # forecastHour 3 dropped
    ifr, fzl = feats[0], feats[1]
    assert ifr["properties"]["hazard"] == "IFR" and ifr["geometry"]["type"] == "Polygon"
    assert ifr["properties"]["kind"] == "G-AIRMET SIERRA"
    assert fzl["geometry"]["type"] == "LineString"
    assert fzl["properties"]["hazard"] == "OTHER" and fzl["properties"]["hazard_raw"] == "FZLVL"
    assert fzl["properties"]["base_ft"] == 4000 and fzl["properties"]["top_ft"] == 4000


def test_geometry_rejects_degenerate_rings_and_short_lines():
    assert sigmet._geom([{"lat": 1, "lon": 1}, {"lat": 2, "lon": 2}], "AREA") is None
    assert sigmet._geom([{"lat": 1, "lon": 1}], "LINE") is None
    assert sigmet._geom(None, "AREA") is None


def test_hazard_and_severity_vocabulary():
    assert sigmet._hazard("TURB-HI") == "TURB" and sigmet._hazard("MT_OBSC") == "IFR"
    assert sigmet._hazard("VA") == "ASH" and sigmet._hazard("LLWS") == "OTHER"
    assert sigmet._sev("SEV") == 4 and sigmet._sev("EMBD") == 3
    assert sigmet._sev("ISOL") == 1 and sigmet._sev(None) == 2
    # the domestic feed grades with an integer, not a word
    assert sigmet._sev_num(5, "CONVECTIVE") == 4 and sigmet._sev_num(3, "IFR") == 3
    assert sigmet._sev_num(None, "SEV") == 4 and sigmet._sev_num(None, "IFR") == 2


# ── layer + point ─────────────────────────────────────────────────────────

def test_layer_merges_three_feeds_and_counts_by_hazard(monkeypatch):
    _stub(monkeypatch)
    lay = sigmet.sigmet_layer()
    assert lay["type"] == "FeatureCollection"
    assert lay["counts"]["airsigmet"] == 1 and lay["counts"]["isigmet"] == 2 and lay["counts"]["gairmet"] == 2
    assert lay["counts"]["CONVECTIVE"] == 1 and lay["counts"]["ASH"] == 1
    assert len(lay["features"]) == 5
    sevs = [f["properties"]["sev"] for f in lay["features"]]
    assert sevs == sorted(sevs, reverse=True)                  # worst first
    assert lay["colors"]["ICE"] == sigmet.HAZARD_COLOR["ICE"]


def test_layer_survives_one_dead_feed(monkeypatch):
    def fake(url, params=None, timeout=20):
        if url.endswith("/isigmet"):
            raise RuntimeError("502 from AWC")
        return AIRSIGMET if url.endswith("/airsigmet") else GAIRMET
    monkeypatch.setattr(ext, "_get_json", fake)
    ext.cache.clear()
    lay = sigmet.sigmet_layer()
    assert "isigmet" not in lay["counts"] and lay["counts"]["airsigmet"] == 1
    assert len(lay["features"]) == 3


def test_point_returns_overlapping_hazards_with_altitude_bands(monkeypatch):
    _stub(monkeypatch)
    hits = sigmet.sigmet_point(41.0, -99.0)                    # inside both US boxes
    assert [h["hazard"] for h in hits] == ["CONVECTIVE", "IFR"]
    assert hits[0]["top_ft"] == 45000 and hits[0]["base_ft"] is None
    assert hits[0]["valid_to"] and hits[0]["raw"].startswith("CONVECTIVE SIGMET")
    assert hits[1]["kind"] == "G-AIRMET SIERRA"


def test_point_outside_every_polygon_is_empty(monkeypatch):
    _stub(monkeypatch)
    assert sigmet.sigmet_point(10.0, 10.0) == []


def test_point_ignores_line_features(monkeypatch):
    _stub(monkeypatch)
    # The freezing-level line passes near here; a line has no interior, so a
    # point lookup must not claim a hazard from it.
    assert sigmet.sigmet_point(45.2, -119.0) == []
