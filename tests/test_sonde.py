"""Parsers, station maths and thermodynamics in wxgrid.sonde — no network:
every upstream call is stubbed. The two live sources have very different
failure modes (IEM answers 200 with an empty list, Wyoming answers 404 with a
sentence), so both are exercised, and so is the case where the socket simply
falls over."""
import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from wxgrid import ext, sonde, sonde_api

# ── fixtures: the exact shapes the two upstreams really emit ─────────────

# Column layout copied byte-for-byte from a live TEXT:LIST page, including the
# ragged tail rows where the instrument lost wind and humidity: those columns
# go blank rather than shifting, which is why the parser slices and never
# splits.
UWYO_PAGE = """<HTML><BODY>
<H1>Observations for Station 47646 at 12 UTC 18 Aug 2026</H1>
<H3>TATENO, JAPAN</H3>
<PRE>
-----------------------------------------------------------------------------
   PRES   HGHT   TEMP   DWPT   RELH   MIXR   DRCT   SPED   THTA   THTE   THTV
    hPa      m      C      C      %   g/kg    deg    m/s      K      K      K
-----------------------------------------------------------------------------
 1015.0     31   25.6   21.7     79  16.30    120    1.0  297.5  344.9  300.4
 1000.0    167   24.4   21.0     81  15.90    135    2.0  297.6  344.1  300.4
  850.0   1530   16.0   12.0     77  10.10    200    7.5  301.0  330.2  302.8
  700.0   3130    5.0   -2.0     60   4.20    240   12.5  305.5  318.4  306.3
  500.0   5840  -10.5  -20.5     45   1.30    260   20.0  318.0  322.5  318.2
   69.0  19048  -64.5                          50    9.8  447.9
   62.5  19656  -61.9                                     466.5
</PRE>
<H3>Sounding Indices</H3>
<TABLE>
<TR><TD>SLAT</TD><TD>Station Latitude</TD><TD style="text-align: right;">36.06</TD><TD>degrees_north</TD></TR>
<TR><TD>SLON</TD><TD>Station Longitude</TD><TD style="text-align: right;">140.13</TD><TD>degrees_east</TD></TR>
<TR><TD>SELV</TD><TD>Station Elevation</TD><TD style="text-align: right;">25.2</TD><TD>meter</TD></TR>
<TR><TD>PWAT</TD><TD>Precipitable Water</TD><TD style="text-align: right;">44.6</TD><TD>millimeter</TD></TR>
</TABLE>
</BODY></HTML>"""

UWYO_MISSING = "Unable to retrieve the data for 03953 at 2026-08-18 13:00:00.\n"

IEM_PAGE = {"profiles": [{"station": "KUIL", "valid": "2026-08-18T12:00:00Z", "profile": [
    {"pres": 1013.0, "hght": 62.0, "tmpc": 12.4, "dwpc": 12.3, "drct": 200.0, "sknt": 10.0},
    {"pres": 1000.0, "hght": 167.0, "tmpc": 11.8, "dwpc": 11.8, "drct": 185.0, "sknt": 5.0},
    {"pres": None, "hght": 200.0, "tmpc": 11.0, "dwpc": 11.0, "drct": None, "sknt": None},
    {"pres": 850.0, "hght": 1450.0, "tmpc": 4.0, "dwpc": 1.0, "drct": None, "sknt": None},
    {"pres": 500.0, "hght": 5600.0, "tmpc": -18.0, "dwpc": -30.0, "drct": 270.0, "sknt": 40.0}]}]}

# IGRA v2's station list is fixed-width; every line is exactly 88 characters.
IGRA_TEXT = "\n".join([
    "USM00072797  47.9339 -124.5602   56.8    QUILLAYUTE; WA.                1966 2026  71443",
    "JAM00047646  36.0581  140.1258   25.2    TATENO                         1957 2026  74310",
    "ACM00078861  17.1170  -61.7830   10.0    COOLIDGE FIELD (UA)            1947 1993  13896",
    "AEXUAE05467  25.2500   55.3700    4.0    SHARJAH                        1935 2026   2477",
    "GMM00010393  52.2085   14.1180   97.7    LINDENBERG                     1950 2026  99999",
])

