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
import shutil
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import requests

from wxgrid import fetch
from wxgrid.config import GRIB_DIR, STORE_DIR
from wxgrid.ens import wind_speed_spread
from wxgrid.grib import iter_fields
from wxgrid.models import MODELS, Model, get_model
from wxgrid.store import RunWriter, build_point_cube, list_runs, prune, run_id, run_path

log = logging.getLogger("wxgrid.ingest")


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


def _resolve_run(model: Model, run: str | None) -> datetime:
    if run and run != "auto":
        return datetime.strptime(run, "%Y-%m-%dT%H").replace(tzinfo=timezone.utc)
    if model.source == "ecmwf":
        from ecmwf.opendata import Client
        client = Client(source="ecmwf", model=model.ecmwf_model, resol="0p25")
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


def ingest_run(model: Model, run: datetime, grib_root: Path = GRIB_DIR,
               store_root: Path = STORE_DIR, keep_grib: bool = False) -> dict:
    rid = run_id(run)
    if rid in list_runs(model.key, store_root):
        log.info("%s %s already in store, skipping", model.key, rid)
        return {"model": model.key, "run": rid, "skipped": True}
    # One writer per run: the timer and a hand-run ingest of the same run
    # would otherwise rmtree each other's half-written group (seen 2026-08-18).
    import fcntl
    lock_path = store_root / model.key / f".{rid}.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    lock = open(lock_path, "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        log.info("%s %s is being ingested by another process, skipping", model.key, rid)
        return {"model": model.key, "run": rid, "skipped": "locked"}
    try:
        return _ingest_locked(model, run, rid, grib_root, store_root, keep_grib)
    finally:
        fcntl.flock(lock, fcntl.LOCK_UN); lock.close()
        lock_path.unlink(missing_ok=True)


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
    for p in paths:
        try:
            for f in iter_fields(p):
                canon = model.canonical_spread(f.short_name, f.level_type, f.level)
                if canon is None:
                    continue
                vals = f.values
                # Same unit rule as the mean path: ECMWF-style metres of water
                # would need ×1000; GEFS ships kg m-2, which is already mm.
                if canon == "tp6_sd" and f.units.strip().startswith("m"):
                    vals = vals * 1000.0
                sd[canon] = vals
        except Exception:
            log.exception("%s step %03d: spread file %s unreadable, skipping", model.key, step, p.name)
    if not sd:
        log.info("%s step %03d: spread file carried nothing we map", model.key, step)
        return []
    written = []
    for canon, vals in sd.items():
        if canon in ("u10_sd", "v10_sd"):
            continue                     # inputs to wind_sd, not stored themselves
        writer.write(canon, step, vals)
        written.append(canon)
    if "u10_sd" in sd and "v10_sd" in sd:
        writer.write("wind_sd", step,
                     wind_speed_spread(mean.get("u10"), mean.get("v10"), sd["u10_sd"], sd["v10_sd"]))
        written.append("wind_sd")
    return written


