"""URL builders for the sources that have no client library of their own."""
from datetime import datetime, timezone
from pathlib import Path

from wxgrid import fetch
from wxgrid.models import LEVELS, get_model

RUN = datetime(2026, 8, 18, 12, tzinfo=timezone.utc)


def test_levels_cover_the_advertised_set():
    assert LEVELS == (1000, 925, 850, 700, 600, 500, 400, 300, 250, 200)
    assert set(get_model("gefs").levels) <= set(LEVELS)   # the mean has fewer


def test_gfs_filter_asks_for_every_level():
    url = fetch.gfs_step_url(RUN, 24, LEVELS)
    for lvl in LEVELS:
        assert f"lev_{lvl}_mb=on" in url
    assert "file=gfs.t12z.pgrb2.0p25.f024" in url


# ── GEM (MSC datamart) ────────────────────────────────────────────────────

def test_gem_url_matches_the_live_datamart_layout():
    url = fetch.gem_file_url(RUN, 3, "AirTemp_AGL-2m")
    assert url == ("https://dd.weather.gc.ca/20260818/WXO-DD/model_gdps/15km/12/003/"
                   "20260818T12Z_MSC_GDPS_AirTemp_AGL-2m_LatLon0.15_PT003H.grib2")
    assert fetch.gem_file_url(RUN, 240, "Precip-Accum_Sfc").endswith("/240/"
           "20260818T12Z_MSC_GDPS_Precip-Accum_Sfc_LatLon0.15_PT240H.grib2")


def test_gem_step_files_add_pressure_levels_on_6h_steps_only():
    gem = get_model("gem")
    sfc = fetch.gem_step_files(gem, 3)
    assert len(sfc) == len(gem.file_params)
    six = fetch.gem_step_files(gem, 6)
    assert len(six) == len(gem.file_params) + len(gem.file_pl_params) * len(gem.levels)
    tokens = dict(six)
    assert tokens["t@850"] == "AirTemp_IsbL-0850"
    assert tokens["gh@1000"] == "GeopotentialHeight_IsbL-1000"
    assert tokens["u@200"] == "WindU_IsbL-0200"      # four digits, zero padded


def test_gem_runs_are_00_and_12z():
    hours = {r.hour for r in fetch.gem_candidate_runs(datetime(2026, 8, 18, 5, tzinfo=timezone.utc))}
    assert hours == {0, 12}


def test_grib_override_round_trips_through_the_filename():
    assert fetch.grib_override(Path("/g/step006__u@850.grib2")) == ("u", 850)
    assert fetch.grib_override(Path("/g/step009__2t.grib2")) == ("2t", None)
    assert fetch.grib_override(Path("/g/step009-sfc.grib2")) == (None, None)


# ── GEFS (NOMADS filter CGI) ──────────────────────────────────────────────

def test_gefs_surface_url_uses_the_0p25s_filter_and_the_geavg_member():
    url = fetch.gefs_sfc_url(RUN, 9)
    assert url.startswith("https://nomads.ncep.noaa.gov/cgi-bin/filter_gefs_atmos_0p25s.pl?")
    assert "dir=%2Fgefs.20260818%2F12%2Fatmos%2Fpgrb2sp25" in url
    assert "file=geavg.t12z.pgrb2s.0p25.f009" in url
    for flag in ("var_TMP=on", "var_APCP=on", "var_PRMSL=on", "lev_2_m_above_ground=on"):
        assert flag in url


def test_gefs_pressure_url_uses_the_half_degree_a_file():
    gem_levels_not_in_mean = {600, 400, 300}
    url = fetch.gefs_pl_url(RUN, 6, get_model("gefs").levels)
    assert "filter_gefs_atmos_0p50a.pl?" in url
    assert "file=geavg.t12z.pgrb2a.0p50.f006" in url
    assert "lev_850_mb=on" in url and "lev_200_mb=on" in url
    # NOMADS rejects the whole request with "invalid parameter" for a level the
    # product does not carry, so these must never be asked for.
    for lvl in gem_levels_not_in_mean:
        assert f"lev_{lvl}_mb=on" not in url


def test_gefs_probe_points_at_the_idx_sidecar():
    assert fetch.gefs_probe_url(RUN, 240).endswith(
        "gefs.20260818/12/atmos/pgrb2sp25/geavg.t12z.pgrb2s.0p25.f240.idx")