IEM_NETWORK_JSON = {"features": [
    {"id": "KUIL", "geometry": {"type": "Point", "coordinates": [-124.55, 47.95]},
     "properties": {"sname": "Quillayute", "elevation": 56.0, "country": "US", "archive_end": None}},
    {"id": "_ABR", "geometry": {"type": "Point", "coordinates": [-98.4, 45.4]},
     "properties": {"sname": "Aberdeen Area -- KHON KABR", "elevation": 385.0, "country": "US", "archive_end": None}},
    {"id": "KCHH", "geometry": {"type": "Point", "coordinates": [-70.0, 41.6]},
     "properties": {"sname": "Chatham", "elevation": 9.0, "country": "US", "archive_end": "2021-03-31"}},
    {"id": "CWMJ", "geometry": {"type": "Point", "coordinates": [-75.9, 46.38]},
     "properties": {"sname": "MANIWAKI", "elevation": 170.0, "country": "CA", "archive_end": None}},
]}


class _Resp:
    def __init__(self, status=200, text="", payload=None):
        self.status_code, self.text, self._payload = status, text, payload

    def json(self):
        return self._payload if self._payload is not None else json.loads(self.text)

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


@pytest.fixture(autouse=True)
def _clean_cache():
    ext.cache.clear()
    yield
    ext.cache.clear()


# ── Wyoming parser ───────────────────────────────────────────────────────

def test_uwyo_parser_reads_levels_metadata_and_source_indices():
    got = sonde._parse_uwyo(UWYO_PAGE)
    assert got["source"] == "uwyo"
    assert got["time"] == "2026-08-18T12:00:00Z"
    assert got["station_name"] == "Tateno, Japan"
    assert got["station_lat"] == 36.06 and got["station_elev_m"] == 25.2
    assert got["source_indices"]["PWAT"] == 44.6
    assert "SLAT" not in got["source_indices"]        # position is metadata, not an index
    assert len(got["levels"]) == 7
    assert got["levels"][0] == {"p": 1015.0, "z": 31, "t": 25.6, "td": 21.7, "wdir": 120, "wspd": 1.0}


def test_uwyo_parser_slices_ragged_rows_instead_of_splitting():
    """The two tail levels have no humidity, and the last has no wind either.
    Splitting on whitespace would slide 447.9 K into the wind columns."""
    levels = sonde._parse_uwyo(UWYO_PAGE)["levels"]
    assert levels[-2] == {"p": 69.0, "z": 19048, "t": -64.5, "td": None, "wdir": 50, "wspd": 9.8}
    assert levels[-1] == {"p": 62.5, "z": 19656, "t": -61.9, "td": None, "wdir": None, "wspd": None}


def test_uwyo_parser_converts_knots_when_the_units_row_says_so():
    page = UWYO_PAGE.replace("   SPED", "   SKNT").replace("    m/s", "   knot")
    levels = sonde._parse_uwyo(page)["levels"]
    assert levels[0]["wspd"] == pytest.approx(0.5, abs=0.05)     # 1.0 kt
    assert levels[4]["wspd"] == pytest.approx(10.3, abs=0.05)    # 20 kt


def test_uwyo_parser_ignores_tables_outside_the_indices_block():
    """The page's masthead is built from <tr><td> too. A loose scan swallowed
    it and shipped 190 KB of Wyoming's own HTML as "source indices"."""
    page = UWYO_PAGE.replace("<H1>", """<TABLE><TR><TD>1</TD><TD>x</TD><TD>99</TD></TR></TABLE><H1>""")
    got = sonde._parse_uwyo(page)
    assert set(got["source_indices"]) == {"PWAT"}


def test_uwyo_parser_survives_a_page_with_no_indices_table():
    page = UWYO_PAGE.split("<H3>Sounding Indices")[0] + "</BODY></HTML>"
    got = sonde._parse_uwyo(page)
    assert got["source_indices"] == {} and got["station_lat"] is None and len(got["levels"]) == 7


