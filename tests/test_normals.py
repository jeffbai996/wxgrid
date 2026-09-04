"""Climate normals: the fixed 366-slot calendar, the ±7-day pooling, the cache seam."""
from datetime import date, timedelta

from wxgrid import normals


def test_day366_is_leap_safe():
    assert normals.day366(date(2021, 1, 1)) == 0
    assert normals.day366(date(2020, 2, 29)) == 59
    assert normals.day366(date(2021, 3, 1)) == 60 == normals.day366(date(2020, 3, 1))
    assert normals.day366(date(2021, 12, 31)) == 365


def _years(y0, y1, f):
    dates, vals = [], []
    d = date(y0, 1, 1)
    while d <= date(y1, 12, 31):
        dates.append(d.isoformat()); vals.append(f(d)); d += timedelta(days=1)
    return dates, vals


def test_normals_average_across_years_and_pool_a_window():
    # temperature = year offset (0..2) + slot/100: the year mean cancels to 1.0
    dates, tmean = _years(2001, 2003, lambda d: (d.year - 2001) + normals.day366(d) / 100)
    out = normals.normals_from_daily(dates, tmean, tmean, tmean, [0.0] * len(dates), window=0)
    assert out["tmean"][0] == 1.0 and out["tmean"][100] == 2.0
    # a window pools neighbours: a spike on one day is diluted 15-fold
    spike = [0.0] * len(dates); spike[dates.index("2002-07-01")] = 15.0
    pooled = normals.normals_from_daily(dates, spike, spike, spike, spike, window=7)
    assert abs(pooled["tmean"][normals.day366(date(2002, 7, 1))] - 15.0 / (15 * 3 - 0) * 1) < 0.5 or pooled["tmean"][normals.day366(date(2002, 7, 1))] < 1.0


def test_feb_29_slot_is_filled_from_its_neighbours_in_common_years():
    dates, t = _years(2001, 2003, lambda d: 5.0)          # no leap year in range
    out = normals.normals_from_daily(dates, t, t, t, [1.0] * len(dates))
    assert out["tmax"][59] == 5.0 and out["precip"][59] == 1.0


def test_none_values_are_skipped_and_empty_slots_are_none():
    out = normals.normals_from_daily(["2001-01-01"], [None], [None], [3.0], [None], window=0)
    assert out["tmax"][0] is None and out["tmean"][0] == 3.0


def test_normals_for_snaps_to_the_cell_and_caches_by_it():
    calls = []
    def get_json(url, params, timeout):
        calls.append((params["latitude"], params["longitude"]))
        dates, t = _years(1991, 1992, lambda d: 10.0)
        return {"daily": {"time": dates, "temperature_2m_max": t, "temperature_2m_min": t, "temperature_2m_mean": t, "precipitation_sum": t}}
    store = {}
    def cache_get(key, ttl, fn):
        if key not in store: store[key] = fn()
        return store[key]
    a = normals.normals_for(49.28, -123.12, get_json=get_json, cache_get=cache_get)
    b = normals.normals_for(49.30, -123.10, get_json=get_json, cache_get=cache_get)   # same cell
    assert calls == [(49.25, -123.0)] and a is b and a["tmean"][200] == 10.0 and "1991" in a["years"]


def test_archive_failure_yields_none_not_an_error():
    def boom(*a, **k): raise RuntimeError("down")
    assert normals.normals_for(0, 0, get_json=boom, cache_get=lambda k, t, fn: fn()) is None
