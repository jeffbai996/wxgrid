"""Fetch a model run and write it to the store.

    python -m wxgrid.ingest --model aifs            # latest complete run
    python -m wxgrid.ingest --model gfs --run 2026-08-18T00
    python -m wxgrid.ingest --all                   # every model, latest run

Idempotent: a run already complete in the store is skipped. GRIBs are
deleted once written; the store is the only durable copy.
"""
from __future__ import annotations

import argparse
import logging
import os
import shlex
import shutil
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import requests

from wxgrid import fetch
from wxgrid.config import GRIB_DIR, GRIB_RAM_DIR, GRIB_RAM_MIN_FREE, STORE_DIR
from wxgrid.ens import wind_speed_spread
from wxgrid.grib import iter_fields
from wxgrid.models import MODELS, SWELL_VAR, WAVE_BAND_INPUTS, Model, get_model
from wxgrid import mode as ingest_mode
from wxgrid.store import RunWriter, build_point_cube, list_runs, prune, run_id, run_lock, run_path
from wxgrid.phase_metrics import Phase, current as current_phase

log = logging.getLogger("wxgrid.ingest")


def wait_for_step_gate() -> None:
    """Run the optional host-pressure gate at a safe ingest boundary.

    The command is deliberately opt-in so normal installs have no dependency
    on a host-specific pressure monitor.  It runs without a shell; a non-zero
    exit aborts the ingest while all completed downloads remain reusable.
    """
    command = os.environ.get("WXGRID_STEP_GATE_COMMAND", "").strip()
    if not command:
        return
    started = time.monotonic()
    try:
        subprocess.run(shlex.split(command), check=True)
    finally:
        phase = current_phase.get()
        if phase is not None:
            phase.gate_seconds += time.monotonic() - started


def accumulation_bucket(mode: str, step: int, start_step: int, accum: np.ndarray,
                        previous: tuple[int, int, np.ndarray] | None) -> np.ndarray:
    """Turn a producer accumulation into this stored step's increment."""
    if step == 0:
        return np.zeros_like(accum)
    if mode == "per_step":
        return accum
    if mode == "bucket6":
        if previous and previous[0] == start_step and previous[1] < step:
            return np.clip(accum - previous[2], 0.0, None)
        return accum
    if previous:
        return np.clip(accum - previous[2], 0.0, None)
    return accum


def swell_from_bands(bands: list[np.ndarray]) -> np.ndarray | None:
    """Root-sum-square of the period-band significant heights: the height of
    the swell (periods ≥ 10 s) as one number. NaN where every band is NaN
    (land), 0 where the bands are present and empty."""
    if not bands:
        return None
    stack = np.stack([np.asarray(b, dtype=np.float32) for b in bands])
    any_valid = np.isfinite(stack).any(axis=0)
    out = np.sqrt(np.nansum(np.square(stack), axis=0)).astype(np.float32)
    out[~any_valid] = np.nan
    return out


def derive_swell(got: dict) -> None:
    """In place: replace the `_wb…` band inputs in `got` with `swell`."""
    bands = [got.pop(k) for k in WAVE_BAND_INPUTS if k in got]
    sw = swell_from_bands(bands)
    if sw is not None:
        got[SWELL_VAR] = sw


def _resolve_run(model: Model, run: str | None) -> datetime:
    if run and run != "auto":
        return datetime.strptime(run, "%Y-%m-%dT%H").replace(tzinfo=timezone.utc)
    if model.source == "weathernext":
        from wxgrid import wn2
        return wn2.resolve_latest(model)
    if model.source == "ecmwf":
        client = fetch.BoundedECMWF(model)
        # Asking for the LAST step means "latest run that is fully published".
        when = client.latest(type="fc", step=model.steps[-1], param=list(model.sfc_params)[:1])
        return when.replace(tzinfo=timezone.utc)
    # For the HTTP sources, "latest" = the newest cycle whose LAST step is
    # already on the server; probing that one file is enough.
    probes = {
        "nomads": (fetch.gfs_candidate_runs, lambda c: fetch.gfs_step_url(c, model.steps[-1], model.levels)),
        "nomads-gefs": (fetch.gfs_candidate_runs, lambda c: fetch.gefs_probe_url(c, model.steps[-1])),
        "aws-aigfs": (fetch.aigfs_candidate_runs, lambda c: fetch.aigfs_probe_url(c, model.steps[-1])),
        "datamart": (fetch.gem_candidate_runs,
                     lambda c: fetch.gem_file_url(c, model.steps[-1], model.file_params["2t"])),
        "hrdps": (fetch.hrdps_candidate_runs,
                  lambda c: fetch.hrdps_file_url(c, model.steps[-1], model.file_params["2t"])),
        "aws-hrrr": (fetch.hrrr_candidate_runs, lambda c: fetch.hrrr_probe_url(c, model.steps[-1])),
    }
    if model.source in probes:
        candidates, url_for = probes[model.source]
        s = fetch.new_session()
        for cand in candidates():
            try:
                if s.head(url_for(cand), timeout=30, allow_redirects=True).status_code == 200:
                    return cand
            except requests.RequestException:
                continue
        raise RuntimeError(f"no fully published {model.key} run found in the last day")
    raise ValueError(model.source)


