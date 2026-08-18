"""Forecast uncertainty at a point.

A deterministic run tells you what one integration of the atmosphere did. An
ensemble tells you how much that integration should be believed, which is the
only part a decision actually turns on. This module turns what the open
ensembles publish into a plume at a point: a median line with p10–p90 and
p25–p75 bands.

Two bases are possible and they are not equally cheap:

  "members"              the real member spaghetti, percentiles taken across
                         members. Truthful about skew (precipitation is not
                         Gaussian) but needs one global GRIB message per
                         member per step.
  "gaussian-from-spread" mean ± z·σ from a stored ensemble standard deviation.
                         One extra field per step, no per-request fetching,
                         and wrong in the tails whenever the distribution is
                         skewed. Every response says which one it used.

Only the second ships. The measurement behind that, taken 2026-08-18 against
ECMWF open data (see AIFS_ENS_COST): pulling ONE surface parameter for all 50
AIFS-ENS perturbed members at ONE step is 30.8 MB and 25.5 s over byte-range
requests, because a GRIB message is a compressed global field with no spatial
random access. A 62-step plume for a single variable is therefore ~1.9 GB and
~26 minutes for ONE point — roughly 10× the byte budget and 25× the time
budget for an on-demand endpoint. The alternatives were checked and closed
too: ECMWF open data publishes no ensemble-spread field for aifs-ens or ifs
(the enfo stream carries cf, pf, and an `ep` probability product that exists
only at 240 h and 360 h); NOMADS retired OPeNDAP in 2025 (SCN 25-81), so
there is no server-side subsetting along the member dimension any more; and
the NOMADS filter CGI's `subregion` is byte-cheap (~1.0 KB per member-step)
but needs ~1230 requests for a 30-member 6-hourly plume, which is ten minutes
at their published 120-hits-per-minute limit.

So the shipped path reads GEFS' `gespr` fields, which the ingest already
stores as `t2m_sd` / `wind_sd` / `msl_sd` / `tp6_sd` on the ordinary `gefs`
run. Point reads hit the same Zarr point cube as everything else.
"""
from __future__ import annotations

import logging
import math
from datetime import timedelta
from pathlib import Path

import numpy as np

from wxgrid.config import CACHE_DIR, STORE_DIR
from wxgrid.models import MODELS
from wxgrid.store import RunReader, list_runs, parse_run_id

log = logging.getLogger("wxgrid.ens")

# Measured 2026-08-18 against https://data.ecmwf.int/forecasts/, run 20260818 00z,
# aifs-ens/0p25/enfo, 2 m temperature at step 24, all 50 perturbed members
# pulled by byte range off the .index sidecar.
AIFS_ENS_COST = {
    "members": 50,
    "steps_in_run": 62,                # 0, 2, then 6-hourly to 360 h
    "mb_per_param_per_step": 30.8,
    "seconds_per_param_per_step": 25.5,
    "measured": "2026-08-18",
    "verdict": "unaffordable: ~1.9 GB and ~26 min for one variable at one point",
}
BUDGET_MB, BUDGET_S = 200.0, 60.0      # per point, from the brief


def aifs_ens_affordable() -> bool:
    """Would a full single-variable plume fit the per-point budget? It does not,
    and this is the arithmetic rather than an opinion, so the API can say why."""
    c = AIFS_ENS_COST
    return (c["mb_per_param_per_step"] * c["steps_in_run"] <= BUDGET_MB
            and c["seconds_per_param_per_step"] * c["steps_in_run"] <= BUDGET_S)


# ── what the store carries ────────────────────────────────────────────────
# `kind` names the WX.units method the front end should convert with; `unit`
# is the STORE unit, the same convention /api/point uses.
SPREAD_VARS: dict[str, dict] = {
    "t2m_sd": {"mean": "t2m", "kind": "temp", "unit": "K", "label": "2 m temperature", "floor": None},
    "wind_sd": {"mean": "wind", "kind": "speed", "unit": "m/s", "label": "10 m wind", "floor": 0.0},
    "msl_sd": {"mean": "msl", "kind": "press", "unit": "Pa", "label": "Mean sea-level pressure", "floor": None},
    "tp6_sd": {"mean": "tp6", "kind": "precip", "unit": "mm", "label": "Precipitation", "floor": 0.0},
}
# The plume takes either name: "t2m" (what the user picked on the map) or
# "t2m_sd" (what the store calls it).
_BY_MEAN = {v["mean"]: k for k, v in SPREAD_VARS.items()}

