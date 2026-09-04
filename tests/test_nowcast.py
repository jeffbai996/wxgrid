"""Rain now: the 15-minute nowcast series and the headline built from it."""
from datetime import datetime, timezone

from wxgrid import nowcast


def _ms(iso):
    return datetime.strptime(iso, "%Y-%m-%dT%H:%MZ").replace(tzinfo=timezone.utc).timestamp() * 1000


def _series(vals, step=15):
    return {"step_min": step, "now": 4, "mm": vals}


def test_headline_says_when_rain_stops_when_it_is_raining_now():
    # raining for the past hour and the next 30 min, then dry
    h = nowcast.headline([0.5] * 4 + [0.4, 0.3, 0, 0, 0, 0, 0, 0], 15, 4)
    assert h == "Light rain stopping in 30 min"


def test_headline_says_when_rain_starts_when_it_is_dry_now():
    h = nowcast.headline([0] * 4 + [0, 0, 0, 1.2, 1.5, 0.2, 0, 0], 15, 4)
    assert h == "Moderate rain starting in 45 min"


def test_headline_keeps_a_wet_window_honest_and_grades_it():
    assert nowcast.headline([0] * 4 + [0.3] * 8, 15, 4) == "Light rain for the next 2 hours"
    assert nowcast.headline([0] * 4 + [2.5] * 8, 15, 4) == "Heavy rain for the next 2 hours"
    assert nowcast.headline([0] * 4 + [0.2, 0.2, 0.2, 0.2, 0, 0, 0, 0], 15, 4) == "Light rain stopping in 1 hour"


def test_headline_is_none_when_nothing_falls_in_the_window():
    assert nowcast.headline([0] * 12, 15, 4) is None
    assert nowcast.headline([0.05] * 12, 15, 4) is None      # trace amounts are not rain


def test_headline_calls_snow_snow():
    assert nowcast.headline([0] * 4 + [0.6] * 8, 15, 4, snow=[0] * 4 + [0.8] * 8) == "Light snow for the next 2 hours"


def test_intensity_bands_follow_the_hourly_rate():
    # 15-minute totals; the bands are the usual 2.5 / 7.5 mm/h breaks
    assert nowcast.band(0.3, 15) == "light" and nowcast.band(0.7, 15) == "moderate" and nowcast.band(2.0, 15) == "heavy"


def test_nowcast_for_shapes_open_meteo_and_marks_now(monkeypatch):
    times = [f"2026-09-04T18:{m:02d}" for m in (0, 15, 30, 45)] + [f"2026-09-04T19:{m:02d}" for m in (0, 15, 30, 45)]
    payload = {"utc_offset_seconds": 0,
               "minutely_15": {"time": times, "precipitation": [0, 0, 0.2, 0.4, 0.6, 0.1, 0, 0],
                               "snowfall": [0] * 8, "weather_code": [3] * 8}}
    calls = []
    def get_json(url, params=None, **kw):
        calls.append(params); return payload
    out = nowcast.nowcast_for(49.28, -123.12, get_json=get_json, cache_get=lambda k, ttl, fn: fn(),
                              now_ms=_ms("2026-09-04T18:50Z"))
    assert calls[0]["past_minutely_15"] == 4 and calls[0]["forecast_minutely_15"] == 8
    assert out["step_min"] == 15 and out["now"] == 3 and out["mm"][3] == 0.4
    assert out["times"][0].endswith("Z") and out["headline"] == "Light rain stopping in 30 min"


def test_nowcast_for_returns_none_when_upstream_fails():
    def boom(*a, **k): raise RuntimeError("down")
    assert nowcast.nowcast_for(0, 0, get_json=boom, cache_get=lambda k, ttl, fn: fn()) is None