def _ingest_locked(model: Model, run: datetime, rid: str, grib_root: Path, store_root: Path, keep_grib: bool) -> dict:

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

    def on_step(step: int, paths: list[Path]) -> None:
        # The ensemble-spread GRIB decodes to the same shortNames as the mean,
        # so the two sets of files are kept apart by name and mapped through
        # different tables (Model.canonical vs Model.canonical_spread).
        spread_paths = [p for p in paths if fetch.is_spread(p)]
        paths = [p for p in paths if not fetch.is_spread(p)]
        got: dict[str, np.ndarray] = {}
        got_start: dict[str, int] = {}
        for f in _fields(paths):
            canon = model.canonical(f.short_name, f.level_type, f.level)
            if canon is None:
                continue
            # HRRR files publish both the since-start total and the last-hour
            # bucket with the same shortName. Range coalescing may bring both
            # messages along; only the total belongs to the deaccumulation path.
            if model.precip_mode == "since_start" and canon in {"tp", "sf"} and f.start_step != 0:
                continue
            got_start[canon] = f.start_step
            vals = f.values
            if (canon == "tcc" or canon in {"lcc", "mcc", "hcc"} or canon.startswith("cc_")) and f.units.strip() == "%":
                vals = vals / 100.0                                        # GFS TCDC is percent
            if canon in ("tp", "sf") and f.units.strip().startswith("m"):      # "m" or "m of water equivalent"
                vals = vals * 1000.0                                       # IFS tp/sf in metres → mm
            got[canon] = vals
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
        if "sd" in got:
            writer.write("sd_cm", step, np.nan_to_num(got["sd"]) * model.snow_depth_factor)
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

    fetcher = {"ecmwf": fetch.fetch_ecmwf, "nomads": fetch.fetch_gfs, "aws-aigfs": fetch.fetch_aigfs,
               "nomads-gefs": fetch.fetch_gefs, "datamart": fetch.fetch_gem,
               "hrdps": fetch.fetch_hrdps, "aws-hrrr": fetch.fetch_hrrr}[model.source]
    got = fetcher(model, run, grib_root, on_step=on_step)

    counts = writer.finish()
    if model.key == "gefs":
        # Member probabilities ride the same ingest, before the point cube is
        # cut so the prob_* series reach the card. Never fatal: a cycle whose
        # members lag just ships without the chance row until the next pass.
        try:
            from wxgrid.prob import ingest_probability
            log.info("gefs %s probability: %s", rid, ingest_probability(rid, store_root))
        except Exception:
            log.exception("gefs %s probability failed (run ships without it)", rid)
    try:
        build_point_cube(model.key, rid, store_root)
    except Exception:
        log.exception("%s %s point cube failed (point reads fall back to the step layout)", model.key, rid)
    if not keep_grib:
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
    from wxgrid import render
    from wxgrid.api import _SIX_HOURLY, _available, _level_step, _render_plan, field_for
    from wxgrid.config import CACHE_DIR
    from wxgrid.store import RunReader

    r = RunReader(model_key, rid, root=store_root)
    done = 0
    for layer in WARM_LAYERS:
        if not _available(r, layer, None):
            continue
        # the same step mapping and the same name/format decision as the
        # request path, so the names collide (that is the point) and a
        # six-hourly layer is not rendered twice. The format comes from the
        # name function: for a while this wrote WebP bytes into .png names
        # (and paid WebP's 3-5 s encode per frame) after the request path
        # had moved to PNG (2026-08-22).
        for step in sorted({_level_step(r, st, layer in _SIX_HOURLY) for st in r.steps}):
            cache_tag, scale = _render_plan(model_key, layer)
            name, fmt, _ = render.layer_cache_name(step, cache_tag, None)
            path = CACHE_DIR / model_key / rid / name
            if path.exists():
                continue
            path.parent.mkdir(parents=True, exist_ok=True)
            disp = render.upscale_values(
                render.DISPLAY[layer](render.to_mercator(
                    field_for(r, layer, None, step), lat0=r.lat0, lon0=r.lon0,
                    dlat=r.dlat, dlon=r.dlon)), layer, factor=scale)
            tmp = path.with_suffix(path.suffix + ".tmp")
            tmp.write_bytes(render.colorize(disp, layer, fmt=fmt))
            tmp.replace(path)
            done += 1
    log.info("%s %s warmed %d frames", model_key, rid, done)
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
    path = run_path(model.key, rid, store_root)
    g = zarr.open_group(path, mode="r+")
    have = list(g.attrs.get("variables", []))
    want = [v for v in model.wave_params.values() if v not in have]
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
    from ecmwf.opendata import Client
    client = Client(source="ecmwf", model=model.ecmwf_model, resol="0p25")
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
        for f in iter_fields(wv):
            canon = model.wave_params.get(f.short_name)
            if canon:
                g[canon][steps.index(step)] = np.asarray(f.values, dtype=np.float32)
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
    """Global products first, then the two heavier regional products.

    Keeping each group sorted makes the timer deterministic while ensuring a
    slow regional fetch never delays an available global cycle.
    """
    return sorted(MODELS, key=lambda key: (MODELS[key].regional, key))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", choices=sorted(MODELS), help="one model")
    ap.add_argument("--all", action="store_true", help="every model")
    ap.add_argument("--run", default="auto", help="YYYY-MM-DDTHH (UTC) or 'auto'")
    ap.add_argument("--keep-grib", action="store_true")
    ap.add_argument("--augment-waves", action="store_true", help="add wave fields to runs already in the store")
    ap.add_argument("--point-cube", action="store_true", help="build the point-read cube for runs already in the store")
    ap.add_argument("--probability", action="store_true", help="count GEFS member probabilities for runs already in the store")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    keys = ingest_order() if args.all else ([args.model] if args.model else [])
    if not keys:
        ap.error("--model or --all")
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
            except RuntimeError as exc:
                # Nothing published yet for this model. With --all that is a
                # normal race against the producers, not a failure.
                log.warning("%s: %s", key, exc)
                if not args.all:
                    rc = 1
                continue
            ingest_run(model, run, keep_grib=args.keep_grib)
        except Exception:
            log.exception("%s failed", key)
            rc = 1
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