def test_station_names_keep_abbreviations_and_lose_the_shouting():
    assert sonde._title("QUILLAYUTE, WA., USA") == "Quillayute, WA., USA"
    assert sonde._title("CASTOR BAY") == "Castor Bay"
    assert sonde._title("STONY PLAIN UA, ALTA") == "Stony Plain UA, Alta"
    assert sonde._title("Yarmouth  NC/CN") == "Yarmouth NC/CN"


def test_uwyo_parser_rejects_a_page_with_no_profile():
    assert sonde._parse_uwyo("<HTML><BODY>nothing here</BODY></HTML>") is None


@pytest.mark.parametrize("status", [400, 404])
def test_uwyo_missing_slot_is_a_miss_not_an_error(monkeypatch, status):
    """Some stations answer 404 for an empty slot and some answer 400. Both
    mean the balloon did not fly, and neither is worth an exception."""
    monkeypatch.setattr(sonde, "UWYO_MIN_GAP", 0.0)
    monkeypatch.setattr(sonde._session, "get", lambda *a, **k: _Resp(status, UWYO_MISSING))
    from datetime import datetime, timezone
    assert sonde._fetch_uwyo("03953", datetime(2026, 8, 18, 13, tzinfo=timezone.utc)) is None


def test_uwyo_transport_failure_returns_none(monkeypatch):
    def boom(*a, **k):
        raise OSError("connection reset")
    monkeypatch.setattr(sonde, "UWYO_MIN_GAP", 0.0)
    monkeypatch.setattr(sonde._session, "get", boom)
    from datetime import datetime, timezone
    assert sonde._fetch_uwyo("03953", datetime(2026, 8, 18, 12, tzinfo=timezone.utc)) is None


# ── IEM parser ───────────────────────────────────────────────────────────

def test_iem_parser_converts_knots_and_drops_levels_with_no_pressure(monkeypatch):
    monkeypatch.setattr(sonde._session, "get", lambda *a, **k: _Resp(200, payload=IEM_PAGE))
    from datetime import datetime, timezone
    got = sonde._fetch_iem("KUIL", datetime(2026, 8, 18, 12, tzinfo=timezone.utc))
    assert got["source"] == "iem" and got["time"] == "2026-08-18T12:00:00Z"
    assert len(got["levels"]) == 4                     # the pressureless level is gone
    assert got["levels"][0]["wspd"] == pytest.approx(5.1, abs=0.05)   # 10 kt → m/s
    assert got["levels"][2]["wdir"] is None and got["levels"][2]["wspd"] is None


def test_iem_empty_profile_list_is_a_miss(monkeypatch):
    monkeypatch.setattr(sonde._session, "get", lambda *a, **k: _Resp(200, payload={"profiles": []}))
    from datetime import datetime, timezone
    assert sonde._fetch_iem("EGRB", datetime(2026, 8, 18, 12, tzinfo=timezone.utc)) is None


def test_iem_transport_failure_returns_none(monkeypatch):
    def boom(*a, **k):
        raise OSError("dns")
    monkeypatch.setattr(sonde._session, "get", boom)
    from datetime import datetime, timezone
    assert sonde._fetch_iem("KUIL", datetime(2026, 8, 18, 12, tzinfo=timezone.utc)) is None


# ── station list ─────────────────────────────────────────────────────────

def test_igra_parser_reads_fixed_width_and_drops_retired_stations():
    got = sonde._parse_igra(IGRA_TEXT, 2025)
    ids = {s["id"] for s in got}
    assert "72797" in ids and "47646" in ids and "10393" in ids
    assert "78861" not in ids                          # last reported 1993
    q = next(s for s in got if s["id"] == "72797")
    assert (q["lat"], q["lon"], q["elev_m"]) == (47.9339, -124.5602, 56.8)
    assert q["name"] == "Quillayute, WA." and q["country"] == "US" and q["wmo"] == "72797"
    sharjah = next(s for s in got if s["igra_id"] == "AEXUAE05467")
    assert sharjah["wmo"] is None and sharjah["id"] == "AEXUAE05467"   # not a WMO-numbered site


