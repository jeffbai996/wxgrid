"""Capabilities/time-index parsing and source picking in wxgrid.radar.

No network: every upstream call is stubbed. The XML fragments are trimmed from
what ECCC GeoMet and the NCEP GeoServer actually served on 2026-08-18 — the
namespaces, the nesting and the two different ways of writing a time dimension
are all real, because those are exactly the parts that break.
"""
from datetime import datetime, timezone

import numpy as np
import pytest

from wxgrid import radar

# ── fixtures ─────────────────────────────────────────────────────────────

# GeoMet: WMS 1.3.0, namespaced, layer nested two deep, time written as an
# interval. Real shape, three frames' worth of window.
GEOMET_CAPS = """<?xml version='1.0' encoding="UTF-8" standalone="no" ?>
<WMS_Capabilities version="1.3.0" xmlns="http://www.opengis.net/wms">
  <Capability>
    <Layer queryable="1">
      <Name>Weather Radar</Name>
      <Layer queryable="1">
        <Name>North American radar composite [1 km]</Name>
        <Layer queryable="1" opaque="0" cascaded="0">
          <Name>RADAR_1KM_RRAI</Name>
          <Title>Radar precipitation rate for rain [mm/h]</Title>
          <Dimension name="time" units="ISO8601" default="2026-08-18T22:06:00Z"
                     nearestValue="0">2026-08-18T21:48:00Z/2026-08-18T22:06:00Z/PT6M</Dimension>
          <Style><Name>RADARURPPRECIPR14</Name></Style>
        </Layer>
      </Layer>
    </Layer>
  </Capability>
</WMS_Capabilities>"""

# GeoServer: same version, same namespace, but every instant listed, with
# fractional seconds and a ragged ~2 min cadence.
MRMS_CAPS = """<?xml version="1.0" encoding="UTF-8"?>
<WMS_Capabilities version="1.3.0" xmlns="http://www.opengis.net/wms">
  <Capability>
    <Layer>
      <Title>NCEP</Title>
      <Layer queryable="1" opaque="0">
        <Name>conus_cref_qcd</Name>
        <Title>conus_cref_qcd</Title>
        <Dimension name="time" default="2026-08-18T22:12:41Z" units="ISO8601" nearestValue="1">2026-08-18T22:06:40.000Z,2026-08-18T22:08:40.000Z,2026-08-18T22:10:41.000Z,2026-08-18T22:12:41.000Z</Dimension>
        <Style><Name>radar_reflectivity</Name></Style>
      </Layer>
    </Layer>
  </Capability>
</WMS_Capabilities>"""

RAINVIEWER_JSON = {
    "version": "2.0", "generated": 1755556800, "host": "https://tilecache.rainviewer.com",
    "radar": {"past": [{"time": 1755556200, "path": "/v2/radar/aaa"}, {"time": 1755556800, "path": "/v2/radar/bbb"}],
              "nowcast": [{"time": 1755557400, "path": "/v2/radar/nowcast/ccc"}]},
}

def _ovation_points():
    """A believable nowcast: an auroral oval with actual area (a single 1° cell
    falls between samples once it is projected, which is a fixture artefact, not
    a bug), plus named cells the assertions below pin down."""
    pts = [[lon, lat, 30] for lon in range(0, 360) for lat in range(64, 73)]
    pts += [[0, -90, 6], [0, 0, 0], [180, 70, 55], [181, 70, 40], [359, 90, 0]]
    return pts


OVATION_JSON = {
    "Observation Time": "2026-08-18T22:05:00Z", "Forecast Time": "2026-08-18T22:53:00Z",
    "Data Format": "[Longitude, Latitude, Aurora]", "type": "MultiPoint",
    "coordinates": _ovation_points(),
}


@pytest.fixture(autouse=True)
def _clean_cache():
    radar.cache._d.clear()
    yield
    radar.cache._d.clear()


# ── ISO 8601 durations and instants ──────────────────────────────────────

def test_duration_parses_the_periods_wms_servers_actually_use():
    assert radar.parse_duration("PT6M") == 360
    assert radar.parse_duration("PT2M") == 120
    assert radar.parse_duration("PT1H") == 3600
    assert radar.parse_duration("PT10S") == 10
    assert radar.parse_duration("PT1H30M") == 5400
    assert radar.parse_duration("P1D") == 86400


