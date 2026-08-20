"""The discussion says true things in plain words."""
import numpy as np

from wxgrid import discussion


def _field(base=101300.0):
    return np.full((721, 1440), base, dtype=np.float32)


def test_nearest_system_finds_a_real_low_and_ignores_a_ridge_dimple():
    z = _field()
    # a genuine low: a smooth 992 hPa cone centred 2.5° north of the point
    # (a flat block would smooth into a plateau, and real fields have none)
    ci, cj = 160, 230
    ii, jj = np.mgrid[0:721, 0:1440]
    dist = np.hypot(ii - ci, jj - cj)
    z = np.minimum(z, 99200.0 + np.clip(dist, 0, 40) * 55.0).astype(np.float32)
    got = discussion.nearest_system(z, lat=90 - 45, lon=-180 + 57.5)
    assert got and got["kind"] == "low" and got["hpa"] <= 1000
    # a shallow dimple inside high pressure is NOT a low
    z2 = _field(102400.0)
    z2[160:162, 228:230] = 102100.0
    got2 = discussion.nearest_system(z2, lat=90 - 45, lon=-180 + 57.5)
    assert got2 is None or got2["kind"] == "high"


def test_compose_tells_the_rain_story_with_member_confidence():
    steps = [0, 6, 12, 18, 24, 30, 36, 42, 48]
    n = len(steps)
    point = {"model": "gfs", "run": "2026-01-01T00", "steps": steps,
             "series": {"msl": [101300.0 - 40 * k for k in range(n)],
                        "tp6": [0, 0, 4, 6, 2, 0, 0, 0, 0],
                        "gust": [5] * n},
             "derived": {"freezing_level_m": [3000 - 200 * k for k in range(n)]}}
    prob = {"series": {"prob_rain": [None, 20, 80, 90, 60, 10, 0, 0]}}

    class R:
        variables = []
    out = discussion.compose(R(), 49.0, -123.0, point, prob)
    text = " ".join(out["paras"])
    assert "rain" in text and "12 mm" in text
    assert "90%" in text and "members" in text
    assert "freezing level drops" in text
    # readable, not meteorologist: no jargon tokens
    for word in ("vorticity", "geopotential", "advection"):
        assert word not in text
