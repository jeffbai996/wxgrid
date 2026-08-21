"""Route forecast: sampling, timing, hazards — plus the WebP layer path.

The store is faked the way tests/test_api.py fakes it: a real RunWriter into
the scratch data dir conftest points the package at, with fields shaped so
every assertion has one obvious cause. Temperature varies with the STEP (so a
sample proves it read the step it would arrive on) and gusts vary with
LONGITUDE (so a sample proves it read the place it would be).
"""
from datetime import datetime, timedelta, timezone

import io
import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from wxgrid import render, route, route_api
from wxgrid.config import GRID_LAT_N, GRID_LON_N, STORE_DIR
from wxgrid.store import RunReader, RunWriter

MODEL, RID = "gfs", "2026-01-01T00"
STEPS = [0, 6, 12, 18, 24]
T0 = datetime(2026, 1, 1, tzinfo=timezone.utc)
LONS = np.linspace(-180, 179.75, GRID_LON_N, dtype=np.float32)


def _full(val):
    return np.full((GRID_LAT_N, GRID_LON_N), val, np.float32)


def _client():
    """The router on its own app — mounting it into wxgrid.api is the parent
    app's job, and these tests should not depend on that having happened."""
    app = FastAPI()
    app.include_router(route_api.router)
    return TestClient(app)


@pytest.fixture(scope="module")
def reader():
    variables = ["u10", "v10", "t2m", "d2m", "gust", "tp6", "sf6", "tcc",
                 "u_850", "v_850", "t_850", "gh_850", "u_700", "v_700", "t_700", "gh_700"]
    w = RunWriter(MODEL, RID, STEPS, variables, root=STORE_DIR)
    # Gusts: calm west of 110°W, 30 m/s east of it. A west→east route crosses
    # the line halfway and only the second half should flag.
    gust = np.tile(np.where(LONS >= -110.0, 30.0, 2.0).astype(np.float32), (GRID_LAT_N, 1))
    for s in STEPS:
        w.write("u10", s, _full(5.0)); w.write("v10", s, _full(0.0))
        w.write("t2m", s, _full(273.15 + s))          # +1 K per forecast hour
        w.write("d2m", s, _full(268.15 + s))          # 5 K dew-point depression
        w.write("gust", s, gust)
        w.write("tp6", s, _full(0.0 if s == 0 else 12.0))   # 12 mm per 6 h bucket
        w.write("sf6", s, _full(0.0))
        w.write("tcc", s, _full(0.5))
        # 850 hPa +5 °C at 1500 m, 700 hPa -5 °C at 3000 m → freezing level 2250 m
        w.write("u_850", s, _full(10.0)); w.write("v_850", s, _full(0.0))
        w.write("t_850", s, _full(278.15)); w.write("gh_850", s, _full(1500.0))
        w.write("u_700", s, _full(20.0)); w.write("v_700", s, _full(0.0))
        w.write("t_700", s, _full(268.15)); w.write("gh_700", s, _full(3000.0))
    w.finish()
    return RunReader(MODEL, RID, root=STORE_DIR)


# ── planning (pure geometry, no store) ────────────────────────────────────

def test_plan_spaces_samples_by_travel_time_and_ends_at_the_destination():
    pts = route.plan([(-123.0, 49.0), (-121.0, 49.0)], T0, speed_kmh=100.0)
    assert pts[0].dist_km == 0 and pts[0].hours == 0
    assert pts[-1].lon == pytest.approx(-121.0, abs=0.01) and pts[-1].lat == pytest.approx(49.0, abs=0.01)
    assert pts[-1].hours == pytest.approx(pts[-1].dist_km / 100.0, rel=1e-3)
    assert [p.dist_km for p in pts] == sorted(p.dist_km for p in pts)
    assert [p.eta for p in pts] == sorted(p.eta for p in pts)
    assert pts[-1].eta == T0 + timedelta(hours=pts[-1].hours)


def test_plan_uses_per_leg_durations_when_given():
    pts = route.plan([(0.0, 0.0), (1.0, 0.0), (2.0, 0.0)], T0, legs_h=[1.0, 3.0], samples=5)
    assert pts[-1].hours == pytest.approx(4.0, rel=1e-6)
    mid = min(pts, key=lambda p: abs(p.dist_km - pts[-1].dist_km / 2))
    assert mid.hours == pytest.approx(1.0, abs=0.05)      # halfway in space, 1 h in — the slow leg is second


