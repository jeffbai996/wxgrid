"""Failures are unknown, geographic routing is conservative, waits are bounded."""
import asyncio
import json
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor

import pytest

from wxgrid import deadline, ext, ext_api
from wxgrid.ttl_cache import _Cache


@pytest.fixture(autouse=True)
def fresh_cache(monkeypatch):
    monkeypatch.setattr(ext, "cache", _Cache())
    monkeypatch.setattr(ext_api, "_alert_slots", threading.BoundedSemaphore(2))


@pytest.mark.parametrize("point,source", [
    ((49.3, -123.1), "Environment Canada"), ((40, -100), "NWS"),
    ((52, 175), "NWS"), ((64, -155), "NWS"), ((21, -157), "NWS"),
    ((18.2, -66), "NWS"), ((15, 145), "NWS"), ((-14.3, -170.7), "NWS"),
    ((47.5, 13.5), "MeteoAlarm"), ((37.7, -25.7), "MeteoAlarm"),
    ((28.3, -16.6), "MeteoAlarm"), ((78, 16), "MeteoAlarm"),
    ((-37.5, 144.5), "BoM"), ((-12.2, 96.8), "BoM"), ((-29, 168), "BoM"),
])
def test_routing_keeps_mainland_and_remote_territories(point, source):
    assert source in ext.alert_sources(*point)


def test_canadian_point_does_not_fetch_unrelated_providers(monkeypatch):
    def forbidden(*a):
        pytest.fail("unrelated provider called")
    for name in ("_nws_point", "_ma_warnings", "_bom_warnings"):
        monkeypatch.setattr(ext, name, forbidden)
    monkeypatch.setattr(ext, "ec_alerts_point", lambda *a: [])
    result = ext.alerts_point_status(49.3, -123.1)
    assert result == {"alerts": [], "sources": ["Environment Canada"], "unavailable": [], "complete": True}
    assert ext.alerts_point_status(0, 0)["complete"] is False


def test_overlapping_providers_share_the_budget(monkeypatch):
    budgets = []
    def ec(*a):
        budgets.append(deadline.remaining())
        raise TimeoutError("GeoMet failed")
    def nws(*a):
        budgets.append(deadline.remaining())
        return [{"event": "wind", "sev": 3}]
    monkeypatch.setattr(ext, "ec_alerts_point", ec)
    monkeypatch.setattr(ext, "_nws_point", nws)
    result = ext.alerts_point_status(48, -100)
    assert 0 < budgets[0] <= ext.ALERT_BUDGET / 2
    assert result["alerts"][0]["event"] == "wind"
    assert result["unavailable"] == ["Environment Canada"]


def test_malformed_success_document_is_not_an_all_clear(monkeypatch):
    monkeypatch.setattr(ext, "_get_json", lambda *a, **kw: {"error": "upstream error"})
    assert ext.alerts_point_status(49.3, -123.1)["complete"] is False
    with pytest.raises(ValueError):
        ext._ma_parse("<html/>")


def test_failed_provider_is_not_cached_as_an_empty_success(monkeypatch):
    calls = []
    def get(*args, **kw):
        calls.append(1)
        if len(calls) == 1:
            raise OSError("offline")
        return {"features": []}
    monkeypatch.setattr(ext, "_get_json", get)
    first = ext.alerts_point_status(49.3, -123.1)
    assert first["unavailable"] == ["Environment Canada"] and not first["complete"]
    assert ext.alerts_point_status(49.3, -123.1)["complete"] is True
    assert ext.alerts_point_status(49.3, -123.1)["complete"] is True
    assert len(calls) == 2


def test_cache_singleflight_wait_obeys_total_deadline():
    cache = _Cache()
    ready, release = threading.Event(), threading.Event()
    def fill():
        ready.set()
        release.wait(2)
        return [1]
    with ThreadPoolExecutor(1) as pool:
        fut = pool.submit(cache.get, "key", 300, fill)
        assert ready.wait(1)
        start = time.monotonic()
        try:
            with deadline.budget(.025), pytest.raises(TimeoutError):
                cache.get("key", 300, lambda: pytest.fail("duplicate fill"))
            assert time.monotonic() - start < .3
        finally:
            release.set()
        assert fut.result() == [1]


