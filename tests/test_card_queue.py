"""A card deadline also releases context work that has not started."""
import asyncio
from concurrent.futures import Future, TimeoutError

from wxgrid import api, ext_api


def test_timed_out_card_cancels_queued_jobs(monkeypatch):
    jobs = []

    class Pool:
        def submit(self, *args):
            f = Future()
            jobs.append(f)
            return f

    def timeout(*args, **kwargs):
        raise TimeoutError()

    monkeypatch.setattr(api, "point_series", lambda **kw: {"available": True})
    monkeypatch.setattr(ext_api, "_card_pool", Pool())
    monkeypatch.setattr(ext_api, "POINT_BUDGET", 0.05)
    monkeypatch.setattr("concurrent.futures.as_completed", timeout)

    async def read():
        response = ext_api.api_card(lat=49, lon=-123, model="gfs", run="latest")
        return [line async for line in response.body_iterator]

    lines = asyncio.run(read())
    assert len(lines) == 7
    kinds = {__import__("json").loads(l)["kind"]: __import__("json").loads(l) for l in lines}
    # Six upstreams are named pending so the client refetches them alone.
    assert sum(1 for l in lines if '"pending": true' in l) == 6
    # The forecast has no second request on the client, so it is never
    # "pending"; a wedged read becomes an error the card can render.
    assert "pending" not in kinds["point"] and kinds["point"]["error"]
    assert len(jobs) == 7 and all(f.cancelled() for f in jobs)


def test_the_place_name_does_not_wait_on_the_forecast(monkeypatch):
    """The generator used to yield the forecast first, which also meant the
    context jobs were not SUBMITTED until the Zarr read returned — the place
    name, the station and the tides all queued behind a read they have nothing
    to do with. The forecast is allowed to be the slow one (Jeff 2026-09-09);
    the name is not allowed to wait for it."""
    import json
    import threading
    from wxgrid import ext

    release = threading.Event()

    def slow_point(**kw):
        assert release.wait(5), "the context jobs never ran while point blocked"
        return {"available": True}

    monkeypatch.setattr(api, "point_series", slow_point)
    monkeypatch.setattr(ext, "local_context", lambda la, lo: (release.set(), {"place": {"name": "Peachland"}})[1])
    for name, value in (("nearest_metar", lambda la, lo: None), ("taf", lambda s: None),
                        ("alerts_point_status", lambda la, lo, until=None: {"alerts": []}),
                        ("air", lambda la, lo: None), ("tides", lambda la, lo: None)):
        monkeypatch.setattr(ext, name, value)
    monkeypatch.setattr(api, "prob_point", lambda la, lo: None)

    async def read():
        response = ext_api.api_card(lat=49, lon=-123, model="gfs", run="latest")
        return [line async for line in response.body_iterator]

    lines = [json.loads(line) for line in asyncio.run(read())]
    kinds = [row["kind"] for row in lines]
    assert "point" in kinds and "local" in kinds
    assert kinds.index("local") < kinds.index("point"), kinds
    assert lines[kinds.index("local")]["data"]["place"]["name"] == "Peachland"