def test_plan_rejects_impossible_routes():
    with pytest.raises(ValueError):
        route.plan([(0.0, 0.0)], T0, speed_kmh=50)
    with pytest.raises(ValueError):
        route.plan([(0.0, 0.0), (1.0, 0.0)], T0, speed_kmh=0)
    with pytest.raises(ValueError):
        route.plan([(0.0, 0.0), (1.0, 0.0), (2.0, 0.0)], T0, legs_h=[1.0])
    with pytest.raises(ValueError):
        route.plan([(3.0, 3.0), (3.0, 3.0)], T0, speed_kmh=50)


def test_plan_honours_an_explicit_sample_spacing():
    pts = route.plan([(0.0, 0.0), (2.0, 0.0)], T0, speed_kmh=100.0, every_km=50.0)
    gaps = [b.dist_km - a.dist_km for a, b in zip(pts, pts[1:])]
    assert all(g <= 50.0 + 1e-6 for g in gaps)
    assert pts[-1].dist_km == pytest.approx(route.path_length_km([(0.0, 0.0), (2.0, 0.0)])[0], abs=0.01)


def test_a_tiny_spacing_widens_instead_of_exploding():
    """every_km=1 m over a long route would be millions of store reads."""
    pts = route.plan([(-125.0, 49.0), (-70.0, 45.0)], T0, speed_kmh=100.0, every_km=0.001)
    assert len(pts) <= route.MAX_SAMPLES + 1
    assert len(route.plan([(0.0, 0.0), (1.0, 0.0)], T0, speed_kmh=50.0, samples=10_000)) == route.MAX_SAMPLES


# ── derived weather (pure) ────────────────────────────────────────────────

def test_visibility_proxy_falls_with_humidity_and_falls_faster_in_snow():
    assert route.visibility_km(50, None, None) > route.visibility_km(90, None, None) > route.visibility_km(100, None, None)
    assert route.visibility_km(100, None, None) < 1.5              # fog-ish at saturation
    assert route.visibility_km(60, 2.0, "snow") < route.visibility_km(60, 2.0, "rain")
    assert route.visibility_km(None, None, None) is None


def test_precip_type_prefers_the_models_own_snowfall_split():
    assert route.precip_type(2.0, 1.9, 280.0, 4000.0, 0.0) == "snow"    # warm surface, but the model says snow
    assert route.precip_type(2.0, 0.6, 280.0, 4000.0, 0.0) == "mixed"
    assert route.precip_type(2.0, 0.0, 280.0, 4000.0, 0.0) == "rain"
    assert route.precip_type(2.0, None, 270.0, None, None) == "snow"    # no sf6: falls back to temperature
    assert route.precip_type(2.0, None, 285.0, 500.0, 1500.0) == "snow"  # freezing level below the ground
    assert route.precip_type(0.0, None, 270.0, None, None) is None


def test_hazards_flag_gusts_freezing_level_and_ice():
    thr = route.THRESHOLDS
    level, flags = route.hazards({"gust": 26.0}, None, thr)
    assert flags == ["gust"] and level == 2
    level, flags = route.hazards({"freezing_level_m": 900}, 1200.0, thr)
    assert "freezing" in flags and level == 1
    level, flags = route.hazards({"precip_mm_h": 1.0, "ptype": "rain", "t2m": 272.0}, None, thr)
    assert "ice" in flags and level == 2
    assert route.hazards({"gust": 3.0, "precip_mm_h": 0.0, "vis_km": 30.0}, 0.0, thr) == (0, [])


def test_segments_group_contiguous_bad_stretches():
    rows = [{"i": i, "hazard": h, "flags": f, "dist_km": i * 10.0, "eta": f"t{i}"}
            for i, (h, f) in enumerate([(0, []), (1, ["gust"]), (2, ["gust", "snow"]), (0, []), (1, ["vis"])])]
    segs = route._segments(rows)
    assert len(segs) == 2
    assert segs[0]["from_i"] == 1 and segs[0]["to_i"] == 2 and segs[0]["level"] == 2
    assert segs[0]["flags"] == ["gust", "snow"]
    assert segs[1]["from_i"] == segs[1]["to_i"] == 4


