"""Global atmospheric-composition layers: fetch, cache, render, point query.

The name is historical — the target was ECMWF CAMS. CAMS global forecasts are
NOT on the ECMWF open-data portal (data.ecmwf.int/forecasts carries only
`ifs`, `aifs-single` and `aifs-ens`); the only free CAMS gridded feed is the
Copernicus ADS, which requires an account key. So the raster layers here come
from the one keyless global composition model that publishes GRIB2 in the open:

    NOAA GEFS-Aerosol (GEFS-Aer, the GOCART aerosol module of the GEFS suite)
    https://nomads.ncep.noaa.gov/  ·  gefs.<date>/<hh>/chem/pgrb2ap25/
    0.25° global, 3-hourly to 120 h, 00/06/12/18 Z.

That gives surface particulate matter and aerosol optical depth on exactly the
grid the rest of wxgrid uses (1440×721, lon 0→359.75, rolled by grib._normalise
like GFS). It carries no gas-phase species — no CO, NO2 or O3, and no AQI —
because GOCART is an aerosol-only module. Those come from Open-Meteo's keyless
air-quality API (which is itself CAMS global + CAMS Europe) at
`point()`, and optionally as a very coarse grid via `refresh_openmeteo_grid()`;
see that function for the measured rate limits and why it is not the default.

Layout mirrors the rest of the project: a fetch that writes a cache, pure
render functions on top, an API layer (wxgrid.cams_api) that only reads.

    data/cache/cams/<run>/catalog.json     run, source, steps, vars
    data/cache/cams/<run>/s<hhh>.npz       float16 (721, 1440) per variable
    data/cache/cams/<run>/png/<var>-<hhh>.png   rendered on first request
"""
from __future__ import annotations

import argparse
import io
import json
import logging
import shutil
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import requests
from PIL import Image

from wxgrid import render
from wxgrid.config import CACHE_DIR, GRID_LAT_N, GRID_LON_N, GRID_RES

log = logging.getLogger(__name__)

CAMS_DIR = CACHE_DIR / "cams"
KEEP_RUNS = 1                    # one run is ~110 MB of npz; the box is small

NOMADS_CHEM = "https://nomads.ncep.noaa.gov/cgi-bin/filter_gefs_chem_0p25.pl"
NOMADS_UA = "Mozilla/5.0 (wxgrid)"   # NOMADS 403s an empty/curl User-Agent
OPENMETEO_AQ = "https://air-quality-api.open-meteo.com/v1/air-quality"

STEPS = tuple(range(0, 73, 3))   # 3-hourly to +72 h; the run goes to 120 h
RUN_HOURS = (18, 12, 6, 0)

ATTRIBUTION = "NOAA NCEP GEFS-Aerosol (GOCART) via NOMADS"


# ── variables ─────────────────────────────────────────────────────────────
# GEFS-Aer messages are identified by GRIB2 (parameterNumber, constituentType)
# plus, for optical depth, the wavelength band. eccodes has no entry for most
# of them, so shortName decodes as "unknown" and we must match on the numbers.
#
# constituentType (WMO code table 4.230): 62000 total aerosol, 62001 dust dry.
# The run also carries 62006 / 62008 / 62009 / 62010 (the other GOCART species
# — sulphate, sea salt, black and organic carbon, in some order); they are not
# exposed here because the table assignment is not worth guessing at.
TOTAL, DUST = 62000, 62001
PM_FINE, PM_COARSE, AOD = 193, 192, 102   # parameterNumber, category 20/13
AOD_550_NM = 545                          # scaledValueOfFirstWavelength of the 545–565 nm band


@dataclass(frozen=True)
class Part:
    """One GRIB message to pull out of a step file."""
    number: int
    constituent: int
    wavelength: int | None = None


