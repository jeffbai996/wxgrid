"""Forecast uncertainty: spread arithmetic, the `_sd` store family, and the
/api/ens routes. No network — the one GRIB decode is stubbed."""
import shutil
from datetime import datetime, timezone

import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from wxgrid import ens, fetch, ingest
from wxgrid.config import GRID_LAT_N, GRID_LON_N, STORE_DIR
from wxgrid.ens_api import router as ens_router
from wxgrid.grib import Field
from wxgrid.models import get_model
from wxgrid.store import RunWriter, run_path

RUN = datetime(2026, 8, 18, 12, tzinfo=timezone.utc)


def _client() -> TestClient:
    """The router on a bare app: what wxgrid.api mounts is the parent app's
    business, and these tests should not fail because of where the include
    line ended up relative to the StaticFiles mount."""
    app = FastAPI()
    app.include_router(ens_router)
    return TestClient(app)


# ── wind: components → speed ──────────────────────────────────────────────

def test_wind_spread_projects_onto_the_mean_wind_direction():
    """A strong westerly whose members disagree mostly about the CROSS-wind
    component: that is disagreement about direction, not about how hard it
    blows, so the speed spread stays near sigma_u."""
    sd = ens.wind_speed_spread(np.array([12.0]), np.array([0.0]),
                               np.array([1.5]), np.array([6.0]))
    assert abs(float(sd[0]) - 1.5) < 0.05
    # the naive vector spread would have claimed 6.2 m/s
    assert float(sd[0]) < float(np.hypot(1.5, 6.0)) / 3


def test_wind_spread_falls_back_to_the_vector_spread_in_calm_air():
    """With no mean wind there is no direction to project onto, and claiming
    zero spread would be claiming a certainty the ensemble does not have."""
    sd = ens.wind_speed_spread(np.array([0.0]), np.array([0.0]),
                               np.array([1.5]), np.array([2.0]))
    assert abs(float(sd[0]) - float(np.hypot(1.5, 2.0))) < 1e-5


def test_wind_spread_without_any_mean_field_uses_the_vector_spread():
    sd = ens.wind_speed_spread(None, None, np.array([3.0]), np.array([4.0]))
    assert float(sd[0]) == pytest.approx(5.0)


def test_wind_spread_is_continuous_across_the_calm_threshold():
    """A hard switch at CALM_MS would print a visible seam in the field."""
    su, sv = np.full(3, 1.0), np.full(3, 5.0)
    eps = 1e-3
    speeds = np.array([ens.CALM_MS - eps, ens.CALM_MS, ens.CALM_MS + eps])
    out = ens.wind_speed_spread(speeds, np.zeros(3), su, sv)
    assert abs(float(out[0]) - float(out[1])) < 0.01
    assert abs(float(out[1]) - float(out[2])) < 0.01


# ── bands ─────────────────────────────────────────────────────────────────

def test_gaussian_band_is_symmetric_about_the_mean():
    mean, sd = np.array([280.0, 285.0]), np.array([1.0, 2.0])
    b = ens.gaussian_band(mean, sd)
    assert np.allclose(b["p50"], mean)
    assert np.allclose(b["p90"] - mean, 1.2815515655446004 * sd)
    assert np.allclose(mean - b["p10"], b["p90"] - mean)          # symmetric by construction
    assert np.allclose(b["p75"] - mean, 0.6744897501960817 * sd)


def test_gaussian_band_clips_a_floored_quantity_at_zero():
    """Rain cannot be negative. mean 0.5 mm with sigma 2 mm puts p10 at -2.1,
    which is clipped — and is exactly why the response carries a note."""
    b = ens.gaussian_band(np.array([0.5]), np.array([2.0]), floor=0.0)
    assert float(b["p10"][0]) == 0.0 and float(b["p25"][0]) == 0.0
    assert float(b["p90"][0]) > 0.5


def test_negative_spread_is_treated_as_a_magnitude():
    b = ens.gaussian_band(np.array([10.0]), np.array([-2.0]))
    assert float(b["p90"][0]) > 10.0 > float(b["p10"][0])


def test_percentiles_from_members_match_numpy():
    rng = np.random.default_rng(7)
    members = rng.normal(280.0, 3.0, size=(31, 5))
    got = ens.percentiles_from_members(members)
    for q in (10, 25, 50, 75, 90):
        assert np.allclose(got[f"p{q}"], np.percentile(members, q, axis=0))


