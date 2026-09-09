import os
import time
from dataclasses import replace
from datetime import datetime, timezone

import pytest

from wxgrid import ingest


def _touch_run_dir(root, model_key, run_name, age_hours):
    d = root / model_key / run_name
    d.mkdir(parents=True)
    (d / "step000.grib2").write_bytes(b"x")
    stamp = time.time() - age_hours * 3600
    os.utime(d, (stamp, stamp))
    return d


def test_sweep_removes_run_dirs_older_than_max_age(tmp_path):
    old = _touch_run_dir(tmp_path, "gfs", "2026-08-01T00", age_hours=48)

    removed = ingest.sweep_orphan_gribs(tmp_path, max_age_hours=24)

    assert removed == [old]
    assert not old.exists()


def test_sweep_keeps_fresh_run_dirs(tmp_path):
    fresh = _touch_run_dir(tmp_path, "gfs", "2026-08-31T00", age_hours=1)

    removed = ingest.sweep_orphan_gribs(tmp_path, max_age_hours=24)

    assert removed == []
    assert fresh.exists()


def test_sweep_handles_missing_and_empty_roots(tmp_path):
    missing = tmp_path / "does-not-exist"
    assert ingest.sweep_orphan_gribs(missing, max_age_hours=24) == []

    empty = tmp_path / "empty"
    empty.mkdir()
    assert ingest.sweep_orphan_gribs(empty, max_age_hours=24) == []


def test_sweep_uses_the_now_argument_for_the_cutoff(tmp_path):
    old = _touch_run_dir(tmp_path, "gfs", "2026-08-01T00", age_hours=48)
    # "now" far enough in the future that the 48h-old dir is inside the window.
    far_future = datetime.now(timezone.utc).replace(year=2030)

    removed = ingest.sweep_orphan_gribs(tmp_path, max_age_hours=24, now=far_future)

    assert removed == [old]


def test_grib_dir_is_removed_even_when_ingest_raises(tmp_path, monkeypatch):
    """The rmtree used to run only after a clean pass through _ingest_locked.
    An exception anywhere in fetch/write/cube-build skipped it and left the
    run's GRIBs on disk forever. It must now run in a finally.

    Pinned to the disk root: this is about the cleanup running, not about where
    the downloads were routed, and gfs now routes to RAM."""
    monkeypatch.setattr(ingest, "_fs_type", lambda p: "ext4")
    model = replace(ingest.get_model("gfs"), steps=[0])
    grib_root = tmp_path / "grib"
    run_dir = grib_root / model.key / "20260828T12"
    run_dir.mkdir(parents=True)
    (run_dir / "step000.grib2").write_bytes(b"x")

    class Writer:
        variables = []

        def __init__(self, *args, **kwargs):
            pass

        def write(self, *args, **kwargs):
            pass

        def finish(self):
            return {}

    def boom(model, run, root, on_step):
        raise RuntimeError("simulated fetch failure")

    monkeypatch.setattr(ingest, "RunWriter", Writer)
    monkeypatch.setattr(ingest.fetch, "fetch_gfs", boom)
    monkeypatch.setattr(ingest, "wait_for_step_gate", lambda: None)
    monkeypatch.setattr(ingest, "build_point_cube", lambda *a, **k: 0)
    monkeypatch.setattr(ingest, "prune", lambda *a, **k: [])
    monkeypatch.setattr(ingest, "warm_layers", lambda *a, **k: 0)

    with pytest.raises(RuntimeError):
        ingest._ingest_locked(
            model,
            datetime(2026, 8, 28, 12, tzinfo=timezone.utc),
            "2026-08-28T12",
            grib_root,
            tmp_path / "store",
            False,
        )

    assert not run_dir.exists()