VARS: dict[str, dict] = {
    "pm2_5": {"label": "PM2.5", "units": "µg/m³", "parts": [Part(PM_FINE, TOTAL)],
              "desc": "Surface fine particulate matter, all species"},
    "pm10": {"label": "PM10", "units": "µg/m³", "parts": [Part(PM_FINE, TOTAL), Part(PM_COARSE, TOTAL)],
             "desc": "Surface fine + coarse particulate matter"},
    "dust": {"label": "Dust", "units": "µg/m³", "parts": [Part(PM_FINE, DUST), Part(PM_COARSE, DUST)],
             "desc": "Surface mineral dust, fine + coarse"},
    "aod550": {"label": "Aerosol optical depth", "units": "", "parts": [Part(AOD, TOTAL, AOD_550_NM)],
               "desc": "Column aerosol optical depth at 550 nm"},
}

# Open-Meteo point variables. GEFS-Aer has no gas phase, so CO/NO2/O3 and the
# two AQI scales are point-only; they are served from CAMS via Open-Meteo.
POINT_VARS = ("pm2_5", "pm10", "dust", "aerosol_optical_depth", "carbon_monoxide",
              "nitrogen_dioxide", "ozone", "sulphur_dioxide", "european_aqi", "us_aqi")


# ── colour ramps ──────────────────────────────────────────────────────────
# Local to this module on purpose: wxgrid.render owns the weather ramps and is
# not edited here. Same (value, rgb) stop format so the shapes stay familiar.
# PM breakpoints follow the WHO/EPA-ish bands people already read colours for.
RAMPS: dict[str, dict] = {
    "pm2_5": {"units": "µg/m³", "lo": 0, "hi": 250, "fade": 12.0, "stops": [
        (0, (36, 92, 168)), (12, (60, 170, 140)), (35, (225, 210, 60)),
        (55, (235, 140, 40)), (110, (205, 45, 45)), (180, (150, 30, 110)), (250, (90, 20, 60))]},
    "pm10": {"units": "µg/m³", "lo": 0, "hi": 500, "fade": 30.0, "stops": [
        (0, (36, 92, 168)), (25, (60, 170, 140)), (60, (225, 210, 60)),
        (110, (235, 140, 40)), (220, (205, 45, 45)), (360, (150, 30, 110)), (500, (90, 20, 60))]},
    "dust": {"units": "µg/m³", "lo": 0, "hi": 500, "fade": 12.0, "stops": [
        (0, (60, 48, 36)), (25, (150, 118, 70)), (60, (200, 165, 95)),
        (110, (228, 190, 110)), (220, (240, 145, 60)), (360, (220, 80, 45)), (500, (140, 30, 30))]},
    "aod550": {"units": "AOD", "lo": 0, "hi": 3.0, "fade": 0.3, "stops": [
        (0, (30, 40, 90)), (0.15, (40, 120, 190)), (0.35, (70, 190, 170)), (0.6, (215, 210, 80)),
        (1.0, (235, 140, 45)), (1.8, (205, 50, 50)), (3.0, (120, 20, 80))]},
}
DEFAULT_ALPHA = 0.82


def _root(root: Path | None) -> Path:
    """Resolve the cache root at call time, not at import time — so a test (or
    a caller with its own data dir) can point CAMS_DIR somewhere else and every
    function here follows, including the ones the API layer calls with no
    argument at all."""
    return CAMS_DIR if root is None else root


def _lut(ramp: dict) -> np.ndarray:
    """256×3 uint8 lookup for values linearly binned lo..hi (as render._lut)."""
    xs = np.array([s[0] for s in ramp["stops"]], dtype=np.float64)
    cols = np.array([s[1] for s in ramp["stops"]], dtype=np.float64)
    v = ramp["lo"] + (ramp["hi"] - ramp["lo"]) * np.arange(256) / 255.0
    return np.stack([np.clip(np.interp(v, xs, cols[:, c]), 0, 255) for c in range(3)], axis=1).astype(np.uint8)


_LUTS = {k: _lut(v) for k, v in RAMPS.items()}


