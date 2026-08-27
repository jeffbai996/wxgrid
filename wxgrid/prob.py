"""Probabilities from the GEFS members.

The spread pane already tells a reader HOW uncertain a forecast is; nobody
plans a day around a standard deviation. What people act on is "70 % chance of
rain tomorrow afternoon" — and with 30 members that is a count, not a model.

This module pulls three surface fields for every perturbed member of a GEFS
run by byte range off the AWS mirror's wgrib2 indexes, counts, per gridpoint,
how many members cross a threshold, and writes the counts into the run's own
Zarr group as percent fields:

    prob_rain    members with > 0.2 mm in the 6 h bucket ending at the step
    prob_gust    members with a surface gust over 50 km/h
    prob_frost   members with 2 m temperature below 0 °C

Members are streamed one at a time and reduced on arrival — never held
together. The measured cost (2026-08-19): 30 members × 3 fields × one step is
39 MB and ~30 s sequential; a full 6-hourly run to 240 h is ~1.6 GB, fetched
member-parallel in a few minutes on the ingest timer.
"""
from __future__ import annotations

import logging
import tempfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import requests

from wxgrid import fetch
from wxgrid.config import GRID_LAT_N, GRID_LON_N, STORE_DIR
from wxgrid.grib import iter_fields
from wxgrid.store import run_path

log = logging.getLogger(__name__)

GEFS_AWS = "https://noaa-gefs-pds.s3.amazonaws.com"
MEMBERS = 30                      # gep01..gep30; the control is not a draw
PROB_STEP = 6                     # 6 h buckets; the 3 h columns interpolate

# (zarr variable, idx var, idx level, threshold test on the decoded field)
RAIN_MM, GUST_MS, FROST_K = 0.2, 50 / 3.6, 273.15
FIELDS = (
    ("prob_rain", "APCP", "surface"),
    ("prob_gust", "GUST", "surface"),
    ("prob_frost", "TMP", "2 m above ground"),
)


def member_url(run: datetime, step: int, member: int) -> str:
    d, h = run.strftime("%Y%m%d"), run.strftime("%H")
    return f"{GEFS_AWS}/gefs.{d}/{h}/atmos/pgrb2sp25/gep{member:02d}.t{h}z.pgrb2s.0p25.f{step:03d}"


def wanted(rows: list[dict], step: int) -> list[dict]:
    """The three messages, taking the APCP bucket that ENDS at this step —
    the file also carries other windows under the same name."""
    bucket = f"{max(0, step - PROB_STEP)}-{step} hour acc fcst"
    picked = []
    for _, var, level in FIELDS:
        for r in rows:
            if r["var"] == var and r["level"] == level and (var != "APCP" or r["window"] == bucket):
                picked.append(r)
                break
    return picked


def _member_masks(s: requests.Session, run: datetime, step: int, member: int,
                  tmp_dir: Path) -> np.ndarray | None:
    """One member's three exceedance masks at one step, or None if unpublished."""
    url = member_url(run, step, member)
    try:
        idx = s.get(url + ".idx", timeout=(10, 60))
        if idx.status_code == 404:
            return None
        idx.raise_for_status()
    except requests.RequestException as exc:
        log.warning("gefs member %02d f%03d idx: %s", member, step, exc)
        return None
    rows = wanted(fetch.parse_idx(idx.text), step)
    if len(rows) != len(FIELDS):
        return None
    target = tmp_dir / f"m{member:02d}-f{step:03d}.grib2"
    if not fetch._download_ranges(s, url, fetch.merge_ranges(rows), target):
        return None
    got: dict[str, np.ndarray] = {}
    try:
        for f in iter_fields(target):
            got[f.short_name] = np.asarray(f.values, dtype=np.float32)
    finally:
        target.unlink(missing_ok=True)
    def first(*names):
        for nm in names:                 # explicit: `or` on an ndarray raises
            if got.get(nm) is not None:
                return got[nm]
        return None
    tp, gust, t2m = first("tp"), first("gust", "fg", "i10fg"), first("2t", "t")
    if tp is None or gust is None or t2m is None:
        log.warning("gefs member %02d f%03d decoded as %s, skipping", member, step, sorted(got))
        return None
    masks = np.empty((3, GRID_LAT_N, GRID_LON_N), dtype=bool)
    masks[0] = tp > RAIN_MM
    masks[1] = gust > GUST_MS
    masks[2] = t2m < FROST_K
    return masks


