"""Catalog reads metadata only; data-reader construction is shared and bounded."""
import json
import time
from concurrent.futures import ThreadPoolExecutor

from wxgrid import api, store


def test_discovery_handles_complete_incomplete_corrupt_and_legacy_metadata(tmp_path, monkeypatch):
    attrs = {"complete": True, "steps": [0, 6], "variables": ["u10", "v10", "t2m"]}
    for rid, data in (("2026-01-01T00", {"node_type": "group", "attributes": attrs}),
                      ("2026-01-01T06", {"node_type": "group", "attributes": {"complete": False}}),
                      ("2026-01-01T12", {"node_type": "array"})):
        p = store.run_path("gfs", rid, tmp_path)
        p.mkdir(parents=True)
        (p / "zarr.json").write_text(json.dumps(data))
    legacy = store.run_path("gfs", "2025-12-31T18", tmp_path)
    legacy.mkdir()
    (legacy / ".zattrs").write_text(json.dumps(attrs))
    corrupt = store.run_path("gfs", "2026-01-01T18", tmp_path)
    corrupt.mkdir()
    (corrupt / "zarr.json").write_text("{")
    monkeypatch.setattr(store.zarr, "open_group", lambda *a, **k: (_ for _ in ()).throw(AssertionError("array open")))
    assert store.list_runs("gfs", tmp_path) == ["2026-01-01T00", "2025-12-31T18"]
    assert store.RunManifest("gfs", "2026-01-01T00", tmp_path).steps == [0, 6]
    monkeypatch.setattr(api, "RunManifest", lambda m, r: store.RunManifest(m, r, tmp_path))
    monkeypatch.setattr(api, "_reader", lambda *a: (_ for _ in ()).throw(AssertionError("reader allocated")))
    catalog = api._build_models({"gfs": ["2026-01-01T00", "missing"]})
    gfs = next(m for m in catalog["models"] if m["key"] == "gfs")
    assert gfs["runs"][0]["layers"] == ["wind", "temp", "dt24"]
    assert gfs["runs"][0]["steps"] == [0, 6]
    assert len(gfs["runs"]) == 1


def test_concurrent_reader_misses_construct_once_and_refresh_on_rewrite(tmp_path, monkeypatch):
    calls = []
    p = tmp_path / "run"
    p.mkdir()
    meta = p / "zarr.json"
    meta.write_text("{}")
    monkeypatch.setattr(api, "_readers", {})
    monkeypatch.setattr(api, "run_path", lambda *a: p)

    def reader(*args):
        calls.append(args)
        time.sleep(0.02)
        return object()

    monkeypatch.setattr(api, "RunReader", reader)
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda _: api._reader("gfs", "run"), range(8)))
    assert len(calls) == 1 and all(r is results[0] for r in results)
    import os
    os.utime(meta, ns=(1_000_000_000, 1_000_000_000))
    assert api._reader("gfs", "run") is not results[0]
    for i in range(20):
        api._reader("gfs", str(i))
    assert len(api._readers) == 12