def colorize(field: np.ndarray, var: str, alpha: float = DEFAULT_ALPHA) -> bytes:
    """RGBA PNG for a Mercator-projected composition field.

    Every one of these variables is "nothing to see" over most of the globe on
    most days, so unlike the weather layers they all fade to transparent at the
    clean end — a uniform blue wash over the Pacific would just hide the map.
    `fade` is the value at which the layer reaches full opacity, and alpha ramps
    to it linearly: the obvious gamma curve makes background air far too solid
    (median alpha 129/255 over the globe at PM2.5, against 43 linear)."""
    ramp, lut = RAMPS[var], _LUTS[var]
    lo, hi = ramp["lo"], ramp["hi"]
    buf = io.BytesIO()
    if not np.any(np.isfinite(field)):
        Image.new("RGBA", (field.shape[1], field.shape[0]), (0, 0, 0, 0)).save(buf, format="PNG")
        return buf.getvalue()
    x = np.nan_to_num(field, nan=lo, posinf=hi, neginf=lo)
    idx = np.clip((x - lo) / (hi - lo) * 255.0, 0, 255).astype(np.uint8)
    rgba = np.empty((*idx.shape, 4), dtype=np.uint8)
    rgba[..., :3] = lut[idx]
    a = np.clip(x / ramp["fade"], 0.0, 1.0)
    a[~np.isfinite(field)] = 0.0
    rgba[..., 3] = (a * alpha * 255.0).astype(np.uint8)
    Image.fromarray(rgba, "RGBA").save(buf, format="PNG", optimize=False, compress_level=6)
    return buf.getvalue()


def legend(var: str) -> dict:
    ramp = RAMPS[var]
    return {"var": var, "label": VARS[var]["label"], "units": ramp["units"],
            "lo": ramp["lo"], "hi": ramp["hi"],
            "stops": [{"v": v, "rgb": list(rgb)} for v, rgb in ramp["stops"]]}


# ── fetch: NOAA GEFS-Aerosol ──────────────────────────────────────────────

def _session() -> requests.Session:
    s = requests.Session()
    s.headers["User-Agent"] = NOMADS_UA
    return s


def _chem_dir(run: datetime) -> str:
    return f"/gefs.{run:%Y%m%d}/{run:%H}/chem/pgrb2ap25"


def _step_url(run: datetime, step: int) -> str:
    """Filter-CGI URL for one step, subset to the messages we use.

    The CGI ANDs the variable set with the level set, so this pulls PMTF/PMTC
    at the surface plus every AOTK band in the column — 17 messages, ~14 MB,
    of which we keep 5. There is no finer server-side filter for GEFS-chem
    (the .idx files under /pub/data are 403 to non-browser clients), so the
    extra optical-depth wavelengths are unavoidable overhead."""
    from urllib.parse import urlencode
    q = urlencode({
        "dir": _chem_dir(run),
        "file": f"gefs.chem.t{run:%H}z.a2d_0p25.f{step:03d}.grib2",
        "var_PMTF": "on", "var_PMTC": "on", "var_AOTK": "on",
        "lev_surface": "on", "lev_entire_atmosphere": "on",
    })
    return f"{NOMADS_CHEM}?{q}"


def available_steps(run: datetime, session: requests.Session | None = None) -> set[int]:
    """Forecast hours the run has actually published, from the CGI's file list."""
    import re
    s = session or _session()
    r = s.get(NOMADS_CHEM, params={"dir": _chem_dir(run)}, timeout=60)
    if r.status_code != 200:
        return set()
    return {int(m) for m in re.findall(r"a2d_0p25\.f(\d{3})\.grib2\"", r.text)}


def latest_run(now: datetime | None = None, session: requests.Session | None = None,
               need: int = STEPS[-1]) -> datetime | None:
    """Newest GEFS-chem run that has published at least out to `need` hours."""
    now = now or datetime.now(timezone.utc)
    s = session or _session()
    for back in range(0, 2):
        day = (now - timedelta(days=back)).replace(hour=0, minute=0, second=0, microsecond=0)
        for hh in RUN_HOURS:
            run = day.replace(hour=hh)
            if run > now:
                continue
            steps = available_steps(run, s)
            if steps and max(steps) >= need:
                return run
    return None