def test_aifs_ens_per_point_is_not_affordable_and_says_so_in_numbers():
    """The measurement is the reason the member basis does not ship; if anyone
    ever edits the constants into affordability, they trip this on the way."""
    r = ens.cost_report()["aifs_ens"]
    assert r["affordable"] is False
    assert r["mb_per_plume"] > ens.BUDGET_MB and r["seconds_per_plume"] > ens.BUDGET_S
    assert ens.member_sources("aifs") == []


# ── model registry ────────────────────────────────────────────────────────

def test_gefs_stores_the_sd_family_and_not_the_raw_components():
    gefs = get_model("gefs")
    store = gefs.store_variables()
    for v in ("t2m_sd", "wind_sd", "msl_sd", "tp6_sd"):
        assert v in store
    assert "u10_sd" not in store and "v10_sd" not in store   # inputs to wind_sd only
    assert len(store) == len(set(store))


def test_spread_mapping_does_not_collide_with_the_mean_mapping():
    """gespr decodes to exactly the same shortNames as geavg; the only thing
    keeping them apart is which table the ingest looks in."""
    gefs = get_model("gefs")
    assert gefs.canonical("2t", "heightAboveGround", 2) == "t2m"
    assert gefs.canonical_spread("2t", "heightAboveGround", 2) == "t2m_sd"
    assert gefs.canonical_spread("t", "isobaricInhPa", 850) is None    # surface only


def test_deterministic_models_declare_no_spread():
    for key in ("gfs", "ifs", "aifs", "gem"):
        m = get_model(key)
        assert m.spread_params == {}
        assert not [v for v in m.store_variables() if v.endswith("_sd")]


# ── fetch URLs ────────────────────────────────────────────────────────────

def test_gefs_spread_url_points_at_gespr_beside_the_mean():
    url = fetch.gefs_spread_url(RUN, 9)
    assert url.startswith("https://nomads.ncep.noaa.gov/cgi-bin/filter_gefs_atmos_0p25s.pl?")
    assert "dir=%2Fgefs.20260818%2F12%2Fatmos%2Fpgrb2sp25" in url    # same dir as geavg
    assert "file=gespr.t12z.pgrb2s.0p25.f009" in url
    for flag in ("var_TMP=on", "var_UGRD=on", "var_VGRD=on", "var_PRMSL=on", "var_APCP=on",
                 "lev_2_m_above_ground=on", "lev_10_m_above_ground=on", "lev_mean_sea_level=on"):
        assert flag in url


def test_spread_files_are_recognised_only_by_their_own_suffix():
    from pathlib import Path
    assert fetch.is_spread(Path("/g/step006-spr.grib2"))
    assert not fetch.is_spread(Path("/g/step006-sfc.grib2"))
    assert not fetch.is_spread(Path("/g/step006-pl.grib2"))


# ── ingest ────────────────────────────────────────────────────────────────

class _FakeWriter:
    """Records writes instead of touching Zarr; mirrors RunWriter's contract
    that an unknown variable is silently ignored."""

    def __init__(self, variables):
        self.variables = list(variables)
        self.written = {}

    def write(self, var, step, values):
        if var in self.variables:
            self.written[(var, step)] = np.asarray(values)


def _spread_fields(units_tp="kg m**-2"):
    one = np.ones((2, 2), dtype=np.float32)
    return [Field("2t", 6, one * 1.4, "heightAboveGround", 2, "K", 6),
            Field("10u", 6, one * 1.5, "heightAboveGround", 10, "m s**-1", 6),
            Field("10v", 6, one * 6.0, "heightAboveGround", 10, "m s**-1", 6),
            Field("prmsl", 6, one * 120.0, "meanSea", 0, "Pa", 6),
            Field("tp", 6, one * 2.0, "surface", 0, units_tp, 0)]


def test_write_spread_stores_the_family_and_derives_wind(monkeypatch):
    monkeypatch.setattr(ingest, "iter_fields", lambda p, **k: iter(_spread_fields()))
    gefs = get_model("gefs")
    w = _FakeWriter(gefs.store_variables())
    mean = {"u10": np.full((2, 2), 12.0, np.float32), "v10": np.zeros((2, 2), np.float32)}
    got = ingest.write_spread(w, gefs, 6, [__import__("pathlib").Path("step006-spr.grib2")], mean)
    assert set(got) == {"t2m_sd", "msl_sd", "tp6_sd", "wind_sd"}
    assert ("u10_sd", 6) not in w.written and ("v10_sd", 6) not in w.written
    assert float(w.written[("t2m_sd", 6)][0, 0]) == pytest.approx(1.4)
    assert float(w.written[("tp6_sd", 6)][0, 0]) == pytest.approx(2.0)   # kg m-2 is already mm
    # a 12 m/s westerly: the 6 m/s cross-component spread must not inflate speed
    assert float(w.written[("wind_sd", 6)][0, 0]) == pytest.approx(1.5, abs=0.05)