def _fs_type(path: Path) -> str:
    """Filesystem type backing `path`, by longest matching mount point."""
    best, kind = "", ""
    try:
        with open("/proc/mounts", encoding="utf-8") as handle:
            for line in handle:
                parts = line.split()
                if len(parts) < 3:
                    continue
                point, fstype = parts[1], parts[2]
                text = str(path)
                if (text == point or text.startswith(point.rstrip("/") + "/")) \
                        and len(point) > len(best):
                    best, kind = point, fstype
    except OSError:
        return ""
    return kind


def grib_root_for(model: Model, grib_root: Path, *, keep_grib: bool = False) -> Path:
    """Where this model's downloads land.

    RAM for everything that reads a GRIB once and drops it. Disk for ECMWF,
    which resumes from validated downloads after a 429, and for --keep-grib,
    which exists so a human can go and look at what a run fetched.

    Falls back to `grib_root` whenever the RAM disk is missing, not actually a
    RAM disk, or too full to be safe: a failed download is a worse outcome than
    a written byte.
    """
    if keep_grib or model.source == "ecmwf":
        return grib_root
    try:
        GRIB_RAM_DIR.mkdir(parents=True, exist_ok=True)
        if _fs_type(GRIB_RAM_DIR) not in ("tmpfs", "ramfs"):
            return grib_root
        st = os.statvfs(GRIB_RAM_DIR)
        if st.f_bavail * st.f_frsize < GRIB_RAM_MIN_FREE:
            log.warning("grib RAM disk %s below %d bytes free; using %s",
                        GRIB_RAM_DIR, GRIB_RAM_MIN_FREE, grib_root)
            return grib_root
    except OSError as exc:
        log.warning("grib RAM disk %s unusable (%s); using %s",
                    GRIB_RAM_DIR, exc, grib_root)
        return grib_root
    return GRIB_RAM_DIR


def sweep_orphan_gribs(grib_root: Path, max_age_hours: int = 24,
                       now: datetime | None = None, store_root: Path = STORE_DIR) -> list[Path]:
    """Remove run dirs under grib_root/<model>/<run> older than max_age_hours.

    Catches the GRIBs an interrupted ingest_run left behind (see the
    try/finally in _ingest_locked): a run dir this stale was never going to
    be resumed, so it is safe to reclaim. Missing/empty grib_root is fine.
    Returns the dirs removed.
    """
    now = now or datetime.now(timezone.utc)
    cutoff = now.timestamp() - max_age_hours * 3600
    removed: list[Path] = []
    if not grib_root.exists():
        return removed
    for model_dir in sorted(grib_root.iterdir()):
        if not model_dir.is_dir():
            continue
        for run_dir in sorted(model_dir.iterdir()):
            if not run_dir.is_dir():
                continue
            try:
                mtime = run_dir.stat().st_mtime
            except OSError:
                continue
            if mtime < cutoff:
                try:
                    stamp = datetime.strptime(run_dir.name, "%Y%m%dT%H")
                except ValueError:
                    try:
                        stamp = datetime.strptime(run_dir.name, "%Y-%m-%dT%H")
                    except ValueError:
                        continue
                with run_lock(model_dir.name, stamp.strftime("%Y-%m-%dT%H"), store_root) as held:
                    if held:
                        shutil.rmtree(run_dir, ignore_errors=True)
                        removed.append(run_dir)
    return removed


