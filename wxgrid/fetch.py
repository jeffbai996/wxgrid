"""Download one model run as GRIB2 files, one file per forecast step.

ECMWF: `ecmwf-opendata` does the byte-range subsetting per step for us.
GFS:   NOMADS' filter CGI does the same server-side (var/level flags).

Both return the list of (step, path). Missing steps (a run still being
published) are skipped, not fatal — ingest marks coverage per variable.
"""
from __future__ import annotations

import logging
import os
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from wxgrid.config import GRIB_DIR
from wxgrid.models import LEVEL_EVERY, Model

log = logging.getLogger(__name__)

NOMADS = "https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl"
# NOAA's AI-GFS (the operational GraphCast lineage) has no filter CGI: it is
# plain GRIB2 on S3 with a wgrib2 `.idx` beside each file. The index gives every
# message's byte offset, so we subset with HTTP Range requests instead — same
# result as the CGI, done client-side.
AIGFS = "https://noaa-nws-graphcastgfs-pds.s3.amazonaws.com"
HRRR = "https://noaa-hrrr-bdp-pds.s3.amazonaws.com"
GEM_WORKERS = 4          # datamart is happy with a handful of parallel GETs
# GFS variable/level flags for the filter CGI. The CGI ANDs the var set with
# the level set, so surface TMP / HGT at pressure levels etc. come along; the
# ingest maps by (shortName, typeOfLevel, level) and drops what it doesn't
# know. APCP at 6-hourly steps is the previous 6 h bucket.
def gfs_flags(levels: tuple[int, ...]) -> dict[str, str]:
    flags = {
        "var_UGRD": "on", "var_VGRD": "on", "var_TMP": "on", "var_HGT": "on",
        "var_PRMSL": "on", "var_APCP": "on", "var_GUST": "on", "var_TCDC": "on", "var_CAPE": "on",
        "var_DPT": "on", "var_SNOD": "on", "var_CSNOW": "on",
        "var_VIS": "on", "var_LAND": "on",
        "lev_10_m_above_ground": "on", "lev_2_m_above_ground": "on", "lev_mean_sea_level": "on",
        "lev_surface": "on", "lev_entire_atmosphere": "on",
    }
    for lvl in levels:
        flags[f"lev_{lvl}_mb"] = "on"
    return flags


def new_session() -> requests.Session:
    """A session that retries the transport-level failures these servers throw
    under load. dd.weather.gc.ca closes pooled keep-alive connections without a
    response often enough that without this every GEM run burns minutes in the
    caller's 5/10/15 s backoff; urllib3 replays the GET on a fresh connection
    instead. `read` must be non-zero: urllib3 counts a "remote end closed the
    connection" as a read error, and that is the exact failure being retried.
    `total` still caps the whole ladder, so a genuinely dead file fails fast."""
    s = requests.Session()
    retry = Retry(total=4, connect=3, read=2, status=3, backoff_factor=0.5,
                  status_forcelist=(500, 502, 503, 504), allowed_methods=("GET", "HEAD"))
    adapter = HTTPAdapter(max_retries=retry, pool_maxsize=GEM_WORKERS * 2)
    s.mount("https://", adapter)
    s.mount("http://", adapter)
    return s


def _have(target: Path) -> bool:
    """A previous, unfinished fetch already left this file here."""
    return target.exists() and target.stat().st_size > 0


def _run_dir(model: Model, run: datetime, root: Path) -> Path:
    d = root / model.key / run.strftime("%Y%m%dT%H")
    d.mkdir(parents=True, exist_ok=True)
    return d


# ── ECMWF ─────────────────────────────────────────────────────────────────

def ecmwf_latest_run(model: Model) -> datetime:
    from ecmwf.opendata import Client

    client = Client(source="ecmwf", model=model.ecmwf_model, resol="0p25")
    when = client.latest(type="fc", step=model.steps[1], param=list(model.sfc_params)[:2])
    return when.replace(tzinfo=timezone.utc)


