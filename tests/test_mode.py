"""Ingest mode: paused | simple | detailed.

The mode file deliberately lives outside the data dir. The data disk is the
one thing that can drop off the bus, and a mode nobody can read is a mode
nobody can use to stop the ingest that is hammering the dying disk.
"""
import json

import pytest

from wxgrid import mode as m


@pytest.fixture(autouse=True)
def _state_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("WXGRID_STATE_DIR", str(tmp_path / "state"))
    yield


def test_default_is_simple_when_the_file_is_absent():
    assert m.read_mode() == "simple"


def test_state_dir_is_never_under_the_data_dir():
    # The data disk dropped off the bus on 2026-09-12 and every read under it
    # returned EIO. A mode switch stored there is a switch you cannot reach
    # exactly when you need it.
    from wxgrid.config import DATA_DIR
    path = m.mode_path()
    assert DATA_DIR.resolve() not in path.resolve().parents


def test_write_then_read_round_trips_every_mode():
    for want in m.MODES:
        m.write_mode(want)
        assert m.read_mode() == want


def test_write_rejects_an_unknown_mode():
    with pytest.raises(ValueError):
        m.write_mode("turbo")
    assert m.read_mode() == "simple"


def test_a_corrupt_or_unknown_file_reads_as_the_default():
    m.mode_path().parent.mkdir(parents=True, exist_ok=True)
    m.mode_path().write_text("{not json")
    assert m.read_mode() == "simple"
    m.mode_path().write_text(json.dumps({"mode": "turbo"}))
    assert m.read_mode() == "simple"


def test_simple_keeps_one_global_and_one_regional_model():
    # aifs is the best global per byte fetched; hrdps is the regional that ages
    # fastest and is cheapest. Ensemble is skipped entirely in simple.
    assert m.SIMPLE_MODELS == ("aifs", "hrdps")
    assert m.models_for_mode("simple", "global", ["ifs", "aifs", "gfs", "gem"]) == ["aifs"]
    assert m.models_for_mode("simple", "regional", ["hrdps", "hrrr"]) == ["hrdps"]
    assert m.models_for_mode("simple", "ensemble", ["gefs"]) == []


def test_detailed_and_paused_do_not_filter_the_model_list():
    every = ["ifs", "aifs", "gfs"]
    assert m.models_for_mode("detailed", "global", every) == every
    assert m.models_for_mode("paused", "global", every) == every


def test_simple_runs_only_the_00z_and_12z_cycles():
    assert m.cycle_allowed("simple", 0) and m.cycle_allowed("simple", 12)
    assert not m.cycle_allowed("simple", 6) and not m.cycle_allowed("simple", 18)
    for hour in (0, 6, 12, 18):
        assert m.cycle_allowed("detailed", hour)
    assert m.SIMPLE_CYCLES == (0, 12)


def test_every_simple_model_is_a_real_model_in_its_expected_group():
    from wxgrid.ingest import model_tier
    from wxgrid.models import MODELS
    tiers = {model_tier(k) for k in m.SIMPLE_MODELS}
    assert all(k in MODELS for k in m.SIMPLE_MODELS)
    assert tiers == {"global", "regional"}