def test_duration_rejects_things_that_are_not_durations():
    for bad in ("6M", "", "PT", "hello", "2026-08-18T22:06:00Z"):
        with pytest.raises(ValueError):
            radar.parse_duration(bad)


def test_instant_parses_with_and_without_fractional_seconds_and_is_utc():
    a = radar.parse_time("2026-08-18T22:06:00Z")
    b = radar.parse_time("2026-08-18T22:06:00.000Z")
    assert a == b == datetime(2026, 8, 18, 22, 6, tzinfo=timezone.utc)
    assert radar.parse_time("2026-08-18T22:06:00").tzinfo == timezone.utc


# ── time dimensions ──────────────────────────────────────────────────────

def test_interval_dimension_expands_to_every_frame_inclusive():
    got = radar.parse_time_dimension("2026-08-18T21:48:00Z/2026-08-18T22:06:00Z/PT6M")
    assert [t.strftime("%H:%M") for t in got] == ["21:48", "21:54", "22:00", "22:06"]


def test_list_dimension_is_sorted_and_deduplicated():
    got = radar.parse_time_dimension("2026-08-18T22:10:41.000Z,2026-08-18T22:06:40.000Z,2026-08-18T22:06:40.000Z")
    assert [t.strftime("%H:%M:%S") for t in got] == ["22:06:40", "22:10:41"]


def test_mixed_list_and_interval_both_land_in_the_same_series():
    got = radar.parse_time_dimension("2026-08-18T20:00:00Z,2026-08-18T21:48:00Z/2026-08-18T22:00:00Z/PT6M")
    assert [t.strftime("%H:%M") for t in got] == ["20:00", "21:48", "21:54", "22:00"]


def test_unparseable_pieces_are_skipped_not_fatal():
    assert radar.parse_time_dimension("garbage,2026-08-18T22:00:00Z,also/bad/stuff") == \
        [datetime(2026, 8, 18, 22, 0, tzinfo=timezone.utc)]


def test_backwards_or_zero_period_intervals_produce_nothing():
    assert radar.parse_time_dimension("2026-08-18T22:00:00Z/2026-08-18T21:00:00Z/PT6M") == []
    assert radar.parse_time_dimension("2026-08-18T21:00:00Z/2026-08-18T22:00:00Z/PT0S") == []


def test_long_series_is_thinned_evenly_and_keeps_the_newest_frame():
    # Two hours at 2 min: 61 frames, more than the tape wants to draw.
    dim = "2026-08-18T20:00:00Z/2026-08-18T22:00:00Z/PT2M"
    got = radar.parse_time_dimension(dim, max_frames=10)
    assert len(got) == 10
    assert got[-1] == datetime(2026, 8, 18, 22, 0, tzinfo=timezone.utc)   # newest survives exactly
    assert got[0] == datetime(2026, 8, 18, 20, 0, tzinfo=timezone.utc)    # so does the oldest
    gaps = {(got[i + 1] - got[i]).total_seconds() for i in range(len(got) - 1)}
    assert max(gaps) - min(gaps) <= 120                                   # evenly spread, not truncated


def test_short_series_is_left_alone():
    got = radar.parse_time_dimension("2026-08-18T21:48:00Z/2026-08-18T22:06:00Z/PT6M", max_frames=10)
    assert len(got) == 4


# ── WMS capabilities ─────────────────────────────────────────────────────

def test_geomet_time_dimension_found_through_two_levels_of_nesting():
    dim = radar.wms_time_dimension(GEOMET_CAPS, "RADAR_1KM_RRAI")
    assert dim == "2026-08-18T21:48:00Z/2026-08-18T22:06:00Z/PT6M"


def test_geoserver_time_dimension_found_and_is_the_explicit_list():
    dim = radar.wms_time_dimension(MRMS_CAPS, "conus_cref_qcd")
    assert dim and dim.startswith("2026-08-18T22:06:40.000Z,")


def test_unknown_layer_and_broken_xml_return_none_rather_than_raising():
    assert radar.wms_time_dimension(GEOMET_CAPS, "RADAR_1KM_NOPE") is None
    assert radar.wms_time_dimension("<not xml", "anything") is None