def fetch_ecmwf(model: Model, run: datetime, root: Path = GRIB_DIR,
                on_step: Callable[[int, list[Path]], None] | None = None) -> list[tuple[int, list[Path]]]:
    """Per step: one surface GRIB and one pressure-level GRIB. A param the
    run does not carry (e.g. gust at some steps) is retried without it rather
    than failing the whole step."""
    from ecmwf.opendata import Client

    client = Client(source="ecmwf", model=model.ecmwf_model, resol="0p25")
    out_dir = _run_dir(model, run, root)
    got: list[tuple[int, list[Path]]] = []
    for step in model.steps:
        paths: list[Path] = []
        sfc = out_dir / f"step{step:03d}-sfc.grib2"
        if _ecmwf_get(client, model, run, step, sfc, dict(param=list(model.sfc_params))):
            paths.append(sfc)
        if model.pl_params and step % LEVEL_EVERY == 0:
            pl = out_dir / f"step{step:03d}-pl.grib2"
            if _ecmwf_get(client, model, run, step, pl,
                          dict(levtype="pl", levelist=list(model.levels), param=list(model.pl_params))):
                paths.append(pl)
        wave = fetch_ecmwf_wave(client, model, run, step, out_dir)
        if wave:
            paths.append(wave)
        if not paths:
            continue
        got.append((step, paths))
        if on_step:
            on_step(step, paths)
    return got


def fetch_ecmwf_wave(client, model: Model, run: datetime, step: int, out_dir: Path) -> Path | None:
    """The wave stream (swh/mwd/mwp) for one 6 h step, or None when the model
    has no wave params or the step is not a level step."""
    if not model.wave_params or step % LEVEL_EVERY:
        return None
    wv = out_dir / f"step{step:03d}-wave.grib2"
    if _ecmwf_get(client, model, run, step, wv, dict(stream="wave", param=list(model.wave_params))):
        return wv
    return None


def _ecmwf_get(client, model: Model, run: datetime, step: int, target: Path, req: dict) -> bool:
    if target.exists() and target.stat().st_size > 0:
        return True
    params = list(req["param"])
    for _ in range(len(params)):
        try:
            client.retrieve(type="fc", date=run.strftime("%Y%m%d"), time=run.hour, step=step,
                            target=str(target), **{**req, "param": params})
            return True
        except Exception as exc:
            msg = str(exc)
            # "No index entries for param=10fg" → drop that one param and retry.
            missing = None
            for p in params:
                if f"param={p}" in msg or f"'{p}'" in msg:
                    missing = p
                    break
            if missing is None or len(params) == 1:
                log.warning("%s %s step %d: %s", model.key, run, step, msg.splitlines()[0][:160])
                target.unlink(missing_ok=True)
                return False
            params.remove(missing)
    target.unlink(missing_ok=True)
    return False


# ── GFS via NOMADS ────────────────────────────────────────────────────────

