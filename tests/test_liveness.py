"""wxgrid.liveness — no network: every upstream call is stubbed or bypassed by
calling the assertion functions directly with crafted data."""
import io
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

import pytest
from PIL import Image

from wxgrid import liveness


def _solid_png(size=(64, 64), color=(10, 20, 30, 255)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGBA", size, color).save(buf, format="PNG")
    return buf.getvalue()


def _multicolor_png(size=(64, 64)) -> bytes:
    import random
    rng = random.Random(7)
    im = Image.new("RGBA", size, (0, 0, 0, 0))
    px = im.load()
    for x in range(size[0]):
        for y in range(size[1]):
            px[x, y] = (rng.randrange(256), rng.randrange(256), rng.randrange(256), 255)
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    return buf.getvalue()      # random noise defeats PNG's compression, so this is comfortably >200 bytes


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


NOW = datetime.now(timezone.utc)


# ── the two assertions the handoff calls out specifically ─────────────────

def test_ec_feature_info_rejects_a_200_that_is_not_a_feature_collection():
    """This is the exact shape of the bug: GeoMet answered 200 to a
    GetFeatureInfo request with an XML ServiceExceptionReport body instead of
    the requested JSON. r.json() upstream of this would already raise on that
    body (a non-JSON payload can't decode), but the explicit shape check must
    independently reject anything that isn't a real FeatureCollection too —
    an upstream that started answering with, say, {"error": "..."} instead of
    changing content-type entirely would sail past a bare "did json() raise?"
    check and still needs to be caught here."""
    with pytest.raises(AssertionError, match="FeatureCollection"):
        liveness._assert_ec_feature_info({"error": "InvalidLayersParameter"})
    with pytest.raises(AssertionError):
        liveness._assert_ec_feature_info("<ServiceExceptionReport/>")


def test_ec_feature_info_accepts_a_real_feature_collection():
    detail = liveness._assert_ec_feature_info({"type": "FeatureCollection", "features": []})
    assert "0 feature" in detail
    detail = liveness._assert_ec_feature_info({"type": "FeatureCollection", "features": [{}, {}]})
    assert "2 feature" in detail


def test_wms_raster_single_colour_is_judged_down():
    """A raster that is one flat colour end to end — exactly what a blank or
    error tile looks like — must fail the liveness check even though the HTTP
    call itself succeeded and returned a well-formed PNG."""
    with pytest.raises(AssertionError, match="1 distinct colour"):
        liveness._assert_ec_wms_raster(("image/png", _solid_png()))


def test_wms_raster_rejects_a_non_image_content_type():
    with pytest.raises(AssertionError, match="not an image"):
        liveness._assert_ec_wms_raster(("text/xml", b"<ServiceExceptionReport/>"))


def test_wms_raster_with_real_variation_is_judged_live():
    detail = liveness._assert_ec_wms_raster(("image/png", _multicolor_png()))
    assert "distinct colour" in detail
    # sanity: the multicolour fixture really does carry more than one colour
    assert liveness._distinct_colors(_multicolor_png()) > 1
    assert liveness._distinct_colors(_solid_png()) == 1


# ── timestamp parsing ───────────────────────────────────────────────────────

def test_age_seconds_handles_z_millis_epoch_and_missing():
    now = datetime.now(timezone.utc)
    assert 0 <= liveness._age_seconds(now.strftime("%Y-%m-%dT%H:%M:%S.000Z")) < 5
    assert 0 <= liveness._age_seconds(now.strftime("%Y-%m-%dT%H:%M:%S")) < 5     # no tz at all
    assert 0 <= liveness._age_seconds(now.timestamp()) < 5                        # epoch float
    assert liveness._age_seconds(None) is None
    assert liveness._age_seconds("") is None
    assert liveness._age_seconds("not a timestamp") is None


def test_age_seconds_on_a_stale_timestamp_is_large():
    old = datetime.now(timezone.utc) - timedelta(days=2)
    assert liveness._age_seconds(_iso(old)) > 3600


# ── registry sanity ─────────────────────────────────────────────────────────

def test_registry_has_unique_nonempty_keys_and_labels():
    keys = [p.key for p in liveness.PROBES]
    assert len(keys) == len(set(keys)) and len(keys) > 20
    for p in liveness.PROBES:
        assert p.key and p.label
        assert callable(p.call) and callable(p.assertion)


# ── per-source assertions: happy path + a shape that must fail ─────────────

def test_nominatim_assertion():
    assert "Vancouver" in liveness._assert_nominatim(
        [{"lat": "49.28", "lon": "-123.12", "display_name": "Vancouver, BC"}])
    with pytest.raises(AssertionError):
        liveness._assert_nominatim([])
    with pytest.raises(AssertionError):
        liveness._assert_nominatim({"error": "blocked"})


def test_elevation_assertion_rejects_implausible_values():
    assert "1599" in liveness._assert_elevation({"elevation": [1599.0]})
    with pytest.raises(AssertionError):
        liveness._assert_elevation({"elevation": [-9999.0]})
    with pytest.raises(AssertionError):
        liveness._assert_elevation({"elevation": []})


def test_timezone_assertion_checks_the_known_zone():
    assert "America/Vancouver" in liveness._assert_timezone(
        {"timezone": "America/Vancouver", "utc_offset_seconds": -25200})
    with pytest.raises(AssertionError):
        liveness._assert_timezone({"timezone": "UTC", "utc_offset_seconds": 0})


def test_metar_assertion_rejects_a_stale_report():
    fresh = [{"reportTime": _iso(datetime.now(timezone.utc) - timedelta(minutes=10))}]
    assert "KSEA" in liveness._assert_metar(fresh)
    stale = [{"reportTime": _iso(datetime.now(timezone.utc) - timedelta(hours=10))}]
    with pytest.raises(AssertionError, match="stale"):
        liveness._assert_metar(stale)
    with pytest.raises(AssertionError):
        liveness._assert_metar([])


def test_taf_assertion_checks_the_raw_body():
    assert "issued" in liveness._assert_taf([{"issueTime": "t", "rawTAF": "TAF KSEA 252320Z"}])
    with pytest.raises(AssertionError):
        liveness._assert_taf([{"rawTAF": "Unable to retrieve the data"}])


def test_avalanche_assertions_require_nonzero_regions():
    assert "3 forecast region" in liveness._assert_avalanche_ca(
        {"features": [{}, {}, {}]})
    with pytest.raises(AssertionError):
        liveness._assert_avalanche_ca({"features": []})
    assert "1 forecast zone" in liveness._assert_avalanche_org({"features": [{}]})
    with pytest.raises(AssertionError):
        liveness._assert_avalanche_org({})


def test_nws_alerts_assertion_needs_total_and_areas():
    assert "12 active" in liveness._assert_nws_alerts({"total": 12, "areas": {"CA": 3}})
    with pytest.raises(AssertionError):
        liveness._assert_nws_alerts({"total": None, "areas": {}})
    with pytest.raises(AssertionError):
        liveness._assert_nws_alerts({"total": 5})


_ATOM_FEED = """<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>MeteoAlarm</title>
<entry><title>a</title></entry></feed>"""


def test_meteoalarm_assertion_requires_an_atom_feed():
    assert "1 entry" in liveness._assert_meteoalarm(_ATOM_FEED)
    with pytest.raises(AssertionError, match="not an Atom"):
        liveness._assert_meteoalarm("<rss><channel/></rss>")
    with pytest.raises(ET.ParseError):
        liveness._assert_meteoalarm("<ServiceExceptionReport>not atom</ServiceExceptionReport")  # malformed


def test_bom_assertion_requires_a_nonempty_listing():
    assert "3 active" in liveness._assert_bom(["a.cap.xml", "b.cap.xml", "c.cap.xml", "IDQ10095.xml"])
    with pytest.raises(AssertionError):
        liveness._assert_bom([])
    with pytest.raises(AssertionError):
        liveness._assert_bom(None)


def test_bom_quiet_day_with_no_cap_files_is_live_not_failed():
    # A populated FWO directory with zero CAP-AU products is a lull, not rot.
    msg = liveness._assert_bom(["IDQ10095.xml", "IDN10064.xml"])
    assert msg.startswith("0 active") and "quiet" in msg


def test_nhc_assertion_checks_activestorms_list():
    assert "2 active" in liveness._assert_nhc({"activeStorms": [{}, {}]})
    with pytest.raises(AssertionError):
        liveness._assert_nhc({"activeStorms": "none"})
    with pytest.raises(AssertionError):
        liveness._assert_nhc({})


_JTWC_RSS = "<rss><channel><item>a</item><item>b</item></channel></rss>"


def test_jtwc_assertion_requires_rss_channel():
    assert "2 basin" in liveness._assert_jtwc(_JTWC_RSS)
    with pytest.raises(AssertionError, match="not <rss>"):
        liveness._assert_jtwc("<feed><channel/></feed>")
    with pytest.raises(AssertionError, match="channel"):
        liveness._assert_jtwc("<rss></rss>")


def test_atcf_adeck_assertion_requires_current_season_files():
    year = datetime.now(timezone.utc).year
    html = f'<a href="aal01{year}.dat.gz">x</a> <a href="aep02{year}.dat.gz">y</a>'
    assert "2 a-deck" in liveness._assert_atcf_adeck(html)
    with pytest.raises(AssertionError, match="no a-deck"):
        liveness._assert_atcf_adeck("<html>nothing here</html>")
    stale_html = '<a href="aal012019.dat.gz">x</a>'
    with pytest.raises(AssertionError, match="no a-deck file from"):
        liveness._assert_atcf_adeck(stale_html)


def test_air_quality_assertion_needs_an_aqi_value():
    fresh = {"current": {"us_aqi": 42, "time": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M")}}
    assert "AQI 42" in liveness._assert_air_quality(fresh)
    with pytest.raises(AssertionError):
        liveness._assert_air_quality({"current": {}})


def test_tide_station_assertions_need_enough_stations():
    stations = [{"latitude": 49.0, "longitude": -123.0}] * 150
    assert "150 station" in liveness._assert_dfo_tides(stations)
    with pytest.raises(AssertionError):
        liveness._assert_dfo_tides([{"latitude": 1, "longitude": 1}])
    assert "200 station" in liveness._assert_noaa_tides({"stations": [{}] * 200})
    with pytest.raises(AssertionError):
        liveness._assert_noaa_tides({"stations": []})


def test_radar_frames_assertion_flags_a_stale_newest_frame():
    fresh = [{"time": time.time() - 60}]
    assert "1 frame" in liveness._assert_radar_frames(fresh, 1200, "test radar")
    stale = [{"time": time.time() - 100000}]
    with pytest.raises(AssertionError, match="min old"):
        liveness._assert_radar_frames(stale, 1200, "test radar")
    with pytest.raises(AssertionError):
        liveness._assert_radar_frames([], 1200, "test radar")


def test_rainviewer_assertion_ignores_future_nowcast_frames():
    frames = [{"time": time.time() - 300, "kind": "past"},
              {"time": time.time() + 3600, "kind": "nowcast"}]
    assert "1 past frame" in liveness._assert_rainviewer(frames)
    with pytest.raises(AssertionError):
        liveness._assert_rainviewer([{"time": time.time() + 100, "kind": "nowcast"}])


def test_ovation_assertion_requires_a_recent_observation():
    fresh = {"grid": [[1.0]], "observation_time": _iso(datetime.now(timezone.utc)), "max_pct": 5.0}
    assert "max 5.0" in liveness._assert_ovation(fresh)
    stale = {"grid": [[1.0]], "observation_time": _iso(datetime.now(timezone.utc) - timedelta(hours=6))}
    with pytest.raises(AssertionError, match="stale"):
        liveness._assert_ovation(stale)
    with pytest.raises(AssertionError):
        liveness._assert_ovation({"grid": []})


def test_kp_assertion_rejects_none_and_stale():
    fresh = {"kp": 2.3, "time": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")}
    assert "Kp 2.3" in liveness._assert_kp(fresh)
    with pytest.raises(AssertionError, match="nothing"):
        liveness._assert_kp(None)
    stale = {"kp": 1.0, "time": (datetime.now(timezone.utc) - timedelta(hours=3)).strftime("%Y-%m-%dT%H:%M:%S")}
    with pytest.raises(AssertionError, match="stale"):
        liveness._assert_kp(stale)


def test_iem_tile_assertion_requires_a_real_image():
    ct, content = "image/png", _multicolor_png()
    assert "image/png" in liveness._assert_iem_tile((ct, content))
    with pytest.raises(AssertionError, match="content-type"):
        liveness._assert_iem_tile(("text/html", b"<html>error</html>"))
    with pytest.raises(AssertionError, match="small"):
        liveness._assert_iem_tile(("image/png", b"\x89PNG\r\n"))


def test_gefs_chem_assertion_requires_published_steps():
    run = datetime(2026, 8, 25, 12, tzinfo=timezone.utc)
    assert "+120h" in liveness._assert_gefs_chem((run, {0, 3, 6, 120}))
    with pytest.raises(AssertionError, match="no forecast hours"):
        liveness._assert_gefs_chem((run, set()))


def test_gefs_chem_target_run_lands_on_a_synoptic_hour():
    run = liveness._gefs_chem_target_run()
    assert run.hour in (0, 6, 12, 18)
    assert run.minute == 0 and run.second == 0


def test_gairmet_assertion_needs_rows():
    assert "3 G-AIRMET" in liveness._assert_gairmet([{}, {}, {}])
    with pytest.raises(AssertionError):
        liveness._assert_gairmet([])


def test_igra_assertion_needs_thousands_of_well_formed_rows():
    lines = "\n".join(f"ABM{n:08d}  10.0000  20.0000   5.0 A STATION {1990} {2020}  100" for n in range(1500))
    assert "1500 station rows" in liveness._assert_igra(lines)
    with pytest.raises(AssertionError, match="expected thousands"):
        liveness._assert_igra("only\nthree\nlines")


def test_iem_raob_network_assertion_needs_enough_stations():
    assert "80 station" in liveness._assert_iem_raob_network({"features": [{}] * 80})
    with pytest.raises(AssertionError):
        liveness._assert_iem_raob_network({"features": [{}] * 3})


def test_overpass_assertion_reads_a_count_response():
    assert "7 node" in liveness._assert_overpass([{"type": "count", "tags": {"total": "7"}}])
    with pytest.raises(AssertionError, match="failed after its retry"):
        liveness._assert_overpass(None)
    with pytest.raises(AssertionError, match="unexpected"):
        liveness._assert_overpass([{"type": "node"}])


# ── the runner ───────────────────────────────────────────────────────────

def test_invoke_never_raises_and_records_the_failure(monkeypatch):
    def boom():
        raise RuntimeError("upstream is on fire")
    probe = liveness.Probe("boom", "Boom", boom, lambda d: "unreachable")
    rec = liveness._invoke(probe)
    assert rec.ok is False and "upstream is on fire" in rec.error
    assert rec.ms >= 0


def test_invoke_reports_the_assertion_failure_as_the_error():
    probe = liveness.Probe("bad-shape", "Bad Shape", lambda: {"nope": 1},
                           lambda d: (_ for _ in ()).throw(AssertionError("wrong shape")))
    rec = liveness._invoke(probe)
    assert rec.ok is False and rec.error == "wrong shape"


def test_invoke_marks_a_good_probe_ok():
    probe = liveness.Probe("fine", "Fine", lambda: 42, lambda d: f"got {d}")
    rec = liveness._invoke(probe)
    assert rec.ok is True and rec.detail == "got 42" and rec.error == ""


def test_run_all_bounds_total_wait_on_a_hanging_probe():
    def hangs():
        time.sleep(5)
        return 1
    fast = liveness.Probe("fast", "Fast", lambda: 1, lambda d: "ok")
    slow = liveness.Probe("slow", "Slow", hangs, lambda d: "ok")
    t0 = time.monotonic()
    records = liveness.run_all([fast, slow], pool_size=2, timeout=0.2)
    elapsed = time.monotonic() - t0
    assert elapsed < 2.0                                  # did not wait for the 5 s sleep
    by_key = {r.key: r for r in records}
    assert by_key["fast"].ok is True
    assert by_key["slow"].ok is False and "did not finish" in by_key["slow"].error


def test_run_all_respects_the_concurrency_cap(monkeypatch):
    active = []
    max_seen = [0]
    lock_probe_count = 6

    def make_call():
        def call():
            active.append(1)
            max_seen[0] = max(max_seen[0], len(active))
            time.sleep(0.05)
            active.pop()
            return 1
        return call

    probes = [liveness.Probe(f"p{i}", f"P{i}", make_call(), lambda d: "ok") for i in range(lock_probe_count)]
    liveness.run_all(probes, pool_size=2, timeout=5)
    assert max_seen[0] <= 2


# ── persistence + streaks ───────────────────────────────────────────────────

@pytest.fixture
def state_path(tmp_path, monkeypatch):
    p = tmp_path / "liveness.json"
    monkeypatch.setattr(liveness, "STATE_PATH", p)
    return p


def test_update_history_tracks_down_since_and_clears_on_recovery(state_path):
    state = {"last_sweep_ts": 0.0, "sources": {}}
    fail = liveness.ProbeRecord("x", "X", False, "", "boom", 10, 100.0)
    state = liveness._update_history(state, [fail])
    assert state["sources"]["x"]["down_since"] == 100.0

    fail2 = liveness.ProbeRecord("x", "X", False, "", "boom again", 10, 200.0)
    state = liveness._update_history(state, [fail2])
    assert state["sources"]["x"]["down_since"] == 100.0     # streak start does not move

    ok = liveness.ProbeRecord("x", "X", True, "fine", "", 10, 300.0)
    state = liveness._update_history(state, [ok])
    assert state["sources"]["x"]["down_since"] is None
    assert state["sources"]["x"]["last"]["ok"] is True


def test_history_is_bounded(state_path):
    state = {"last_sweep_ts": 0.0, "sources": {}}
    for i in range(liveness.HISTORY_LEN + 20):
        state = liveness._update_history(state, [liveness.ProbeRecord("x", "X", True, "ok", "", 1, float(i))])
    assert len(state["sources"]["x"]["history"]) == liveness.HISTORY_LEN


def test_save_and_load_state_round_trips(state_path):
    state = {"last_sweep_ts": 123.0, "sources": {"x": {"label": "X", "history": [], "down_since": None,
                                                        "last": {"ok": True, "detail": "d", "error": "", "ms": 1, "ts": 1.0}}}}
    liveness._save_state(state)
    got = liveness._load_state()
    assert got == state


def test_load_state_with_no_file_returns_empty_default(state_path):
    assert liveness._load_state() == {"last_sweep_ts": 0.0, "sources": {}}


def test_summary_reports_down_keys_and_duration(state_path, monkeypatch):
    monkeypatch.setattr(time, "time", lambda: 1000.0)
    state = {"last_sweep_ts": 900.0, "sources": {
        "good": {"label": "Good", "down_since": None, "history": [],
                 "last": {"ok": True, "detail": "fine", "error": "", "ms": 5, "ts": 900.0}},
        "bad": {"label": "Bad", "down_since": 400.0, "history": [],
                "last": {"ok": False, "detail": "", "error": "boom", "ms": 5, "ts": 900.0}},
    }}
    s = liveness.summary(state)
    assert s["sources_down"] == ["bad"]
    assert s["sources"]["bad"]["down_for_s"] == 600
    assert s["sources"]["good"]["down_for_s"] == 0
    assert s["checked_at"] is not None


def test_sweep_runs_probes_and_persists(state_path, monkeypatch):
    probe = liveness.Probe("only", "Only", lambda: 1, lambda d: "ok")
    monkeypatch.setattr(liveness, "PROBES", (probe,))
    state = liveness.sweep((probe,))
    assert state["sources"]["only"]["last"]["ok"] is True
    assert state_path.exists()


# ── background refresh ──────────────────────────────────────────────────────

def test_ensure_fresh_serves_stored_result_without_blocking(state_path, monkeypatch):
    calls = []
    monkeypatch.setattr(liveness, "sweep", lambda probes=liveness.PROBES: calls.append(1))
    liveness._save_state({"last_sweep_ts": time.time(), "sources": {
        "x": {"label": "X", "down_since": None, "history": [],
              "last": {"ok": True, "detail": "d", "error": "", "ms": 1, "ts": time.time()}}}})
    out = liveness.ensure_fresh(ttl=3600)
    assert out["sources"]["x"]["ok"] is True
    assert calls == []                                    # fresh enough: no background sweep triggered


def test_ensure_fresh_triggers_a_background_sweep_when_stale(state_path, monkeypatch):
    done = __import__("threading").Event()
    calls = []

    def fake_sweep(probes=None):
        calls.append(1)
        done.set()
        return {}
    monkeypatch.setattr(liveness, "sweep", fake_sweep)
    liveness._save_state({"last_sweep_ts": 1.0, "sources": {}})   # ancient
    liveness.ensure_fresh(ttl=1.0)
    assert done.wait(timeout=2.0), "background sweep never ran"
    assert calls == [1]
    for _ in range(50):                                  # let the thread's own cleanup finish
        if not liveness._bg_running:
            break
        time.sleep(0.01)
    liveness._bg_running = False                          # isolate the next test regardless


def test_trigger_background_sweep_does_not_double_fire(monkeypatch):
    monkeypatch.setattr(liveness, "_bg_running", True)
    monkeypatch.setattr(liveness.threading, "Thread",
                        lambda *a, **k: (_ for _ in ()).throw(AssertionError("a second sweep should not have been started")))
    liveness._trigger_background_sweep()   # _bg_running already True: must be a no-op


# ── CLI ──────────────────────────────────────────────────────────────────────

def test_main_exits_nonzero_when_a_probe_is_down(state_path, monkeypatch, capsys):
    ok_probe = liveness.Probe("ok", "OK", lambda: 1, lambda d: "fine")
    down_probe = liveness.Probe("down", "Down", lambda: (_ for _ in ()).throw(RuntimeError("dead")), lambda d: "n/a")
    monkeypatch.setattr(liveness, "PROBES", (ok_probe, down_probe))
    code = liveness.main([])
    out = capsys.readouterr().out
    assert code == 1
    assert "OK" in out and "DOWN" in out and "dead" in out


def test_main_exits_zero_when_everything_is_live(state_path, monkeypatch, capsys):
    ok_probe = liveness.Probe("ok", "OK", lambda: 1, lambda d: "fine")
    monkeypatch.setattr(liveness, "PROBES", (ok_probe,))
    assert liveness.main([]) == 0


def test_main_json_output_is_parseable(state_path, monkeypatch, capsys):
    import json
    ok_probe = liveness.Probe("ok", "OK", lambda: 1, lambda d: "fine")
    monkeypatch.setattr(liveness, "PROBES", (ok_probe,))
    liveness.main(["--json"])
    rows = json.loads(capsys.readouterr().out)
    assert rows == [{"key": "ok", "label": "OK", "ok": True, "detail": "fine", "error": "", "ms": rows[0]["ms"], "ts": rows[0]["ts"]}]


def test_main_rejects_an_unknown_probe_key(state_path, capsys):
    code = liveness.main(["--only", "not-a-real-key"])
    assert code == 2
    assert "unknown probe key" in capsys.readouterr().err


def test_main_only_filters_the_registry(state_path, monkeypatch, capsys):
    probes = (liveness.Probe("a", "A", lambda: 1, lambda d: "ok"),
              liveness.Probe("b", "B", lambda: 1, lambda d: "ok"),
              liveness.Probe("c", "C", lambda: 1, lambda d: "ok"))
    monkeypatch.setattr(liveness, "PROBES", probes)
    code = liveness.main(["--only", "a,c", "--json"])
    import json
    rows = json.loads(capsys.readouterr().out)
    assert sorted(r["key"] for r in rows) == ["a", "c"]
