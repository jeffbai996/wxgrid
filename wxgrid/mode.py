"""How much weather to fetch: paused, simple or detailed.

Three settings, one file, no schema:

  paused    every scheduled pass exits 0 immediately. The switch you reach for
            when the box, the network or the disk needs the ingest to stop.
  simple    one global model and one regional, 00z and 12z only, no ensemble.
            The default: it keeps the map useful on a fraction of the bytes.
  detailed  every configured model, every cycle — the historical behaviour.

The file deliberately does NOT live under the data dir. On 2026-09-12 the
store's disk dropped off the bus and every read under it returned EIO; a
switch that says "stop hammering that disk" must not itself be on it. It goes
to $WXGRID_STATE_DIR, defaulting to ~/.local/state/wxgrid.
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path

log = logging.getLogger("wxgrid.mode")

MODES = ("paused", "simple", "detailed")
DEFAULT_MODE = "simple"

# Simple mode's fleet: the best global per byte fetched, and the regional that
# ages fastest and is cheapest to pull. Exported as a constant because the
# ingest filter, the /api/mode payload and the tests must not each carry their
# own idea of what "simple" means.
SIMPLE_MODELS = ("aifs", "hrdps")
# The two cycles every producer in the fleet publishes. 06z/18z double the
# fetch for half a day's extra freshness, which is the trade simple declines.
SIMPLE_CYCLES = (0, 12)


def state_dir() -> Path:
    """Where runtime state that must outlive the data disk lives."""
    override = os.environ.get("WXGRID_STATE_DIR")
    if override:
        return Path(override)
    base = os.environ.get("XDG_STATE_HOME") or (Path.home() / ".local" / "state")
    return Path(base) / "wxgrid"


def mode_path() -> Path:
    return state_dir() / "mode.json"


def read_mode() -> str:
    """The current mode, or the default when the file is missing or unreadable.

    Never raises: this is consulted at the top of every timer pass, and a pass
    that cannot parse a settings file should fetch weather, not crash.
    """
    try:
        value = json.loads(mode_path().read_text()).get("mode")
    except (OSError, ValueError, AttributeError):
        return DEFAULT_MODE
    return value if value in MODES else DEFAULT_MODE


def write_mode(mode: str) -> str:
    """Persist a mode. Raises ValueError on anything not in MODES."""
    if mode not in MODES:
        raise ValueError(f"unknown mode {mode!r}; expected one of {MODES}")
    path = mode_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps({"mode": mode}))
    tmp.replace(path)                       # atomic: a torn file reads as default
    log.info("ingest mode set to %s", mode)
    return mode


def models_for_mode(mode: str, group: str, keys: list[str]) -> list[str]:
    """The subset of `keys` a pass over `group` should walk in this mode.

    Only simple filters. Paused is handled before this is reached (the pass
    exits); detailed is the unfiltered list by definition.
    """
    if mode != "simple":
        return list(keys)
    if group == "ensemble":
        return []
    return [k for k in keys if k in SIMPLE_MODELS]


def cycle_allowed(mode: str, hour: int) -> bool:
    """Whether a run at this UTC cycle hour is worth fetching in this mode."""
    return hour in SIMPLE_CYCLES if mode == "simple" else True