def gfs_candidate_runs(now: datetime | None = None, back: int = 4) -> list[datetime]:
    """Most recent synoptic cycles, newest first. GFS is fully out ~5 h after
    the cycle time, so callers try each until one has the steps they need."""
    now = now or datetime.now(timezone.utc)
    base = now.replace(minute=0, second=0, microsecond=0)
    base = base.replace(hour=(base.hour // 6) * 6)
    return [base - timedelta(hours=6 * k) for k in range(back)]


def gfs_step_url(run: datetime, step: int, levels: tuple[int, ...] = ()) -> str:
    q = {"dir": f"/gfs.{run:%Y%m%d}/{run:%H}/atmos",
         "file": f"gfs.t{run:%H}z.pgrb2.0p25.f{step:03d}", **gfs_flags(levels)}
    return NOMADS + "?" + "&".join(f"{k}={v}" for k, v in q.items())


def fetch_gfs(model: Model, run: datetime, root: Path = GRIB_DIR,
              session: requests.Session | None = None,
              on_step: Callable[[int, list[Path]], None] | None = None) -> list[tuple[int, list[Path]]]:
    s = session or new_session()
    out_dir = _run_dir(model, run, root)
    got: list[tuple[int, list[Path]]] = []
    for step in model.steps:
        target = out_dir / f"step{step:03d}.grib2"
        if not target.exists() or target.stat().st_size == 0:
            ok = _download(s, gfs_step_url(run, step, model.levels if step % LEVEL_EVERY == 0 else ()), target)
            if not ok:
                continue
        got.append((step, [target]))
        if on_step:
            on_step(step, [target])
        time.sleep(0.5)   # NOMADS rate courtesy; they ban hammering
    return got


def _download(s: requests.Session, url: str, target: Path, tries: int = 3,
              timeout: tuple[float, float] = (10.0, 120.0)) -> bool:
    """`timeout` is (connect, read). Read is per-chunk, not for the whole body,
    so it bounds a stalled socket rather than a big-but-moving download."""
    for attempt in range(tries):
        try:
            r = s.get(url, timeout=timeout, stream=True)
            if r.status_code == 404:
                # normal: a step the producer has not written yet, or a
                # datamart parameter that does not exist at hour 000
                log.info("not published: %s", url.rsplit("/", 1)[-1][:80])
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


# ── GEFS ensemble mean via NOMADS ─────────────────────────────────────────
# Two products, because the mean is not published with 0.25° pressure levels:
#   pgrb2sp25  geavg.tHHz.pgrb2s.0p25.fHHH   surface, 0.25°, 3-hourly
#   pgrb2ap5   geavg.tHHz.pgrb2a.0p50.fHHH   pressure levels, 0.5°, regridded
# The 0.5° fields go through the bilinear regridder in wxgrid.grib.
NOMADS_GEFS_SFC = "https://nomads.ncep.noaa.gov/cgi-bin/filter_gefs_atmos_0p25s.pl"
NOMADS_GEFS_PL = "https://nomads.ncep.noaa.gov/cgi-bin/filter_gefs_atmos_0p50a.pl"
GEFS_PUB = "https://nomads.ncep.noaa.gov/pub/data/nccf/com/gens/prod"

GEFS_SFC_FLAGS = {
    "var_UGRD": "on", "var_VGRD": "on", "var_TMP": "on", "var_DPT": "on",
    "var_PRMSL": "on", "var_APCP": "on", "var_GUST": "on", "var_TCDC": "on",
    "var_CAPE": "on", "var_SNOD": "on", "var_CSNOW": "on",
    "lev_10_m_above_ground": "on", "lev_2_m_above_ground": "on",
    "lev_mean_sea_level": "on", "lev_surface": "on", "lev_entire_atmosphere": "on",
}


# Ensemble standard deviation, published beside the mean in the same
# pgrb2sp25 directory as geavg:  gespr.tHHz.pgrb2s.0p25.fHHH  (+ .idx).
# Identical grid, steps and parameter list to geavg — only the GRIB2 "derived
# forecast" octet differs, which eccodes does not surface in the shortName. So
# the file lands in the step dir under its own suffix and the ingest reads the
# provenance off the NAME, not off the message.
SPREAD_SUFFIX = "-spr.grib2"
GEFS_SPREAD_FLAGS = {
    "var_TMP": "on", "var_UGRD": "on", "var_VGRD": "on", "var_PRMSL": "on", "var_APCP": "on",
    "lev_2_m_above_ground": "on", "lev_10_m_above_ground": "on",
    "lev_mean_sea_level": "on", "lev_surface": "on",
}


def _query(url: str, q: dict[str, str]) -> str:
    return url + "?" + "&".join(f"{k}={v}" for k, v in q.items())


def gefs_spread_url(run: datetime, step: int) -> str:
    return _query(NOMADS_GEFS_SFC, {
        "dir": f"%2Fgefs.{run:%Y%m%d}%2F{run:%H}%2Fatmos%2Fpgrb2sp25",
        "file": f"gespr.t{run:%H}z.pgrb2s.0p25.f{step:03d}", **GEFS_SPREAD_FLAGS})


def is_spread(path: str | Path) -> bool:
    """True for a GRIB this module downloaded from an ensemble-spread stream."""
    return Path(path).name.endswith(SPREAD_SUFFIX)


def gefs_sfc_url(run: datetime, step: int) -> str:
    return _query(NOMADS_GEFS_SFC, {
        "dir": f"%2Fgefs.{run:%Y%m%d}%2F{run:%H}%2Fatmos%2Fpgrb2sp25",
        "file": f"geavg.t{run:%H}z.pgrb2s.0p25.f{step:03d}", **GEFS_SFC_FLAGS})


def gefs_pl_url(run: datetime, step: int, levels: tuple[int, ...]) -> str:
    flags = {"var_UGRD": "on", "var_VGRD": "on", "var_TMP": "on", "var_HGT": "on"}
    flags.update({f"lev_{lvl}_mb": "on" for lvl in levels})
    return _query(NOMADS_GEFS_PL, {
        "dir": f"%2Fgefs.{run:%Y%m%d}%2F{run:%H}%2Fatmos%2Fpgrb2ap5",
        "file": f"geavg.t{run:%H}z.pgrb2a.0p50.f{step:03d}", **flags})


def gefs_probe_url(run: datetime, step: int) -> str:
    """Cheap existence check (the .idx next to the raw member file)."""
    return (f"{GEFS_PUB}/gefs.{run:%Y%m%d}/{run:%H}/atmos/pgrb2sp25/"
            f"geavg.t{run:%H}z.pgrb2s.0p25.f{step:03d}.idx")


def fetch_gefs(model: Model, run: datetime, root: Path = GRIB_DIR,
               session: requests.Session | None = None,
               on_step: Callable[[int, list[Path]], None] | None = None) -> list[tuple[int, list[Path]]]:
    s = session or new_session()
    out_dir = _run_dir(model, run, root)
    got: list[tuple[int, list[Path]]] = []
    for step in model.steps:
        paths: list[Path] = []
        sfc = out_dir / f"step{step:03d}-sfc.grib2"
        if _have(sfc) or _download(s, gefs_sfc_url(run, step), sfc):
            paths.append(sfc)
        time.sleep(0.5)      # NOMADS rate courtesy; they ban hammering
        if model.spread_params:
            # Never fatal: a step whose spread file is missing simply leaves
            # the `_sd` variables NaN there, and the mean is still ingested.
            spr = out_dir / f"step{step:03d}{SPREAD_SUFFIX}"
            if _have(spr) or _download(s, gefs_spread_url(run, step), spr):
                paths.append(spr)
            else:
                log.info("%s %s step %03d: no ensemble spread published", model.key, run, step)
            time.sleep(0.5)
        if model.pl_params and step % LEVEL_EVERY == 0:
            pl = out_dir / f"step{step:03d}-pl.grib2"
            if _have(pl) or _download(s, gefs_pl_url(run, step, model.levels), pl):
                paths.append(pl)
            time.sleep(0.5)
        if not paths:
            continue
        got.append((step, paths))
        if on_step:
            on_step(step, paths)
    return got


# ── GEM GDPS via the MSC datamart ─────────────────────────────────────────
# One GRIB per (variable, level, step) under a date-partitioned tree. The old
# /model_gem_global/15km/... path and the CMC_glb_* filenames are gone: the
# live tree is /{YYYYMMDD}/WXO-DD/model_gdps/15km/{HH}/{hhh}/ with MSC's
# standard names, e.g.
#   20260818T00Z_MSC_GDPS_AirTemp_AGL-2m_LatLon0.15_PT003H.grib2
#   20260818T00Z_MSC_GDPS_WindU_IsbL-0850_LatLon0.15_PT006H.grib2
DATAMART = "https://dd.weather.gc.ca"


def gem_candidate_runs(now: datetime | None = None, back: int = 4) -> list[datetime]:
    """GDPS runs at 00 and 12 Z only, newest first."""
    now = now or datetime.now(timezone.utc)
    base = now.replace(minute=0, second=0, microsecond=0)
    base = base.replace(hour=(base.hour // 12) * 12)
    return [base - timedelta(hours=12 * k) for k in range(back)]


def gem_file_url(run: datetime, step: int, var: str) -> str:
    return (f"{DATAMART}/{run:%Y%m%d}/WXO-DD/model_gdps/15km/{run:%H}/{step:03d}/"
            f"{run:%Y%m%d}T{run:%H}Z_MSC_GDPS_{var}_LatLon0.15_PT{step:03d}H.grib2")


def gem_step_files(model: Model, step: int) -> list[tuple[str, str]]:
    """(shortName we force on the message, datamart variable token) for a step."""
    out = list(model.file_params.items())
    if model.file_pl_params and step % LEVEL_EVERY == 0:
        for short, token in model.file_pl_params.items():
            out += [(f"{short}@{lvl}", f"{token}_IsbL-{lvl:04d}") for lvl in model.levels]
    return out


def _gem_target(out_dir: Path, step: int, short: str) -> Path:
    """`step006__u@850.grib2` — the token after `__` is the shortName override
    the ingest reads back off the filename."""
    return out_dir / f"step{step:03d}__{short}.grib2"


def fetch_gem(model: Model, run: datetime, root: Path = GRIB_DIR,
              session: requests.Session | None = None,
              on_step: Callable[[int, list[Path]], None] | None = None) -> list[tuple[int, list[Path]]]:
    """A step is whatever files came back; accumulations are absent at step 0
    (the datamart publishes no Precip-Accum for hour 000) and that is fine."""
    import threading
    from concurrent.futures import ThreadPoolExecutor

    local = threading.local()

    def _session() -> requests.Session:
        if session is not None:
            return session
        if not hasattr(local, "s"):
            local.s = new_session()           # keep-alive per worker thread
        return local.s

    out_dir = _run_dir(model, run, root)
    got: list[tuple[int, list[Path]]] = []
    with ThreadPoolExecutor(max_workers=GEM_WORKERS) as pool:
        for step in model.steps:
            wanted = gem_step_files(model, step)

            def _one(item: tuple[str, str]) -> Path | None:
                short, token = item
                target = _gem_target(out_dir, step, short)
                if _have(target):
                    return target
                return target if _download(_session(), gem_file_url(run, step, token), target,
                                           timeout=(10.0, 60.0)) else None

            paths = [p for p in pool.map(_one, wanted) if p is not None]
            if not paths:
                log.info("gem %s step %03d: nothing published", run, step)
                continue
            got.append((step, paths))
            if on_step:
                on_step(step, paths)
    return got


# ── HRDPS 2.5 km via the MSC datamart ───────────────────────────────────

def hrdps_candidate_runs(now: datetime | None = None, back: int = 6) -> list[datetime]:
    """HRDPS publishes the 00/06/12/18 Z synoptic cycles."""
    return gfs_candidate_runs(now, back)


def hrdps_file_url(run: datetime, step: int, var: str) -> str:
    return (f"{DATAMART}/{run:%Y%m%d}/WXO-DD/model_hrdps/continental/2.5km/{run:%H}/{step:03d}/"
            f"{run:%Y%m%d}T{run:%H}Z_MSC_HRDPS_{var}_RLatLon0.0225_PT{step:03d}H.grib2")


def hrdps_step_files(model: Model, step: int) -> list[tuple[str, str]]:
    return [(short, token) for short, token in model.file_params.items()
            if step != 0 or short not in {"tp", "sf"}]


def fetch_hrdps(model: Model, run: datetime, root: Path = GRIB_DIR,
                session: requests.Session | None = None,
                on_step: Callable[[int, list[Path]], None] | None = None) -> list[tuple[int, list[Path]]]:
    """Fetch one GRIB per hourly surface variable from the ECCC datamart."""
    import threading
    from concurrent.futures import ThreadPoolExecutor

    local = threading.local()

    def _session() -> requests.Session:
        if session is not None:
            return session
        if not hasattr(local, "s"):
            local.s = new_session()
        return local.s

    out_dir = _run_dir(model, run, root)
    got: list[tuple[int, list[Path]]] = []
    with ThreadPoolExecutor(max_workers=GEM_WORKERS) as pool:
        for step in model.steps:
            def _one(item: tuple[str, str]) -> Path | None:
                short, token = item
                target = _gem_target(out_dir, step, short)
                if _have(target):
                    return target
                return target if _download(_session(), hrdps_file_url(run, step, token), target,
                                           timeout=(10.0, 90.0)) else None

            paths = [p for p in pool.map(_one, hrdps_step_files(model, step)) if p is not None]
            if not paths:
                continue
            got.append((step, paths))
            if on_step:
                on_step(step, paths)
    return got


# ── HRRR 3 km over S3 byte ranges ────────────────────────────────────────

def hrrr_candidate_runs(now: datetime | None = None, back: int = 6) -> list[datetime]:
    """wxgrid deliberately ingests only HRRR's 00/06/12/18 Z cycles."""
    return gfs_candidate_runs(now, back)


def hrrr_url(run: datetime, step: int) -> str:
    return (f"{HRRR}/hrrr.{run:%Y%m%d}/conus/"
            f"hrrr.t{run:%H}z.wrfsfcf{step:02d}.grib2")


def hrrr_probe_url(run: datetime, step: int) -> str:
    return hrrr_url(run, step) + ".idx"


HRRR_SFC = {
    ("GUST", "surface"), ("UGRD", "10 m above ground"), ("VGRD", "10 m above ground"),
    ("TMP", "2 m above ground"), ("DPT", "2 m above ground"), ("MSLMA", "mean sea level"),
    ("SNOD", "surface"), ("TCDC", "entire atmosphere"),
}


def hrrr_wanted(rows: list[dict], step: int) -> list[dict]:
    """Surface story plus the since-start precip/snow totals we deaccumulate."""
    total = f"0-{step} hour acc fcst"
    out = [r for r in rows if (r["var"], r["level"]) in HRRR_SFC]
    if step:
        out.extend(r for r in rows if r["var"] in {"APCP", "WEASD"}
                   and r["level"] == "surface" and r["window"] == total)
    return out


def fetch_hrrr(model: Model, run: datetime, root: Path = GRIB_DIR,
               session: requests.Session | None = None,
               on_step: Callable[[int, list[Path]], None] | None = None) -> list[tuple[int, list[Path]]]:
    s = session or new_session()
    out_dir = _run_dir(model, run, root)
    got: list[tuple[int, list[Path]]] = []
    for step in model.steps:
        target = out_dir / f"step{step:03d}.grib2"
        if not _have(target):
            url = hrrr_url(run, step)
            try:
                idx = s.get(url + ".idx", timeout=(10.0, 60.0))
                if idx.status_code == 404:
                    continue
                idx.raise_for_status()
            except requests.RequestException as exc:
                log.warning("HRRR index unavailable for %s: %s", url.rsplit("/", 1)[-1], exc)
                continue
            wanted = hrrr_wanted(parse_idx(idx.text), step)
            if not wanted or not _download_ranges(s, url, merge_ranges(wanted), target):
                continue
        got.append((step, [target]))
        if on_step:
            on_step(step, [target])
    return got



# ── NOAA AI-GFS (GraphCast lineage) over S3 byte ranges ──────────────────

def aigfs_candidate_runs(now: datetime | None = None, back: int = 4) -> list[datetime]:
    """Same synoptic cycles as GFS. AI-GFS publishes about an hour behind it."""
    return gfs_candidate_runs(now, back)


def aigfs_url(run: datetime, step: int, kind: str) -> str:
    """`kind` is "sfc" (surface fields) or "pres" (pressure levels)."""
    return (f"{AIGFS}/aigfs.{run:%Y%m%d}/{run:%H}/model/atmos/grib2/"
            f"aigfs.t{run:%H}z.{kind}.f{step:03d}.grib2")


def aigfs_probe_url(run: datetime, step: int) -> str:
    return aigfs_url(run, step, "sfc") + ".idx"


# The surface fields we keep, by (variable, level) exactly as the index names
# them. Precipitation is handled separately: the file carries BOTH the 6-hour
# bucket and the since-start total under the same name, and we want the bucket.
AIGFS_SFC = {("TMP", "2 m above ground"), ("DPT", "2 m above ground"),
             ("UGRD", "10 m above ground"), ("VGRD", "10 m above ground"),
             ("PRMSL", "mean sea level")}
AIGFS_PL_VARS = ("TMP", "UGRD", "VGRD", "HGT")
# Two ranges this close together are cheaper as one request than as two, even
# counting the bytes in between.
IDX_MERGE_SLACK = 512 * 1024


def parse_idx(text: str) -> list[dict]:
    """A wgrib2 index: `n:offset:date:VAR:LEVEL:WINDOW:`. Returns each message
    with the byte range it occupies; the last message runs to end-of-file."""
    rows = []
    for line in text.splitlines():
        parts = line.split(":")
        if len(parts) < 6 or not parts[1].isdigit():
            continue
        rows.append({"n": int(parts[0]), "start": int(parts[1]),
                     "var": parts[3], "level": parts[4], "window": parts[5]})
    for i, row in enumerate(rows):
        row["end"] = rows[i + 1]["start"] - 1 if i + 1 < len(rows) else None
    return rows


def aigfs_wanted(rows: list[dict], step: int, levels: tuple[int, ...], kind: str) -> list[dict]:
    """Which messages this step needs. For precipitation that means the bucket
    ending at this step — the file also holds the since-start total under the
    same name, and taking the wrong one turns a 6-hour rainfall into a
    cumulative one."""
    if kind == "pres":
        want_levels = {f"{lv} mb" for lv in levels}
        return [r for r in rows if r["var"] in AIGFS_PL_VARS and r["level"] in want_levels]
    bucket = f"{max(0, step - 6)}-{step} hour acc fcst"
    picked, seen = [], set()
    for r in rows:
        key = (r["var"], r["level"])
        if key in seen:
            continue                      # at f006 the bucket IS the total: two identical messages
        if key in AIGFS_SFC or (r["var"] == "APCP" and r["level"] == "surface" and r["window"] == bucket):
            picked.append(r)
            seen.add(key)
    return picked


def merge_ranges(rows: list[dict], slack: int = IDX_MERGE_SLACK) -> list[tuple[int, int | None]]:
    """Collapse the wanted messages into as few HTTP ranges as possible."""
    out: list[list] = []
    for r in sorted(rows, key=lambda x: x["start"]):
        if out and out[-1][1] is not None and r["start"] - out[-1][1] <= slack:
            out[-1][1] = r["end"] if r["end"] is not None else None
        else:
            out.append([r["start"], r["end"]])
    return [(a, b) for a, b in out]


def _download_ranges(s: requests.Session, url: str, ranges: list[tuple[int, int | None]],
                     target: Path, tries: int = 3) -> bool:
    """Fetch byte ranges and concatenate them. GRIB2 messages are self-contained,
    so the result is a valid multi-message file that eccodes reads normally."""
    tmp = target.with_suffix(f".part-{os.getpid()}")
    try:
        with tmp.open("wb") as fh:
            for start, end in ranges:
                span = f"bytes={start}-{end if end is not None else ''}"
                for attempt in range(tries):
                    try:
                        r = s.get(url, headers={"Range": span}, timeout=(10.0, 120.0), stream=True)
                        if r.status_code == 404:
                            log.info("not published: %s", url.rsplit("/", 1)[-1])
                            return False
                        r.raise_for_status()
                        for chunk in r.iter_content(1 << 16):
                            fh.write(chunk)
                        break
                    except requests.RequestException as exc:
                        if attempt == tries - 1:
                            log.warning("range %s of %s failed: %s", span, url.rsplit("/", 1)[-1], exc)
                            return False
                        time.sleep(1.5 * (attempt + 1))
        tmp.replace(target)
        return True
    finally:
        tmp.unlink(missing_ok=True)


def fetch_aigfs(model: Model, run: datetime, root: Path = GRIB_DIR,
                session: requests.Session | None = None,
                on_step: Callable[[int, list[Path]], None] | None = None) -> list[tuple[int, list[Path]]]:
    s = session or new_session()
    out_dir = _run_dir(model, run, root)
    got: list[tuple[int, list[Path]]] = []
    for step in model.steps:
        paths: list[Path] = []
        for kind in ("sfc", "pres"):
            if kind == "pres" and step % LEVEL_EVERY != 0:
                continue
            target = out_dir / f"step{step:03d}.{kind}.grib2"
            if _have(target):
                paths.append(target)
                continue
            url = aigfs_url(run, step, kind)
            try:
                idx = s.get(url + ".idx", timeout=(10.0, 60.0))
                if idx.status_code == 404:
                    log.info("not published: %s.idx", url.rsplit("/", 1)[-1])
                    continue
                idx.raise_for_status()
            except requests.RequestException as exc:
                log.warning("index unavailable for %s: %s", url.rsplit("/", 1)[-1], exc)
                continue
            wanted = aigfs_wanted(parse_idx(idx.text), step, model.levels, kind)
            if not wanted:
                continue
            if _download_ranges(s, url, merge_ranges(wanted), target):
                paths.append(target)
        if not paths:
            continue
        got.append((step, paths))
        if on_step:
            on_step(step, paths)
    return got


def grib_override(path: Path) -> tuple[str | None, int | None]:
    """(shortName, level) encoded in a datamart filename, or (None, None)."""
    stem = Path(path).stem
    if "__" not in stem:
        return None, None
    token = stem.split("__", 1)[1]
    if "@" in token:
        short, _, lvl = token.partition("@")
        return short, int(lvl)
    return token, None
