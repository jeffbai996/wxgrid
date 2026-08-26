# Visual checks

The rest of the suite reads the source. `tests/test_front_ui.py` greps
`app.js` and `styles.css` for substrings, which is fast and catches a
contract being dropped, but it cannot see a rendered pixel. Everything that
actually broke this summer was invisible to it: a crosshair that turned solid
white, a `<select>` rendering white text on a white popup, tool-strip buttons
trimmed away by an overflow rule, a card row that would not centre, and an
Environment Canada alert raster that had been painting nothing for weeks
because the upstream renamed its WMS layer.

This directory looks at the running app.

## Two questions, because a golden image only answers one

**The interface** is compared against a stored picture. Those views are cropped
to exclude the map, so the golden stays valid as runs and weather move, and any
difference is a real difference.

**The map** cannot be. Tomorrow's run carries different weather, so a stored
picture of it would fail every day for the right reason and never for the wrong
one. Map views are checked by property instead — the number of distinct colours
and how much of the frame got painted — which answers the only question a
picture could not: is this overlay drawing anything at all.

**Overlays** are checked as a pair, because an empty map can be honest: no
fires burning, no alerts out. The API is asked what it has first. Nothing to
draw means the view is skipped and says so. Features returned and a blank map
is the failure.

## Running it

Needs a wxgrid to look at and a Chrome listening for CDP.

```
python -m tests.visual.run capture              # record every golden
python -m tests.visual.run check                # compare against them
python -m tests.visual.run check rail-right     # one view
python -m tests.visual.run check --base http://127.0.0.1:8197
```

`check` exits non-zero when a view fails. Failed comparisons write an
amplified difference image next to the capture, under `/tmp/wxgrid-visual`.

Chrome comes from `BROWSE_CHROME_PORT` (9224 by default). The driver talks raw
CDP rather than using Playwright, because the app registers a service worker
and Playwright asserts on worker targets it does not own, which blocks
`connect_over_cdp` for the whole browser. Raw CDP also gives each capture a
throwaway incognito context, so every run starts with an empty HTTP cache and
no worker of its own.

## Adding a view

Add it to `views.py`. `CHROME` for interface, `PAINT` for a map layer,
`OVERLAY` for something toggled on that has an API behind it. Then
`python -m tests.visual.run capture <name>` and commit the golden.

Goldens are cropped and downscaled to 480px wide before they are written, so
the whole set stays small enough to live in the repo and still large enough to
show a missing control.

## Recapturing

A deliberate design change makes a golden stale. Recapture that view, look at
the new picture, and commit it in the same change as the code that moved it.
A golden updated on its own, in its own commit, is a golden nobody checked.

## When it will not run

`pytest tests/visual/` skips itself when no Chrome or no server is there, so it
never turns a normal test run red. It is opt-in on purpose: the two-file halves
the ship loop runs glob `tests/test_*.py` at the top level and do not reach
this directory.
