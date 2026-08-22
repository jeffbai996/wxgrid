"""Cache semantics for more than one user: run-keyed files are immutable
(already), the point series is edge-cacheable and conditional, the shell
always revalidates (a stale styles.css cost a morning on 2026-08-22), and
every request leaves one access line with its timing and cache outcome."""
import logging

import numpy as np
import pytest
from fastapi.testclient import TestClient

from wxgrid import api
from wxgrid.config import STORE_DIR
from wxgrid.store import RunWriter

RID = "2026-07-01T00"


@pytest.fixture(scope="module")
def client():
    w = RunWriter("gfs", RID, [0, 3], ["t2m", "u10", "v10"], root=STORE_DIR)
    for step in (0, 3):
        w.write("t2m", step, np.full(w.grid_shape, 290.0, np.float32))
        w.write("u10", step, np.full(w.grid_shape, 3.0, np.float32))
        w.write("v10", step, np.full(w.grid_shape, -1.0, np.float32))
    w.finish()
    return TestClient(api.app)


def test_point_series_is_edge_cacheable_and_conditional(client):
    r = client.get("/api/point", params={"lat": 49.2, "lon": -123.1, "model": "gfs", "run": RID})
    assert r.status_code == 200 and r.json()["available"]
    assert "max-age=300" in r.headers["cache-control"] and "public" in r.headers["cache-control"]
    etag = r.headers["etag"]
    again = client.get("/api/point", params={"lat": 49.2, "lon": -123.1, "model": "gfs", "run": RID},
                       headers={"If-None-Match": etag})
    assert again.status_code == 304


def test_shell_assets_always_revalidate(client):
    r = client.get("/styles.css")
    assert r.status_code == 200
    assert r.headers["cache-control"] == "no-cache" and r.headers.get("etag")
    assert client.get("/api/models").headers["cache-control"] == "no-cache"


def test_run_keyed_files_stay_immutable(client):
    r = client.get(f"/api/layer/gfs/{RID}/0/temp.png")
    assert r.status_code == 200 and "immutable" in r.headers["cache-control"]


def test_every_request_logs_timing_and_cache_outcome(client, caplog):
    with caplog.at_level(logging.INFO, logger="wxgrid.access"):
        client.get(f"/api/layer/gfs/{RID}/3/wind.png")
        client.get(f"/api/layer/gfs/{RID}/3/wind.png")
        client.get("/api/models")
    lines = [rec.getMessage() for rec in caplog.records if rec.name == "wxgrid.access"]
    assert len(lines) == 3
    assert "cache=miss" in lines[0] and "cache=hit" in lines[1] and "cache=-" in lines[2]
    assert all(" 200 " in l and l.endswith("ms") for l in lines)


def test_card_stream_still_carries_the_point(client):
    """The card opens from one NDJSON stream whose first line is the point
    series, produced by calling the series function directly. Adding an HTTP
    `request` parameter to the route broke that call and the card went
    'point forecast unavailable' while /api/point itself still answered
    (2026-08-22) — the route and the function are separate now, and this
    guards the seam."""
    import json
    r = client.get("/api/card", params={"lat": 49.2, "lon": -123.1, "model": "gfs", "run": RID})
    assert r.status_code == 200
    first = json.loads(r.text.splitlines()[0])
    assert first["kind"] == "point" and "error" not in first, first
    assert first["data"]["available"] and first["data"]["series"]["t2m"]
    assert api.point_series(lat=49.2, lon=-123.1, model="gfs", run=RID)["available"]
