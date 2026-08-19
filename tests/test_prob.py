"""The probability counter: right messages, right buckets, right percentages."""
import numpy as np

from wxgrid import prob
from wxgrid.config import GRID_LAT_N, GRID_LON_N, STORE_DIR
from wxgrid.store import RunWriter


def test_wanted_picks_the_bucket_that_ends_at_the_step():
    rows = [
        {"n": 1, "start": 0, "end": 9, "var": "APCP", "level": "surface", "window": "0-24 hour acc fcst"},
        {"n": 2, "start": 10, "end": 19, "var": "APCP", "level": "surface", "window": "18-24 hour acc fcst"},
        {"n": 3, "start": 20, "end": 29, "var": "GUST", "level": "surface", "window": "24 hour fcst"},
        {"n": 4, "start": 30, "end": None, "var": "TMP", "level": "2 m above ground", "window": "24 hour fcst"},
    ]
    got = prob.wanted(rows, 24)
    assert [r["n"] for r in got] == [2, 3, 4]


def test_ingest_probability_counts_members_into_percent(monkeypatch):
    variables = ["u10", "v10", "t2m"]
    w = RunWriter("gefs", "2026-01-03T00", [0, 6, 12], variables, root=STORE_DIR)
    for s in (0, 6, 12):
        for v in variables:
            w.write(v, s, np.full((GRID_LAT_N, GRID_LON_N), 1.0, np.float32))
    w.finish()

    def fake_masks(session, run, step, member, tmp_dir):
        m = np.zeros((3, GRID_LAT_N, GRID_LON_N), dtype=bool)
        if member <= 3:                       # 3 of 4 members give rain everywhere
            m[0] = True
        m[2, 0, 0] = True                     # every member freezes one corner
        return m

    monkeypatch.setattr(prob, "_member_masks", fake_masks)
    out = prob.ingest_probability("2026-01-03T00", STORE_DIR, workers=2, members=4)
    assert out["steps"] == 2                  # step 0 has no bucket

    import zarr
    from wxgrid.store import run_path
    g = zarr.open_group(run_path("gefs", "2026-01-03T00", STORE_DIR), mode="r")
    assert np.isnan(g["prob_rain"][0, 5, 5])              # f000 stays NaN
    assert g["prob_rain"][1, 5, 5] == 75.0
    assert g["prob_frost"][1, 0, 0] == 100.0 and g["prob_frost"][1, 5, 5] == 0.0
    assert "prob_gust" in g.attrs["variables"]
    # resume: nothing left to do
    assert prob.ingest_probability("2026-01-03T00", STORE_DIR, workers=2, members=4)["steps"] == 0