def ingest_run(model: Model, run: datetime, grib_root: Path = GRIB_DIR,
               store_root: Path = STORE_DIR, keep_grib: bool = False) -> dict:
    rid = run_id(run)
    if rid in list_runs(model.key, store_root):
        log.info("%s %s already in store, skipping", model.key, rid)
        return {"model": model.key, "run": rid, "skipped": True}
    if model.source == "weathernext":
        from wxgrid import wn2
        return wn2.ingest_wn2(model, run, store_root)
    # One writer per run: the timer and a hand-run ingest of the same run
    # would otherwise rmtree each other's half-written group (seen 2026-08-18).
    # The same lock guards the maintenance writers (store.run_lock, #4vd6x).
    with run_lock(model.key, rid, store_root) as held:
        if not held:
            log.info("%s %s is being written by another process, skipping", model.key, rid)
            return {"model": model.key, "run": rid, "skipped": "locked"}
        return _ingest_locked(model, run, rid, grib_root, store_root, keep_grib)


def write_spread(writer: RunWriter, model: Model, step: int, paths: list[Path],
                 mean: dict[str, np.ndarray]) -> list[str]:
    """Ensemble-spread GRIBs → the `_sd` variables for one step.

    Never fatal. A step whose spread file did not download, a parameter the
    producer dropped that cycle, or a GRIB that will not decode all end the
    same way: log it, leave those steps NaN, let the run finish. `finish()`
    drops a variable that no step ever delivered, so the API never advertises
    an all-NaN field.

    `mean` is the same step's decoded mean fields, needed only for `wind_sd`:
    NOMADS publishes the spread of the wind components, and turning that into
    a spread of wind SPEED needs the mean wind direction.
    """
    if not model.spread_params or not paths:
        return []
    sd: dict[str, np.ndarray] = {}
    written = []

    def fields():
        for p in paths:
            try:
                yield from iter_fields(p)
            except Exception:
                log.exception("%s step %03d: spread file %s unreadable, skipping", model.key, step, p.name)

    for f in fields():
        canon = model.canonical_spread(f.short_name, f.level_type, f.level)
        if canon is None:
            del f
            continue
        vals = f.values
        if canon == "tp6_sd" and f.units.strip().startswith("m"):
            vals = vals * 1000.0
        if canon in ("u10_sd", "v10_sd"):
            sd[canon] = vals  # Only the wind-speed derivation needs both.
        else:
            writer.write(canon, step, vals)
            if canon not in written:
                written.append(canon)
        del f, vals
    if not sd and not written:
        log.info("%s step %03d: spread file carried nothing we map", model.key, step)
        return []
    if "u10_sd" in sd and "v10_sd" in sd:
        writer.write("wind_sd", step,
                     wind_speed_spread(mean.get("u10"), mean.get("v10"), sd["u10_sd"], sd["v10_sd"]))
        written.append("wind_sd")
    return written


