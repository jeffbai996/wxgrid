import json
from pathlib import Path

from wxgrid import phase_metrics as metrics


def test_disabled_metrics_do_not_read_proc(monkeypatch):
    monkeypatch.delenv("WXGRID_PHASE_METRICS", raising=False)
    monkeypatch.setattr(metrics, "snapshot", lambda: (_ for _ in ()).throw(AssertionError()))
    with metrics.Phase("gfs", "run", "warming") as phase:
        phase.tick()


def test_progress_rate_context_and_error_status(monkeypatch, caplog):
    monkeypatch.setenv("WXGRID_PHASE_METRICS", "1")
    now = [10]
    monkeypatch.setattr(metrics.time, "monotonic", lambda: now[0])
    monkeypatch.setattr(metrics, "snapshot", lambda: {"rss_bytes": 100, "read_bytes": 10})
    caplog.set_level("INFO", logger="wxgrid.ingest")
    with metrics.Phase("gfs", "run", "warming") as phase:
        for _ in range(1000): phase.tick()
        assert metrics.current.get() is phase
        now[0] += 60
        phase.tick(skipped=True)
        phase.gate_seconds = 3
    rows = [json.loads(record.message[6:]) for record in caplog.records]
    assert [r["status"] for r in rows] == ["start", "progress", "ok"]
    assert rows[-1]["completed"] == 1000 and rows[-1]["cache_skips"] == 1
    assert rows[-1]["gate_wait_s"] == 3
    assert metrics.current.get() is None


def test_missing_proc_is_optional(monkeypatch):
    def missing(*args): raise OSError("unsupported")
    monkeypatch.setattr(Path, "read_text", missing)
    assert metrics.snapshot() == {}
