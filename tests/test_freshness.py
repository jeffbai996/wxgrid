"""The freshness check reads the served run, not the disk (2026-08-26: 29 h
stale with every unit active)."""
from datetime import datetime, timezone

import numpy as np

from wxgrid import freshness, store


def _run(root, model, rid, complete=True):
    w = store.RunWriter(model, rid, [0, 6], ["t2m"], root=root)
    for h in (0, 6):
        w.write("t2m", h, np.full(w.grid_shape, 280.0, dtype=np.float32))
    if complete:
        w.finish()


def test_a_fresh_global_run_is_fine_and_an_old_one_is_stale(tmp_path):
    _run(tmp_path, "gfs", "2026-01-01T06")
    now = datetime(2026, 1, 1, 12, tzinfo=timezone.utc)
    rows = {r["model"]: r for r in freshness.run_ages(now, tmp_path)}
    assert rows["gfs"]["age_h"] == 6.0 and rows["gfs"]["stale"] is False
    late = datetime(2026, 1, 2, 0, tzinfo=timezone.utc)
    assert {r["model"]: r for r in freshness.run_ages(late, tmp_path)}["gfs"]["stale"] is True


def test_an_incomplete_run_on_disk_does_not_count_as_served(tmp_path):
    _run(tmp_path, "gfs", "2026-01-01T00")
    _run(tmp_path, "gfs", "2026-01-01T12", complete=False)     # mid-ingest
    now = datetime(2026, 1, 1, 13, tzinfo=timezone.utc)
    r = {x["model"]: x for x in freshness.run_ages(now, tmp_path)}["gfs"]
    assert r["run"] == "2026-01-01T00" and r["stale"] is True


def test_regional_models_are_held_to_a_tighter_clock(tmp_path):
    _run(tmp_path, "hrrr", "2026-01-01T06")
    now = datetime(2026, 1, 1, 11, tzinfo=timezone.utc)      # 5 h old
    r = {x["model"]: x for x in freshness.run_ages(now, tmp_path)}["hrrr"]
    assert r["tier"] == "regional" and r["stale"] is True


def test_a_model_with_no_runs_is_stale(tmp_path):
    r = {x["model"]: x for x in freshness.run_ages(datetime(2026, 1, 1, tzinfo=timezone.utc), tmp_path)}["ifs"]
    assert r["run"] is None and r["stale"] is True
