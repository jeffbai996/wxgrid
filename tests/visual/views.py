"""What to look at, and which question to ask of it.

Two catalogues, because there are two kinds of visual regression and only one
of them can be checked against a stored picture.

CHROME views are the interface: the rail, the tape, the tool strip, the cards,
the menus. They are cropped to exclude the map, so a golden of one stays valid
across runs and weather, and any change is a real change. This is where the
bugs of the last month actually lived — a crosshair that turned solid white, a
dropdown rendering white text on white, buttons trimmed away by an overflow
rule, a card row that would not centre.

PAINT views ask a different question of the map: is anything being drawn at
all. No golden — the weather moves — just the statistics in `harness.measure`.
This is the check that would have caught Environment Canada's alert raster,
which served a blank tile for weeks because the WMS layer had been renamed.
"""
from __future__ import annotations

from dataclasses import dataclass

from tests.visual.harness import View

# A view of open water at a fixed zoom, so the frame is dominated by the
# overlay rather than by coastline.
ATLANTIC = "45.000,-30.000,3.20"
EUROPE = "50.000,5.000,4.00"
CASCADIA = "47.600,-122.300,6.00"
CANADA = "50.500,-115.000,5.00"

# ── the interface ─────────────────────────────────────────────────────────
# Crops are (left, top, right, bottom) in the 1280x800 capture.

# Every one of these watches a control, never a number. The forecast values in
# the tape and the point card change with each run, so a stored picture of them
# would go stale in six hours and teach everyone to ignore a red check. What is
# worth pinning is the furniture: which controls exist, where they sit, and
# whether their text is still legible against their background.

CHROME: list[View] = [
    View("models", f"{EUROPE};ifs;temp;s0", selector="#models"),
    View("levels", f"{EUROPE};ifs;temp;s0", selector="#levels"),
    View("layers", f"{EUROPE};ifs;temp;s0", selector="#layers"),
    View("legend", f"{EUROPE};ifs;temp;s0", selector="#legend"),
    View("legend-gh500", f"{EUROPE};ifs;gh/500;s0", selector="#legend"),
    View("rail", f"{EUROPE};ifs;temp;s0", selector=".rail"),
    View("tool-strip", f"{EUROPE};ifs;temp;s0", selector="#tstrip"),
    # The head carries the place name and elevation, which are fixed for a
    # fixed coordinate, and the tab row. The body below it is all values.
    View("point-head", f"{CASCADIA};ifs;temp;s0;p47.600,-122.300",
         selector=".point-head", wait_ms=4000,
         ready='document.querySelector("#point") && !document.querySelector("#point").hidden'),
    View("point-tabs", f"{CASCADIA};ifs;temp;s0;p47.600,-122.300",
         selector=".point-tabs", wait_ms=4000,
         ready='document.querySelector("#point") && !document.querySelector("#point").hidden'),
    View("phone-chrome", f"{EUROPE};ifs;temp;s0",
         width=420, height=880, crop=(0, 0, 420, 190)),
]

# ── the map ───────────────────────────────────────────────────────────────
# One entry per overlay that has its own way of going quiet. `crop` is the
# middle of the map, away from every control.

MAP_CROP = (200, 120, 1060, 640)

PAINT: list[View] = [
    View("paint-temp", f"{EUROPE};ifs;temp;s0", crop=MAP_CROP),
    View("paint-tp6", f"{EUROPE};ifs;tp6;s4", crop=MAP_CROP),
    View("paint-ptype", f"{EUROPE};ifs;ptype;s4", crop=MAP_CROP),
    View("paint-gh500", f"{EUROPE};ifs;gh/500;s0", crop=MAP_CROP),
    View("paint-waves", f"{ATLANTIC};ifs;waves;s0", crop=MAP_CROP),
    View("paint-cape", f"{EUROPE};ifs;cape;s0", crop=MAP_CROP),
    View("paint-regional", f"{CASCADIA};hrrr;temp;s0", crop=MAP_CROP),
    View("paint-globe", f"20.000,0.000,1.20;ifs;temp;s0", crop=MAP_CROP, wait_ms=4000),
]

# ── overlays ──────────────────────────────────────────────────────────────
# An overlay can be blank for an honest reason: no fires burning, no alerts
# out, a quiet night. "Nothing painted" is therefore not a failure on its own,
# and a check that treated it as one would cry wolf until someone turned it
# off.
#
# So each overlay is checked as a pair. Ask the API what it has; if it has
# nothing, the view is skipped and says so. If it HAS features and the map is
# still blank, that is the bug — the data arrived and the drawing did not.
# Environment Canada was the other shape of the same fault (the source itself
# went quiet), which is why `wxgrid/liveness.py` exists alongside this.


@dataclass(frozen=True)
class Overlay:
    view: View
    activate: str            # JS that turns the overlay on
    probe: str               # API path that says whether there is anything to draw
    count: str               # dotted path or expression naming the feature count


OVERLAY: list[Overlay] = [
    Overlay(
        View("paint-alerts", f"{CANADA};ifs;temp;s0", crop=MAP_CROP, wait_ms=6000),
        'document.querySelector("#alerts-toggle").click()',
        "/api/alerts/layer",
        "features",
    ),
    Overlay(
        View("paint-fires", f"{CASCADIA};ifs;temp;s0", crop=MAP_CROP, wait_ms=6000),
        'document.querySelector("#fires-toggle").click()',
        "/api/fires/layer",
        "features",
    ),
]

ALL_NAMES = ([v.name for v in CHROME] + [v.name for v in PAINT]
             + [o.view.name for o in OVERLAY])
