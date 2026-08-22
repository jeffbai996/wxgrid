"""The render cache is keyed by run; a pruned run's renders are dead weight
(11 GB, 15 run dirs against 4 runs on 2026-08-22)."""
import numpy as np

from wxgrid import store


def test_prune_sweeps_the_render_cache_of_pruned_runs(tmp_path, monkeypatch):
    root = tmp_path / "store"
    cache = tmp_path / "cache"
    monkeypatch.setattr(store, "CACHE_DIR", cache)
    for rid in ("2026-01-01T00", "2026-01-01T06", "2026-01-01T12"):
        w = store.RunWriter("gfs", rid, [0], ["t2m"], root=root)
        w.write("t2m", 0, np.full(w.grid_shape, 280, np.float32))
        w.finish()
        (cache / "gfs" / rid).mkdir(parents=True)
        (cache / "gfs" / rid / "000-temp.png").write_bytes(b"png")
    (cache / "gfs" / "2026-01-01T18").mkdir()          # in-flight newer run: untouched
    (cache / "gfs" / "ext.json").write_text("{}")      # not a run dir: untouched
    removed = store.prune("gfs", keep=2, root=root)
    assert removed == ["2026-01-01T00"]
    assert not (cache / "gfs" / "2026-01-01T00").exists()
    assert (cache / "gfs" / "2026-01-01T06" / "000-temp.png").exists()
    assert (cache / "gfs" / "2026-01-01T18").exists()
    assert (cache / "gfs" / "ext.json").exists()