def _read_grib(path: Path) -> dict[str, np.ndarray]:
    """Extract and combine the configured variables from one step GRIB.

    Uses `grib._normalise` so a composition field lands on the exact same
    (721, 1440) N→S / -180→180 grid as every weather layer — GEFS-chem is
    0.25° with a 0° longitude origin, so that is a roll, not a resample.
    Reaching into the private helper beats re-deriving the normalisation."""
    import eccodes

    from wxgrid.grib import _normalise

    wanted: dict[tuple, list[str]] = {}
    for name, spec in VARS.items():
        for p in spec["parts"]:
            wanted.setdefault((p.number, p.constituent, p.wavelength), []).append(name)

    out: dict[str, np.ndarray] = {}
    with open(path, "rb") as fh:
        while True:
            gid = eccodes.codes_grib_new_from_file(fh)
            if gid is None:
                break
            try:
                key = (int(eccodes.codes_get(gid, "parameterNumber")),
                       int(eccodes.codes_get(gid, "constituentType")),
                       int(eccodes.codes_get(gid, "scaledValueOfFirstWavelength"))
                       if eccodes.codes_is_defined(gid, "scaledValueOfFirstWavelength") else None)
                names = wanted.get(key) or wanted.get((key[0], key[1], None))
                if not names:
                    continue                       # a wavelength band we do not use
                values = np.asarray(eccodes.codes_get_values(gid), dtype=np.float32)
                missing = eccodes.codes_get(gid, "missingValue")
                if missing is not None:
                    values[values == np.float32(missing)] = np.nan
                grid = _normalise(
                    values,
                    float(eccodes.codes_get(gid, "latitudeOfFirstGridPointInDegrees")),
                    float(eccodes.codes_get(gid, "latitudeOfLastGridPointInDegrees")),
                    float(eccodes.codes_get(gid, "longitudeOfFirstGridPointInDegrees")),
                    float(eccodes.codes_get(gid, "iDirectionIncrementInDegrees")),
                    int(eccodes.codes_get(gid, "Nj")), int(eccodes.codes_get(gid, "Ni")),
                    int(eccodes.codes_get(gid, "jScansPositively")) == 1)
                for name in names:
                    out[name] = grid if name not in out else out[name] + grid
            finally:
                eccodes.codes_release(gid)
    return out


# ── cache ─────────────────────────────────────────────────────────────────

def run_id(run: datetime) -> str:
    return run.astimezone(timezone.utc).strftime("%Y-%m-%dT%H")


def run_dir(rid: str, root: Path | None = None) -> Path:
    return _root(root) / rid


def _step_file(rid: str, step: int, root: Path | None = None) -> Path:
    return run_dir(rid, root) / f"s{step:03d}.npz"


def list_runs(root: Path | None = None) -> list[str]:
    """Run ids with a catalog, newest first."""
    root = _root(root)
    if not root.is_dir():
        return []
    return sorted((p.name for p in root.iterdir() if (p / "catalog.json").exists()), reverse=True)


def catalog(root: Path | None = None) -> dict:
    """Catalog of the newest cached run, or an empty one when nothing is cached."""
    runs = list_runs(root)
    if not runs:
        return {"run": None, "runs": [], "vars": [], "steps": [], "source": ATTRIBUTION}
    cat = json.loads((run_dir(runs[0], root) / "catalog.json").read_text())
    cat["runs"] = runs
    return cat


def load_step(rid: str, step: int, root: Path | None = None) -> dict[str, np.ndarray]:
    """One step back as float32 (721, 1440) per variable."""
    path = _step_file(rid, step, root)
    if not path.exists():
        raise FileNotFoundError(f"cams: no cached step {step} for run {rid}")
    with np.load(path) as z:
        return {k: z[k].astype(np.float32) for k in z.files}


def _prune(root: Path | None = None, keep: int = KEEP_RUNS) -> None:
    for rid in list_runs(root)[keep:]:
        shutil.rmtree(run_dir(rid, root), ignore_errors=True)
        log.info("cams: pruned run %s", rid)


