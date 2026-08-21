import json

import numpy as np
from fastapi.testclient import TestClient

from wxgrid import api, render
from wxgrid.config import STORE_DIR
from wxgrid.ingest import accumulation_bucket
from wxgrid.models import MODELS, Model
from wxgrid.store import RunReader, RunWriter


def _regional_model(key: str = "regional-test") -> Model:
    return Model(
        key=key,
        label="Regional test",
        short="REG",
        source="test",
        grid="2.5km",
        grid_shape=(3, 5),
        lat0=50.0,
        lon0=-124.0,
        dlat=-0.025,
        dlon=0.025,
        domain=(-124.0, 49.95, -123.9, 50.0),
        steps=[0, 1],
        sfc_params={"10u": "u10"},
    )


def test_per_model_grid_roundtrip_and_point_lookup(tmp_path, monkeypatch):
    model = _regional_model()
    monkeypatch.setitem(MODELS, model.key, model)
    field = np.arange(15, dtype=np.float32).reshape(3, 5)

    writer = RunWriter(model.key, "2026-01-01T00", [0, 1], ["u10"], root=tmp_path)
    writer.write("u10", 0, field)
    writer.write("u10", 1, field + 100)
    writer.finish()

    reader = RunReader(model.key, "2026-01-01T00", root=tmp_path)
    assert reader.grid_shape == (3, 5)
    assert reader.lats.tolist() == [50.0, 49.974998474121094, 49.95000076293945]
    assert reader.lons.tolist() == [-124.0, -123.9749984741211, -123.94999694824219,
                                    -123.92500305175781, -123.9000015258789]
    assert reader.slab("u10", 0).shape == (3, 5)
    assert reader.point("u10", 49.975, -123.95).tolist() == [7.0, 107.0]
    assert reader.contains(49.95, -124.0)
    assert not reader.contains(49.0, -124.0)


def test_models_advertise_domain_and_out_of_domain_point_is_clear(monkeypatch):
    model = _regional_model("regional-api-test")
    monkeypatch.setitem(MODELS, model.key, model)
    writer = RunWriter(model.key, "2026-01-01T00", [0, 1], ["u10"], root=STORE_DIR)
    writer.write("u10", 0, np.ones(model.grid_shape, dtype=np.float32))
    writer.write("u10", 1, np.ones(model.grid_shape, dtype=np.float32))
    writer.finish()
    api._readers.clear()

    client = TestClient(api.app)
    info = next(item for item in client.get("/api/models").json()["models"] if item["key"] == model.key)
    assert info["domain"] == [-124.0, 49.95, -123.9, 50.0]
    assert info["grid_shape"] == [3, 5]
    outside = client.get("/api/point", params={"model": model.key, "lat": 48.0, "lon": -123.95})
    assert outside.status_code == 200
    assert outside.json() == {
        "available": False,
        "model": model.key,
        "run": "2026-01-01T00",
        "lat": 48.0,
        "lon": -123.95,
        "reason": "Point is outside the Regional test forecast domain.",
    }


def test_hrrr_since_start_precip_is_deaccumulated_per_hour():
    previous = (0, 1, np.full((2, 2), 1.25, dtype=np.float32))
    total = np.full((2, 2), 3.75, dtype=np.float32)
    bucket = accumulation_bucket("since_start", 2, 0, total, previous)
    np.testing.assert_allclose(bucket, 2.5)
    np.testing.assert_allclose(accumulation_bucket("per_step", 2, 1, total, previous), total)


def test_regional_render_and_particle_grid_do_not_wrap():
    field = np.tile(np.array([50.0, 49.975, 49.95], dtype=np.float32)[:, None], (1, 5))
    merc = render.to_mercator(field, lat0=50.0, lon0=-124.0, dlat=-0.025, dlon=0.025)
    assert merc.shape[1] == 5
    assert merc[0, 0] > merc[-1, 0]
    assert 49.94 < merc[-1, 0] < 50.01

    payload = json.loads(render.wind_json(
        np.ones((3, 5), dtype=np.float32),
        np.zeros((3, 5), dtype=np.float32),
        factor=1,
        lat0=50.0,
        lon0=-124.0,
        dlat=-0.025,
        dlon=0.025,
        wrap=False,
    ))
    assert payload["wrap"] is False
    assert payload["nx"] == 5
    assert payload["ny"] == 3
    assert payload["lon0"] == -124.0 and payload["lat0"] == 50.0