def _ingest_locked(model: Model, run: datetime, rid: str, grib_root: Path, store_root: Path, keep_grib: bool) -> dict:
    # Chosen once and used for the fetch, the per-step release and the cleanup
    # below, so all three agree on where the files actually are.
    grib_root = grib_root_for(model, grib_root, keep_grib=keep_grib)

    writer = RunWriter(model.key, rid, model.steps, model.store_variables(),
                       attribution=model.attribution, root=store_root)
    # Precip/snow are accumulations; we store the amount since the PREVIOUS
    # STORED STEP (3 h or 6 h, whatever the model's step list is). ECMWF
    # accumulates since t0; GFS accumulates in 6 h buckets whose start we read
    # from the GRIB (startStep). Remember (start, step, accum) per variable.
    prev_accum: dict[str, tuple[int, int, np.ndarray]] = {}

    def _fields(paths: list[Path]):
        """Every message in this step's files. Datamart files carry one
        variable each and encode the shortName in the filename, because a few
        GEM parameters decode as "unknown" against the stock eccodes tables."""
        for p in paths:
            short, _ = fetch.grib_override(p)
            try:
                yield from iter_fields(p, short_name=short,
                                       units=model.unit_override.get(short) if short else None,
                                       target_model=model if model.regional else None)
            except Exception:
                # A truncated download poisons every retry: _have() sees a
                # non-empty file and skips the re-fetch, then decoding dies at
                # the torn message and used to abort the whole run. Keep what
                # decoded, drop the file so the next cycle re-fetches it.
                log.warning("unreadable GRIB %s, dropping it", p.name, exc_info=True)
                p.unlink(missing_ok=True)
                if model.source == "ecmwf":
                    raise fetch.FetchDeferred("ECMWF GRIB decode failed; refetch required")

    def write_step(step: int, paths: list[Path]) -> None:
        # The ensemble-spread GRIB decodes to the same shortNames as the mean,
        # so the two sets of files are kept apart by name and mapped through
        # different tables (Model.canonical vs Model.canonical_spread).
        spread_paths = [p for p in paths if fetch.is_spread(p)]
        paths = [p for p in paths if not fetch.is_spread(p)]
        got: dict[str, np.ndarray] = {}
        got_start: dict[str, int] = {}
        # Independent fields go straight to their step chunk. Keep only the
        # inputs whose final occurrence is needed by a derived field; re-reading
        # them from the float16 store would change the derived values.
        deferred = {"tp", "sf", "csnow", "tsk", "lsm", *WAVE_BAND_INPUTS}
        if spread_paths and model.spread_params:
            deferred.update(("u10", "v10"))
        for f in _fields(paths):
            canon = model.canonical(f.short_name, f.level_type, f.level)
            if canon is None:
                del f
                continue
            # HRRR files publish both the since-start total and the last-hour
            # bucket with the same shortName. Range coalescing may bring both
            # messages along; only the total belongs to the deaccumulation path.
            if model.precip_mode == "since_start" and canon in {"tp", "sf"} and f.start_step != 0:
                del f
                continue
            vals = f.values
            if (canon == "tcc" or canon in {"lcc", "mcc", "hcc"} or canon.startswith("cc_")) and f.units.strip() == "%":
                vals = vals / 100.0                                        # GFS TCDC is percent
            if canon in ("tp", "sf") and f.units.strip().startswith("m"):      # "m" or "m of water equivalent"
                vals = vals * 1000.0                                       # IFS tp/sf in metres → mm
            if canon in deferred:
                got[canon] = vals
                got_start[canon] = f.start_step
            elif canon == "sd":
                writer.write("sd_cm", step, np.nan_to_num(vals) * model.snow_depth_factor)
            else:
                writer.write(canon, step, vals)
            del f, vals
        derive_swell(got)
        # accumulations → amount since the previous stored step
        starts = {c: st for c, st in got_start.items()}
        buckets: dict[str, np.ndarray] = {}
        for canon, out in (("tp", "tp6"), ("sf", "sf6")):
            if canon not in got:
                # GEM publishes no accumulation file for hour 000; nothing has
                # fallen at t0 either way, so store the zero rather than a hole.
                if step == 0 and out in writer.variables:
                    writer.write(out, step, np.zeros(model.grid_shape, dtype=np.float32))
                continue
            accum = np.nan_to_num(got[canon])
            prev = prev_accum.get(canon)
            bucket = accumulation_bucket(model.precip_mode, step, starts.get(canon, 0), accum, prev)
            buckets[out] = bucket
            writer.write(out, step, bucket)
            prev_accum[canon] = (starts.get(canon, 0), step, accum)
        # GFS has no snowfall field: snow = the precip bucket where the
        # categorical-snow flag is on.
        if "csnow" in got and "tp6" in buckets and model.precip_mode == "bucket6":
            writer.write("sf6", step, np.where(got["csnow"] >= 0.5, buckets["tp6"], 0.0))
        # Skin temperature is ground temperature over land — misleading as a
        # "sea temp". Masked to water here, it is exactly the SST product.
        if "tsk" in got and "lsm" in got:
            writer.write("sst", step, np.where(got["lsm"] < 0.5, got["tsk"], np.nan).astype(np.float32))
        for canon, vals in got.items():
            if canon in ("tp", "sf", "sd", "csnow", "tsk", "lsm"):
                continue
            writer.write(canon, step, vals)
        write_spread(writer, model, step, spread_paths, got)
        log.info("%s %s step %03d written", model.key, rid, step)

    # ECMWF alone resumes from its downloads: a deferred run keeps its
    # validated GRIBs and re-decodes them next invocation, so those files have
    # to outlive the step. Every other source re-downloads from scratch, and
    # the run directory is removed in the finally below either way.
    release_gribs = model.source != "ecmwf" and not keep_grib

    def on_step(step: int, paths: list[Path]) -> None:
        with Phase(model.key, rid, "decode_write") as phase:
            write_step(step, paths)
            phase.tick()
        # A decoded GRIB is dead weight: nothing reads it again, and the whole
        # run used to sit on disk until the finally below (3.5 GB for GFS).
        # Unlinking here also spares most of the write: the pages are seconds
        # old and well inside vm.dirty_expire_centisecs, so writeback has not
        # claimed them yet and truncation drops them before they reach the
        # platter. Measured 50 GB of GRIB scratch over 30 h on 2026-09-09.
        if release_gribs:
            for path in paths:
                path.unlink(missing_ok=True)
        # The write stack and its decoded arrays are gone before waiting, so a
        # pressure pause does not pin the just-completed step in RAM. Gating
        # the final step matters too: the point-cube build that follows is the
        # most disk-intensive phase of the ingest.
        wait_for_step_gate()

    fetcher = {"ecmwf": fetch.fetch_ecmwf, "nomads": fetch.fetch_gfs, "aws-aigfs": fetch.fetch_aigfs,
               "nomads-gefs": fetch.fetch_gefs, "datamart": fetch.fetch_gem,
               "hrdps": fetch.fetch_hrdps, "aws-hrrr": fetch.fetch_hrrr}[model.source]
    # The rmtree below used to run only after a clean pass through this whole
    # block. An exception, OOM, or timeout kill anywhere in fetch/write/cube
    # build then skipped it and left the run's GRIBs on disk forever (grib
    # dirs are keyed by run id, so nothing later ever revisits or cleans
    # them). try/finally makes the cleanup unconditional; keep_grib still
    # opts a run out of it either way.
    deferred = False
    try:
        with Phase(model.key, rid, "fetch_decode") as phase:
            got = fetcher(model, run, grib_root, on_step=on_step)
            phase.count = len(got)
        # No later phase deaccumulates another step. Do not carry the final
        # rain/snow arrays through point-cube construction and warming.
        prev_accum.clear()
        counts = writer.finish()
        if model.key == "gefs":
            # Member probabilities ride the same ingest, before the point cube is
            # cut so the prob_* series reach the card. Never fatal: a cycle whose
            # members lag just ships without the chance row until the next pass.
            try:
                from wxgrid.prob import ingest_probability
                log.info("gefs %s probability: %s", rid, ingest_probability(rid, store_root))
                wait_for_step_gate()
            except Exception:
                log.exception("gefs %s probability failed (run ships without it)", rid)
        try:
            with Phase(model.key, rid, "point_cube") as phase:
                phase.count = build_point_cube(model.key, rid, store_root, step_gate=wait_for_step_gate)
        except Exception:
            log.exception("%s %s point cube failed (point reads fall back to the step layout)", model.key, rid)
    except fetch.FetchDeferred:
        deferred = True
        raise
    finally:
        if not keep_grib and not deferred:
            shutil.rmtree(grib_root / model.key / run.strftime("%Y%m%dT%H"), ignore_errors=True)
    removed = prune(model.key, root=store_root)
    log.info("%s %s done: %d/%d steps, coverage %s, pruned %s",
             model.key, rid, len(got), len(model.steps), counts, removed)
    try:
        warm_layers(model.key, rid, store_root)
    except Exception:
        log.exception("%s %s warm render failed (layers render on first request instead)", model.key, rid)
    return {"model": model.key, "run": rid, "steps": len(got), "coverage": counts,
            "pruned": removed}