def test_crossed_alerts_reports_only_the_polygon_the_route_enters():
    layer = {"features": [
        {"geometry": {"type": "Polygon", "coordinates": [[[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]]]},
         "properties": {"id": "A", "event": "Wind Warning", "sev": 3, "source": "NWS"}},
        {"geometry": {"type": "Polygon", "coordinates": [[[50, 50], [51, 50], [51, 51], [50, 51], [50, 50]]]},
         "properties": {"id": "B", "event": "Far Away", "sev": 4, "source": "NWS"}},
    ]}
    rows = [{"lon": -5.0, "lat": 0.0, "dist_km": 0.0, "eta": "t0"},
            {"lon": 0.0, "lat": 0.0, "dist_km": 100.0, "eta": "t1"},
            {"lon": 0.5, "lat": 0.5, "dist_km": 150.0, "eta": "t2"}]
    hits = route.crossed_alerts(rows, layer)
    assert [h["event"] for h in hits] == ["Wind Warning"]
    assert hits[0]["samples"] == 2 and hits[0]["from_km"] == 100.0 and hits[0]["to_km"] == 150.0
    assert route.crossed_alerts(rows, None) == []


# ── sampling against a real (seeded) run ──────────────────────────────────

def test_sample_reads_the_step_it_would_arrive_on(reader):
    """t2m rises 1 K per forecast hour, so the temperature a sample reports is
    a direct readout of the valid time it used."""
    out = route.route_forecast(reader, [(-123.0, 49.0), (-121.0, 49.0)], T0, speed_kmh=25.0, samples=5)
    got = [s["t2m"] - 273.15 for s in out["samples"]]
    hours = [s["hours"] for s in out["samples"]]
    assert got == pytest.approx(hours, abs=0.05)
    assert out["samples"][0]["eta"].startswith("2026-01-01T00:00")
    assert out["duration_h"] == pytest.approx(hours[-1], rel=1e-6)


def test_precip_rate_divides_the_bucket_by_its_own_window(reader):
    out = route.route_forecast(reader, [(-123.0, 49.0), (-122.0, 49.0)], T0, speed_kmh=20.0, samples=4)
    late = out["samples"][-1]
    assert late["precip_bucket_mm"] == 12.0 and late["bucket_h"] == 6.0
    assert late["precip_mm_h"] == pytest.approx(2.0)
    assert late["ptype"] == "rain"                       # sf6 is zero, so the model says liquid
    assert out["summary"]["total_precip_mm"] > 0


def test_gusts_flag_only_the_stretch_that_has_them(reader):
    """Gusts are 2 m/s west of 110°W and 30 m/s east of it."""
    out = route.route_forecast(reader, [(-125.0, 49.0), (-95.0, 49.0)], T0, speed_kmh=1000.0, samples=13)
    flagged = [s for s in out["samples"] if "gust" in s["flags"]]
    calm = [s for s in out["samples"] if "gust" not in s["flags"]]
    assert flagged and calm
    assert max(s["lon"] for s in calm) < min(s["lon"] for s in flagged)
    assert all(s["lon"] >= -110.0 for s in flagged)
    segs = out["summary"]["segments"]
    assert len(segs) == 1 and segs[0]["to_i"] == len(out["samples"]) - 1
    assert out["summary"]["worst_gust"]["value"] == pytest.approx(30.0)
    assert out["summary"]["hazard"] == 2


def test_freezing_level_below_the_ground_is_a_hazard(reader):
    path = [(-123.0, 49.0), (-122.0, 49.0)]
    pts = route.plan(path, T0, speed_kmh=50.0, samples=3)
    high = route.forecast(reader, pts, elevs=[3000.0] * len(pts))
    assert all(s["freezing_level_m"] == 2250 for s in high["samples"])
    assert all("freezing" in s["flags"] for s in high["samples"])
    low = route.forecast(reader, route.plan(path, T0, speed_kmh=50.0, samples=3), elevs=[0.0] * len(pts))
    assert not any("freezing" in s["flags"] for s in low["samples"])


def test_samples_past_the_end_of_the_run_are_flagged_not_faked(reader):
    depart = T0 + timedelta(hours=20)
    out = route.route_forecast(reader, [(-123.0, 49.0), (-100.0, 49.0)], depart, speed_kmh=100.0)
    assert out["samples"][0]["outside_run"] is False
    tail = out["samples"][-1]
    assert tail["outside_run"] is True
    assert tail["t2m"] is None and tail["wind"] is None and tail["flags"] == []
    assert out["summary"]["outside_run"] > 0


def test_wind_direction_comes_from_the_components(reader):
    out = route.route_forecast(reader, [(-123.0, 49.0), (-122.0, 49.0)], T0, speed_kmh=50.0, samples=3)
    assert all(s["wind"] == pytest.approx(5.0) for s in out["samples"])
    assert all(s["wdir"] == 270 for s in out["samples"])          # +u is a westerly