def refresh(run: datetime | None = None, steps: tuple[int, ...] = STEPS,
            root: Path | None = None, session: requests.Session | None = None,
            force: bool = False) -> dict:
    """Download, decode and cache a GEFS-Aerosol run, one step at a time.

    Each step's GRIB is deleted as soon as it is decoded, so peak disk is one
    ~14 MB file and peak memory is a handful of 4 MB float32 grids."""
    s = session or _session()
    run = run or latest_run(session=s)
    if run is None:
        raise RuntimeError("cams: no GEFS-Aerosol run available on NOMADS")
    rid = run_id(run)
    d = run_dir(rid, root)
    # Skip only a run that already covers everything asked for. A run cached
    # from a shallower --max-step, or one where some steps 404'd because the
    # run was still publishing, must be topped up rather than declared done.
    if (d / "catalog.json").exists() and not force:
        done = set(json.loads((d / "catalog.json").read_text()).get("steps", []))
        if done >= set(steps):
            log.info("cams: run %s already cached (%d steps)", rid, len(done))
            return catalog(root)
        log.info("cams: run %s cached but missing %d steps, topping up",
                 rid, len(set(steps) - done))
    d.mkdir(parents=True, exist_ok=True)
    tmp = d / "_step.grib2"
    t0 = time.time()
    got: list[int] = []
    grib_bytes = 0
    for step in steps:
        if _step_file(rid, step, root).exists() and not force:
            got.append(step)
            continue
        try:
            with s.get(_step_url(run, step), timeout=180, stream=True) as r:
                r.raise_for_status()
                with open(tmp, "wb") as fh:
                    for chunk in r.iter_content(1 << 20):
                        fh.write(chunk)
        except requests.RequestException as e:
            log.warning("cams: step %d download failed: %s", step, e)
            continue
        grib_bytes += tmp.stat().st_size
        try:
            fields = _read_grib(tmp)
        except Exception as e:                       # a truncated / half-published step
            log.warning("cams: step %d decode failed: %s", step, e)
            tmp.unlink(missing_ok=True)
            continue
        tmp.unlink(missing_ok=True)
        if not fields:
            log.warning("cams: step %d carried none of the wanted messages", step)
            continue
        np.savez_compressed(_step_file(rid, step, root),
                            **{k: v.astype(np.float16) for k, v in fields.items()})
        got.append(step)
        del fields
        log.info("cams: step %03d cached (%d/%d)", step, len(got), len(steps))
    tmp.unlink(missing_ok=True)
    if not got:
        shutil.rmtree(d, ignore_errors=True)
        raise RuntimeError(f"cams: run {rid} produced no usable steps")
    cat = {
        "run": rid, "source": ATTRIBUTION, "model": "gefs-aer", "resolution_deg": GRID_RES,
        "steps": got,
        "vars": {k: {"label": v["label"], "units": v["units"], "desc": v["desc"]}
                 for k, v in VARS.items()},
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "seconds": round(time.time() - t0, 1), "grib_bytes": grib_bytes,
        "cache_bytes": sum(p.stat().st_size for p in d.glob("*.npz")),
        "point_source": "Open-Meteo air-quality (CAMS global + CAMS Europe)",
        "point_vars": list(POINT_VARS),
    }
    (d / "catalog.json").write_text(json.dumps(cat, indent=1))
    _prune(root)
    return cat


# ── render ────────────────────────────────────────────────────────────────

def layer_png(var: str, step: int, rid: str | None = None, root: Path | None = None) -> bytes:
    """Mercator PNG for one variable and step, cached on disk after the first
    request — same deal as the weather layers in wxgrid.api."""
    if var not in VARS:
        raise KeyError(var)
    rid = rid or (list_runs(root) or [None])[0]
    if rid is None:
        raise FileNotFoundError("cams: nothing cached")
    cache = run_dir(rid, root) / "png" / f"{var}-{step:03d}.png"
    if cache.exists():
        return cache.read_bytes()
    field = load_step(rid, step, root)[var]
    png = colorize(render.to_mercator(field), var)
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_bytes(png)
    return png


