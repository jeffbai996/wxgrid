import json
from pathlib import Path

import numpy as np
import pytest

from wxgrid import static_demo
from wxgrid.config import GRID_LAT_N, GRID_LON_N, STORE_DIR
from wxgrid.store import RunWriter


def test_static_build_writes_catalog_layers_and_point_tiles(tmp_path):
    variables = ["u10", "v10", "t2m", "msl", "u_850", "v_850", "t_850", "gh_850", "u_700", "v_700", "t_700", "gh_700"]
    w = RunWriter("aifs", "2026-01-01T00", [0, 12], variables, root=STORE_DIR)
    for s in (0, 12):
        for v in variables:
            w.write(v, s, np.full((GRID_LAT_N, GRID_LON_N), 1.0 if v.startswith(("u", "v")) else 280.0 if v.startswith("t") else 1500.0 if v.startswith("gh") else 101300.0, np.float32))
    w.finish()
    out = tmp_path / "pages"
    summary = static_demo.build(out, "aifs", [0, 12], scale=4)
    cat = json.loads((out / "api" / "models.json").read_text())
    assert cat["static"] and cat["models"][0]["runs"][0]["steps"] == [0, 12]
    assert (out / "api" / "layer" / "aifs" / "2026-01-01T00" / "0" / "wind.png").exists()
    assert (out / "api" / "layer" / "aifs" / "2026-01-01T00" / "0" / "wind-850.png").exists()
    assert (out / "api" / "wind" / "aifs" / "2026-01-01T00" / "12.json").exists()
    tile = json.loads((out / "api" / "pt" / "aifs" / "2026-01-01T00" / "4_2.json").read_text())   # 50N..40N, -160..-150
    assert tile["lat0"] == 50 and tile["lon0"] == -160 and len(tile["vars"]["t2m"]) == 2 * tile["ny"] * tile["nx"]
    assert summary["point_tiles"] == 648 and (out / "index.html").read_text().count("wxgrid-mode") == 1
    idx = (out / "index.html").read_text()
    assert idx.index('src="static-api.js"') < idx.index('src="app.js"')
    assert not (out / "private").exists()


def test_rewrite_index_injects_the_shim_ahead_of_the_app():
    html = (Path(__file__).resolve().parents[1] / "front" / "index.html").read_text()
    out = static_demo._rewrite_index(html)
    assert out.index('src="static-api.js"') < out.index('src="app.js"')
    assert out.count('src="static-api.js"') == 1
    assert "private/theme" not in out
    assert '<meta name="wxgrid-mode" content="static">' in out


def test_rewrite_index_raises_when_the_markup_drifts():
    # The whole point: a build that cannot patch the page must fail rather than
    # publish a demo pointed at an API that is not there.
    with pytest.raises(RuntimeError):
        static_demo._rewrite_index("<html><head><title>wxgrid</title></head><body></body></html>")
