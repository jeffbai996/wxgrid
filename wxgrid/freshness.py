"""Is what the store serves still fresh?

A `.zarr` on disk is not a served run (only a complete one is listed), and a
timer that fires is not a pass that finished — the ingest went 29 h stale on
2026-08-26 with every unit "active". So this asks the one question that
matters, per model: how old is the newest COMPLETE run against how old it is
allowed to be, given how often the model publishes and how long its pass
takes. `/api/health` carries the answer; `python -m wxgrid.freshness` exits
non-zero when anything is stale, for a timer or a squad check to act on.
"""
from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path

from wxgrid.config import STORE_DIR
from wxgrid.models import MODELS
from wxgrid.store import list_runs, parse_run_id

# Hours a model's newest run may be old before it is called stale: the
# publish cadence plus the measured pass ceiling, with slack. Regional models
# publish hourly and ingest in under an hour; a global cycle is 6 h and the
# store carries it within ~4 h of publication; the ensemble is 6 h and the
# probability pass is the slow part.
MAX_AGE_H = {"regional": 4.0, "global": 12.0, "ensemble": 16.0}


def tier(key: str) -> str:
    m = MODELS[key]
    if m.regional:
        return "regional"
    return "ensemble" if m.spread_params else "global"


def run_ages(now: datetime | None = None, root: Path = STORE_DIR) -> list[dict]:
    """One record per model: newest complete run, its age, the allowance,
    and whether it is stale. A model with no complete run at all is stale."""
    now = now or datetime.now(timezone.utc)
    out = []
    for key in sorted(MODELS):
        runs = list_runs(key, root)
        t = tier(key)
        allow = MAX_AGE_H[t]
        if not runs:
            out.append({"model": key, "tier": t, "run": None, "age_h": None, "max_age_h": allow, "stale": True})
            continue
        age = (now - parse_run_id(runs[0])).total_seconds() / 3600
        out.append({"model": key, "tier": t, "run": runs[0], "age_h": round(age, 1), "max_age_h": allow, "stale": age > allow,
                    "cube": _has_cube(key, runs[0], root)})
    return out


def _has_cube(model: str, rid: str, root: Path) -> bool:
    """The point cube is what makes a card 0.2 s instead of 10 s; a served
    run without one is a fault worth showing next to staleness."""
    import zarr
    from wxgrid.store import run_path
    try:
        return "pt" in zarr.open_group(run_path(model, rid, root), mode="r")
    except Exception:                                            # noqa: BLE001
        return False


def main(argv: list[str] | None = None) -> int:
    rows = run_ages()
    stale = [r for r in rows if r["stale"] or r.get("cube") is False]
    for r in rows:
        age = "none" if r["age_h"] is None else f"{r['age_h']:.1f} h"
        flag = "STALE" if r["stale"] else "NOCUBE" if r.get("cube") is False else "ok"
        print(f"{flag:6s} {r['model']:6s} {r['tier']:8s} {r['run'] or '-':16s} {age:>8s} / {r['max_age_h']:.0f} h")
    return 1 if stale else 0


if __name__ == "__main__":
    sys.exit(main())