def test_grib_dir_is_kept_on_raise_when_keep_grib_is_set(tmp_path, monkeypatch):
    model = replace(ingest.get_model("gfs"), steps=[0])
    grib_root = tmp_path / "grib"
    run_dir = grib_root / model.key / "20260828T12"
    run_dir.mkdir(parents=True)
    (run_dir / "step000.grib2").write_bytes(b"x")

    class Writer:
        variables = []

        def __init__(self, *args, **kwargs):
            pass

        def write(self, *args, **kwargs):
            pass

        def finish(self):
            return {}

    def boom(model, run, root, on_step):
        raise RuntimeError("simulated fetch failure")

    monkeypatch.setattr(ingest, "RunWriter", Writer)
    monkeypatch.setattr(ingest.fetch, "fetch_gfs", boom)
    monkeypatch.setattr(ingest, "wait_for_step_gate", lambda: None)

    with pytest.raises(RuntimeError):
        ingest._ingest_locked(
            model,
            datetime(2026, 8, 28, 12, tzinfo=timezone.utc),
            "2026-08-28T12",
            grib_root,
            tmp_path / "store",
            True,
        )

    assert run_dir.exists()


def _step_harness(tmp_path, monkeypatch, model_key, source=None):
    """One model, one step, a GRIB on disk, everything after decode stubbed."""
    model = replace(ingest.get_model(model_key), steps=[0])
    if source:
        model = replace(model, source=source)
    grib_root = tmp_path / "grib"
    run_dir = grib_root / model.key / "20260828T12"
    run_dir.mkdir(parents=True)
    grib = run_dir / "step000.grib2"
    grib.write_bytes(b"x")

    class Writer:
        variables = []
        def __init__(self, *args, **kwargs): pass
        def write(self, *args, **kwargs): pass
        def finish(self): return {}

    seen = {}

    def fetcher(model, run, root, on_step):
        on_step(0, [grib])
        seen["after_step"] = grib.exists()
        return [(0, [grib])]

    monkeypatch.setattr(ingest, "_fs_type", lambda p: "ext4")   # pin to the disk root
    monkeypatch.setattr(ingest, "RunWriter", Writer)
    for name in ("fetch_gfs", "fetch_ecmwf", "fetch_hrrr"):
        monkeypatch.setattr(ingest.fetch, name, fetcher)
    monkeypatch.setattr(ingest, "wait_for_step_gate", lambda: None)
    monkeypatch.setattr(ingest, "build_point_cube", lambda *a, **k: 0)
    monkeypatch.setattr(ingest, "prune", lambda *a, **k: [])
    monkeypatch.setattr(ingest, "warm_layers", lambda *a, **k: 0)
    monkeypatch.setattr(ingest, "write_step", None, raising=False)
    return model, grib_root, grib, seen


def test_a_decoded_grib_is_released_before_the_next_step(tmp_path, monkeypatch):
    """The whole run's downloads used to sit on disk until the finally — 3.5 GB
    for GFS, and 50 GB of scratch a day across the fleet. Nothing reads a GRIB
    after its step decodes, so it goes then."""
    model, grib_root, grib, seen = _step_harness(tmp_path, monkeypatch, "gfs")
    ingest._ingest_locked(model, datetime(2026, 8, 28, 12, tzinfo=timezone.utc),
                          "2026-08-28T12", grib_root, tmp_path / "store", False)
    assert seen["after_step"] is False
    assert not grib.exists()


def test_an_ecmwf_grib_outlives_its_step(tmp_path, monkeypatch):
    """ECMWF is the one source that resumes from its downloads: a deferred run
    keeps validated GRIBs and re-decodes them next invocation. Releasing them
    per step would make every 429 a full re-download."""
    model, grib_root, grib, seen = _step_harness(tmp_path, monkeypatch, "ifs")
    assert model.source == "ecmwf"
    ingest._ingest_locked(model, datetime(2026, 8, 28, 12, tzinfo=timezone.utc),
                          "2026-08-28T12", grib_root, tmp_path / "store", False)
    assert seen["after_step"] is True