def test_write_spread_converts_metre_precipitation_to_millimetres(monkeypatch):
    monkeypatch.setattr(ingest, "iter_fields", lambda p, **k: iter(_spread_fields(units_tp="m")))
    gefs = get_model("gefs")
    w = _FakeWriter(gefs.store_variables())
    ingest.write_spread(w, gefs, 6, [__import__("pathlib").Path("x-spr.grib2")], {})
    assert float(w.written[("tp6_sd", 6)][0, 0]) == pytest.approx(2000.0)


def test_write_spread_is_a_no_op_when_no_spread_file_landed():
    gefs = get_model("gefs")
    w = _FakeWriter(gefs.store_variables())
    assert ingest.write_spread(w, gefs, 6, [], {}) == []
    assert w.written == {}
    assert ingest.write_spread(w, get_model("gfs"), 6, ["x-spr.grib2"], {}) == []


def test_write_spread_survives_a_grib_that_will_not_decode(monkeypatch):
    """A bad spread file must cost that step's uncertainty, never the run."""
    def boom(p, **k):
        raise RuntimeError("eccodes said no")
    monkeypatch.setattr(ingest, "iter_fields", boom)
    gefs = get_model("gefs")
    w = _FakeWriter(gefs.store_variables())
    assert ingest.write_spread(w, gefs, 6, [__import__("pathlib").Path("x-spr.grib2")], {}) == []


def test_accumulation_window_follows_the_producers_bucket():
    """GEFS APCP restarts every 6 h with a partial at the 3 h step: f009 is the
    6-9 h bucket, not 0-9 and not the stored 3 h increment."""
    class R:
        pass
    assert ens._accum_window_h(R(), 0) == 0
    assert ens._accum_window_h(R(), 3) == 3
    assert ens._accum_window_h(R(), 6) == 6
    assert ens._accum_window_h(R(), 9) == 3
    assert ens._accum_window_h(R(), 12) == 6


# ── the routes ────────────────────────────────────────────────────────────

def _full(val):
    return np.full((GRID_LAT_N, GRID_LON_N), val, np.float32)


def _seed_gefs():
    variables = ["u10", "v10", "t2m", "tp6", "msl", "t2m_sd", "wind_sd", "msl_sd", "tp6_sd"]
    w = RunWriter("gefs", "2026-08-18T12", [0, 6, 12], variables,
                  attribution="NOAA NCEP GEFS ensemble mean via NOMADS, public domain", root=STORE_DIR)
    for i, step in enumerate([0, 6, 12]):
        w.write("u10", step, _full(10.0)); w.write("v10", step, _full(0.0))
        w.write("t2m", step, _full(288.15)); w.write("msl", step, _full(101325.0))
        w.write("tp6", step, _full(0.5 * i))
        # spread grows with lead time, which is the whole point of the chart
        w.write("t2m_sd", step, _full(0.5 + i)); w.write("wind_sd", step, _full(0.4 + 0.6 * i))
        w.write("msl_sd", step, _full(40.0 + 80.0 * i)); w.write("tp6_sd", step, _full(2.0))
    w.finish()
    ens.cache()._d.clear()


def test_plume_returns_a_symmetric_band_labelled_as_synthesised():
    _seed_gefs()
    c = _client()
    p = c.get("/api/ens/plume", params={"lat": 49.25, "lon": -123.25, "model": "gefs", "var": "t2m"}).json()
    assert p["basis"] == "gaussian-from-spread" and p["members"] is None
    assert p["unit"] == "K" and p["kind"] == "temp"
    assert p["steps"] == [0, 6, 12] and len(p["valid"]) == 3
    assert p["valid"][1].startswith("2026-08-18T18:00")
    assert p["mean"] == [288.15, 288.15, 288.15]
    assert p["p50"] == p["mean"]
    assert p["p90"][2] > p["p90"][1] > p["p90"][0]              # the fan opens with lead time
    assert p["p10"][0] < p["mean"][0] < p["p90"][0]
    assert "not from the members" in p["note"]
    assert "GEFS" in p["source"]