# ── the endpoint ──────────────────────────────────────────────────────────

def test_route_endpoint_returns_samples_and_a_summary(reader):
    c = _client()
    r = c.get("/api/route", params={"path": "-125,49;-95,49", "depart": "2026-01-01T00:00Z",
                                    "speed_kmh": 1000, "model": MODEL, "run": RID,
                                    "terrain": "false", "alerts": "false", "samples": 13})
    assert r.status_code == 200
    d = r.json()
    assert d["model"] == MODEL and d["run"] == RID
    assert len(d["samples"]) == 13
    assert d["summary"]["worst_gust"]["value"] == pytest.approx(30.0)
    assert d["summary"]["crosses_warning"] is False
    assert d["units"]["t2m"] == "K"
    assert set(route.THRESHOLDS) <= set(d["thresholds"])


def test_route_endpoint_accepts_a_posted_path_and_custom_thresholds(reader):
    c = _client()
    body = {"path": [[-125, 49], [-95, 49]], "depart": "2026-01-01T00:00Z", "speed_kmh": 1000,
            "model": MODEL, "run": RID, "terrain": False, "alerts": False, "samples": 13,
            "thresholds": {"gust_ms": 40.0}}
    d = c.post("/api/route", json=body).json()
    assert d["thresholds"]["gust_ms"] == 40.0
    assert not any("gust" in s["flags"] for s in d["samples"])     # 30 m/s no longer clears the bar


def test_route_endpoint_rejects_nonsense(reader):
    c = _client()
    base = {"model": MODEL, "run": RID, "terrain": "false", "alerts": "false"}
    assert c.get("/api/route", params={**base, "path": "-125,49"}).status_code == 400
    assert c.get("/api/route", params={**base, "path": "north,49;-95,49"}).status_code == 400
    assert c.get("/api/route", params={**base, "path": "-125,49;-95,49", "depart": "yesterday"}).status_code == 400
    assert c.get("/api/route", params={**base, "path": "-125,49;-95,49", "model": "nope"}).status_code == 404
    assert c.get("/api/route/thresholds").json()["thresholds"]["gust_ms"] == route.THRESHOLDS["gust_ms"]


# ── WebP layers ───────────────────────────────────────────────────────────

def _rgba(blob):
    return np.asarray(Image.open(io.BytesIO(blob)).convert("RGBA"))


@pytest.mark.parametrize("layer", ["temp", "wind", "tp6", "tcc"])
def test_webp_layer_decodes_to_exactly_the_png_pixels(layer):
    rng = np.random.default_rng(7)
    lo, hi = render.RAMPS[layer]["lo"], render.RAMPS[layer]["hi"]
    field = (lo + (hi - lo) * rng.random((64, 128))).astype(np.float32)
    field[:4, :4] = np.nan
    png, webp = render.colorize(field, layer), render.colorize(field, layer, fmt="webp")
    assert Image.open(io.BytesIO(webp)).format == "WEBP"
    assert np.array_equal(_rgba(png), _rgba(webp))       # including the alpha under the ramp


def test_webp_is_smaller_than_the_png_on_a_real_shaped_field():
    """Alpha layers are where WebP wins big — the PNG carries them as RGBA."""
    y, x = np.mgrid[0:256, 0:512]
    field = np.where((x % 90) < 30, 12.0 * np.sin(y / 40.0) ** 2, 0.0).astype(np.float32)
    png, webp = render.colorize(field, "tp6"), render.colorize(field, "tp6", fmt="webp")
    assert len(webp) < len(png)
    assert np.array_equal(_rgba(png), _rgba(webp))


def test_all_missing_field_is_transparent_in_webp_too():
    field = np.full((32, 64), np.nan, dtype=np.float32)
    assert _rgba(render.colorize(field, "gust", fmt="webp"))[..., 3].max() == 0


def test_pick_format_and_cache_name_follow_the_accept_header():
    assert render.pick_format("image/avif,image/webp,*/*") == "webp"
    assert render.pick_format("image/png,*/*") == "png"
    assert render.pick_format(None) == "png"
    assert render.layer_cache_name(6, "wind-850", "image/webp") == (
        f"006-{render.LAYER_CACHE_VERSION}-wind-850.webp", "webp", "image/webp")
    assert render.layer_cache_name(6, "wind", None) == (
        f"006-{render.LAYER_CACHE_VERSION}-wind.png", "png", "image/png")
    with pytest.raises(ValueError):
        render.colorize(np.zeros((4, 4), np.float32), "temp", fmt="gif")
