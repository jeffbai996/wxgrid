"""Starting and inspecting the ingest units, with a fake systemctl runner.

Nothing here shells out: the runner is a parameter precisely so the tests, and
a box without these units installed, never depend on systemd being there.
"""
import pytest

from wxgrid import ingest_control as ic, mode as m


@pytest.fixture(autouse=True)
def _state_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("WXGRID_STATE_DIR", str(tmp_path / "state"))
    yield


class FakeRunner:
    """Stands in for `systemctl --user`; records argv, answers is-active."""

    def __init__(self, states: dict[str, str] | None = None):
        self.calls: list[list[str]] = []
        self.states = states or {}

    def __call__(self, argv: list[str]) -> tuple[int, str]:
        self.calls.append(list(argv))
        if argv and argv[0] == "is-active":
            state = self.states.get(argv[1], "inactive")
            return (0 if state == "active" else 3), state
        return 0, ""


def test_simple_mode_starts_the_global_and_regional_units_only():
    m.write_mode("simple")
    run = FakeRunner()
    assert ic.refresh_now(run) == {"started": True, "units": list(ic.SIMPLE_UNITS)}
    assert run.calls == [["start", "--no-block", *ic.SIMPLE_UNITS]]
    assert ic.ENSEMBLE_UNIT not in ic.SIMPLE_UNITS


def test_detailed_mode_also_starts_the_ensemble_unit():
    m.write_mode("detailed")
    run = FakeRunner()
    started = ic.refresh_now(run)
    assert ic.ENSEMBLE_UNIT in started["units"]
    assert run.calls[0][0] == "start"


def test_refresh_is_a_no_op_while_paused():
    m.write_mode("paused")
    run = FakeRunner()
    assert ic.refresh_now(run) == {"started": False, "units": []}
    assert run.calls == []


def test_refresh_never_blocks_on_the_units_it_starts():
    # `systemctl start` waits for the job by default, and an ingest pass is
    # measured in tens of minutes. --no-block is the whole point of the route.
    m.write_mode("detailed")
    run = FakeRunner()
    ic.refresh_now(run)
    assert "--no-block" in run.calls[0]


def test_status_reports_one_state_per_unit():
    run = FakeRunner({ic.GLOBAL_UNIT: "active", ic.REGIONAL_UNIT: "failed"})
    st = ic.status(run)
    assert st["units"][ic.GLOBAL_UNIT] == "active"
    assert st["units"][ic.REGIONAL_UNIT] == "failed"
    assert st["units"][ic.ENSEMBLE_UNIT] == "inactive"
    assert st["running"] is True


def test_status_is_not_running_when_every_unit_is_idle():
    st = ic.status(FakeRunner())
    assert st["running"] is False
    assert set(st["units"]) == set(ic.ALL_UNITS)


def test_status_survives_a_systemctl_that_is_not_there():
    def boom(argv):
        raise FileNotFoundError("systemctl")

    st = ic.status(boom)
    assert st["running"] is False
    assert all(v == "unknown" for v in st["units"].values())


def test_refresh_reports_not_started_when_systemctl_is_missing():
    def boom(argv):
        raise FileNotFoundError("systemctl")

    m.write_mode("simple")
    assert ic.refresh_now(boom)["started"] is False


def test_last_written_reads_the_newest_written_line(tmp_path):
    log = tmp_path / "ingest.log"
    log.write_text(
        "2026-09-12 10:29:00 INFO wxgrid.ingest: aifs 2026-09-12T00 written in 61 s\n"
        "2026-09-12 10:31:00 INFO wxgrid.ingest: hrdps 2026-09-12T12 written in 44 s\n"
        "2026-09-12 10:32:00 INFO wxgrid.ingest: nothing to do\n")
    assert ic.last_written(log) == "2026-09-12 10:31:00"


def test_last_written_is_none_without_a_log_or_a_written_line(tmp_path):
    assert ic.last_written(tmp_path / "nope.log") is None
    empty = tmp_path / "empty.log"
    empty.write_text("2026-09-12 10:00:00 INFO wxgrid.ingest: start\n")
    assert ic.last_written(empty) is None