def test_expired_work_neither_fetches_nor_populates_cache():
    cache = _Cache()
    with deadline.budget(.01):
        def slow():
            time.sleep(.02)
            return "late"
        with pytest.raises(TimeoutError):
            cache.get("key", 300, slow)
    assert cache.get("key", 300, lambda: "fresh") == "fresh"
    with deadline.budget(0), pytest.raises(TimeoutError):
        cache.get("other", 300, lambda: pytest.fail("expired fetch"))


def test_partial_warning_and_failed_detail_remain_visible(monkeypatch):
    warning = {"id": "one", "source": "MeteoAlarm", "sev": 3, "event": "wind", "url": "https://example.test/cap",
               "geometry": {"type": "Polygon", "coordinates": [[[13, 47], [14, 47], [14, 48], [13, 48], [13, 47]]]}}
    def partial():
        raise ext._PartialAlerts([warning])
    def failed(url):
        raise TimeoutError("detail")
    monkeypatch.setattr(ext, "_ma_warnings", partial)
    monkeypatch.setattr(ext, "_ma_detail", failed)
    result = ext.alerts_point_status(47.5, 13.5)
    assert result["alerts"][0]["id"] == "one"
    assert result["unavailable"] == ["MeteoAlarm"] and not result["complete"]


def test_missing_geometry_is_incomplete_not_all_clear(monkeypatch):
    monkeypatch.setattr(ext, "_bom_warnings", lambda: [{"geometry": None}])
    assert ext.alerts_point_status(-37.5, 144.5)["unavailable"] == ["BoM"]


def test_meteoalarm_successful_countries_survive_partial_refresh(monkeypatch):
    calls = []
    monkeypatch.setattr(ext, "MA_COUNTRIES", ("austria", "germany"))
    monkeypatch.setattr(ext, "_emma_regions", lambda: {})
    def get(url, **kw):
        calls.append(url)
        if url.endswith("germany"):
            raise OSError("offline")
        return "<feed/>"
    monkeypatch.setattr(ext, "_get_text", get)
    for _ in range(2):
        with pytest.raises(ext._PartialAlerts):
            ext._ma_warnings()
    assert sum(u.endswith("austria") for u in calls) == 1
    assert sum(u.endswith("germany") for u in calls) == 2


def test_http_deadline_includes_queue_and_bounds_abandoned_work(monkeypatch):
    jobs = []
    class Pool:
        def submit(self, *a, **kw):
            job = Future()
            jobs.append(job)
            return job
    monkeypatch.setattr(ext_api, "_card_pool", Pool())
    monkeypatch.setattr(ext, "ALERT_BUDGET", .01)
    start = time.monotonic()
    response = asyncio.run(ext_api.api_alerts_point(lat=49.3, lon=-123.1))
    assert time.monotonic() - start < .7
    assert json.loads(response.body)["unavailable"] == ["Environment Canada"]
    assert response.headers["cache-control"] == "no-store"
    assert not jobs[0].cancelled()
    # Slots stay held by abandoned work until it really exits. Repeated
    # requests cannot stack replacement jobs behind a wedged worker pool.
    asyncio.run(ext_api.api_alerts_point(lat=49.3, lon=-123.1))
    for _ in range(5):
        response = asyncio.run(ext_api.api_alerts_point(lat=49.3, lon=-123.1))
        assert json.loads(response.body)["complete"] is False
    assert len(jobs) == 2


def test_http_boundary_does_not_wait_for_a_stalled_running_worker(monkeypatch):
    started, release = threading.Event(), threading.Event()
    def stalled(*a, **kw):
        started.set()
        release.wait(2)
        return {"alerts": []}
    with ThreadPoolExecutor(1) as pool:
        monkeypatch.setattr(ext_api, "_card_pool", pool)
        monkeypatch.setattr(ext, "alerts_point_status", stalled)
        monkeypatch.setattr(ext, "ALERT_BUDGET", .01)
        try:
            start = time.monotonic()
            response = asyncio.run(ext_api.api_alerts_point(lat=49.3, lon=-123.1))
            assert started.is_set() and time.monotonic() - start < .7
            assert json.loads(response.body)["complete"] is False
        finally:
            release.set()