# Standard-normal quantiles. Hard-coded rather than pulled from scipy: four
# constants are not worth a dependency, and they will not change.
Z = {"p10": -1.2815515655446004, "p25": -0.6744897501960817, "p50": 0.0,
     "p75": 0.6744897501960817, "p90": 1.2815515655446004}

CALM_MS = 2.0      # below this the wind direction is not meaningful; see below

CACHE_TTL = 1800.0     # a run does not change under us; this is just tap-spam relief
_cache = None


def cache():
    """The same TTL-plus-disk cache wxgrid.ext uses for its proxies, built on
    first use. Lazy because the ingest imports this module for
    `wind_speed_spread` alone and has no business reading a cache file."""
    global _cache
    if _cache is None:
        from wxgrid.ext import _Cache
        _cache = _Cache(Path(CACHE_DIR) / "ens.json")
    return _cache


# ── spread arithmetic (pure; everything here is unit-tested) ──────────────

def wind_speed_spread(u: np.ndarray | None, v: np.ndarray | None,
                      su: np.ndarray, sv: np.ndarray) -> np.ndarray:
    """Spread of 10 m wind SPEED from the spreads of its two components.

    NOMADS publishes gespr for UGRD and VGRD, never for wind speed, and
    √(σu² + σv²) is the spread of the wind VECTOR — it counts disagreement
    about direction as disagreement about speed, which over-widens a speed
    plume whenever the members swing the wind around without changing how hard
    it blows. First-order (delta-method) propagation projects the component
    spreads onto the mean wind direction instead:

        σ_S ≈ √( (ū²σu² + v̄²σv²) / (ū² + v̄²) )

    That projection degenerates in calm air, where the direction is undefined
    and it would collapse to zero — claiming a certainty the ensemble does not
    have. So below CALM_MS the vector spread is used, and the two are blended
    linearly across it rather than switched, which would put a seam in the
    field. With no mean wind available at all (the mean file for that step did
    not land), the vector spread is returned: wider, never falsely confident.
    """
    su = np.asarray(su, dtype=np.float32)
    sv = np.asarray(sv, dtype=np.float32)
    vector = np.hypot(su, sv)
    if u is None or v is None:
        return vector
    u = np.asarray(u, dtype=np.float32)
    v = np.asarray(v, dtype=np.float32)
    spd2 = u * u + v * v
    with np.errstate(invalid="ignore", divide="ignore"):
        along = np.sqrt((u * u * su * su + v * v * sv * sv) / np.where(spd2 > 0, spd2, np.nan))
    along = np.where(np.isfinite(along), along, vector)
    w = np.clip(np.sqrt(spd2) / CALM_MS, 0.0, 1.0)
    return (w * along + (1.0 - w) * vector).astype(np.float32)


def gaussian_band(mean: np.ndarray, sd: np.ndarray, floor: float | None = None) -> dict[str, np.ndarray]:
    """Percentiles of a normal with this mean and this standard deviation.

    `floor` clips the low side for quantities that cannot go negative (rain,
    wind speed). That clipping is exactly where the Gaussian assumption shows:
    a precipitation ensemble is zero-inflated and right-skewed, so the real
    p10 is usually 0 while mean − 1.28σ is a negative number we then clamp.
    The API says so in `note`; do not read the low precipitation percentiles
    as anything but "some members are dry".
    """
    mean = np.asarray(mean, dtype=np.float64)
    sd = np.abs(np.asarray(sd, dtype=np.float64))
    out = {}
    for name, z in Z.items():
        band = mean + z * sd
        out[name] = np.clip(band, floor, None) if floor is not None else band
    return out


def percentiles_from_members(members: np.ndarray) -> dict[str, np.ndarray]:
    """Percentiles taken ACROSS members, shape (n_members, n_steps) → (n_steps,).

    Unused by any shipped route — the member fetch is unaffordable (see the
    module docstring) — but the plume assembler branches on basis, so the
    honest branch exists and is tested rather than being a TODO.
    """
    members = np.asarray(members, dtype=np.float64)
    qs = [10.0, 25.0, 50.0, 75.0, 90.0]
    vals = np.nanpercentile(members, qs, axis=0)
    return {f"p{int(q)}": vals[i] for i, q in enumerate(qs)}


