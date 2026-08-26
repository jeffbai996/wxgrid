"""Capture or check the visual views.

    python -m tests.visual.run capture            # (re)record every golden
    python -m tests.visual.run capture rail-right # one view
    python -m tests.visual.run check              # compare against the goldens
    python -m tests.visual.run check --base http://127.0.0.1:8197

Needs a wxgrid answering on `--base` and a Chrome listening for CDP on
BROWSE_CHROME_PORT (9224 by default). Both are checked up front, and a missing
one is reported plainly rather than as a stack trace.

Exit code is 1 when a view fails, so this can gate a deploy.
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from pathlib import Path

from tests.visual import views as V
from tests.visual.driver import Chrome, Tab, available, chrome_port
from tests.visual.harness import (GOLDEN_DIR, capture, compare, measure, painting,
                                  quiesce, write_diff)

OUT_DIR = Path("/tmp/wxgrid-visual")


def _server_up(base: str) -> bool:
    try:
        urllib.request.urlopen(f"{base.rstrip('/')}/healthz", timeout=5)
        return True
    except Exception:
        return False


def _feature_count(base: str, path: str) -> int | None:
    """How many features the API says it has. None when it could not be asked."""
    try:
        with urllib.request.urlopen(f"{base.rstrip('/')}{path}", timeout=30) as r:
            body = json.load(r)
    except Exception:
        return None
    feats = body.get("features") if isinstance(body, dict) else None
    return len(feats) if isinstance(feats, list) else None


def _capture_overlay(ov: V.Overlay, base: str, out: Path, chrome: Chrome) -> dict:
    """An overlay needs a click between load and capture, so it cannot use the
    plain `capture` path."""
    tab = Tab(chrome, ov.view.url(base), width=ov.view.width, height=ov.view.height)
    try:
        quiesce(tab, 500)
        tab.eval(ov.activate)
        quiesce(tab, ov.view.wait_ms)
        out.parent.mkdir(parents=True, exist_ok=True)
        tab.shot(str(out))
    finally:
        tab.close()
    from tests.visual.harness import _shrink
    _shrink(out, ov.view.crop)
    return {}


def cmd_capture(args) -> int:
    """Record the interface goldens, and report what the map views measure.

    Only CHROME views get a stored picture. A map view is checked against the
    numbers in `harness.measure`, never against a golden, so keeping one would
    be a file that rots without ever being read. The measurements are printed
    instead, because that is what the thresholds get calibrated against."""
    only = set(args.names)
    GOLDEN_DIR.mkdir(parents=True, exist_ok=True)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with Chrome() as chrome:
        for view in V.CHROME:
            if only and view.name not in only:
                continue
            state = capture(view, args.base, GOLDEN_DIR / f"{view.name}.png", chrome)
            print(f"  golden  {view.name:<16} {json.dumps(state)}")
        for view in V.PAINT:
            if only and view.name not in only:
                continue
            shot = OUT_DIR / f"{view.name}.png"
            capture(view, args.base, shot, chrome)
            print(f"  measure {view.name:<16} {json.dumps(measure(shot))}")
        for ov in V.OVERLAY:
            if only and ov.view.name not in only:
                continue
            shot = OUT_DIR / f"{ov.view.name}.png"
            _capture_overlay(ov, args.base, shot, chrome)
            print(f"  measure {ov.view.name:<16} {json.dumps(measure(shot))}")
    print(f"\ngoldens in {GOLDEN_DIR}")
    return 0


def cmd_check(args) -> int:
    only = set(args.names)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    failures, skipped = [], []
    with Chrome() as chrome:
        # The interface: compared against its stored picture.
        for view in V.CHROME:
            if only and view.name not in only:
                continue
            golden = GOLDEN_DIR / f"{view.name}.png"
            shot = OUT_DIR / f"{view.name}.png"
            if not golden.exists():
                skipped.append(f"{view.name}: no golden recorded")
                continue
            capture(view, args.base, shot, chrome)
            r = compare(golden, shot)
            if r["ok"]:
                print(f"  ok    {view.name:<16} {r['moved']:.2%} moved")
            else:
                write_diff(golden, shot, OUT_DIR / f"{view.name}-diff.png")
                print(f"  FAIL  {view.name:<16} {r['reason']}")
                failures.append(f"{view.name}: {r['reason']}")

        # The map: asked whether it painted, not whether it matches.
        for view in V.PAINT:
            if only and view.name not in only:
                continue
            shot = OUT_DIR / f"{view.name}.png"
            capture(view, args.base, shot, chrome)
            s = measure(shot)
            if painting(s):
                print(f"  ok    {view.name:<16} {s['distinct']} colours, ink {s['ink']:.2f}")
            else:
                print(f"  FAIL  {view.name:<16} nothing painted: {s}")
                failures.append(f"{view.name}: nothing painted ({s['distinct']} colours)")

        # Overlays: only a failure when the data was there and the map was not.
        for ov in V.OVERLAY:
            if only and ov.view.name not in only:
                continue
            n = _feature_count(args.base, ov.probe)
            if n is None:
                skipped.append(f"{ov.view.name}: could not ask {ov.probe}")
                continue
            if n == 0:
                skipped.append(f"{ov.view.name}: nothing to draw (0 features)")
                continue
            shot = OUT_DIR / f"{ov.view.name}.png"
            _capture_overlay(ov, args.base, shot, chrome)
            s = measure(shot)
            if painting(s):
                print(f"  ok    {ov.view.name:<16} {n} features, {s['distinct']} colours")
            else:
                print(f"  FAIL  {ov.view.name:<16} {n} features and a blank map: {s}")
                failures.append(f"{ov.view.name}: {n} features returned, nothing drawn")

    for s in skipped:
        print(f"  skip  {s}")
    if failures:
        print(f"\n{len(failures)} failed:")
        for f in failures:
            print(f"  - {f}")
        print(f"\nshots and diffs in {OUT_DIR}")
        return 1
    print("\nall views ok")
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="tests.visual.run")
    p.add_argument("command", choices=("capture", "check"))
    p.add_argument("names", nargs="*", help="limit to these view names")
    p.add_argument("--base", default="http://127.0.0.1:8097",
                   help="the wxgrid to point at")
    args = p.parse_args(argv)

    if not _server_up(args.base):
        print(f"no wxgrid answering at {args.base}", file=sys.stderr)
        return 2
    if not available():
        print(f"no debuggable Chrome on port {chrome_port()}; "
              f"set BROWSE_CHROME_PORT or start one", file=sys.stderr)
        return 2
    return cmd_capture(args) if args.command == "capture" else cmd_check(args)


if __name__ == "__main__":
    raise SystemExit(main())
