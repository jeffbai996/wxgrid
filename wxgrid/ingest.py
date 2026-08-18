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
from wxgrid.grib import iter_fields
from wxgrid.models import MODELS, Model, get_model
from wxgrid.store import RunWriter, list_runs, prune, run_id

log = logging.getLogger("wxgrid.ingest")


def _resolve_run(model: Model, run: str | None) -> datetime:
    if run and run != "auto":
        return datetime.strptime(run, "%Y-%m-%dT%H").replace(tzinfo=timezone.utc)
    if model.source == "ecmwf":
        from ecmwf.opendata import Client
        client = Client(source="ecmwf", model=model.ecmwf_model, resol="0p25")
        # Asking for the LAST step means "latest run that is fully published".
        when = client.latest(type="fc", step=model.steps[-1], param=list(model.sfc_params)[:1])
        return when.replace(tzinfo=timezone.utc)
    if model.source == "nomads":
        s = requests.Session()
        for cand in fetch.gfs_candidate_runs():
            url = fetch.gfs_step_url(cand, model.steps[-1], model.levels)
            try:
                if s.head(url, timeout=30, allow_redirects=True).status_code == 200:
                    return cand
            except requests.RequestException:
                continue
        raise RuntimeError("no fully published GFS run found in the last 24 h")
    raise ValueError(model.source)


def ingest_run(model: Model, run: datetime, grib_root: Path = GRIB_DIR,
               store_root: Path = STORE_DIR, keep_grib: bool = False) -> dict:
    rid = run_id(run)
    if rid in list_runs(model.key, store_root):
        log.info("%s %s already in store, skipping", model.key, rid)
        return {"model": model.key, "run": rid, "skipped": True}

    writer = RunWriter(model.key, rid, model.steps, model.store_variables(),
                       attribution=model.attribution, root=store_root)
    prev_accum: np.ndarray | None = None      # ECMWF tp is accumulated since t0
    prev_step: int | None = None

    def on_step(step: int, paths: list[Path]) -> None:
        nonlocal prev_accum, prev_step
        for f in (fld for p in paths for fld in iter_fields(p)):
            canon = model.canonical(f.short_name, f.level_type, f.level)
            if canon is None:
                continue
            if canon == "tcc" and f.units.strip() == "%":
                f.values = f.values / 100.0                              # GFS TCDC is percent
            if canon != "tp":
                writer.write(canon, step, f.values)
                continue
            if model.precip_mode == "bucket6":
                writer.write("tp6", step, np.nan_to_num(f.values))       # already mm / 6 h
            else:
                # IFS ships tp in metres, AIFS in kg m-2 (= mm); trust the GRIB.
                accum_mm = f.values * (1000.0 if f.units.strip() == "m" else 1.0)
                if prev_accum is None or prev_step is None or step - prev_step != 6:
                    tp6 = np.zeros_like(accum_mm) if step == 0 else np.full_like(accum_mm, np.nan)
                else:
                    tp6 = np.clip(accum_mm - prev_accum, 0.0, None)
                writer.write("tp6", step, tp6)
                prev_accum, prev_step = accum_mm, step
        log.info("%s %s step %03d written", model.key, rid, step)

    if model.source == "ecmwf":
        got = fetch.fetch_ecmwf(model, run, grib_root, on_step=on_step)
    else:
        got = fetch.fetch_gfs(model, run, grib_root, on_step=on_step)

    counts = writer.finish()
    if not keep_grib:
        shutil.rmtree(grib_root / model.key / run.strftime("%Y%m%dT%H"), ignore_errors=True)
    removed = prune(model.key, root=store_root)
    log.info("%s %s done: %d/%d steps, coverage %s, pruned %s",
             model.key, rid, len(got), len(model.steps), counts, removed)
    return {"model": model.key, "run": rid, "steps": len(got), "coverage": counts,
            "pruned": removed}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", choices=sorted(MODELS), help="one model")
    ap.add_argument("--all", action="store_true", help="every model")
    ap.add_argument("--run", default="auto", help="YYYY-MM-DDTHH (UTC) or 'auto'")
    ap.add_argument("--keep-grib", action="store_true")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    keys = sorted(MODELS) if args.all else ([args.model] if args.model else [])
    if not keys:
        ap.error("--model or --all")
    rc = 0
    for key in keys:
        model = get_model(key)
        try:
            run = _resolve_run(model, args.run)
            ingest_run(model, run, keep_grib=args.keep_grib)
        except Exception:
            log.exception("%s failed", key)
            rc = 1
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
