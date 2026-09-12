"""Start and inspect the ingest units without blocking on them.

The systemctl call is a parameter, not an import: the tests, and any box where
these user units are not installed, must never depend on systemd being there.
A runner takes an argv list (everything after `systemctl --user`) and returns
(returncode, stdout).
"""
from __future__ import annotations

import logging
import os
import re
import subprocess
from pathlib import Path
from typing import Callable

from wxgrid import mode as ingest_mode

log = logging.getLogger("wxgrid.ingest_control")

Runner = Callable[[list[str]], "tuple[int, str]"]

GLOBAL_UNIT = "wxgrid-ingest.service"
REGIONAL_UNIT = "wxgrid-ingest-regional.service"
ENSEMBLE_UNIT = "wxgrid-ingest-ensemble.service"
# Simple mode has no ensemble models, so refreshing it would start a unit whose
# only job is to exit having found nothing to do.
SIMPLE_UNITS = (GLOBAL_UNIT, REGIONAL_UNIT)
DETAILED_UNITS = (GLOBAL_UNIT, REGIONAL_UNIT, ENSEMBLE_UNIT)
ALL_UNITS = DETAILED_UNITS

# The ingest logs to the journal; a box that also tees it to a file can point
# this at it and the status route gets a "last written" timestamp for free.
LOG_PATH_ENV = "WXGRID_INGEST_LOG"
_WRITTEN = re.compile(r"^(\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d)\b.*\bwritten\b")


def systemctl(argv: list[str]) -> tuple[int, str]:
    """The real runner. Never raises on a non-zero exit — `is-active` uses it."""
    proc = subprocess.run(["systemctl", "--user", *argv], capture_output=True, text=True, timeout=15)
    return proc.returncode, (proc.stdout or "").strip()


def units_for(mode: str) -> list[str]:
    if mode == "paused":
        return []
    return list(SIMPLE_UNITS if mode == "simple" else DETAILED_UNITS)


def refresh_now(run: Runner = systemctl) -> dict:
    """Kick one pass of the current mode's units and return immediately.

    `systemctl start` waits for the job to finish by default, and an ingest
    pass is measured in tens of minutes — the route would hang the browser. So
    --no-block, and the caller polls status().
    """
    units = units_for(ingest_mode.read_mode())
    if not units:
        return {"started": False, "units": []}
    try:
        rc, out = run(["start", "--no-block", *units])
    except (OSError, subprocess.SubprocessError) as exc:
        log.warning("could not start ingest units: %s", exc)
        return {"started": False, "units": []}
    if rc != 0:
        log.warning("systemctl start returned %d: %s", rc, out)
        return {"started": False, "units": units}
    return {"started": True, "units": units}


def status(run: Runner = systemctl) -> dict:
    """Per-unit state, plus whether anything is currently running."""
    states: dict[str, str] = {}
    for unit in ALL_UNITS:
        try:
            _, out = run(["is-active", unit])
        except (OSError, subprocess.SubprocessError):
            states[unit] = "unknown"
            continue
        # activating/deactivating both read as "in flight" to the UI.
        states[unit] = out or "inactive"
    return {"units": states,
            "running": any(s in ("active", "activating", "reloading") for s in states.values()),
            "last_written": last_written()}


def last_written(path: Path | None = None) -> str | None:
    """Timestamp of the newest "… written …" line in the ingest log, if there
    is a log file at all. Cheap by design: no journal query, no parsing beyond
    a prefix match, None whenever the answer is not sitting in a file."""
    if path is None:
        configured = os.environ.get(LOG_PATH_ENV)
        if not configured:
            return None
        path = Path(configured)
    try:
        lines = path.read_text(errors="replace").splitlines()
    except OSError:
        return None
    for line in reversed(lines):
        hit = _WRITTEN.match(line)
        if hit:
            return hit.group(1)
    return None