def test_dimension_is_inherited_from_a_parent_layer():
    caps = """<WMS_Capabilities version="1.3.0" xmlns="http://www.opengis.net/wms"><Capability>
      <Layer><Name>group</Name><Dimension name="time" units="ISO8601">2026-01-01T00:00:00Z</Dimension>
        <Layer><Name>child</Name></Layer></Layer></Capability></WMS_Capabilities>"""
    assert radar.wms_time_dimension(caps, "child") == "2026-01-01T00:00:00Z"


def test_oversized_capabilities_document_is_refused():
    with pytest.raises(ValueError):
        radar.wms_time_dimension("<a/>" + " " * (radar.MAX_CAPS_BYTES + 1), "a")


# ── frame lists ──────────────────────────────────────────────────────────

def test_eccc_frames_carry_epoch_iso_and_the_wms_time_token(monkeypatch):
    monkeypatch.setattr(radar, "_get_text", lambda *a, **k: GEOMET_CAPS)
    frames = radar.eccc_frames()
    assert len(frames) == 4
    assert frames[-1]["iso"] == "2026-08-18T22:06:00Z"
    assert frames[-1]["token"] == "2026-08-18T22:06:00Z"    # WMS TIME= wants the instant
    assert frames[-1]["time"] == int(datetime(2026, 8, 18, 22, 6, tzinfo=timezone.utc).timestamp())
    assert {f["kind"] for f in frames} == {"past"}          # agency radar is observation only


def test_mrms_frames_come_from_the_explicit_list(monkeypatch):
    monkeypatch.setattr(radar, "_get_text", lambda *a, **k: MRMS_CAPS)
    frames = radar.mrms_frames()
    assert [f["iso"] for f in frames] == ["2026-08-18T22:06:40Z", "2026-08-18T22:08:40Z",
                                          "2026-08-18T22:10:41Z", "2026-08-18T22:12:41Z"]


def test_capabilities_without_a_time_dimension_raises_so_the_chain_falls_back(monkeypatch):
    monkeypatch.setattr(radar, "_get_text", lambda *a, **k: "<WMS_Capabilities/>")
    with pytest.raises(ValueError):
        radar.eccc_frames()


def test_iem_frames_are_the_cache_name_suffixes_newest_last():
    # 2026-08-18T22:07:30Z; the caches are seeded on the 5-minute mark.
    frames = radar.iem_frames(now=1755554850.0)
    assert len(frames) == 12
    assert frames[-1]["token"] == ""                        # the unsuffixed layer is "latest"
    assert frames[-2]["token"] == "-m05m"
    assert frames[0]["token"] == "-m55m"
    assert [f["time"] for f in frames] == sorted(f["time"] for f in frames)
    assert frames[-1]["time"] - frames[0]["time"] == 55 * 60
    assert frames[-1]["time"] % 300 == 0


def test_iem_needs_no_network():
    # No monkeypatching at all: if this ever grew a request it would hang here.
    assert len(radar.iem_frames()) == 12


def test_rainviewer_frames_keep_past_and_nowcast_apart(monkeypatch):
    monkeypatch.setattr(radar, "_get_json", lambda *a, **k: RAINVIEWER_JSON)
    frames = radar.rainviewer_frames()
    assert [f["kind"] for f in frames] == ["past", "past", "nowcast"]
    assert frames[0]["token"] == "/v2/radar/aaa"
    assert all(f["host"] == "https://tilecache.rainviewer.com" for f in frames)


# ── the source catalogue ─────────────────────────────────────────────────

def test_a_dead_source_reports_the_error_instead_of_raising(monkeypatch):
    def boom():
        raise RuntimeError("connection reset by peer")
    monkeypatch.setitem(radar.SOURCE_SPECS["eccc"], "fetch", boom)
    s = radar.source("eccc")
    assert s["frames"] == [] and "connection reset" in s["error"]


def test_source_templates_keep_maplibre_placeholders_and_expose_ours(monkeypatch):
    monkeypatch.setattr(radar, "_get_text", lambda *a, **k: GEOMET_CAPS)
    s = radar.source("eccc")
    assert len(s["templates"]) == 2                          # rain and snow are separate WMS layers…
    assert "RADAR_1KM_RRAI" in s["templates"][0] and "RADAR_1KM_RSNO" in s["templates"][1]
    for t in s["templates"]:
        assert "{bbox-epsg-3857}" in t and "TIME={token}" in t
    assert "conus_cref_qcd" in radar.SOURCE_SPECS["mrms"]["templates"][0]
    assert "{z}/{x}/{y}" in radar.SOURCE_SPECS["iem"]["templates"][0]


