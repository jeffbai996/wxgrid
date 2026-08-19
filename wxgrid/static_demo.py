"""Build a self-contained static snapshot of wxgrid for GitHub Pages.

    python -m wxgrid.static_demo --out dist-pages [--model aifs] [--hours 0:120:12]

What Pages gets (no server, no query strings):
  index.html + front assets (front/private/ excluded, a <meta wxgrid-mode=static> injected)
  api/models.json                              catalog for the one model/run
  api/layer/M/R/S/<layer>[-<level>].png        Mercator PNGs, downsampled 2×
  api/wind/M/R/S[-<level>].json                coarse u/v for particles
  api/isolines/M/R/S/<var>.json                isobars etc.
  api/pt/M/R/<ty>_<tx>.json                    point tiles: 10°×10° blocks of a 2° point grid,
                                               every surface variable + 850/700/500 hPa aloft
  api/resorts/all.json + api/resorts/<id>.json for resorts whose detail is already cached

front/static-api.js turns the live API calls into these files at runtime.
The snapshot is a demo: one model, 12-hourly, coarse points — the README says so.
"""
from __future__ import annotations

import re
import argparse
import json
import logging
import shutil
from datetime import timedelta
from pathlib import Path

import numpy as np
from PIL import Image

from wxgrid import render
from wxgrid.api import ISOLINE_SPECS, LAYERS, _available, _freezing_level_grid, _isoline_geojson, _levels_for, _vars_for, field_for
from wxgrid.config import BASE_DIR, DATA_DIR, FRONT_DIR
from wxgrid.models import MODELS
from wxgrid.store import RunReader, list_runs, parse_run_id

log = logging.getLogger("wxgrid.static_demo")

POINT_DEG = 2.0            # point-grid spacing in the demo
TILE_DEG = 10.0
DEMO_LEVELS = (850, 700, 500)
WIND_LEVELS = (850, 250)
TEMP_LEVELS = (850,)