# The layers a fresh visit paints, warmed right after ingest so the first
# request of each step hits disk instead of paying the cold render (~0.5 s a
# frame, felt hardest when someone presses play on a new run).
# The set a visit actually opens: the defaults plus the tape's own layers.
# Every surface layer for every step would be ~14,000 frames a generation —
# four CPU-hours a cycle — so the warm set is chosen, not total; levels and
# the long tail still render on first request.
WARM_LAYERS = ("wind", "temp", "gust", "tp6", "tcc", "msl")


def warm_layers(model_key: str, rid: str, store_root: Path = STORE_DIR) -> int:
    with Phase(model_key, rid, "warming") as phase:
        return _warm_layers(model_key, rid, store_root, phase)


def _warm_layers(model_key: str, rid: str, store_root: Path, phase: Phase) -> int:
    """Pre-encode the field files the browser asks for (/api/field). The
    coloured PNGs of /api/layer are the fallback for clients without WebGL
    and render on first request; warming both would double the warm time
    for a path almost nobody takes."""
    from wxgrid import render
    from wxgrid.api import _SIX_HOURLY, _available, _level_step, field_for
    from wxgrid.config import CACHE_DIR
    from wxgrid.store import RunReader

    r = RunReader(model_key, rid, root=store_root)
    done = 0

    def frame(path, step, layer):
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        try:
            tmp.write_bytes(render.encode_field(render.DISPLAY[layer](field_for(r, layer, None, step)), layer, fmt="webp"))
            tmp.replace(path)
        finally:
            tmp.unlink(missing_ok=True)
    for layer in WARM_LAYERS:
        if not _available(r, layer, None):
            continue
        # the same step mapping and the same name as the request path, so the
        # names collide (that is the point) and a six-hourly layer is not
        # encoded twice
        for step in sorted({_level_step(r, st, layer in _SIX_HOURLY) for st in r.steps}):
            # WebP is what the app's field.js asks for; PNG stays on-demand for
            # the odd client without it.
            path = CACHE_DIR / model_key / rid / render.field_cache_name(step, layer, "webp")
            if path.exists():
                phase.tick(skipped=True)
                continue
            if done == 0:
                wait_for_step_gate()
            frame(path, step, layer)
            done += 1
            wait_for_step_gate()
            phase.tick()
    log.info("%s %s warmed %d fields", model_key, rid, done)
    return done


