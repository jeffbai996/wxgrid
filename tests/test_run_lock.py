"""One writer per run, whatever the writer is. The ingest had a flock since
2026-08-18, but the maintenance passes (wave augment, point cube, GEFS
probabilities) opened the same group read-write outside it (#4vd6x)."""
import subprocess
import sys
import textwrap

import numpy as np

from wxgrid import ingest, store
from wxgrid.config import GRID_LAT_N, GRID_LON_N


def _run(root, model="gfs", rid="2026-01-01T00"):
    w = store.RunWriter(model, rid, [0, 6], ["t2m"], root=root)
    for h in (0, 6):
        w.write("t2m", h, np.full((GRID_LAT_N, GRID_LON_N), 280.0, dtype=np.float32))
    w.finish()
    return rid


def _hold(root, model, rid):
    """A separate process holding the run's lock, released when it exits."""
    code = textwrap.dedent(f"""
        import sys, time
        from pathlib import Path
        from wxgrid.store import run_lock
        with run_lock({model!r}, {rid!r}, Path({str(root)!r})) as held:
            print("held" if held else "busy", flush=True)
            time.sleep(30)
    """)
    p = subprocess.Popen([sys.executable, "-c", code], stdout=subprocess.PIPE, text=True)
    assert p.stdout.readline().strip() == "held"
    return p


def test_run_lock_is_exclusive_across_processes_and_released_on_exit(tmp_path):
    rid = _run(tmp_path)
    holder = _hold(tmp_path, "gfs", rid)
    try:
        with store.run_lock("gfs", rid, tmp_path) as held:
            assert held is False
    finally:
        holder.kill(); holder.wait()
    with store.run_lock("gfs", rid, tmp_path) as held:      # a dead holder frees it
        assert held is True


def test_every_maintenance_writer_steps_aside_when_the_run_is_locked(tmp_path, monkeypatch):
    rid = _run(tmp_path)
    _run(tmp_path, model="gefs")
    holder = _hold(tmp_path, "gfs", rid)
    holder2 = _hold(tmp_path, "gefs", rid)                  # the GEFS pass locks its own model
    try:
        assert store.build_point_cube("gfs", rid, tmp_path) == 0
        assert not (tmp_path / "gfs" / f"{rid}.zarr" / "pt").exists()
        import dataclasses
        model = dataclasses.replace(ingest.get_model("gfs"), wave_params={"swh": "swh"})
        assert ingest.augment_waves(model, rid, store_root=tmp_path)["skipped"] == "locked"
        from wxgrid import prob
        assert prob.ingest_probability(rid, store_root=tmp_path)["skipped"] == "locked"
    finally:
        holder.kill(); holder.wait(); holder2.kill(); holder2.wait()


def test_ingest_run_uses_the_same_lock(tmp_path):
    rid = _run(tmp_path)
    holder = _hold(tmp_path, "gfs", "2026-02-02T00")
    try:
        from datetime import datetime, timezone
        out = ingest.ingest_run(ingest.get_model("gfs"), datetime(2026, 2, 2, tzinfo=timezone.utc), store_root=tmp_path)
        assert out["skipped"] == "locked"
    finally:
        holder.kill(); holder.wait()



def test_the_lock_is_reentrant_so_the_ingest_can_build_its_own_cube(tmp_path):
    # The ingest holds the run lock and then calls build_point_cube, which
    # takes it again. Skipping there left every new run without a cube.
    rid = _run(tmp_path)
    with store.run_lock("gfs", rid, tmp_path) as held:
        assert held is True
        assert store.build_point_cube("gfs", rid, tmp_path) == 1
        with store.run_lock("gfs", rid, tmp_path) as again:
            assert again is True
    # released for real once the outer block exits: a second process gets it
    holder = _hold(tmp_path, "gfs", rid)
    holder.kill(); holder.wait()


def test_repair_cubes_builds_only_the_newest_missing_cube(tmp_path):
    _run(tmp_path, rid="2026-01-01T00")
    rid = _run(tmp_path, rid="2026-01-01T06")
    assert ingest.repair_cubes(ingest.get_model("gfs"), tmp_path) == [rid]   # newest only
    assert ingest.repair_cubes(ingest.get_model("gfs"), tmp_path) == []      # idempotent
