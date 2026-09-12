"""A group pass consults the mode before it touches the network or the store.

Nothing here opens a store or resolves a run: the pass is intercepted at the
point where it has decided which models to walk, which is the only decision
the mode participates in.
"""
import pytest

from wxgrid import ingest, mode as m


@pytest.fixture(autouse=True)
def _state_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("WXGRID_STATE_DIR", str(tmp_path / "state"))
    yield


@pytest.fixture
def walked(monkeypatch):
    """Record the model keys a pass would walk, and never run one."""
    seen: list[str] = []

    def _fake(model, run, **kw):                       # pragma: no cover - args unused
        seen.append(model.key)

    monkeypatch.setattr(ingest, "ingest_run", _fake)
    monkeypatch.setattr(ingest, "repair_cubes", lambda *a, **k: [])
    monkeypatch.setattr(ingest, "sweep_orphan_gribs", lambda *a, **k: [])
    monkeypatch.setattr(ingest, "models_in", lambda group: {
        "global": ["ifs", "aifs", "gfs"], "regional": ["hrdps", "hrrr"], "ensemble": ["gefs"]}[group])
    monkeypatch.setattr(ingest, "ingest_order", lambda: ["hrdps", "hrrr", "ifs", "aifs", "gfs", "gefs"])
    import datetime as _dt
    monkeypatch.setattr(ingest, "_resolve_run",
                        lambda model, run: _dt.datetime(2026, 1, 1, 12, tzinfo=_dt.timezone.utc))
    return seen


def test_paused_exits_zero_without_walking_a_single_model(walked, caplog):
    m.write_mode("paused")
    with caplog.at_level("INFO", logger="wxgrid.ingest"):
        rc = ingest.main(["--group", "global"])
    assert rc == 0 and walked == []
    assert "paused" in caplog.text


def test_paused_also_stops_the_no_arg_full_pass(walked):
    m.write_mode("paused")
    assert ingest.main(["--all"]) == 0
    assert walked == []


def test_simple_walks_only_the_simple_model_of_that_group(walked):
    m.write_mode("simple")
    assert ingest.main(["--group", "global"]) == 0
    assert walked == ["aifs"]
    walked.clear()
    assert ingest.main(["--group", "regional"]) == 0
    assert walked == ["hrdps"]


def test_simple_makes_the_ensemble_group_a_no_op(walked):
    m.write_mode("simple")
    assert ingest.main(["--group", "ensemble"]) == 0
    assert walked == []


def test_simple_skips_a_cycle_that_is_not_00z_or_12z(walked, monkeypatch):
    import datetime as _dt
    monkeypatch.setattr(ingest, "_resolve_run",
                        lambda model, run: _dt.datetime(2026, 1, 1, 18, tzinfo=_dt.timezone.utc))
    m.write_mode("simple")
    assert ingest.main(["--group", "global"]) == 0
    assert walked == []


def test_detailed_walks_every_model_of_the_group(walked):
    m.write_mode("detailed")
    assert ingest.main(["--group", "global"]) == 0
    assert walked == ["ifs", "aifs", "gfs"]


def test_an_explicit_model_ignores_the_mode_because_a_human_asked(walked):
    m.write_mode("paused")
    assert ingest.main(["--model", "gfs"]) == 0
    assert walked == ["gfs"]


def test_force_ignores_the_mode_on_a_group_pass(walked):
    m.write_mode("paused")
    assert ingest.main(["--group", "global", "--force"]) == 0
    assert walked == ["ifs", "aifs", "gfs"]
    walked.clear()
    m.write_mode("simple")
    assert ingest.main(["--group", "global", "--force"]) == 0
    assert walked == ["ifs", "aifs", "gfs"]