def _finite(a) -> list:
    """numpy → JSON: NaN becomes null, everything else a plain float."""
    return [None if not np.isfinite(x) else round(float(x), 4) for x in np.asarray(a, dtype=np.float64)]


# ── reading a run ─────────────────────────────────────────────────────────

def _reader(model: str, run: str, root: Path = STORE_DIR) -> RunReader:
    """Own reader rather than borrowing api.py's: api.py imports this module's
    router at the bottom of its own file, so importing back out of it would be
    a circular import waiting for someone to reorder two lines."""
    if model not in MODELS:
        raise LookupError(f"unknown model {model}")
    if run in ("latest", "", None):
        runs = list_runs(model, root)
        if not runs:
            raise LookupError(f"no runs for {model}")
        run = runs[0]
    return RunReader(model, run, root)


def spread_vars_in(reader: RunReader) -> list[str]:
    """The `_sd` variables this run actually delivered."""
    return [v for v in SPREAD_VARS if v in reader.variables]


def models_with_spread(root: Path = STORE_DIR) -> dict[str, list[str]]:
    """{model: [sd vars]} across the latest run of each model — what the front
    end needs to decide whether to offer an uncertainty view at all."""
    out = {}
    for key in MODELS:
        try:
            r = _reader(key, "latest", root)
        except (LookupError, FileNotFoundError):
            continue
        got = spread_vars_in(r)
        if got:
            out[key] = got
    return out


def _snap(lat: float, lon: float) -> tuple[float, float]:
    """Round to the store grid so neighbouring taps share a cache entry."""
    return round(lat * 4) / 4, round(lon * 4) / 4


def _accum_window_h(reader: RunReader, step: int) -> int:
    """Hours the producer's accumulation bucket covers at this step.

    GEFS APCP restarts its bucket every 6 h and publishes a partial at the
    intermediate 3 h step: f003 is 0–3, f006 is 0–6, f009 is 6–9, f012 is
    6–12. The spread is published on that bucket, so the plume has to say
    which window it is describing — it is NOT the same window as the stored
    `tp6` increment at the 6-hourly steps.
    """
    if step == 0:
        return 0
    return 6 if step % 6 == 0 else step % 6


def spread_point(model: str, run: str = "latest", lat: float = 0.0, lon: float = 0.0,
                 root: Path = STORE_DIR) -> dict:
    """Every stored `_sd` series at a point, with the mean beside it."""
    r = _reader(model, run, root)
    t0 = parse_run_id(r.rid)
    got = spread_vars_in(r)
    if not got:
        raise LookupError(f"{model}/{r.rid} carries no ensemble spread")
    series = {}
    for sd_var in got:
        spec = SPREAD_VARS[sd_var]
        series[sd_var] = {
            "sd": _finite(r.point(sd_var, lat, lon)),
            "mean": _finite(_mean_series(r, spec["mean"], lat, lon)),
            "unit": spec["unit"], "kind": spec["kind"], "label": spec["label"],
        }
    return {"model": model, "run": r.rid, "lat": lat, "lon": lon,
            "steps": r.steps, "valid": [(t0 + timedelta(hours=h)).isoformat() for h in r.steps],
            "vars": series, "source": r.attrs.get("attribution", "")}


def _mean_series(r: RunReader, mean_var: str, lat: float, lon: float) -> np.ndarray:
    """The deterministic centre a spread describes. `wind` is not a stored
    variable — it is the speed of the stored components."""
    if mean_var == "wind":
        u = r.point("u10", lat, lon)
        v = r.point("v10", lat, lon)
        return np.hypot(u, v)
    if mean_var not in r.variables:
        return np.full(len(r.steps), np.nan, dtype=np.float32)
    return r.point(mean_var, lat, lon)


# ── the plume ─────────────────────────────────────────────────────────────

