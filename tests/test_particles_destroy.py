from pathlib import Path

ROOT = Path(__file__).parents[1]


def _read(name: str) -> str:
    return (ROOT / "front" / name).read_text()


def test_destroy_clears_the_pinch_wait_and_watch_intervals():
    # destroy() used to leave both setInterval loops (pinch-zoom settle and
    # the starve watchdog) running after teardown. Neither is reachable from
    # outside the class, so a leaked interval keeps firing forever.
    source = _read("particles.js")
    destroy = source.split("destroy() {", 1)[1].split("\n  }", 1)[0]
    assert "clearInterval(this._pinchWait)" in destroy
    assert "this._pinchWait = null" in destroy
    assert "clearInterval(this._watch)" in destroy
    assert "this._watch = null" in destroy