# ── point query ───────────────────────────────────────────────────────────

def _nearest(lat: float, lon: float) -> tuple[int, int]:
    """Row/column of the common grid nearest a coordinate."""
    row = int(round((90.0 - lat) / GRID_RES))
    col = int(round(((lon + 180.0) % 360.0) / GRID_RES)) % GRID_LON_N
    return min(max(row, 0), GRID_LAT_N - 1), col


def grid_point(lat: float, lon: float, rid: str | None = None, root: Path | None = None) -> dict:
    """Every cached variable at every cached step for the nearest gridpoint."""
    cat = catalog(root)
    rid = rid or cat.get("run")
    if rid is None:
        return {"run": None, "steps": [], "values": {}}
    row, col = _nearest(lat, lon)
    run = datetime.strptime(rid, "%Y-%m-%dT%H").replace(tzinfo=timezone.utc)
    steps, values = [], {k: [] for k in VARS}
    for step in cat.get("steps", []):
        try:
            fields = load_step(rid, step, root)
        except FileNotFoundError:
            continue
        steps.append(step)
        for k in VARS:
            v = fields.get(k)
            values[k].append(None if v is None or not np.isfinite(v[row, col])
                             else round(float(v[row, col]), 3))
    return {"run": rid, "source": ATTRIBUTION, "steps": steps,
            "valid": [(run + timedelta(hours=h)).isoformat(timespec="seconds") for h in steps],
            "lat": round(90.0 - row * GRID_RES, 4),
            "lon": round(((col * GRID_RES - 180.0) + 180.0) % 360.0 - 180.0, 4),
            "values": values}


def openmeteo_point(lat: float, lon: float, days: int = 3,
                    session: requests.Session | None = None) -> dict:
    """CAMS at one coordinate through Open-Meteo — the gas phase and the AQIs
    that GEFS-Aerosol does not model. One weighted API call, no key."""
    s = session or requests
    try:
        r = s.get(OPENMETEO_AQ, params={"latitude": lat, "longitude": lon,
                                        "hourly": ",".join(POINT_VARS),
                                        "forecast_days": days, "timeformat": "unixtime"},
                  timeout=30, headers={"User-Agent": "wxgrid"})
        r.raise_for_status()
        d = r.json()
    except (requests.RequestException, ValueError) as e:
        log.warning("cams: open-meteo point failed: %s", e)
        return {"source": "Open-Meteo air-quality (CAMS)", "error": str(e), "hourly": {}}
    h = d.get("hourly", {})
    return {"source": "Open-Meteo air-quality (CAMS global + CAMS Europe)",
            "lat": d.get("latitude"), "lon": d.get("longitude"),
            "units": d.get("hourly_units", {}),
            "time": h.get("time", []),
            "hourly": {k: h.get(k) for k in POINT_VARS if k in h}}


def point(lat: float, lon: float, root: Path | None = None,
          session: requests.Session | None = None) -> dict:
    """Both halves: the model grid we cache, and the CAMS point feed."""
    return {"lat": lat, "lon": lon,
            "grid": grid_point(lat, lon, root=root),
            "cams": openmeteo_point(lat, lon, session=session)}


# ── optional: coarse global grid from Open-Meteo ──────────────────────────
# Kept for the variables GEFS-Aerosol cannot give (CO and the two AQI scales)
# and NOT run by default, because the free tier makes it expensive and ugly:
#
#   · ~500 coordinates per request is the ceiling — 600+ exceeds the URL
#     length the server accepts (HTTP 414).
#   · Billing is per coordinate, not per request. Measured: two 400-point
#     requests go through back to back in ~1.6 s each, then HTTP 429 for
#     ~40 s. That is a ~600-coordinate-per-minute bucket, against published
#     ceilings of 5 000/hour and 10 000/day.
#   · So a 4° grid (41×90 = 3 690 points) costs ~4.5 minutes of wall clock and
#     37 % of the daily budget for ONE refresh, and 4° is far too coarse to
#     draw as a raster anyway.
#
# Conclusion: gas-phase composition stays a point product. This exists so the
# numbers are reproducible, not because it is a good layer.

