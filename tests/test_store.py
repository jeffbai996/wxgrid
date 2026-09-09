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


def test_float16_fields_use_byte_shuffle_in_both_layouts(tmp_path):
    """Blosc's bit shuffle came in with the first commit and was never
    measured. It pays off when the low bits are noise; these fields are
    quantised through offset/scale and smooth in space, so neighbouring values
    share a high byte and byte shuffle hands zstd a run of them. 13% smaller
    over 22 variables, 33% on the smooth surface fields, same read speed."""
    import zarr
    from wxgrid import store
    assert getattr(store.FIELD_CODEC.shuffle, "value", store.FIELD_CODEC.shuffle) == "shuffle"
    root = tmp_path / "store"
    w = store.RunWriter("gfs", "2026-01-01T00", [0, 6], ["t2m"], root=root)
    ny, nx = w.grid_shape
    w.write("t2m", 0, np.full((ny, nx), 280.0, dtype=np.float32))
    w.write("t2m", 6, np.full((ny, nx), 281.0, dtype=np.float32))
    w.finish()
    store.build_point_cube("gfs", "2026-01-01T00", root)
    g = zarr.open_group(store.run_path("gfs", "2026-01-01T00", root), mode="r")
    for arr in (g["t2m"], g["pt"]["t2m"]):
        assert arr.dtype == np.dtype("float16")
        shuffles = [getattr(c, "shuffle", None) for c in arr.compressors]
        assert any(getattr(s, "value", s) == "shuffle" for s in shuffles), shuffles


def test_a_run_written_with_bit_shuffle_still_reads(tmp_path):
    """Zarr records the codec per array, so the runs already on disk keep
    theirs. Changing the default must not strand four days of store."""
    import zarr
    from zarr.codecs import BloscCodec
    from wxgrid import store
    path = store.run_path("gfs", "2026-01-01T00", tmp_path)
    g = zarr.open_group(path, mode="w")
    values = np.arange(2 * 4 * 3, dtype="float16").reshape(2, 4, 3)
    g.create_array("t2m", data=values, chunks=(1, 4, 3),
                   compressors=BloscCodec(cname="zstd", clevel=3, shuffle="bitshuffle"))
    g.attrs.update({"model": "gfs", "run": "2026-01-01T00", "steps": [0, 6],
                    "variables": ["t2m"], "complete": True})
    np.testing.assert_array_equal(
        zarr.open_group(path, mode="r")["t2m"][:], values)
    assert store.build_point_cube("gfs", "2026-01-01T00", tmp_path) == 1
    np.testing.assert_array_equal(zarr.open_group(path, mode="r")["pt/t2m"][:], values)