def test_rainviewer_host_is_baked_into_the_template(monkeypatch):
    monkeypatch.setattr(radar, "_get_json", lambda *a, **k: RAINVIEWER_JSON)
    s = radar.source("rainviewer")
    assert s["templates"][0].startswith("https://tilecache.rainviewer.com{token}/256/")
    assert "host" not in s["frames"][0]                      # internal, not part of the wire format


def test_sources_names_a_pick_and_a_fallback_chain_ending_in_rainviewer(monkeypatch):
    monkeypatch.setattr(radar, "_get_text", lambda *a, **k: GEOMET_CAPS)
    monkeypatch.setattr(radar, "_get_json", lambda *a, **k: RAINVIEWER_JSON)
    cat = radar.sources(49.28, -123.12)
    assert cat["picked"] == "eccc"
    assert cat["order"][0] == "eccc" and cat["order"][-1] == "rainviewer"
    assert {s["id"] for s in cat["sources"]} == set(radar.SOURCE_SPECS)


def test_sources_without_a_centre_defaults_to_the_global_source(monkeypatch):
    monkeypatch.setattr(radar, "_get_json", lambda *a, **k: RAINVIEWER_JSON)
    monkeypatch.setattr(radar, "_get_text", lambda *a, **k: GEOMET_CAPS)
    assert radar.sources()["picked"] == "rainviewer"


def test_every_fallback_chain_terminates_in_a_global_source():
    for sid, chain in radar.FALLBACK.items():
        assert sid == "rainviewer" or "rainviewer" in chain
        assert sid not in chain                              # no source falls back to itself


# ── picking a source from the map centre ─────────────────────────────────

@pytest.mark.parametrize("name,lat,lon,want", [
    # Canada: ECCC's own 1 km composite
    ("Vancouver", 49.28, -123.12, "eccc"),
    ("Calgary", 51.05, -114.07, "eccc"),
    ("Winnipeg", 49.90, -97.14, "eccc"),
    ("Toronto", 43.65, -79.38, "eccc"),
    ("Montreal", 45.50, -73.57, "eccc"),
    ("Halifax", 44.65, -63.57, "eccc"),
    ("St John's", 47.56, -52.70, "eccc"),
    ("Iqaluit", 63.75, -68.52, "eccc"),
    ("Whitehorse", 60.72, -135.06, "eccc"),
    # CONUS: NOAA's own MRMS
    ("Seattle", 47.60, -122.33, "mrms"),
    ("Denver", 39.74, -104.99, "mrms"),
    ("Miami", 25.76, -80.19, "mrms"),
    ("Boston", 42.36, -71.06, "mrms"),
    ("Buffalo", 42.89, -78.88, "mrms"),
    ("Detroit", 42.33, -83.05, "mrms"),
    ("Portland ME", 43.66, -70.26, "mrms"),
    ("Fargo", 46.88, -96.79, "mrms"),
    # No keyless agency composite: the global fallback
    ("Anchorage", 61.20, -149.90, "rainviewer"),
    ("Honolulu", 21.30, -157.86, "rainviewer"),
    ("Mexico City", 19.43, -99.13, "rainviewer"),
    ("London", 51.50, -0.13, "rainviewer"),
    ("Tokyo", 35.68, 139.69, "rainviewer"),
    ("Sydney", -33.87, 151.21, "rainviewer"),
    ("mid-Atlantic", 40.00, -40.00, "rainviewer"),
])
def test_source_picked_for_a_map_centre(name, lat, lon, want):
    assert radar.pick_source(lat, lon) == want, name


def test_the_border_runs_along_the_49th_in_the_west_and_dips_through_the_lakes():
    assert radar.border_lat(-120.0) == pytest.approx(49.0)
    assert radar.border_lat(-100.0) == pytest.approx(49.0)
    assert radar.border_lat(-79.5) < 44.0                   # Lake Ontario, not 49
    assert radar.border_lat(-73.0) == pytest.approx(45.0)   # the Quebec/NY straight line
    assert radar.border_lat(-60.0) < 44.0                   # open water south of Nova Scotia


def test_the_border_is_monotonic_nowhere_but_always_finite():
    lons = np.linspace(-141.0, -52.0, 400)
    lats = np.array([radar.border_lat(x) for x in lons])
    assert np.isfinite(lats).all()
    assert lats.min() > 40.0 and lats.max() <= 60.0


