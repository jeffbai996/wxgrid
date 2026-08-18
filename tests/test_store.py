import numpy as np

from wxgrid.config import GRID_LAT_N, GRID_LON_N
from wxgrid.store import RunReader, RunWriter, list_runs, prune


def _field(val):
    return np.full((GRID_LAT_N, GRID_LON_N), val, dtype=np.float32)


def test_write_read_roundtrip_and_point_lookup(tmp_path):
    w = RunWriter("aifs", "2026-01-01T00", [0, 6], ["u10", "v10", "gust"], root=tmp_path)
    w.write("u10", 0, _field(1.0)); w.write("u10", 6, _field(2.0))
    w.write("v10", 0, _field(3.0)); w.write("v10", 6, _field(4.0))
    counts = w.finish()
    assert counts == {"u10": 2, "v10": 2, "gust": 0}
    r = RunReader("aifs", "2026-01-01T00", root=tmp_path)
    assert r.variables == ["u10", "v10"]           # gust never arrived → not advertised
    assert r.slab("u10", 6)[0, 0] == 2.0
    assert list(r.point("v10", 49.28, -123.12)) == [3.0, 4.0]


def test_incomplete_runs_are_hidden_and_pruned(tmp_path):
    for rid in ["2026-01-01T00", "2026-01-01T06", "2026-01-01T12"]:
        w = RunWriter("gfs", rid, [0], ["u10"], root=tmp_path)
        w.write("u10", 0, _field(1.0)); w.finish()
    RunWriter("gfs", "2025-12-31T18", [0], ["u10"], root=tmp_path)   # never finished
    assert list_runs("gfs", root=tmp_path) == ["2026-01-01T12", "2026-01-01T06", "2026-01-01T00"]
    removed = prune("gfs", keep=2, root=tmp_path)
    assert set(removed) == {"2026-01-01T00", "2025-12-31T18"}
    assert list_runs("gfs", root=tmp_path) == ["2026-01-01T12", "2026-01-01T06"]
