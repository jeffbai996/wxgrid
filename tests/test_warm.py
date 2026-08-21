"""Warming pre-renders exactly the file names the request path will ask for."""
import numpy as np

from wxgrid import ingest, render
from wxgrid.config import GRID_LAT_N, GRID_LON_N, STORE_DIR
from wxgrid.store import RunWriter


def test_warm_layers_writes_the_request_paths(tmp_path, monkeypatch):
    variables = ["u10", "v10", "t2m", "tp6"]
    w = RunWriter("gem", "2026-01-02T00", [0, 6], variables, root=STORE_DIR)
    for s in (0, 6):
        for v in variables:
            w.write(v, s, np.full((GRID_LAT_N, GRID_LON_N), 1.0 if v[0] in "uv" else 280.0 if v == "t2m" else 0.5, np.float32))
    w.finish()
    import wxgrid.ingest as ing
    import wxgrid.api as api_mod
    monkeypatch.setattr(ing, "STORE_DIR", STORE_DIR)
    import wxgrid.config as config
    monkeypatch.setattr(config, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(api_mod, "CACHE_DIR", tmp_path, raising=False)
    n = ingest.warm_layers("gem", "2026-01-02T00", STORE_DIR)
    assert n == 6                                       # 3 layers × 2 steps
    for layer in ("wind", "temp", "tp6"):
        name, _, _ = render.layer_cache_name(0, layer, "image/webp")
        assert (tmp_path / "gem" / "2026-01-02T00" / name).exists()
    # a second pass renders nothing: the names are the cache
    assert ingest.warm_layers("gem", "2026-01-02T00", STORE_DIR) == 0