def test_a_point_just_either_side_of_the_line_picks_a_different_agency():
    lon = -100.0                                            # prairie border, exactly 49°N
    assert radar.pick_source(49.05, lon) == "eccc"
    assert radar.pick_source(48.95, lon) == "mrms"


# ── aurora ───────────────────────────────────────────────────────────────

def test_ovation_lands_on_a_lat_lon_grid_with_the_probabilities_where_they_belong(monkeypatch):
    monkeypatch.setattr(radar, "_get_json", lambda *a, **k: OVATION_JSON)
    ov = radar.ovation()
    grid = np.asarray(ov["grid"], dtype=np.float32)
    assert grid.shape == (radar.OV_LAT, radar.OV_LON)
    assert grid[0, 0] == 6                                  # lat -90, lon 0
    assert grid[70 + 90, 180] == 55                         # lat 70, lon 180
    assert ov["observation_time"] == "2026-08-18T22:05:00Z"
    assert ov["max_pct"] == 55.0


def test_mercator_projection_puts_north_at_the_top_and_wraps_longitude():
    grid = np.zeros((radar.OV_LAT, radar.OV_LON), dtype=np.float32)
    grid[60 + 90, :] = 100.0                                # a band right around 60°N
    merc = radar.to_mercator(grid, width=64, height=64)
    assert merc.shape == (64, 64)
    hot = merc.mean(axis=1)
    assert hot[: 32].max() > hot[32:].max()                 # the band is in the northern half
    # Longitude 0 sits mid-image (col 32), and the band is uniform, so no seam.
    assert merc[hot.argmax()].std() < 1e-3


def test_aurora_png_is_transparent_where_nothing_is_happening(monkeypatch):
    monkeypatch.setattr(radar, "_get_json", lambda *a, **k: OVATION_JSON)
    png = radar.aurora_png(width=64, height=64)
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    from PIL import Image
    import io
    a = np.array(Image.open(io.BytesIO(png)))
    assert a.shape == (64, 64, 4)
    assert a[..., 3].max() > 0                              # the 55 % cell drew something
    assert (a[..., 3] == 0).mean() > 0.5                    # and most of the world did not


def test_the_colour_ramp_is_transparent_below_the_noise_floor_and_runs_green_to_magenta():
    lut = radar._aurora_lut()
    assert lut.shape == (256, 4)
    below = int(radar.AURORA_MIN_PCT / 100.0 * 255)
    assert lut[: below + 1, 3].max() == 0                   # under 2 %: nothing at all
    assert lut[-1, 3] > 0
    lo, hi = lut[int(0.08 * 255)], lut[-1]
    assert lo[1] > lo[0] and lo[1] > lo[2]                  # low end is green
    assert hi[0] > hi[1] and hi[2] > hi[1]                  # high end is magenta


def test_aurora_meta_carries_the_validity_times_and_kp(monkeypatch):
    monkeypatch.setattr(radar, "_get_json",
                        lambda url, *a, **k: OVATION_JSON if "ovation" in url else
                        [{"time_tag": "2026-08-18T22:08:00", "kp_index": 3, "estimated_kp": 3.0, "kp": "3Z"}])
    m = radar.aurora_meta()
    assert m["forecast_time"] == "2026-08-18T22:53:00Z" and m["max_pct"] == 55.0
    assert m["kp"]["kp"] == 3.0 and m["kp"]["kp_index"] == 3
    assert m["min_pct"] == radar.AURORA_MIN_PCT and m["stops"][0]["rgb"]


def test_a_dead_kp_feed_does_not_take_the_aurora_layer_with_it(monkeypatch):
    def fake(url, *a, **k):
        if "ovation" in url:
            return OVATION_JSON
        raise RuntimeError("SWPC timed out")
    monkeypatch.setattr(radar, "_get_json", fake)
    m = radar.aurora_meta()
    assert m["kp"] is None and m["max_pct"] == 55.0


# ── lightning ────────────────────────────────────────────────────────────

def test_lightning_is_declared_unavailable_with_a_reason_and_no_upstream():
    st = radar.LIGHTNING_STATUS
    assert st["available"] is False
    assert "GIBS" in st["reason"] and "Blitzortung" in st["reason"]
    assert st["alternative"]
    assert not [k for k in dir(radar) if k.startswith("lightning_") or k.endswith("_strikes")]