def openmeteo_grid_points(res_deg: float = 4.0, lat_max: float = 80.0) -> list[tuple[float, float]]:
    lats = np.arange(-lat_max, lat_max + 1e-9, res_deg)
    lons = np.arange(-180.0, 180.0 - 1e-9, res_deg)
    return [(float(a), float(o)) for a in lats for o in lons]


def refresh_openmeteo_grid(res_deg: float = 4.0, batch: int = 400, days: int = 3,
                           vars_: tuple[str, ...] = ("carbon_monoxide", "european_aqi", "us_aqi"),
                           root: Path | None = None, session: requests.Session | None = None,
                           pause: int = 45) -> dict:
    """Coarse global grid of the gas-phase/AQI variables. Slow by design: it
    backs off `pause` seconds on the 429 that arrives every ~600 coordinates."""
    s = session or requests.Session()
    pts = openmeteo_grid_points(res_deg)
    t0, rows = time.time(), []
    for i in range(0, len(pts), batch):
        chunk = pts[i:i + batch]
        params = {"latitude": ",".join(f"{a:.2f}" for a, _ in chunk),
                  "longitude": ",".join(f"{o:.2f}" for _, o in chunk),
                  "hourly": ",".join(vars_), "forecast_days": days, "timeformat": "unixtime"}
        for attempt in range(5):
            try:
                r = s.get(OPENMETEO_AQ, params=params, timeout=180, headers={"User-Agent": "wxgrid"})
                if r.status_code == 429:
                    time.sleep(pause)
                    continue
                r.raise_for_status()
                rows.extend(r.json())
                break
            except requests.RequestException as e:
                log.warning("cams: open-meteo grid batch %d: %s", i // batch, e)
                time.sleep(pause)
        log.info("cams: open-meteo grid %d/%d points", min(i + batch, len(pts)), len(pts))
    out = run_dir("openmeteo", root)
    out.mkdir(parents=True, exist_ok=True)
    path = out / f"grid{res_deg:g}deg.json"
    payload = {"res_deg": res_deg, "vars": list(vars_), "points": len(pts), "returned": len(rows),
               "seconds": round(time.time() - t0, 1),
               "source": "Open-Meteo air-quality (CAMS)", "locations": rows}
    path.write_text(json.dumps(payload, separators=(",", ":")))
    payload.pop("locations")
    payload["bytes"] = path.stat().st_size
    return payload


# ── CLI ───────────────────────────────────────────────────────────────────

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m wxgrid.cams",
                                 description="Global air-quality layers (NOAA GEFS-Aerosol).")
    ap.add_argument("--refresh", action="store_true", help="fetch and cache the latest run")
    ap.add_argument("--force", action="store_true", help="re-fetch a run that is already cached")
    ap.add_argument("--run", help="run id to fetch, e.g. 2026-08-18T00 (default: latest)")
    ap.add_argument("--max-step", type=int, default=STEPS[-1], help="last forecast hour (default 72)")
    ap.add_argument("--openmeteo-grid", type=float, metavar="DEG",
                    help="also build the coarse CO/AQI grid at this resolution (slow, rate-limited)")
    ap.add_argument("--catalog", action="store_true", help="print the cached catalog and exit")
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if a.catalog:
        print(json.dumps(catalog(), indent=1))
        return 0
    if not a.refresh and a.openmeteo_grid is None:
        ap.print_help()
        return 2
    if a.refresh:
        run = (datetime.strptime(a.run, "%Y-%m-%dT%H").replace(tzinfo=timezone.utc) if a.run else None)
        cat = refresh(run=run, steps=tuple(h for h in STEPS if h <= a.max_step), force=a.force)
        print(json.dumps({k: v for k, v in cat.items() if k != "vars"}, indent=1))
    if a.openmeteo_grid is not None:
        print(json.dumps(refresh_openmeteo_grid(res_deg=a.openmeteo_grid), indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