def test_plume_accepts_either_the_map_name_or_the_store_name():
    _seed_gefs()
    c = _client()
    a = c.get("/api/ens/plume", params={"lat": 49.25, "lon": -123.25, "var": "wind"}).json()
    b = c.get("/api/ens/plume", params={"lat": 49.25, "lon": -123.25, "var": "wind_sd"}).json()
    assert a["sd_var"] == b["sd_var"] == "wind_sd"
    assert a["mean"] == [10.0, 10.0, 10.0]                      # speed of the stored components
    assert min(a["p10"]) >= 0.0                                 # wind speed is floored


def test_precipitation_plume_is_floored_and_declares_its_accumulation_window():
    _seed_gefs()
    c = _client()
    p = c.get("/api/ens/plume", params={"lat": 49.25, "lon": -123.25, "var": "tp6"}).json()
    assert p["p10"] == [0.0, 0.0, 0.0]                          # mean - 1.28*2mm is negative
    assert p["window_h"] == [0, 6, 6]
    assert "zero-inflated" in p["note"]


def test_longitudes_on_a_repeated_world_copy_wrap():
    _seed_gefs()
    c = _client()
    a = c.get("/api/ens/plume", params={"lat": 49.25, "lon": -123.25}).json()
    b = c.get("/api/ens/plume", params={"lat": 49.25, "lon": 236.75}).json()
    assert a["lon"] == b["lon"] == -123.25


def test_spread_route_lists_every_stored_sd_series_with_its_mean():
    _seed_gefs()
    c = _client()
    s = c.get("/api/ens/spread", params={"lat": 49.25, "lon": -123.25, "model": "gefs"}).json()
    assert set(s["vars"]) == {"t2m_sd", "wind_sd", "msl_sd", "tp6_sd"}
    assert s["vars"]["msl_sd"]["unit"] == "Pa"
    assert s["vars"]["msl_sd"]["sd"] == [40.0, 120.0, 200.0]
    assert s["vars"]["wind_sd"]["mean"] == [10.0, 10.0, 10.0]
    assert s["steps"] == [0, 6, 12]


def test_unknown_variable_and_deterministic_model_both_404():
    _seed_gefs()
    c = _client()
    assert c.get("/api/ens/plume", params={"lat": 49.25, "lon": -123.25, "var": "cape"}).status_code == 404
    assert c.get("/api/ens/plume", params={"lat": 49.25, "lon": -123.25, "model": "gem"}).status_code == 404
    assert c.get("/api/ens/spread", params={"lat": 49.25, "lon": -123.25, "model": "gem"}).status_code == 404


def test_sources_advertises_gefs_and_carries_the_member_cost_measurement():
    _seed_gefs()
    c = _client()
    s = c.get("/api/ens/sources").json()
    assert set(s["spread"]["gefs"]) == {"t2m_sd", "wind_sd", "msl_sd", "tp6_sd"}
    assert s["members"]["gefs"] == []
    assert s["cost"]["aifs_ens"]["affordable"] is False
    assert s["vars"]["t2m_sd"]["kind"] == "temp"


def test_latest_is_resolved_before_the_cache_is_keyed():
    """Keying the cache on the literal word "latest" would keep serving the
    previous cycle for a whole TTL after a new run lands — which is exactly
    when someone looks. The cache is NOT cleared between the two seeds here."""
    _seed_gefs()
    c = _client()
    first = c.get("/api/ens/plume", params={"lat": 49.25, "lon": -123.25}).json()
    assert first["run"] == "2026-08-18T12"

    w = RunWriter("gefs", "2026-08-18T18", [0, 6],
                  ["u10", "v10", "t2m", "t2m_sd"], root=STORE_DIR)
    for step in (0, 6):
        w.write("u10", step, _full(3.0)); w.write("v10", step, _full(0.0))
        w.write("t2m", step, _full(300.0)); w.write("t2m_sd", step, _full(1.0))
    w.finish()

    try:
        second = c.get("/api/ens/plume", params={"lat": 49.25, "lon": -123.25}).json()
        assert second["run"] == "2026-08-18T18" and second["mean"] == [300.0, 300.0]
    finally:
        # do not leave a newer run behind for whatever runs next
        shutil.rmtree(run_path("gefs", "2026-08-18T18", STORE_DIR), ignore_errors=True)
        ens.cache()._d.clear()
