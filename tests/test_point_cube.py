"""The point cube is a re-chunk of the run: same values, each source chunk
read once. The map chunks span the full grid per step, so reading
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


@pytest.mark.parametrize("chunk_steps", [1, 2])
def test_staged_cube_preserves_raw_bits_and_reads_chunks_once(tmp_path, monkeypatch, chunk_steps):
    monkeypatch.setattr(store, "_POINT_IN_MEMORY_BYTES", 0)
    path = store.run_path("gfs", "2026-01-01T00", tmp_path)
    g = zarr.open_group(path, mode="w")
    g.attrs["variables"] = ["t2m"]
    values = np.random.default_rng(4).normal(size=(5, 53, 29)).astype("float16")
    values[0, 0, :4] = [np.nan, -0.0, np.inf, -np.inf]
    src = g.create_array("t2m", data=values, chunks=(chunk_steps, 53, 29))
    src.attrs.update(offset=273.15, scale=0.1, units="K")
    reads = []
    original = zarr.Array.__getitem__

    def read(self, key):
        if self.name == "/t2m":
            reads.append(key)
        return original(self, key)

    monkeypatch.setattr(zarr.Array, "__getitem__", read)
    assert store.build_point_cube("gfs", "2026-01-01T00", tmp_path) == 1
    assert [key[0].start for key in reads] == list(range(0, 5, chunk_steps))
    np.testing.assert_array_equal(g["pt/t2m"][:].view("uint16"), values.view("uint16"))
    assert dict(g["pt/t2m"].attrs) == {"offset": 273.15, "scale": 0.1, "units": "K", "complete": True}
    assert not list(path.glob(".point-transpose-*"))


def test_staging_failure_closes_scratch_and_leaves_retryable_cube(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "_POINT_IN_MEMORY_BYTES", 0)
    path = store.run_path("gfs", "2026-01-01T00", tmp_path)
    g = zarr.open_group(path, mode="w")
    g.attrs["variables"] = ["t2m"]
    values = np.ones((3, 25, 7), dtype="float16")
    g.create_array("t2m", data=values, chunks=(1, 25, 7))
    opened = []
    original = store.tempfile.TemporaryFile

    def temporary(**kwargs):
        f = original(**kwargs)
        opened.append(f)
        return f

    monkeypatch.setattr(store.tempfile, "TemporaryFile", temporary)
    with monkeypatch.context() as failure:
        def full(file):
            raise OSError(28, "No space left on device")
        failure.setattr(store, "_drop_staging_cache", full)
        with pytest.raises(OSError, match="No space"):
            store.build_point_cube("gfs", "2026-01-01T00", tmp_path)
    assert opened[0].closed
    assert g["pt/t2m"].attrs["complete"] is False
    assert not list(path.glob(".point-transpose-*"))
    assert store.build_point_cube("gfs", "2026-01-01T00", tmp_path) == 1
    np.testing.assert_array_equal(g["pt/t2m"][:], values)


def test_small_cube_needs_no_staging_disk(tmp_path, monkeypatch):
    def unexpected(**kwargs):
        raise AssertionError("small cube should not stage")
    monkeypatch.setattr(store.tempfile, "TemporaryFile", unexpected)
    root, _ = _run(tmp_path, steps=1)
    assert store.build_point_cube("gfs", "2026-01-01T00", root) == 2


def test_staging_and_output_share_the_write_budget(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "_POINT_IN_MEMORY_BYTES", 0)
    group = zarr.open_group(tmp_path, mode="w")
    values = np.ones((3, 25, 7), dtype="float16")
    src = group.create_array("src", data=values, chunks=(1, 25, 7))
    dst = group.create_array("dst", shape=values.shape, dtype=values.dtype, chunks=(3, 24, 24))
    charges = []

    class Pacer:
        spend = staticmethod(charges.append)

    store._copy_point_variable(src, dst, tmp_path, Pacer())
    assert sum(charges[:3]) == values.nbytes  # scratch writes
    assert sum(charges[3:]) == values.nbytes  # destination writes
    np.testing.assert_array_equal(dst[:], values)
