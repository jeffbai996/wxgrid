"""URL builders for the sources that have no client library of their own."""
from datetime import datetime, timezone
from pathlib import Path

from wxgrid import fetch
from wxgrid.models import LEVELS, get_model

RUN = datetime(2026, 8, 18, 12, tzinfo=timezone.utc)


def test_levels_cover_the_advertised_set():
    assert LEVELS == (1000, 925, 850, 700, 600, 500, 400, 300, 250, 200, 150, 100)
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


# ── NOAA AI-GFS: byte-range subsetting off the .idx ─────────────────────

_IDX = """1:0:d=2026081900:UGRD:10 m above ground:6-12 hour fcst:
2:1000:d=2026081900:VGRD:10 m above ground:6-12 hour fcst:
3:2000:d=2026081900:DPT:2 m above ground:12 hour fcst:
4:3000:d=2026081900:TMP:2 m above ground:12 hour fcst:
5:4000:d=2026081900:TMP:surface:12 hour fcst:
6:5000:d=2026081900:PRMSL:mean sea level:12 hour fcst:
7:6000:d=2026081900:ACPCP:surface:6-12 hour acc fcst:
8:7000:d=2026081900:APCP:surface:6-12 hour acc fcst:
9:9000:d=2026081900:APCP:surface:0-12 hour acc fcst:
"""


def test_aigfs_urls_point_at_the_open_data_bucket():
    run = datetime(2026, 8, 19, 0, tzinfo=timezone.utc)
    assert fetch.aigfs_url(run, 12, "sfc").endswith(
        "aigfs.20260819/00/model/atmos/grib2/aigfs.t00z.sfc.f012.grib2")
    assert fetch.aigfs_url(run, 6, "pres").endswith("aigfs.t00z.pres.f006.grib2")
    assert fetch.aigfs_probe_url(run, 384).endswith("sfc.f384.grib2.idx")


def test_idx_gives_every_message_a_byte_range():
    rows = fetch.parse_idx(_IDX)
    assert len(rows) == 9
    assert rows[0]["start"] == 0 and rows[0]["end"] == 999
    assert rows[-1]["end"] is None                    # the last one runs to EOF


def test_precip_selection_takes_the_bucket_not_the_running_total():
    """The file carries both `6-12 hour acc` and `0-12 hour acc` under the name
    APCP. Taking the second would turn a six-hour rainfall into a cumulative
    one, silently, for every step after the first."""
    rows = fetch.parse_idx(_IDX)
    picked = fetch.aigfs_wanted(rows, 12, (850, 500), "sfc")
    windows = [r["window"] for r in picked if r["var"] == "APCP"]
    assert windows == ["6-12 hour acc fcst"]
    # surface temperature at 2 m, not the skin temperature beside it
    assert ("TMP", "2 m above ground") in {(r["var"], r["level"]) for r in picked}
    assert ("TMP", "surface") not in {(r["var"], r["level"]) for r in picked}
    assert not any(r["var"] == "ACPCP" for r in picked)
    # at the first step the bucket and the running total are the same message
    # written twice; taking both would decode one field over the other
    first = fetch.aigfs_wanted(fetch.parse_idx(
        "1:0:d=x:APCP:surface:0-6 hour acc fcst:\n2:10:d=x:APCP:surface:0-6 hour acc fcst:\n"), 6, (), "sfc")
    assert len(first) == 1


def test_pressure_selection_keeps_only_the_levels_we_store():
    rows = fetch.parse_idx(
        "1:0:d=x:TMP:850 mb:12 hour fcst:\n2:10:d=x:TMP:975 mb:12 hour fcst:\n"
        "3:20:d=x:HGT:850 mb:12 hour fcst:\n4:30:d=x:RH:850 mb:12 hour fcst:\n")
    picked = fetch.aigfs_wanted(rows, 12, (850,), "pres")
    assert {(r["var"], r["level"]) for r in picked} == {("TMP", "850 mb"), ("HGT", "850 mb")}


