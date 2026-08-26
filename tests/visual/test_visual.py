"""The visual checks as pytest, skipping when there is nothing to look at.

Opt-in by construction: the ship loop globs `tests/test_*.py` at the top level
and never reaches this file. Run it directly:

    pytest tests/visual/ -v
    pytest tests/visual/ -v --base http://127.0.0.1:8197
"""
from __future__ import annotations

import pytest

from tests.visual import views as V
from tests.visual.driver import Chrome, available
from tests.visual.harness import GOLDEN_DIR, capture, compare, measure, painting
from tests.visual.run import OUT_DIR, _capture_overlay, _feature_count, _server_up


def pytest_addoption(parser):                      # pragma: no cover - pytest hook
    parser.addoption("--base", default="http://127.0.0.1:8097")


@pytest.fixture(scope="module")
def base(request) -> str:
    try:
        value = request.config.getoption("--base")
    except ValueError:
        value = "http://127.0.0.1:8097"
    if not _server_up(value):
        pytest.skip(f"no wxgrid at {value}")
    return value


@pytest.fixture(scope="module")
def chrome():
    if not available():
        pytest.skip("no debuggable Chrome")
    c = Chrome()
    yield c
    c.close()


@pytest.mark.parametrize("view", V.CHROME, ids=lambda v: v.name)
def test_interface_matches_its_golden(view, base, chrome):
    golden = GOLDEN_DIR / f"{view.name}.png"
    if not golden.exists():
        pytest.skip(f"no golden for {view.name}; run: python -m tests.visual.run capture {view.name}")
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    shot = OUT_DIR / f"{view.name}.png"
    capture(view, base, shot, chrome)
    r = compare(golden, shot)
    assert r["ok"], f"{view.name}: {r['reason']} (see {shot})"


@pytest.mark.parametrize("view", V.PAINT, ids=lambda v: v.name)
def test_map_layer_paints_something(view, base, chrome):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    shot = OUT_DIR / f"{view.name}.png"
    capture(view, base, shot, chrome)
    s = measure(shot)
    assert painting(s), f"{view.name} drew nothing: {s} (see {shot})"


@pytest.mark.parametrize("ov", V.OVERLAY, ids=lambda o: o.view.name)
def test_overlay_draws_what_the_api_returned(ov, base, chrome):
    n = _feature_count(base, ov.probe)
    if n is None:
        pytest.skip(f"could not ask {ov.probe}")
    if n == 0:
        pytest.skip(f"{ov.view.name}: nothing to draw right now")
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    shot = OUT_DIR / f"{ov.view.name}.png"
    _capture_overlay(ov, base, shot, chrome)
    s = measure(shot)
    assert painting(s), (
        f"{ov.view.name}: {ov.probe} returned {n} features and the map is blank: {s}")
