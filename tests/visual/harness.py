"""Capture a wxgrid view the same way twice.

A screenshot of a live weather map is not naturally reproducible: particles
animate, basemap tiles stream in, the service worker serves yesterday's bundle,
and "now" moves. Everything in this file exists to remove one of those.

The comparison is deliberately coarse. Goldens are stored downscaled, and a
view fails on gross change: a layer that stopped painting, a control that
vanished, text that turned the same colour as its background. Antialiasing
noise and a one-pixel shift are not regressions worth a red build.
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path

from PIL import Image

from tests.visual.driver import Chrome, Tab

HERE = Path(__file__).parent
GOLDEN_DIR = HERE / "golden"

# Goldens are stored at this width. Big enough to see a missing control, small
# enough that a full set stays a few hundred kilobytes in the repo.
GOLDEN_WIDTH = 480
# Per-pixel channel difference below this is noise, not change.
CHANNEL_TOLERANCE = 24
# A view fails when more than this fraction of pixels move by more than the
# tolerance above.
FAIL_FRACTION = 0.02


@dataclass(frozen=True)
class View:
    """One reproducible screenshot of the app."""

    name: str
    fragment: str                     # the URL hash: what the app should show
    wait_ms: int = 2500               # settling time after the map says it is ready
    width: int = 1280
    height: int = 800
    crop: tuple[int, int, int, int] | None = None   # left, top, right, bottom
    selector: str = ""                # crop to this element instead of `crop`
    ready: str = ""                   # extra JS that must be truthy before capture

    def url(self, base: str) -> str:
        frag = self.fragment if self.fragment.startswith("#") else "#" + self.fragment
        # Freeze the clock reference the app opens with, so "now" cannot move
        # the timeline between a golden and a check.
        sep = "&" if "?" in base else "?"
        return f"{base}{sep}visual=1{frag}"


def quiesce(tab: Tab, wait_ms: int) -> dict:
    """Stop everything that would differ between two identical runs.

    Order matters. The particle layer is disabled before the tiles are awaited,
    because turning it off mid-settle leaves a half-drawn frame behind."""
    # The map itself has to exist before anything else is worth trying.
    tab.wait("window.WX && WX.map && WX.catalog && WX.map.getStyle()", timeout=90)

    # Particles animate continuously: two runs never agree while they are on.
    tab.eval("""
      (() => {
        try { WX.windLayer && WX.windLayer.setEnabled && WX.windLayer.setEnabled(false); } catch (e) {}
        try { WX.windLayer && WX.windLayer.clear && WX.windLayer.clear(); } catch (e) {}
        return true;
      })()
    """)

    # Every basemap tile in, or two runs differ by whatever had arrived.
    tab.wait("WX.map.loaded() && WX.map.areTilesLoaded()", timeout=90)
    time.sleep(wait_ms / 1000)

    # A particle canvas can still hold its last frame after the layer is off.
    tab.eval("""
      (() => {
        const c = document.querySelector("#particles");
        if (c) { const x = c.getContext("2d"); x && x.clearRect(0, 0, c.width, c.height); }
        return true;
      })()
    """)
    time.sleep(0.4)
    return json.loads(tab.eval("""
      JSON.stringify({
        layer: WX.state.layer, level: WX.state.level || null, model: WX.state.model,
        run: WX.state.run, tiles: WX.map.areTilesLoaded(),
        field: !!(window.WX.field && WX.field.live)
      })
    """))


def capture(view: View, base: str, out_path: Path, chrome: Chrome | None = None) -> dict:
    """Screenshot one view. Returns what the app said it was showing, so a
    golden can never silently be of the wrong layer."""
    own = chrome is None
    chrome = chrome or Chrome()
    try:
        tab = Tab(chrome, view.url(base), width=view.width, height=view.height)
        try:
            state = quiesce(tab, view.wait_ms)
            if view.ready:
                tab.wait(view.ready, timeout=30)
            crop = element_box(tab, view.selector) if view.selector else view.crop
            out_path.parent.mkdir(parents=True, exist_ok=True)
            tab.shot(str(out_path))
        finally:
            tab.close()
    finally:
        if own:
            chrome.close()
    _shrink(out_path, crop)
    return state


def element_box(tab, selector: str, pad: int = 2) -> tuple[int, int, int, int]:
    """The on-screen box of one element, as a crop.

    Cropping to an element rather than to hardcoded pixels is what keeps these
    goldens maintainable: a view says WHICH control it is watching, and a
    layout change moves the crop with the control instead of silently sliding
    a neighbour into frame."""
    box = tab.eval(f"""
      (() => {{
        const el = document.querySelector({selector!r});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)];
      }})()
    """)
    if not box:
        raise RuntimeError(f"no element matches {selector!r}")
    left, top, right, bottom = box
    return (max(0, left - pad), max(0, top - pad), right + pad, bottom + pad)


def _shrink(path: Path, crop: tuple[int, int, int, int] | None) -> None:
    """Crop, downscale and rewrite in place, so what lands in git is small."""
    img = Image.open(path).convert("RGB")
    if crop:
        img = img.crop(crop)
    if img.width > GOLDEN_WIDTH:
        h = round(img.height * GOLDEN_WIDTH / img.width)
        img = img.resize((GOLDEN_WIDTH, h), Image.LANCZOS)
    img.save(path, format="PNG", optimize=True)


def compare(golden: Path, shot: Path) -> dict:
    """How far apart two captures are, and whether that counts as a change."""
    import numpy as np

    a = Image.open(golden).convert("RGB")
    b = Image.open(shot).convert("RGB")
    if a.size != b.size:
        return {"ok": False, "reason": f"size {b.size} != golden {a.size}",
                "moved": 1.0, "mean": None, "max": None}
    d = np.abs(np.asarray(a, np.int16) - np.asarray(b, np.int16))
    moved = float((d.max(axis=2) > CHANNEL_TOLERANCE).mean())
    return {"ok": moved <= FAIL_FRACTION, "moved": round(moved, 5),
            "mean": round(float(d.mean()), 2), "max": int(d.max()),
            "reason": "" if moved <= FAIL_FRACTION
                      else f"{moved:.1%} of pixels changed (limit {FAIL_FRACTION:.0%})"}


def write_diff(golden: Path, shot: Path, out: Path) -> None:
    """An amplified difference image, for a human deciding if it matters."""
    from PIL import ImageChops

    a = Image.open(golden).convert("RGB")
    b = Image.open(shot).convert("RGB")
    if a.size != b.size:
        return
    ImageChops.difference(a, b).point(lambda x: min(255, x * 6)).save(out)


# ── the other kind of check ───────────────────────────────────────────────
# A golden image cannot be used on the map itself. Tomorrow's run carries
# different weather, and a diff against yesterday's picture would fail every
# day for the right reason and never for the wrong one.
#
# So the map is checked by PROPERTY instead: an overlay that is painting looks
# nothing like an overlay that is not. Environment Canada's alert raster served
# a blank tile for an unknown number of weeks and no one noticed; `distinct`
# below is the number that would have been 1.


def measure(path: Path, crop: tuple[int, int, int, int] | None = None) -> dict:
    """Cheap descriptive statistics for a captured region.

    `distinct`  colours after a coarse 5-bit quantisation. A layer that is
                painting has many; a blank or single-colour tile has one or two.
    `spread`    mean absolute deviation from the region's own mean colour. Low
                on a flat fill, high on a real field.
    `ink`       fraction of pixels that differ from the most common colour,
                which for a map overlay is roughly "how much got painted".
    """
    import numpy as np

    img = Image.open(path).convert("RGB")
    if crop:
        img = img.crop(crop)
    a = np.asarray(img, np.uint8)
    q = (a >> 3).astype(np.int32)                      # 32 levels per channel
    codes = q[..., 0] * 1024 + q[..., 1] * 32 + q[..., 2]
    values, counts = np.unique(codes, return_counts=True)
    top = int(counts.max())
    return {"distinct": int(values.size),
            "spread": round(float(np.abs(a.astype(np.int16) - a.reshape(-1, 3).mean(0)).mean()), 2),
            "ink": round(float(1.0 - top / codes.size), 4)}


def painting(stats: dict, min_distinct: int = 24, min_ink: float = 0.05) -> bool:
    """Whether a region looks like something actually rendered into it."""
    return stats["distinct"] >= min_distinct and stats["ink"] >= min_ink