def test_neighbouring_messages_become_one_request():
    rows = fetch.parse_idx(_IDX)
    picked = fetch.aigfs_wanted(rows, 12, (), "sfc")
    merged = fetch.merge_ranges(picked)
    assert len(merged) < len(picked)                  # 6 messages, fewer requests
    assert merged[0][0] == 0
    # a gap wider than the slack is not bridged
    far = [{"start": 0, "end": 99}, {"start": 10_000_000, "end": 10_000_099}]
    assert len(fetch.merge_ranges(far)) == 2


# ── regional models ──────────────────────────────────────────────────────

def test_hrdps_url_and_hourly_surface_file_set():
    url = fetch.hrdps_file_url(RUN, 6, "GUST_AGL-10m")
    assert url == ("https://dd.weather.gc.ca/20260818/WXO-DD/model_hrdps/continental/2.5km/12/006/"
                   "20260818T12Z_MSC_HRDPS_GUST_AGL-10m_RLatLon0.0225_PT006H.grib2")
    files = dict(fetch.hrdps_step_files(get_model("hrdps"), 6))
    assert files["10u"] == "UGRD_AGL-10m"
    assert files["tp"] == "APCP-Accum1h_Sfc"
    assert files["sf"] == "WEASN-Accum1h_Sfc"


_HRRR_IDX = """1:0:d=x:GUST:surface:6 hour fcst:
2:100:d=x:UGRD:10 m above ground:6 hour fcst:
3:200:d=x:VGRD:10 m above ground:6 hour fcst:
4:300:d=x:TMP:2 m above ground:6 hour fcst:
5:400:d=x:DPT:2 m above ground:6 hour fcst:
6:500:d=x:MSLMA:mean sea level:6 hour fcst:
7:600:d=x:APCP:surface:0-6 hour acc fcst:
8:700:d=x:APCP:surface:5-6 hour acc fcst:
9:800:d=x:WEASD:surface:0-6 hour acc fcst:
10:900:d=x:WEASD:surface:5-6 hour acc fcst:
11:1000:d=x:SNOD:surface:6 hour fcst:
12:1100:d=x:TCDC:entire atmosphere:6 hour fcst:
13:1200:d=x:TMP:surface:6 hour fcst:
"""


def test_hrrr_urls_and_since_start_accumulation_selection():
    assert fetch.hrrr_url(RUN, 6).endswith(
        "hrrr.20260818/conus/hrrr.t12z.wrfsfcf06.grib2")
    assert fetch.hrrr_probe_url(RUN, 48).endswith("wrfsfcf48.grib2.idx")
    picked = fetch.hrrr_wanted(fetch.parse_idx(_HRRR_IDX), 6)
    keys = {(r["var"], r["level"], r["window"]) for r in picked}
    assert ("APCP", "surface", "0-6 hour acc fcst") in keys
    assert ("APCP", "surface", "5-6 hour acc fcst") not in keys
    assert ("WEASD", "surface", "0-6 hour acc fcst") in keys
    assert ("TMP", "surface", "6 hour fcst") not in keys
    assert len(picked) == 10

    # NOAA changes the wording exactly at day boundaries. These are still
    # since-start totals and must not become holes in otherwise-hourly data.
    day = fetch.parse_idx(
        "1:0:d=x:APCP:surface:0-1 day acc fcst:\n"
        "2:100:d=x:APCP:surface:23-24 hour acc fcst:\n"
        "3:200:d=x:WEASD:surface:0-1 day acc fcst:\n"
    )
    day_picked = fetch.hrrr_wanted(day, 24)
    assert {(r["var"], r["window"]) for r in day_picked} == {
        ("APCP", "0-1 day acc fcst"), ("WEASD", "0-1 day acc fcst")
    }

    analysis = fetch.parse_idx(
        "1:0:d=x:APCP:surface:0-0 day acc fcst:\n"
        "2:100:d=x:WEASD:surface:0-0 day acc fcst:\n"
    )
    assert len(fetch.hrrr_wanted(analysis, 0)) == 2