def _shrink_png(png: bytes, factor: int) -> bytes:
    if factor <= 1:
        return png
    import io
    im = Image.open(io.BytesIO(png))
    im = im.resize((im.width // factor, im.height // factor), Image.BILINEAR)
    buf = io.BytesIO()
    im.save(buf, format="PNG", optimize=True)
    return buf.getvalue()



def _rewrite_index(html: str) -> str:
    """Turn the live index.html into the static-demo one.

    Every edit here is asserted. These used to be literal `str.replace` calls,
    which return the input unchanged when the markup drifts — adding `defer`
    to the script tags silently stopped static-api.js from being injected and
    shipped a demo that booted against an API that does not exist on Pages.
    A build that cannot patch the page must fail, not publish.
    """
    subs = [
        # the private overlay is not part of the public build
        (r'[ \t]*<link rel="stylesheet" href="private/theme\.css">\n', "", 1),
        (r'[ \t]*<script[^>]*\bsrc="private/theme\.js"[^>]*></script>\n', "", 1),
        (r"<title>wxgrid</title>",
         '<title>wxgrid</title>\n<meta name="wxgrid-mode" content="static">', 1),
        # the shim must run before app.js, so it goes immediately in front of it
        # and carries the same defer/async attributes to keep execution order
        (r'<script([^>]*)\bsrc="app\.js"([^>]*)></script>',
         r'<script\1src="static-api.js"\2></script>\n<script\1src="app.js"\2></script>', 1),
    ]
    for pattern, repl, count in subs:
        html, n = re.subn(pattern, repl, html, count=count)
        if n != count:
            raise RuntimeError(f"static build could not patch index.html: {pattern!r} matched {n} times")
    return html

def build(out: Path, model_key: str, hours: list[int], scale: int = 2) -> dict:
    model = MODELS[model_key]
    runs = list_runs(model_key)
    if not runs:
        raise SystemExit(f"no complete run for {model_key}")
    rid = runs[0]
    r = RunReader(model_key, rid)
    steps = [h for h in hours if h in r.steps]
    log.info("building %s %s steps=%s → %s", model_key, rid, steps, out)
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    # ── front ────────────────────────────────────────────────────────
    for item in FRONT_DIR.iterdir():
        if item.name == "private":
            continue
        if item.is_dir():
            shutil.copytree(item, out / item.name)
        else:
            shutil.copy2(item, out / item.name)
    html = _rewrite_index((out / "index.html").read_text())
    (out / "index.html").write_text(html)
    (out / ".nojekyll").write_text("")

    api = out / "api"
    # ── catalog ──────────────────────────────────────────────────────
    levels = _levels_for(r)
    # The demo trims the long-window and second-order layers to keep the Pages
    # payload sane; the live app has them all.
    STATIC_SKIP = {"tp72", "sf72", "rh", "wperiod"}
    layers = [l for l in LAYERS if _available(r, l) and l not in STATIC_SKIP]
    catalog = {"models": [{"key": model_key, "label": model.label, "short": model.short, "attribution": model.attribution,
                           "runs": [{"run": rid, "steps": steps, "layers": layers,
                                     "levels": [l for l in levels if l in set(WIND_LEVELS) | set(TEMP_LEVELS)],
                                     "valid_from": parse_run_id(rid).isoformat()}]}],
               "layers": [render.legend(l) for l in LAYERS], "levels": list(WIND_LEVELS),
               "static": {"built": rid, "point_deg": POINT_DEG, "note": "static demo: one model, 12-hourly, 2° point grid"}}
    api.mkdir(parents=True)
    (api / "models.json").write_text(json.dumps(catalog))

    # ── layers, wind, isolines ───────────────────────────────────────
    n_png = 0
    for h in steps:
        ldir = api / "layer" / model_key / rid / str(h); ldir.mkdir(parents=True, exist_ok=True)
        wdir = api / "wind" / model_key / rid; wdir.mkdir(parents=True, exist_ok=True)
        idir = api / "isolines" / model_key / rid / str(h); idir.mkdir(parents=True, exist_ok=True)
        for layer in layers:
            variants: list[int | None] = [None]
            if layer == "wind":
                variants += [l for l in WIND_LEVELS if l in levels]
            if layer == "temp":
                variants += [l for l in TEMP_LEVELS if l in levels]
            for lvl in variants:
                vars_ = _vars_for(layer, lvl)
                field = field_for(r, layer, lvl, h)
                disp = render.DISPLAY[layer](render.to_mercator(field))
                png = _shrink_png(render.colorize(disp, layer), scale)
                (ldir / f"{layer}{'' if lvl is None else '-' + str(lvl)}.png").write_bytes(png)
                n_png += 1
                if layer == "wind":
                    (wdir / f"{h}{'' if lvl is None else '-' + str(lvl)}.json").write_bytes(render.wind_json(r.slab(vars_[0], h), r.slab(vars_[1], h), factor=6, decimals=0))
        # isolines: msl + frz (+ temp) at this step
        for var in ("msl", "frz"):
            interval, disp_fn, unit = ISOLINE_SPECS[var]
            if var == "msl" and "msl" not in r.variables:
                continue
            src = _freezing_level_grid(r, h) if var == "frz" else r.slab("t2m" if var == "temp" else var, h)
            try:
                payload = _isoline_geojson(src, interval, disp_fn, unit)
            except ValueError:
                continue
            (idir / f"{var}.json").write_text(json.dumps(payload, separators=(",", ":")))
        log.info("step %03d done", h)

    # ── point tiles ──────────────────────────────────────────────────
    pdir = api / "pt" / model_key / rid; pdir.mkdir(parents=True, exist_ok=True)
    sfc_vars = [v for v in ("u10", "v10", "t2m", "msl", "tp6", "sf6", "sd_cm", "tcc", "cape", "d2m", "gust") if v in r.variables]
    lvl_vars = [f"{p}_{l}" for l in DEMO_LEVELS if l in levels for p in ("t", "u", "v", "gh")]
    allvars = sfc_vars + lvl_vars
    step_idx = [r.steps.index(h) for h in steps]
    # Pull each variable once for the chosen steps at the 2° grid: [nsteps, nlat, nlon]
    lat_idx = np.arange(0, 721, int(POINT_DEG / 0.25))          # 90 → -90 every 2°
    lon_idx = np.arange(0, 1440, int(POINT_DEG / 0.25))         # -180 → 178
    cube = {}
    for v in allvars:
        arr = np.asarray(r.group[v].oindex[step_idx, lat_idx, lon_idx], dtype=np.float32)
        cube[v] = arr
    n_tiles = 0
    tiles_lat = int(180 / TILE_DEG); tiles_lon = int(360 / TILE_DEG)
    per_tile = int(TILE_DEG / POINT_DEG)
    for ty in range(tiles_lat):
        for tx in range(tiles_lon):
            r0, r1 = ty * per_tile, (ty + 1) * per_tile
            c0, c1 = tx * per_tile, (tx + 1) * per_tile
            tile = {"lat0": 90 - ty * TILE_DEG, "lon0": -180 + tx * TILE_DEG, "d": POINT_DEG,
                    "ny": r1 - r0, "nx": c1 - c0, "steps": steps, "vars": {}}
            for v in allvars:
                block = cube[v][:, r0:r1, c0:c1]
                tile["vars"][v] = [None if np.isnan(x) else round(float(x), 2) for x in block.ravel()]   # [step, y, x]
            (pdir / f"{ty}_{tx}.json").write_text(json.dumps(tile, separators=(",", ":")))
            n_tiles += 1

    # ── resorts (catalog + cached details only) ──────────────────────
    rdir = api / "resorts"; rdir.mkdir(parents=True, exist_ok=True)
    cat = DATA_DIR / "resorts" / "catalog.json"
    n_res = 0
    if cat.exists():
        entries = json.loads(cat.read_text())
        entries = entries.get("resorts", entries) if isinstance(entries, dict) else entries
        (rdir / "all.json").write_text(json.dumps({"resorts": [{"id": e["id"], "name": e["name"], "lat": e["lat"], "lon": e["lon"], "country": e.get("country"), "region": e.get("region"), "ele_summit_m": e.get("ele_summit_m")} for e in entries]}))
        for det in (DATA_DIR / "resorts").glob("*.json"):
            if det.name == "catalog.json":
                continue
            shutil.copy2(det, rdir / det.name)
            n_res += 1
    size_mb = sum(p.stat().st_size for p in out.rglob("*") if p.is_file()) / 1e6
    summary = {"model": model_key, "run": rid, "steps": steps, "layers": layers, "pngs": n_png, "point_tiles": n_tiles,
               "resort_details": n_res, "size_mb": round(size_mb, 1)}
    log.info("done: %s", summary)
    return summary


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=str(BASE_DIR / "dist-pages"))
    ap.add_argument("--model", default="aifs", choices=sorted(MODELS))
    ap.add_argument("--hours", default="0:96:12", help="start:stop:step forecast hours")
    ap.add_argument("--scale", type=int, default=2, help="downsample layers by this factor")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    a, b, c = (int(x) for x in args.hours.split(":"))
    print(json.dumps(build(Path(args.out), args.model, list(range(a, b + 1, c)), args.scale)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