def test_keep_grib_still_keeps_every_step(tmp_path, monkeypatch):
    """`--keep-grib` is for inspecting what a run actually downloaded."""
    model, grib_root, grib, seen = _step_harness(tmp_path, monkeypatch, "gfs")
    ingest._ingest_locked(model, datetime(2026, 8, 28, 12, tzinfo=timezone.utc),
                          "2026-08-28T12", grib_root, tmp_path / "store", True)
    assert seen["after_step"] is True
    assert grib.exists()


# ---------------------------------------------------- downloads land in RAM

def test_a_read_once_source_downloads_into_ram(tmp_path, monkeypatch):
    """A GRIB is written once, decoded once and deleted. Unlinking it early
    saved nothing — ext4 mounts data=ordered and its five-second journal commit
    forces the pages out before the unlink (measured 2026-09-09). The only way
    not to write them is not to put them on a disk."""
    ram = tmp_path / "ram"
    monkeypatch.setattr(ingest, "GRIB_RAM_DIR", ram)
    monkeypatch.setattr(ingest, "_fs_type", lambda p: "tmpfs")
    assert ingest.grib_root_for(ingest.get_model("gfs"), tmp_path / "disk") == ram


def test_ecmwf_keeps_its_downloads_on_disk(tmp_path, monkeypatch):
    """It is the one source that resumes from validated downloads after a 429,
    and RAM does not survive the process."""
    ram = tmp_path / "ram"
    disk = tmp_path / "disk"
    monkeypatch.setattr(ingest, "GRIB_RAM_DIR", ram)
    monkeypatch.setattr(ingest, "_fs_type", lambda p: "tmpfs")
    for key in ("ifs", "aifs"):
        model = ingest.get_model(key)
        assert model.source == "ecmwf"
        assert ingest.grib_root_for(model, disk) == disk


def test_keep_grib_still_puts_them_where_a_human_can_look(tmp_path, monkeypatch):
    monkeypatch.setattr(ingest, "GRIB_RAM_DIR", tmp_path / "ram")
    monkeypatch.setattr(ingest, "_fs_type", lambda p: "tmpfs")
    disk = tmp_path / "disk"
    assert ingest.grib_root_for(ingest.get_model("gfs"), disk, keep_grib=True) == disk


def test_a_ram_disk_that_is_not_one_is_refused(tmp_path, monkeypatch):
    """If /dev/shm is missing or someone points the env at a real directory,
    writing there would be the same bytes on the same platter, silently."""
    monkeypatch.setattr(ingest, "GRIB_RAM_DIR", tmp_path / "ram")
    monkeypatch.setattr(ingest, "_fs_type", lambda p: "ext4")
    disk = tmp_path / "disk"
    assert ingest.grib_root_for(ingest.get_model("gfs"), disk) == disk


def test_a_full_ram_disk_falls_back_to_disk(tmp_path, monkeypatch):
    """Filling /dev/shm pushes the box into swap, which is worse than the
    writes. A failed download is worse than both."""
    import os as _os
    monkeypatch.setattr(ingest, "GRIB_RAM_DIR", tmp_path / "ram")
    monkeypatch.setattr(ingest, "_fs_type", lambda p: "tmpfs")
    monkeypatch.setattr(ingest, "GRIB_RAM_MIN_FREE", 2 * 1024 ** 3)
    real = _os.statvfs

    class Tiny:
        f_bavail = 1
        f_frsize = 4096
    monkeypatch.setattr(_os, "statvfs", lambda p: Tiny() if str(p).endswith("ram") else real(p))
    disk = tmp_path / "disk"
    assert ingest.grib_root_for(ingest.get_model("gfs"), disk) == disk


def test_the_sweep_reclaims_the_ram_root_too(tmp_path):
    """A run killed mid-fetch leaves downloads behind; on the RAM disk that is
    memory nobody is using."""
    old = _touch_run_dir(tmp_path, "gfs", "2026-08-01T00", age_hours=48)
    assert ingest.sweep_orphan_gribs(tmp_path, max_age_hours=24) == [old]
    assert not old.exists()