def augment_waves(model: Model, rid: str, grib_root: Path = GRIB_DIR, store_root: Path = STORE_DIR) -> dict:
    """Add the wave variables to a run that was ingested before waves existed.
    Opens the run's group read-write, creates the missing arrays, fetches the
    wave GRIB per 6 h step and writes it. Runs that already carry them, or
    models without a wave stream, are a no-op."""
    import zarr
    from zarr.codecs import BloscCodec
    from wxgrid.models import LEVEL_EVERY

    if not model.wave_params:
        return {"model": model.key, "run": rid, "skipped": "no wave params"}
    with run_lock(model.key, rid, store_root) as held:
        if not held:
            return {"model": model.key, "run": rid, "skipped": "locked"}
        return _augment_waves_locked(model, rid, grib_root, store_root)


def _augment_waves_locked(model: Model, rid: str, grib_root: Path, store_root: Path) -> dict:
    import zarr
    from zarr.codecs import BloscCodec
    from wxgrid.models import LEVEL_EVERY

    path = run_path(model.key, rid, store_root)
    g = zarr.open_group(path, mode="r+")
    have = list(g.attrs.get("variables", []))
    want = [v for v in model.wave_variables() if v not in have]
    if not want:
        return {"model": model.key, "run": rid, "skipped": "already has waves"}
    steps = list(g.attrs["steps"])
    codec = BloscCodec(cname="zstd", clevel=3, shuffle="bitshuffle")
    for var in want:
        if var not in g:
            shape = tuple(g["t2m"].shape[1:]) if "t2m" in g else get_model(model.key).grid_shape
            g.create_array(var, shape=(len(steps), *shape), dtype="float32",
                           chunks=(1, *shape), compressors=codec, fill_value=np.nan,
                           dimension_names=("step", "latitude", "longitude"))
    client = fetch.BoundedECMWF(model)
    run = datetime.strptime(rid, "%Y-%m-%dT%H").replace(tzinfo=timezone.utc)
    out_dir = grib_root / model.key / run.strftime("%Y%m%dT%H")
    out_dir.mkdir(parents=True, exist_ok=True)
    written = 0
    for step in steps:
        if step % LEVEL_EVERY:
            continue
        wv = fetch.fetch_ecmwf_wave(client, model, run, step, out_dir)
        if not wv:
            continue
        got: dict[str, np.ndarray] = {}
        for f in iter_fields(wv):
            canon = model.wave_params.get(f.short_name)
            if canon:
                got[canon] = np.asarray(f.values, dtype=np.float32)
        derive_swell(got)
        for canon, vals in got.items():
            if canon in want:
                g[canon][steps.index(step)] = vals
                written += 1
        wv.unlink(missing_ok=True)
    cov = dict(g.attrs.get("coverage", {}))
    for var in want:
        cov[var] = written // max(1, len(want))
    g.attrs.update({"variables": have + want, "coverage": cov})   # rewrites zarr.json → API reopens the run
    build_point_cube(model.key, rid, store_root, want)
    log.info("%s %s: waves added, %d fields", model.key, rid, written)
    return {"model": model.key, "run": rid, "wave_fields": written}