def test_iem_network_parser_skips_pseudo_sites_and_closed_archives():
    got = sonde._parse_iem_network(IEM_NETWORK_JSON)
    assert {s["icao"] for s in got} == {"KUIL", "CWMJ"}
    assert next(s for s in got if s["icao"] == "CWMJ")["name"] == "Maniwaki"


def test_merge_attaches_icao_to_the_igra_station_it_sits_on():
    merged = sonde._merge_stations(sonde._parse_igra(IGRA_TEXT, 2025),
                                   sonde._parse_iem_network(IEM_NETWORK_JSON))
    q = next(s for s in merged if s["id"] == "72797")
    assert q["icao"] == "KUIL" and q["sources"] == ["iem", "uwyo"]
    # Maniwaki has no IGRA twin in this fixture, so it stands on its own.
    mj = next(s for s in merged if s["id"] == "CWMJ")
    assert mj["sources"] == ["iem"] and mj["wmo"] is None
    assert sum(1 for s in merged if s.get("icao") == "KUIL") == 1


def test_station_list_survives_both_upstreams_being_down(monkeypatch):
    def boom(*a, **k):
        raise OSError("down")
    monkeypatch.setattr(sonde._session, "get", boom)
    assert sonde.stations() == []


def _stub_stations(monkeypatch, rows):
    monkeypatch.setattr(sonde, "stations", lambda: rows)


def test_nearest_station_picks_the_closest_and_honours_max_km(monkeypatch):
    rows = sonde._merge_stations(sonde._parse_igra(IGRA_TEXT, 2025),
                                 sonde._parse_iem_network(IEM_NETWORK_JSON))
    _stub_stations(monkeypatch, rows)
    near = sonde.nearest_station(47.6, -122.3)         # Seattle
    assert near["id"] == "72797" and near["distance_km"] < 200
    assert sonde.nearest_station(47.6, -122.3, max_km=50) is None
    assert sonde.nearest_station(-30.0, -140.0) is None  # middle of the South Pacific


def test_station_lookup_accepts_wmo_icao_and_igra_ids(monkeypatch):
    rows = sonde._merge_stations(sonde._parse_igra(IGRA_TEXT, 2025),
                                 sonde._parse_iem_network(IEM_NETWORK_JSON))
    _stub_stations(monkeypatch, rows)
    for key in ("72797", "KUIL", "kuil", "USM00072797"):
        assert sonde.station(key)["id"] == "72797"
    assert sonde.station("ZZZZ") is None


# ── time handling ────────────────────────────────────────────────────────

def test_synoptic_slots_are_newest_first_and_respect_the_posting_lag():
    from datetime import datetime, timezone
    slots = sonde._synoptic_slots(datetime(2026, 8, 18, 13, 30, tzinfo=timezone.utc), tries=3)
    assert [s.hour for s in slots] == [12, 6, 0]
    # 12:30Z is inside the posting lag for the 12Z launch, so 06Z leads.
    early = sonde._synoptic_slots(datetime(2026, 8, 18, 12, 30, tzinfo=timezone.utc), tries=2)
    assert [s.hour for s in early] == [6, 0]


def test_parse_when_accepts_compact_and_iso_stamps():
    from datetime import datetime, timezone
    want = datetime(2026, 8, 18, 12, tzinfo=timezone.utc)
    for s in ("2026081812", "2026-08-18T12", "2026-08-18 12:00", "2026-08-18T12:00:00Z"):
        assert sonde._parse_when(s) == want
    assert sonde._parse_when("yesterday") is None


# ── thermodynamics ───────────────────────────────────────────────────────

def test_saturation_vapour_pressure_and_mixing_ratio_match_published_values():
    assert sonde._es(20.0) == pytest.approx(23.4, abs=0.1)          # hPa at 20 °C
    assert sonde._mixing_ratio(1000.0, 20.0) * 1000 == pytest.approx(14.9, abs=0.1)   # g/kg


