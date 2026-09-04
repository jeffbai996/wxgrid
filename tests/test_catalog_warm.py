"""Concurrent visits share one catalog build; startup warms before serving."""
import asyncio
import time
from concurrent.futures import ThreadPoolExecutor

from wxgrid import api


def test_concurrent_catalog_requests_build_once(monkeypatch):
    calls = []
    monkeypatch.setattr(api, "_models_cache", {"key": None, "payload": None})
    monkeypatch.setattr(api, "store_summary", lambda: {})
    monkeypatch.setattr(api, "_models_key", lambda summary: ("test",))

    def build(summary):
        calls.append(1)
        time.sleep(0.02)
        return {"models": []}

    monkeypatch.setattr(api, "_build_models", build)
    with ThreadPoolExecutor(max_workers=4) as pool:
        assert list(pool.map(lambda _: api.api_models(), range(4))) == [{"models": []}] * 4
    assert len(calls) == 1


def test_lifespan_warms_catalog_before_accepting_requests(monkeypatch):
    calls = []
    monkeypatch.setattr(api, "api_models", lambda: calls.append(1))

    async def check():
        async with api.catalog_lifespan(api.app):
            assert calls == [1]

    asyncio.run(check())