def ingest_order() -> list[str]:
    """Most perishable first: short-range regional, then global, then ensemble.

    This used to run globals first so "a slow regional fetch never delays an
    available global cycle", which had it backwards for the model that needs
    freshness most. HRRR sat last, behind GEFS — whose 30 members and
    probability pass can run for hours — and because the hourly timer cannot
    fire while a pass is still running, HRRR went ten hours without a refresh
    (2026-08-25). A 3 km hourly model is the first thing to go stale and the
    last thing anyone wants stale; a 10-day global that publishes four times a
    day can wait the extra two minutes.

    Each group stays sorted by key so the pass is deterministic.
    """
    return sorted((k for k in MODELS if configured(k)), key=lambda key: (TIERS.index(model_tier(key)), key))


def configured(key: str) -> bool:
    """False for an optional model this box has no access to. Such a model
    stays out of the timer passes entirely (asking for it is what
    `--model <key>` is for); it used to fail the whole global pass with
    exit 1 every three hours (2026-09-03)."""
    m = MODELS[key]
    if not m.optional:
        return True
    if m.source == "weathernext":
        from wxgrid import wn2
        return wn2.zarr_url() is not None
    return True


# How perishable a model is, and therefore how often it is worth fetching.
# One name for the idea, used by the pass order and by --group, so a model
# cannot be early in the order and in the wrong group at the same time.
TIERS = ("regional", "global", "ensemble")


def model_tier(key: str) -> str:
    """Which refresh tier a model belongs to.

    regional  short range, ages fastest, cheapest to fetch
    global    the deterministic globals
    ensemble  spread_params is what an ensemble carries and nothing else does:
              the heaviest fetch in the pass and the least time-critical
    """
    m = MODELS[key]
    if m.regional:
        return "regional"
    return "ensemble" if m.spread_params else "global"


def models_in(group: str) -> list[str]:
    """The models of one tier, in pass order."""
    return [k for k in ingest_order() if model_tier(k) == group]


# Third-party loggers that narrate every retry: urllib3 on each broken
# connection, multiurl with "attempt 1 of 500", ecmwf.opendata with its
# connection-limit notice on every run. The retry budget (ecmwf_budget.py)
# owns those decisions and logs its own outcome once.
QUIET_LOGGERS = ("urllib3.connectionpool", "multiurl.retry", "multiurl.base", "ecmwf.opendata.utils")


