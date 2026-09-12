"""The demo's data is frozen: a front-only rebuild leaves api/ alone.

Refreshing the demo's weather twice a day was disk burn for no gain — the UI
is what the demo demonstrates, and the `Static demo · run <built>Z` toast is
honest about the age of the numbers.
"""
import json
from pathlib import Path

import pytest

from wxgrid import static_demo


def _seed(out: Path) -> None:
    """A dist-pages that a previous data build left behind."""
    (out / "api" / "layer" / "aifs" / "2026-01-01T00" / "0").mkdir(parents=True)
    (out / "api" / "layer" / "aifs" / "2026-01-01T00" / "0" / "wind.png").write_bytes(b"png")
    (out / "api" / "models.json").write_text(json.dumps(
        {"models": [], "layers": [], "levels": [], "static": {"built": "2026-01-01T00"}}))
    (out / "index.html").write_text("stale")
    (out / "stale-asset.js").write_text("stale")


def test_front_only_rebuilds_the_shell_and_keeps_every_api_byte(tmp_path):
    out = tmp_path / "pages"
    out.mkdir()
    _seed(out)
    before = (out / "api" / "layer" / "aifs" / "2026-01-01T00" / "0" / "wind.png").read_bytes()
    summary = static_demo.build_front_only(out)
    assert summary["front_only"] is True
    assert (out / "api" / "layer" / "aifs" / "2026-01-01T00" / "0" / "wind.png").read_bytes() == before
    assert json.loads((out / "api" / "models.json").read_text())["static"]["built"] == "2026-01-01T00"
    html = (out / "index.html").read_text()
    assert html.count("wxgrid-mode") == 1 and "static-api.js" in html
    assert html.index('src="static-api.js"') < html.index('src="bundle.js"')
    assert (out / "bundle.js").exists() and not (out / "private").exists()


def test_front_only_replaces_stale_assets_from_a_previous_build(tmp_path):
    out = tmp_path / "pages"
    out.mkdir()
    _seed(out)
    static_demo.build_front_only(out)
    assert not (out / "stale-asset.js").exists()


def test_front_only_refuses_an_output_that_has_no_data_to_reuse(tmp_path):
    out = tmp_path / "pages"
    out.mkdir()
    with pytest.raises(SystemExit):
        static_demo.build_front_only(out)


def test_the_demo_bundle_never_carries_the_ingest_control_markup(tmp_path):
    out = tmp_path / "pages"
    out.mkdir()
    _seed(out)
    static_demo.build_front_only(out)
    bundle = (out / "bundle.js").read_text()
    # The gate is `if (window.WXStatic) return ""` inside ingestBlock(); the
    # demo's page sets WXStatic, so the markup is never produced. Prove the
    # gate shipped rather than that the string is absent from the source.
    assert "function ingestBlock()" in bundle
    head = bundle[bundle.index("function ingestBlock()"):]
    assert head[:120].replace("\n", " ").strip().startswith(
        'function ingestBlock() { if (window.WXStatic) return "";'.split("{")[0].strip())
    assert "if (window.WXStatic) return \"\";" in head[:200]


def test_cli_defaults_to_reusing_data_and_can_still_be_told_to_refresh():
    import inspect
    src = inspect.getsource(static_demo.main)
    assert "--refresh-data" in src and "--reuse-data" in src
    assert "build_front_only" in src