def test_lcl_of_a_textbook_parcel():
    """1000 hPa, 30 °C, dew point 20 °C lifts to roughly 865 hPa."""
    p_lcl, t_lcl = sonde._lcl(1000.0, 30.0, 20.0)
    assert p_lcl == pytest.approx(864.5, abs=2.0)
    assert t_lcl == pytest.approx(17.7, abs=0.3)


def test_lcl_of_a_saturated_parcel_is_at_the_surface():
    p_lcl, _ = sonde._lcl(1000.0, 15.0, 15.0)
    assert p_lcl == pytest.approx(1000.0, abs=1.0)


def test_moist_lapse_is_gentler_than_dry():
    dry = (30 + 273.15) * (700 / 1000) ** sonde.KAPPA - 273.15
    moist = sonde._moist_lapse(1000.0, 30.0, 700.0)
    assert moist > dry + 5                              # latent heat release
    assert 15.0 < moist < 24.0


def test_precipitable_water_matches_a_hand_integral():
    """Two levels, both saturated at 20 °C: q̄ ≈ 0.01549, Δp = 100 hPa, so
    PW = q̄ Δp·100 / g ≈ 15.8 mm."""
    levels = [{"p": 1000.0, "td": 20.0}, {"p": 900.0, "td": 20.0}]
    assert sonde._pwat(levels) == pytest.approx(15.8, abs=0.2)


def test_precipitable_water_of_a_dry_column_is_near_zero():
    levels = [{"p": p, "td": -80.0} for p in (1000.0, 700.0, 500.0, 300.0)]
    assert sonde._pwat(levels) < 0.1


def test_freezing_level_interpolates_between_levels():
    levels = [{"p": 1000, "t": 10.0, "z": 0}, {"p": 850, "t": -10.0, "z": 2000}]
    assert sonde._freezing_level(levels) == 1000


def test_freezing_level_is_none_when_the_surface_is_already_below_zero():
    levels = [{"p": 1000, "t": -3.0, "z": 0}, {"p": 850, "t": -10.0, "z": 2000}]
    assert sonde._freezing_level(levels) is None


def _profile(surface_t, surface_td, lapse_c_per_km):
    """A synthetic sounding on a fixed set of heights with a constant lapse
    rate and a dry free atmosphere above the surface layer."""
    out = []
    for z, p in ((0, 1000.0), (500, 942.0), (1000, 887.0), (1500, 835.0), (2000, 785.0),
                 (3000, 692.0), (4000, 609.0), (5000, 533.0), (6000, 465.0), (8000, 350.0),
                 (10000, 260.0), (12000, 190.0)):
        t = surface_t - lapse_c_per_km * z / 1000.0
        td = min(surface_td - 2.0 * z / 1000.0, t)
        out.append({"p": p, "z": z, "t": round(t, 1), "td": round(td, 1)})
    return out


def test_cape_is_large_for_a_hot_moist_steep_profile():
    idx = sonde._cape_cin(_profile(32.0, 23.0, 8.5))
    assert idx["sbcape_j_kg"] > 1000
    assert idx["lfc_hpa"] is not None and idx["el_hpa"] < idx["lfc_hpa"]
    assert 800 < idx["lcl_hpa"] < 960


def test_cape_is_zero_for_a_stable_profile():
    idx = sonde._cape_cin(_profile(10.0, 2.0, 4.0))
    assert idx["sbcape_j_kg"] == 0
    assert idx["sbcin_j_kg"] == 0


def test_indices_are_labelled_as_ours():
    idx = sonde.indices(_profile(32.0, 23.0, 8.5))
    assert idx["computed_by"] == "wxgrid"
    assert idx["surface"] == {"p": 1000.0, "t": 32.0, "td": 23.0}
    assert idx["pwat_mm"] > 20 and idx["freezing_level_m"] > 3000


