import numpy as np
from fastapi.testclient import TestClient

from wxgrid import api
from wxgrid.config import GRID_LAT_N, GRID_LON_N, STORE_DIR
from wxgrid.store import RunWriter


def _seed():
    w = RunWriter("aifs", "2026-01-01T00", [0, 6], ["u10", "v10", "t2m"], root=STORE_DIR)
    for s, val in [(0, 1.0), (6, 2.0)]:
        w.write("u10", s, np.full((GRID_LAT_N, GRID_LON_N), val, np.float32))
        w.write("v10", s, np.zeros((GRID_LAT_N, GRID_LON_N), np.float32))
        w.write("t2m", s, np.full((GRID_LAT_N, GRID_LON_N), 273.15 + 10 * val, np.float32))
    w.finish()


def test_models_layers_and_point():
    _seed()
    c = TestClient(api.app)
    m = c.get("/api/models").json()
    aifs = next(x for x in m["models"] if x["key"] == "aifs")
    assert aifs["runs"][0]["layers"] == ["t2m", "wind"]      # no msl/tp6/gust seeded
    p = c.get("/api/point", params={"lat": 49.28, "lon": -123.12, "model": "aifs"}).json()
    assert p["series"]["wind"] == [1.0, 2.0] and p["series"]["wdir"] == [270, 270]
    assert c.get("/api/layer/aifs/latest/6/wind.png").headers["content-type"] == "image/png"
    assert c.get("/api/layer/aifs/latest/6/msl.png").status_code == 404
    assert c.get("/api/wind/aifs/2026-01-01T00/0.json").json()["nx"] == 361
