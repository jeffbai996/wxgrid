"""The ingest block in the settings drawer, and its absence from the demo."""
import re
from pathlib import Path

ROOT = Path(__file__).parents[1]


def _read(name: str) -> str:
    return (ROOT / "front" / name).read_text()


def test_settings_carries_a_three_way_ingest_control_bound_to_the_api():
    s = _read("settings.js")
    assert 'data-key="ingest-mode"' in s
    modes = re.search(r"const INGEST_MODES = \[(.+?)\];", s)
    assert modes
    for value, label in (("paused", "Paused"), ("simple", "Simple"), ("detailed", "Detailed")):
        assert f'["{value}", "{label}"]' in modes.group(1)
    assert 'data-v="${v}"' in s
    assert "/api/mode" in s and "/api/ingest/refresh" in s and "/api/ingest/status" in s
    assert 'id="ingest-refresh"' in s


def test_the_block_is_gated_on_static_mode_so_the_demo_never_renders_it():
    s = _read("settings.js")
    # Same gate the rest of the front uses for the Pages build.
    assert "window.WXStatic" in s
    gate = re.search(r"function ingestBlock\(\)\s*\{\s*\n?\s*if \(window\.WXStatic\) return \"\";", s)
    assert gate, "the ingest block must return empty markup in static mode"


def test_status_polls_on_a_ten_second_beat_and_labels_only():
    s = _read("settings.js")
    assert "10000" in s or "10e3" in s
    # Labels only: the owner's UI rule forbids hints, tooltips and explainers
    # inside the drawer's controls.
    block = s[s.index("function ingestBlock()"):s.index("function ingestBlock()") + 2500]
    assert "title=" not in block and "placeholder=" not in block


def test_the_service_worker_shell_version_was_bumped():
    sw = _read("sw.js")
    version = re.search(r'const VERSION = "wxgrid-v(\d+)"', sw)
    assert version and int(version.group(1)) >= 116