def test_indices_degrade_instead_of_raising_on_a_stub_profile():
    idx = sonde.indices([{"p": 1000.0, "z": 0, "t": 5.0, "td": 5.0}])
    assert idx["sbcape_j_kg"] is None and idx["pwat_mm"] is None


# ── payload shaping ──────────────────────────────────────────────────────

def test_thinning_keeps_the_ends_and_the_mandatory_levels():
    levels = [{"p": round(1000.0 - i * 0.25, 2)} for i in range(3800)]
    thin = sonde._thin(levels, cap=100)
    assert len(thin) <= 100
    assert thin[0]["p"] == 1000.0 and thin[-1]["p"] == levels[-1]["p"]
    have = {lv["p"] for lv in thin}
    for target in (925, 850, 700, 500, 400, 300, 250, 200, 150, 100):
        assert any(abs(p - target) < 0.3 for p in have), target


def test_thinning_leaves_a_short_profile_alone():
    levels = [{"p": 1000.0 - 10 * i} for i in range(50)]
    assert sonde._thin(levels, cap=320) is levels


def test_shape_reports_observation_time_age_and_thinning():
    st = {"id": "47646", "wmo": "47646", "icao": None, "name": "Tateno, Japan",
          "lat": 36.06, "lon": 140.13, "elev_m": 25.2, "country": "JA", "distance_km": 12.3}
    out = sonde._shape(sonde._parse_uwyo(UWYO_PAGE), st, cap=320)
    assert out["station"]["distance_km"] == 12.3
    assert out["time"] == "2026-08-18T12:00:00Z" and out["age_h"] is not None
    assert out["units"]["wspd"] == "m/s"
    assert out["thinned"] is False and out["n_levels"] == out["n_levels_full"] == 7
    assert out["indices"]["computed_by"] == "wxgrid"
    assert out["source_indices"]["PWAT"] == 44.6


# ── end to end, still no network ─────────────────────────────────────────

def _rows():
    return sonde._merge_stations(sonde._parse_igra(IGRA_TEXT, 2025),
                                 sonde._parse_iem_network(IEM_NETWORK_JSON))


def test_sounding_prefers_iem_and_never_touches_wyoming_when_it_answers(monkeypatch):
    _stub_stations(monkeypatch, _rows())
    monkeypatch.setattr(sonde, "_fetch_iem", lambda icao, when: sonde._parse_uwyo(UWYO_PAGE))
    def forbidden(*a, **k):
        raise AssertionError("wyoming must not be asked when IEM answered")
    monkeypatch.setattr(sonde, "_fetch_uwyo", forbidden)
    got = sonde.sounding("KUIL")
    assert got["station"]["id"] == "72797" and got["n_levels"] == 7


def test_sounding_falls_back_to_wyoming_and_walks_back_through_slots(monkeypatch):
    _stub_stations(monkeypatch, _rows())
    monkeypatch.setattr(sonde, "_fetch_iem", lambda icao, when: None)
    tried = []
    def uwyo(wmo, when):
        tried.append(when.hour)
        return sonde._parse_uwyo(UWYO_PAGE) if len(tried) == 3 else None
    monkeypatch.setattr(sonde, "_fetch_uwyo", uwyo)
    got = sonde.sounding("72797")
    assert got is not None and len(tried) == 3
    assert tried == sorted(tried, reverse=True) or len(set(tried)) == 3


def test_sounding_returns_none_when_nothing_is_posted(monkeypatch):
    _stub_stations(monkeypatch, _rows())
    monkeypatch.setattr(sonde, "_fetch_iem", lambda icao, when: None)
    monkeypatch.setattr(sonde, "_fetch_uwyo", lambda wmo, when: None)
    assert sonde.sounding("72797") is None


def test_sounding_returns_none_for_an_unknown_station(monkeypatch):
    _stub_stations(monkeypatch, _rows())
    assert sonde.sounding("ZZZZ") is None


