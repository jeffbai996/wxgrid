"""At most a few cold renders run at once. A burst of misses on different
keys used to render all of them in parallel: each is a global-grid upscale
and encode, and eight together exhaust the worker before anyone is served."""
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pytest
from fastapi.testclient import TestClient

from wxgrid import api, render
from wxgrid.config import STORE_DIR
from wxgrid.store import RunWriter

RID = "2026-07-02T00"


@pytest.fixture(scope="module")
def client():
    steps = [0, 3, 6, 9, 12, 15]
    w = RunWriter("gfs", RID, steps, ["t2m", "u10", "v10"], root=STORE_DIR)
    for step in steps:
        w.write("t2m", step, np.full(w.grid_shape, 290.0, np.float32))
        w.write("u10", step, np.full(w.grid_shape, 3.0, np.float32))
        w.write("v10", step, np.full(w.grid_shape, -1.0, np.float32))
    w.finish()
    return TestClient(api.app)


def test_cold_renders_are_capped(client, monkeypatch):
    running, peak, lock = [0], [0], threading.Lock()
    real = render.colorize

    def slow_colorize(*a, **kw):
        with lock:
            running[0] += 1; peak[0] = max(peak[0], running[0])
        time.sleep(0.3)
        try:
            return real(*a, **kw)
        finally:
            with lock:
                running[0] -= 1
    monkeypatch.setattr(render, "colorize", slow_colorize)
    urls = [f"/api/layer/gfs/{RID}/{s}/temp.png" for s in (0, 3, 6, 9, 12, 15)]
    with ThreadPoolExecutor(6) as ex:
        codes = list(ex.map(lambda u: client.get(u).status_code, urls))
    assert codes == [200] * 6
    assert peak[0] <= api.RENDER_SLOTS
