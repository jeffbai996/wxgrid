"""Download one model run as GRIB2 files, one file per forecast step.

ECMWF: `ecmwf-opendata` does the byte-range subsetting per step for us.
GFS:   NOMADS' filter CGI does the same server-side (var/level flags).

Both return the list of (step, path). Missing steps (a run still being
published) are skipped, not fatal — ingest marks coverage per variable.
"""
from __future__ import annotations

import logging
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable

import requests

from wxgrid.config import GRIB_DIR
from wxgrid.models import Model

log = logging.getLogger(__name__)

NOMADS = "https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl"
# GFS variable/level flags for the filter CGI. APCP at 6-hourly steps is the
# previous 6 h bucket; GUST is surface.
GFS_FLAGS = {
    "var_UGRD": "on", "var_VGRD": "on", "lev_10_m_above_ground": "on",
    "var_TMP": "on", "lev_2_m_above_ground": "on",
    "var_PRMSL": "on", "lev_mean_sea_level": "on",
    "var_APCP": "on", "var_GUST": "on", "lev_surface": "on",
}


def _run_dir(model: Model, run: datetime, root: Path) -> Path:
    d = root / model.key / run.strftime("%Y%m%dT%H")
    d.mkdir(parents=True, exist_ok=True)
    return d


# ── ECMWF ─────────────────────────────────────────────────────────────────

def ecmwf_latest_run(model: Model) -> datetime:
    from ecmwf.opendata import Client

    client = Client(source="ecmwf", model=model.ecmwf_model, resol="0p25")
    when = client.latest(type="fc", step=model.steps[1], param=list(model.params)[:2])
    return when.replace(tzinfo=timezone.utc)


def fetch_ecmwf(model: Model, run: datetime, root: Path = GRIB_DIR,
                on_step: Callable[[int, Path], None] | None = None) -> list[tuple[int, Path]]:
    from ecmwf.opendata import Client

    client = Client(source="ecmwf", model=model.ecmwf_model, resol="0p25")
    out_dir = _run_dir(model, run, root)
    got: list[tuple[int, Path]] = []
    for step in model.steps:
        target = out_dir / f"step{step:03d}.grib2"
        if not target.exists() or target.stat().st_size == 0:
            try:
                client.retrieve(type="fc", date=run.strftime("%Y%m%d"), time=run.hour,
                                step=step, param=list(model.params), target=str(target))
            except Exception as exc:  # a step not yet published, or a 4xx on a param
                log.warning("%s %s step %d: %s", model.key, run, step, exc)
                target.unlink(missing_ok=True)
                continue
        got.append((step, target))
        if on_step:
            on_step(step, target)
    return got


# ── GFS via NOMADS ────────────────────────────────────────────────────────

def gfs_candidate_runs(now: datetime | None = None, back: int = 4) -> list[datetime]:
    """Most recent synoptic cycles, newest first. GFS is fully out ~5 h after
    the cycle time, so callers try each until one has the steps they need."""
    now = now or datetime.now(timezone.utc)
    base = now.replace(minute=0, second=0, microsecond=0)
    base = base.replace(hour=(base.hour // 6) * 6)
    return [base - timedelta(hours=6 * k) for k in range(back)]


def gfs_step_url(run: datetime, step: int) -> str:
    q = {"dir": f"/gfs.{run:%Y%m%d}/{run:%H}/atmos",
         "file": f"gfs.t{run:%H}z.pgrb2.0p25.f{step:03d}", **GFS_FLAGS}
    return NOMADS + "?" + "&".join(f"{k}={v}" for k, v in q.items())


def fetch_gfs(model: Model, run: datetime, root: Path = GRIB_DIR,
              session: requests.Session | None = None,
              on_step: Callable[[int, Path], None] | None = None) -> list[tuple[int, Path]]:
    s = session or requests.Session()
    out_dir = _run_dir(model, run, root)
    got: list[tuple[int, Path]] = []
    for step in model.steps:
        target = out_dir / f"step{step:03d}.grib2"
        if not target.exists() or target.stat().st_size == 0:
            ok = _download(s, gfs_step_url(run, step), target)
            if not ok:
                continue
        got.append((step, target))
        if on_step:
            on_step(step, target)
        time.sleep(0.5)   # NOMADS rate courtesy; they ban hammering
    return got


def _download(s: requests.Session, url: str, target: Path, tries: int = 3) -> bool:
    for attempt in range(tries):
        try:
            r = s.get(url, timeout=120, stream=True)
            if r.status_code == 404:
                log.info("not published yet: %s", url.split("file=")[1][:40])
                return False
            r.raise_for_status()
            tmp = target.with_suffix(".part")
            with open(tmp, "wb") as fh:
                for chunk in r.iter_content(1 << 16):
                    fh.write(chunk)
            if tmp.stat().st_size < 1000:      # NOMADS returns an HTML error page at 200 sometimes
                tmp.unlink()
                return False
            tmp.rename(target)
            return True
        except requests.RequestException as exc:
            log.warning("download %s failed (%d/%d): %s", target.name, attempt + 1, tries, exc)
            time.sleep(5 * (attempt + 1))
    return False