def ingest_probability(rid: str, store_root: Path = STORE_DIR, workers: int = 8,
                       members: int = MEMBERS) -> dict:
    """Count member exceedances for every 6 h step of a stored GEFS run and
    write the percent fields into its group. Restartable: a step whose three
    fields are already non-NaN is skipped."""
    from wxgrid.store import run_lock
    with run_lock("gefs", rid, store_root) as held:
        if not held:
            return {"run": rid, "skipped": "locked"}
        return _ingest_probability_locked(rid, store_root, workers, members)


def _ingest_probability_locked(rid: str, store_root: Path, workers: int, members: int) -> dict:
    import zarr
    from zarr.codecs import BloscCodec

    path = run_path("gefs", rid, store_root)
    g = zarr.open_group(path, mode="r+")
    steps = list(g.attrs["steps"])
    run = datetime.strptime(rid, "%Y-%m-%dT%H").replace(tzinfo=timezone.utc)
    codec = BloscCodec(cname="zstd", clevel=3, shuffle="bitshuffle")
    for var, _, _ in FIELDS:
        if var not in g:
            g.create_array(var, shape=(len(steps), GRID_LAT_N, GRID_LON_N), dtype="float32",
                           chunks=(1, GRID_LAT_N, GRID_LON_N), compressors=codec, fill_value=np.nan,
                           dimension_names=("step", "latitude", "longitude"))
    done_steps = 0
    with tempfile.TemporaryDirectory(prefix="gefs-prob-") as td:
        tmp_dir = Path(td)
        for step in steps:
            if step == 0 or step % PROB_STEP:
                continue                            # buckets need a 6 h window
            k = steps.index(step)
            if not np.isnan(g[FIELDS[0][0]][k, 0, 0]):
                continue                            # already counted (resume)
            counts = np.zeros((3, GRID_LAT_N, GRID_LON_N), dtype=np.uint16)
            n = 0
            with ThreadPoolExecutor(max_workers=workers) as pool:
                sessions = [requests.Session() for _ in range(workers)]
                futs = [pool.submit(_member_masks, sessions[m % workers], run, step, m + 1, tmp_dir)
                        for m in range(members)]
                for fut in futs:
                    masks = fut.result()
                    if masks is not None:
                        counts += masks
                        n += 1
            if n < members // 2:
                log.info("gefs prob f%03d: only %d members published, leaving NaN", step, n)
                continue
            for j, (var, _, _) in enumerate(FIELDS):
                g[var][k] = counts[j].astype(np.float32) * (100.0 / n)
            done_steps += 1
            log.info("gefs prob f%03d: %d members counted", step, n)
    have = list(g.attrs.get("variables", []))
    g.attrs["variables"] = have + [v for v, _, _ in FIELDS if v not in have]
    try:
        archive_for_calibration(rid, g, steps)
    except Exception:
        log.exception("gefs prob %s: calibration archive failed (counts still stored)", rid)
    return {"run": rid, "steps": done_steps}


def archive_for_calibration(rid: str, g, steps: list[int],
                            out_dir: Path | None = None) -> Path:
    """Keep what verification will need after the store prunes this run.

    The store holds two runs; calibration ("when we said 70 %, how often did
    it rain?") needs months. So each counted run leaves behind a coarse copy —
    every 4th gridpoint, ~1° — of the probabilities and the precipitation
    buckets, a few hundred KB per run. The joining and the scoring can be
    designed later; what cannot be recovered later is data never kept.
    """
    from wxgrid.config import DATA_DIR
    out_dir = out_dir or (DATA_DIR / "calib" / "gefs")
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{rid}.npz"
    if path.exists():
        return path
    kept = [k for k, h in enumerate(steps) if h and h % PROB_STEP == 0]
    arrays: dict[str, np.ndarray] = {"steps": np.array([steps[k] for k in kept], dtype=np.int16)}
    for var, _, _ in FIELDS:
        arrays[var] = np.stack([np.asarray(g[var][k][::4, ::4], dtype=np.float32) for k in kept])
    if "tp6" in g:
        arrays["tp6"] = np.stack([np.asarray(g["tp6"][k][::4, ::4], dtype=np.float32) for k in kept])
    # np.savez appends ".npz" to any name that lacks it, so the temp name
    # must already end that way or the rename source will not exist
    tmp = out_dir / f".{rid}.tmp.npz"
    np.savez_compressed(tmp, **arrays)
    tmp.rename(path)
    log.info("gefs %s calibration archive: %d steps → %s (%.1f MB)",
             rid, len(kept), path.name, path.stat().st_size / 1e6)
    return path