def test_explicit_when_asks_for_exactly_that_slot(monkeypatch):
    _stub_stations(monkeypatch, _rows())
    monkeypatch.setattr(sonde, "_fetch_iem", lambda icao, when: None)
    asked = []
    def uwyo(wmo, when):
        asked.append(when)
        return sonde._parse_uwyo(UWYO_PAGE)
    monkeypatch.setattr(sonde, "_fetch_uwyo", uwyo)
    sonde.sounding("72797", when="2026081800")
    assert len(asked) == 1 and asked[0].hour == 0 and asked[0].day == 18


def test_a_miss_is_not_cached_as_long_as_a_hit(monkeypatch):
    """A slot that has not been posted yet must be retried inside the miss
    window, or a station that launches at 12:00Z stays blank until 15:00Z."""
    _stub_stations(monkeypatch, _rows())
    monkeypatch.setattr(sonde, "MISS_TTL", 0.0)
    monkeypatch.setattr(sonde, "_fetch_iem", lambda icao, when: None)
    calls = []
    def uwyo(wmo, when):
        calls.append(when)
        return None
    monkeypatch.setattr(sonde, "_fetch_uwyo", uwyo)
    assert sonde.sounding("72797") is None
    n = len(calls)
    assert sonde.sounding("72797") is None
    assert len(calls) > n


# ── routes ───────────────────────────────────────────────────────────────

def _client():
    app = FastAPI()
    app.include_router(sonde_api.router)
    return TestClient(app)


def test_route_nearest_returns_station_and_sounding(monkeypatch):
    _stub_stations(monkeypatch, _rows())
    monkeypatch.setattr(sonde, "_fetch_iem", lambda icao, when: sonde._parse_uwyo(UWYO_PAGE))
    j = _client().get("/api/sonde/nearest", params={"lat": 47.6, "lon": -122.3}).json()
    assert j["reason"] is None
    assert j["station"]["id"] == "72797" and j["station"]["distance_km"] > 0
    assert j["sounding"]["units"]["p"] == "hPa" and len(j["sounding"]["levels"]) == 7


def test_route_nearest_says_why_when_there_is_no_station(monkeypatch):
    _stub_stations(monkeypatch, _rows())
    j = _client().get("/api/sonde/nearest", params={"lat": -30.0, "lon": -140.0}).json()
    assert j["station"] is None and j["sounding"] is None and "400" in j["reason"]


def test_route_nearest_says_why_when_the_station_has_not_flown(monkeypatch):
    _stub_stations(monkeypatch, _rows())
    monkeypatch.setattr(sonde, "_fetch_iem", lambda icao, when: None)
    monkeypatch.setattr(sonde, "_fetch_uwyo", lambda wmo, when: None)
    j = _client().get("/api/sonde/nearest", params={"lat": 47.6, "lon": -122.3}).json()
    assert j["station"]["id"] == "72797" and j["sounding"] is None
    assert "no sounding posted" in j["reason"]


def test_route_station_by_icao_and_unknown_station(monkeypatch):
    _stub_stations(monkeypatch, _rows())
    monkeypatch.setattr(sonde, "_fetch_iem", lambda icao, when: sonde._parse_uwyo(UWYO_PAGE))
    c = _client()
    assert c.get("/api/sonde/station/KUIL").json()["sounding"]["source"] == "uwyo"
    assert c.get("/api/sonde/station/ZZZZ").status_code == 404


def test_route_respects_max_levels(monkeypatch):
    _stub_stations(monkeypatch, _rows())
    big = {**sonde._parse_uwyo(UWYO_PAGE),
           "levels": [{"p": round(1000.0 - i * 0.25, 2), "z": i, "t": 10.0, "td": 5.0,
                       "wdir": 200, "wspd": 5.0} for i in range(3000)]}
    monkeypatch.setattr(sonde, "_fetch_iem", lambda icao, when: big)
    j = _client().get("/api/sonde/station/KUIL", params={"max_levels": 60}).json()
    assert j["sounding"]["n_levels"] <= 60 and j["sounding"]["n_levels_full"] == 3000
    assert j["sounding"]["thinned"] is True
    assert len(json.dumps(j).encode()) < 100_000