def plume(model: str = "gefs", run: str = "latest", lat: float = 0.0, lon: float = 0.0,
          var: str = "t2m", root: Path = STORE_DIR) -> dict:
    """Percentile fan for one variable at one point.

    `var` takes either the map's name for the field (`t2m`, `wind`, `msl`,
    `tp6`) or the store's name for its spread (`t2m_sd`, …).
    """
    sd_var = var if var in SPREAD_VARS else _BY_MEAN.get(var)
    if sd_var is None:
        raise LookupError(f"no uncertainty for {var!r}; have {sorted(_BY_MEAN)}")
    spec = SPREAD_VARS[sd_var]
    lat_s, lon_s = _snap(lat, lon)
    key = f"plume:{model}:{run}:{sd_var}:{lat_s}:{lon_s}"

    def build() -> dict:
        r = _reader(model, run, root)
        if sd_var not in r.variables:
            raise LookupError(f"{model}/{r.rid} has no {sd_var}")
        t0 = parse_run_id(r.rid)
        mean = np.asarray(_mean_series(r, spec["mean"], lat_s, lon_s), dtype=np.float64)
        sd = np.asarray(r.point(sd_var, lat_s, lon_s), dtype=np.float64)
        bands = gaussian_band(mean, sd, spec["floor"])
        note = ("Bands are mean ± z·σ from the ensemble standard deviation, not from the members "
                "themselves — symmetric by construction.")
        if spec["kind"] == "precip":
            note += (" Precipitation is right-skewed and zero-inflated, so the low percentiles are "
                     "clipped at zero and read as 'some members are dry', not as an amount. Each "
                     "step's σ describes the producer's own accumulation bucket (see window_h).")
        out = {
            "model": model, "run": r.rid, "lat": lat_s, "lon": lon_s,
            "var": spec["mean"], "sd_var": sd_var, "label": spec["label"],
            "unit": spec["unit"], "kind": spec["kind"],
            "steps": r.steps,
            "valid": [(t0 + timedelta(hours=h)).isoformat() for h in r.steps],
            "members": None,
            "mean": _finite(mean),
            "sd": _finite(sd),
            "basis": "gaussian-from-spread",
            "source": r.attrs.get("attribution", "") or f"{model} ensemble spread",
            "note": note,
        }
        out.update({name: _finite(vals) for name, vals in bands.items()})
        if spec["kind"] == "precip":
            out["window_h"] = [_accum_window_h(r, h) for h in r.steps]
        return out

    return cache().get(key, CACHE_TTL, build)


def plume_from_members(members: np.ndarray, steps: list[int], t0, label: str = "",
                       unit: str = "", kind: str = "") -> dict:
    """The other basis, for when a member source is ever cheap enough to ship.

    Kept because the shape of a members-backed response is part of the API
    contract — the front end draws thin member lines when `members` is not
    null — and because a contract with no implementation rots.
    """
    members = np.asarray(members, dtype=np.float64)
    bands = percentiles_from_members(members)
    out = {"steps": list(steps), "valid": [(t0 + timedelta(hours=h)).isoformat() for h in steps],
           "members": [_finite(m) for m in members],
           "mean": _finite(np.nanmean(members, axis=0)),
           "sd": _finite(np.nanstd(members, axis=0, ddof=1)),
           "basis": "members", "label": label, "unit": unit, "kind": kind,
           "note": "Percentiles taken across members; no distributional assumption."}
    out.update({name: _finite(vals) for name, vals in bands.items()})
    return out


def member_sources(model: str) -> list[str]:
    """Which member streams this deployment can actually serve. Empty, and the
    module docstring carries the measurements that make it empty."""
    return []


def cost_report() -> dict:
    """What the affordability call was, in numbers, for /api/ens/sources."""
    c = AIFS_ENS_COST
    return {
        "aifs_ens": {
            **c,
            "mb_per_plume": round(c["mb_per_param_per_step"] * c["steps_in_run"], 1),
            "seconds_per_plume": round(c["seconds_per_param_per_step"] * c["steps_in_run"]),
            "budget_mb": BUDGET_MB, "budget_seconds": BUDGET_S,
            "affordable": aifs_ens_affordable(),
        },
        "shipped": "gaussian-from-spread, GEFS gespr",
    }


def sd_to_band_label(sd: float, kind: str) -> str:
    """'±1.3 K' style summary for a legend. Trivial, but every caller was
    about to write it slightly differently."""
    if sd is None or not math.isfinite(sd):
        return "—"
    unit = {"temp": "K", "press": "Pa", "precip": "mm", "speed": "m/s"}.get(kind, "")
    return f"±{sd:.1f} {unit}".strip()
