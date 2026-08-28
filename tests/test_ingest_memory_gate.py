from dataclasses import replace
from datetime import datetime, timezone

from wxgrid import ingest


def test_step_gate_is_disabled_without_a_command(monkeypatch):
    monkeypatch.delenv("WXGRID_STEP_GATE_COMMAND", raising=False)
    monkeypatch.setattr(ingest.subprocess, "run", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError))

    ingest.wait_for_step_gate()


def test_step_gate_runs_the_configured_command_without_a_shell(monkeypatch):
    calls = []
    monkeypatch.setenv(
        "WXGRID_STEP_GATE_COMMAND",
        "/usr/bin/python3 /tmp/memory-gate wait --max-seconds 21600",
    )
    monkeypatch.setattr(ingest.subprocess, "run", lambda *args, **kwargs: calls.append((args, kwargs)))

    ingest.wait_for_step_gate()

    assert calls == [(([
        "/usr/bin/python3",
        "/tmp/memory-gate",
        "wait",
        "--max-seconds",
        "21600",
    ],), {"check": True})]


def test_ingest_checks_the_gate_between_complete_steps_only(tmp_path, monkeypatch):
    model = replace(ingest.get_model("gfs"), steps=[0, 6])
    gate_steps = []

    class Writer:
        variables = []

        def __init__(self, *args, **kwargs):
            pass

        def write(self, *args, **kwargs):
            pass

        def finish(self):
            return {}

    def fetch_two_steps(model, run, root, on_step):
        on_step(0, [])
        on_step(6, [])
        return [(0, []), (6, [])]

    monkeypatch.setattr(ingest, "RunWriter", Writer)
    monkeypatch.setattr(ingest.fetch, "fetch_gfs", fetch_two_steps)
    monkeypatch.setattr(ingest, "wait_for_step_gate", lambda: gate_steps.append("wait"))
    monkeypatch.setattr(ingest, "build_point_cube", lambda *args, **kwargs: 0)
    monkeypatch.setattr(ingest, "prune", lambda *args, **kwargs: [])
    monkeypatch.setattr(ingest, "warm_layers", lambda *args, **kwargs: 0)

    ingest._ingest_locked(
        model,
        datetime(2026, 8, 28, 12, tzinfo=timezone.utc),
        "2026-08-28T12",
        tmp_path / "grib",
        tmp_path / "store",
        True,
    )

    assert gate_steps == ["wait", "wait"]
