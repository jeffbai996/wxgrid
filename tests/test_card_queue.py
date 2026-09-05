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
    monkeypatch.setattr("concurrent.futures.as_completed", timeout)

    async def read():
        response = ext_api.api_card(lat=49, lon=-123, model="gfs", run="latest")
        return [line async for line in response.body_iterator]

    lines = asyncio.run(read())
    assert len(lines) == 7
    assert all('"pending": true' in line for line in lines[1:])
    assert len(jobs) == 6 and all(f.cancelled() for f in jobs)
