from datetime import datetime
from email.utils import formatdate
from pathlib import Path
from types import SimpleNamespace

import pytest
import requests

from wxgrid import ecmwf_budget as budget, fetch, ingest
from wxgrid.models import get_model


def response_error(status, retry=None):
    r = requests.Response()
    r.status_code = status
    r._content = b""
    r._content_consumed = True
    if retry is not None:
        r.headers["Retry-After"] = retry
    return requests.HTTPError(response=r)


def make_client(monkeypatch, fn):
    clock = [100.0]
    sleeps = []
    monkeypatch.setattr(budget.time, "monotonic", lambda: clock[0])
    def sleep(seconds):
        sleeps.append(seconds)
        clock[0] += seconds
    monkeypatch.setattr(budget.time, "sleep", sleep)
    raw = SimpleNamespace(session=requests.Session(), retrieve=fn, latest=fn)
    return budget.BoundedECMWF(get_model("aifs"), raw), sleeps, clock


def test_numeric_date_and_bad_retry_after():
    assert budget.retry_delay("12", 2) == 12
    assert budget.retry_delay(formatdate(120, usegmt=True), 2, now=100) == 20
    assert budget.retry_delay("garbage", 2) == 2
    assert budget.retry_delay("-1", 2) == 0


def test_retry_once_then_success(monkeypatch):
    calls = []
    def retrieve(**kw):
        calls.append(kw)
        if len(calls) == 1:
            raise response_error(429, "12")
        return "ok"
    client, sleeps, _ = make_client(monkeypatch, retrieve)
    assert client.retrieve(target="unused") == "ok"
    assert sleeps == [12] and len(calls) == 2 and client.wait_left == 888


@pytest.mark.parametrize("status,header,attempts", [(429, "301", 1), (429, "1", 4), (503, "1", 4), (403, None, 1), (404, None, 1)])
def test_retry_bounds(monkeypatch, status, header, attempts):
    calls = []
    def fail(**kw):
        calls.append(1)
        raise response_error(status, header)
    client, sleeps, _ = make_client(monkeypatch, fail)
    with pytest.raises(budget.FetchDeferred):
        client.retrieve()
    assert len(calls) == attempts
    assert len(sleeps) == attempts - 1


def test_model_wait_budget_and_probe_deadline(monkeypatch):
    def fail(**kw):
        raise response_error(429, "10")
    client, sleeps, _ = make_client(monkeypatch, fail)
    client.wait_left = 9
    with pytest.raises(budget.FetchDeferred):
        client.latest()
    assert sleeps == []
    assert client.client.session.deadline == 160


def test_stream_checks_deadline_and_closes(monkeypatch):
    clock = [0]
    monkeypatch.setattr(budget.time, "monotonic", lambda: clock[0])
    closed, timeouts = [], []
    def request(self, method, url, **kwargs):
        timeouts.append(kwargs)
        def chunks(*a, **kw):
            yield b"first"
            clock[0] = 6
            yield b"late"
        return SimpleNamespace(status_code=200, iter_content=chunks, close=lambda: closed.append(True))
    monkeypatch.setattr(requests.Session, "request", request)
    session = budget.DeadlineSession()
    session.deadline = 5
    r = session.get("https://example.invalid")
    parts = r.iter_content(1)
    assert next(parts) == b"first"
    with pytest.raises(budget.FetchDeferred):
        next(parts)
    assert closed and timeouts[0]["stream"] and timeouts[0]["timeout"] == (5, 5)


def test_transient_head_is_not_mistaken_for_unpublished_cycle(monkeypatch):
    monkeypatch.setattr(budget.time, "monotonic", lambda: 0)
    monkeypatch.setattr(requests.Session, "request", lambda *a, **kw: response_error(429, "10").response)
    session = budget.DeadlineSession()
    session.deadline = 5
    with pytest.raises(requests.HTTPError):
        session.head("https://example.invalid")


def test_grib_validation_and_completed_file_reuse(tmp_path):
    block = b"GRIB\x00\x00\x00\x02" + (20).to_bytes(8, "big") + b"7777"
    target = tmp_path / "step.grib2"
    target.write_bytes(block * 2)
    assert budget.valid_grib(target)
    assert fetch._ecmwf_get(None, get_model("aifs"), datetime(2026, 1, 1), 0, target, {"param": ["2t"]})
    for bad in (b"", b"<html>error</html>", block[:-1], block + b"trailing"):
        target.write_bytes(bad)
        assert not budget.valid_grib(target)


def test_deferred_ingest_retains_gribs_without_finish_or_warm(tmp_path, monkeypatch):
    grib = tmp_path / "grib" / "aifs" / "20260101T00"
    grib.mkdir(parents=True)
    (grib / "done.grib2").write_bytes(b"retained")
    class Writer:
        def __init__(self, *a, **kw): pass
        def finish(self): raise AssertionError("must not publish")
    def fail(*a, **kw): raise budget.FetchDeferred("429")
    monkeypatch.setattr(ingest, "RunWriter", Writer)
    monkeypatch.setattr(fetch, "fetch_ecmwf", fail)
    monkeypatch.setattr(ingest, "warm_layers", lambda *a: pytest.fail("must not warm"))
    with pytest.raises(budget.FetchDeferred):
        ingest._ingest_locked(get_model("aifs"), datetime(2026, 1, 1), "2026-01-01T00", tmp_path / "grib", tmp_path / "store", False)
    assert (grib / "done.grib2").exists()


def test_sweeper_skips_locked_old_run(tmp_path, monkeypatch):
    import os
    from contextlib import contextmanager
    path = tmp_path / "aifs" / "20260101T00"
    path.mkdir(parents=True)
    os.utime(path, (1, 1))
    @contextmanager
    def locked(*args):
        yield False
    monkeypatch.setattr(ingest, "run_lock", locked)
    assert ingest.sweep_orphan_gribs(tmp_path) == []
    assert path.exists()


def test_cli_continues_other_models_after_deferral(monkeypatch, tmp_path):
    # The default ingest mode is "simple", which walks one global model. This
    # test is about what a deferral does to the REST of a pass, so it asks for
    # the full fleet explicitly.
    monkeypatch.setenv("WXGRID_STATE_DIR", str(tmp_path / "state"))
    from wxgrid import mode as ingest_mode
    ingest_mode.write_mode("detailed")
    seen = []
    monkeypatch.setattr(ingest, "sweep_orphan_gribs", lambda *a: [])
    monkeypatch.setattr(ingest, "_resolve_run", lambda *a: datetime(2026, 1, 1))
    monkeypatch.setattr(ingest, "repair_cubes", lambda *a: [])
    def run(model, *args, **kw):
        seen.append(model.key)
        if len(seen) == 1:
            raise budget.FetchDeferred("budget")
    monkeypatch.setattr(ingest, "ingest_run", run)
    assert ingest.main(["--group", "global"]) == 1
    assert len(seen) > 1


def test_optional_missing_wave_does_not_hide_required_failure(tmp_path):
    class Client:
        def retrieve(self, **kw):
            raise ValueError("Cannot find index entries matching {'param': ['swh']}")
    args = (Client(), get_model("ifs"), datetime(2026, 1, 1), 0, tmp_path / "wave", {"param": ["swh"]})
    assert fetch._ecmwf_get(*args, optional=True) is False
    with pytest.raises(budget.FetchDeferred):
        fetch._ecmwf_get(*args)