def quiet_third_party_loggers() -> None:
    for name in QUIET_LOGGERS:
        logging.getLogger(name).setLevel(logging.ERROR)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", choices=sorted(MODELS), help="one model")
    ap.add_argument("--all", action="store_true", help="every model")
    ap.add_argument("--group", choices=TIERS,
                    help="every model of one refresh tier: regional, global or ensemble")
    ap.add_argument("--force", action="store_true",
                    help="run a group or full pass even when the ingest mode would skip it")
    ap.add_argument("--run", default="auto", help="YYYY-MM-DDTHH (UTC) or 'auto'")
    ap.add_argument("--keep-grib", action="store_true")
    ap.add_argument("--augment-waves", action="store_true", help="add wave fields to runs already in the store")
    ap.add_argument("--point-cube", action="store_true", help="build the point-read cube for runs already in the store")
    ap.add_argument("--probability", action="store_true", help="count GEFS member probabilities for runs already in the store")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    if not args.verbose:
        quiet_third_party_loggers()
    if args.all:
        keys = ingest_order()
    elif args.group:
        keys = models_in(args.group)
    else:
        keys = [args.model] if args.model else []
    if not keys:
        ap.error("--model, --group or --all")
    # A scheduled pass — a group or the full fleet — obeys the ingest mode.
    # `--model X` does not: a human typed a model name, and the switch is for
    # the timers, not for them. `--force` is the same exemption for the
    # refresh-now button, which is also a human asking.
    scheduled = bool(args.group or args.all) and not args.force
    mode = ingest_mode.read_mode() if scheduled else "detailed"
    if scheduled:
        if mode == "paused":
            log.info("ingest paused; nothing to do")
            return 0
        group = args.group or ""
        if group:
            keys = ingest_mode.models_for_mode(mode, group, keys)
        elif mode == "simple":
            keys = [k for k in keys if k in ingest_mode.SIMPLE_MODELS]
        if not keys:
            log.info("ingest mode %s: nothing to do for %s", mode, group or "all")
            return 0
    # Both roots: a run killed mid-fetch leaves its downloads behind, and on
    # the RAM disk that is memory nobody is using.
    swept = sweep_orphan_gribs(GRIB_DIR)
    swept += sweep_orphan_gribs(GRIB_RAM_DIR)
    if swept:
        log.info("swept %d orphan grib run dir(s)", len(swept))
    rc = 0
    for key in keys:
        model = get_model(key)
        try:
            if args.augment_waves:
                for rid in list_runs(model.key):
                    log.info("augment %s", augment_waves(model, rid))
                continue
            if args.point_cube:
                for rid in list_runs(model.key):
                    log.info("point cube %s %s: %d variables", model.key, rid, build_point_cube(model.key, rid))
                continue
            if args.probability:
                if model.key != "gefs":
                    continue
                from wxgrid.prob import ingest_probability
                for rid in list_runs("gefs"):
                    log.info("probability %s: %s", rid, ingest_probability(rid))
                    log.info("point cube gefs %s: %d variables", rid, build_point_cube("gefs", rid))
                continue
            try:
                run = _resolve_run(model, args.run)
            except fetch.FetchDeferred as exc:
                log.warning("%s deferred: %s", key, exc)
                rc = 1
                continue
            except RuntimeError as exc:
                # Nothing published yet for this model. With --all that is a
                # normal race against the producers, not a failure.
                log.warning("%s: %s", key, exc)
                if not args.all:
                    rc = 1
                continue
            if not ingest_mode.cycle_allowed(mode, run.hour):
                log.info("%s %02dz skipped: mode %s runs %s only",
                         key, run.hour, mode, "/".join(f"{h:02d}z" for h in ingest_mode.SIMPLE_CYCLES))
                continue
            ingest_run(model, run, keep_grib=args.keep_grib)
            # A served run without its point cube is a 10 s card instead of
            # 0.2 s (2026-08-28: three models' newest runs had none after a
            # lock bug). Idempotent, cheap when the cube is there.
            repair_cubes(model)
        except fetch.FetchDeferred as exc:
            log.warning("%s deferred; completed GRIBs retained: %s", key, exc)
            rc = 1
        except Exception:
            log.exception("%s failed", key)
            rc = 1
    return rc


def repair_cubes(model: Model, store_root: Path = STORE_DIR) -> list[str]:
    """Build the point cube for any complete run of `model` that lacks one.
    Returns the run ids it built."""
    import zarr
    built = []
    # Newest complete run only: it is the one every card reads, and a cube
    # is half a run on disk — rebuilding one for every superseded run was
    # 10 min and 3 GB apiece for runs nobody opens (2026-08-28).
    for rid in list_runs(model.key, store_root)[:1]:
        try:
            g = zarr.open_group(run_path(model.key, rid, store_root), mode="r")
            if "pt" in g:
                continue
        except Exception:                                        # noqa: BLE001
            continue
        try:
            n = build_point_cube(model.key, rid, store_root, step_gate=wait_for_step_gate)
            if n:
                built.append(rid)
                log.info("%s %s: point cube repaired, %d variables", model.key, rid, n)
        except Exception:
            log.exception("%s %s point cube repair failed", model.key, rid)
    return built


if __name__ == "__main__":
    raise SystemExit(main())
