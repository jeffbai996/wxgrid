"""The point cube is a re-chunk of the run: same values, one read of the
source per variable. The map chunks span the full grid per step, so reading
the source in 24-row bands decompressed every chunk once per band — thirty
times over for a global run (400 GB of reads per cycle on 2026-08-22)."""
import numpy as np
import pytest
import zarr

from wxgrid import store


def _run(tmp_path, steps=3):
    root = tmp_path / "store"
    w = store.RunWriter("gfs", "2026-01-01T00", list(range(0, steps * 6, 6)), ["t2m", "u10"], root=root)
    ny, nx = w.grid_shape
    rng = np.random.default_rng(0)
    fields = {"t2m": 280 + rng.random((steps, ny, nx), dtype=np.float32) * 20,
              "u10": rng.standard_normal((steps, ny, nx), dtype=np.float32) * 8}
    for var, cube in fields.items():
        for i in range(steps):
            w.write(var, i * 6, cube[i])
    w.finish()
    return root, fields


def test_point_cube_matches_the_source(tmp_path):
    root, fields = _run(tmp_path)
    assert store.build_point_cube("gfs", "2026-01-01T00", root) == 2
    g = zarr.open_group(store.run_path("gfs", "2026-01-01T00", root), mode="r")
    for var in fields:
        np.testing.assert_array_equal(g["pt"][var][:], g[var][:])
        assert g["pt"][var].chunks[0] == fields[var].shape[0]


def test_point_cube_reads_each_variable_once(tmp_path, monkeypatch):
    root, fields = _run(tmp_path)
    reads = []
    orig = zarr.Array.__getitem__
    monkeypatch.setattr(zarr.Array, "__getitem__",
                        lambda self, key: reads.append(self.name) or orig(self, key))
    store.build_point_cube("gfs", "2026-01-01T00", root)
    src_reads = [n for n in reads if not n.startswith("/pt")]
    assert sorted(src_reads) == sorted(f"/{v}" for v in fields)
