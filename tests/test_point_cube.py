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


def test_point_cube_checks_the_gate_between_variables(tmp_path):
    root, fields = _run(tmp_path)
    gates = []

    assert store.build_point_cube(
        "gfs", "2026-01-01T00", root, step_gate=lambda: gates.append("wait")
    ) == 2
    assert gates == ["wait"] * len(fields)


def test_an_interrupted_variable_is_rebuilt(tmp_path):
    root, fields = _run(tmp_path)
    assert store.build_point_cube("gfs", "2026-01-01T00", root) == 2
    g = zarr.open_group(store.run_path("gfs", "2026-01-01T00", root), mode="r+")
    g["pt"]["t2m"].attrs["complete"] = False
    g["pt"]["t2m"][:] = 0

    assert store.build_point_cube("gfs", "2026-01-01T00", root) == 1
    np.testing.assert_array_equal(g["pt"]["t2m"][:], g["t2m"][:])
    assert g["pt"]["t2m"].attrs["complete"] is True


def test_reader_ignores_an_interrupted_variable(tmp_path):
    root, fields = _run(tmp_path)
    store.build_point_cube("gfs", "2026-01-01T00", root)
    g = zarr.open_group(store.run_path("gfs", "2026-01-01T00", root), mode="r+")
    g["pt"]["t2m"].attrs["complete"] = False
    g["pt"]["t2m"][:] = 0

    reader = store.RunReader("gfs", "2026-01-01T00", root)
    i, j = reader.indices(49.0, -123.0)
    np.testing.assert_array_equal(
        reader.point("t2m", 49.0, -123.0),
        reader.decode("t2m", g["t2m"][:, int(i), int(j)]),
    )


def test_the_cube_index_is_built_once_however_many_threads_open_the_reader(tmp_path, monkeypatch):
    # The card reads ~75 variables through an 8-thread pool. The reader's
    # cube index was a lazy property, so all eight threads found it missing
    # and each opened every cube array through zarr's one event loop — a
    # 7 s first card instead of 0.2 s (2026-08-26). Build it once, up front.
    from concurrent.futures import ThreadPoolExecutor
    root, fields = _run(tmp_path)
    store.build_point_cube("gfs", "2026-01-01T00", root)
    opens = []
    orig = zarr.Group.__getitem__
    monkeypatch.setattr(zarr.Group, "__getitem__",
                        lambda self, key: opens.append(key) or orig(self, key))
    r = store.RunReader("gfs", "2026-01-01T00", root)
    assert "_pt_cache" in vars(r)                       # eager, not lazy
    assert opens.count("pt") == 1
    built = len(opens)
    with ThreadPoolExecutor(8) as pool:
        list(pool.map(lambda v: r.point(v, 49.0, -123.0), list(fields) * 4))
    # after construction, no read opens a group member again: not the cube,
    # not a source array for its encoding attrs
    assert opens[built:] == []
