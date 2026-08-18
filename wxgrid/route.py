"""Route forecast: the weather you actually meet, not the weather at a point.

A point forecast answers "what is it like there, later". A route forecast
answers "what will it be like where I am, when I am there" — you walk the path
forward in time, and at every sample you read the run at the step you would
arrive on. Windy sells this; the maths is a haversine and a linear
interpolation.

    plan(path, depart, speed_kmh=…)   → samples: position, distance, ETA
    forecast(reader, samples, …)      → weather at each sample's valid time

`plan` is pure geometry, `forecast` is pure store reads — neither touches the
network, so both are testable with a stubbed reader. The alerts crossing takes
an already-fetched FeatureCollection (wxgrid.ext.alerts_layer()); route_api
does the fetching.

Conventions follow /api/point: SI in, SI out (K, m/s, Pa, mm), None for
missing, the same `_clean` / `_wind_pair` / `_freezing_level` helpers.
"""
from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from wxgrid.api import _clean, _fill_gaps, _freezing_level, _levels_for, _wind_pair, _wrap_lon
from wxgrid.config import GRID_LON_N, GRID_RES
from wxgrid.ext import _bbox_hit, _in_geom
from wxgrid.store import RunReader, parse_run_id

log = logging.getLogger("wxgrid.route")

EARTH_R_KM = 6371.0088
# Surface variables a route sample wants. A model that lacks one simply
# reports None for it (gust and cape are not universal).
SURFACE_VARS = ("t2m", "d2m", "u10", "v10", "gust", "tp6", "sf6", "tcc", "msl", "cape")

# Hazard thresholds, all overridable per request.
THRESHOLDS = {
    "gust_ms": 17.0,        # Beaufort 8 starts at 17.2 m/s — the "both hands" line
    "precip_mm_h": 4.0,     # heavy rain
    "snow_mm_h": 1.0,       # water-equivalent; ≈1 cm/h of fresh snow
    "vis_km": 1.0,
    "freezing_margin_m": 0.0,   # freezing level at or below (ground + margin) is a hazard
}
MAX_SAMPLES = 240
MAX_PATH_POINTS = 500


# ── geometry ──────────────────────────────────────────────────────────────

def haversine_km(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    p = math.pi / 180.0
    a = (0.5 - math.cos((lat2 - lat1) * p) / 2
         + math.cos(lat1 * p) * math.cos(lat2 * p) * (1 - math.cos((lon2 - lon1) * p)) / 2)
    return 2 * EARTH_R_KM * math.asin(math.sqrt(max(0.0, min(1.0, a))))


def _gc_interp(a: tuple[float, float], b: tuple[float, float], f: float) -> tuple[float, float]:
    """Point at fraction `f` along the great circle from a to b (lon, lat)."""
    lon1, lat1 = math.radians(a[0]), math.radians(a[1])
    lon2, lat2 = math.radians(b[0]), math.radians(b[1])
    d = 2 * math.asin(math.sqrt(max(0.0, math.sin((lat2 - lat1) / 2) ** 2
                                    + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2)))
    if d < 1e-12:
        return (a[0], a[1])
    ca, cb = math.sin((1 - f) * d) / math.sin(d), math.sin(f * d) / math.sin(d)
    x = ca * math.cos(lat1) * math.cos(lon1) + cb * math.cos(lat2) * math.cos(lon2)
    y = ca * math.cos(lat1) * math.sin(lon1) + cb * math.cos(lat2) * math.sin(lon2)
    z = ca * math.sin(lat1) + cb * math.sin(lat2)
    return (math.degrees(math.atan2(y, x)), math.degrees(math.atan2(z, math.hypot(x, y))))


@dataclass
class Sample:
    """One place on the route, and when you are there."""
    lon: float
    lat: float
    dist_km: float          # along-path distance from the start
    hours: float            # hours after departure
    eta: datetime
    leg_h: float = 0.0      # time this sample stands for (for accumulating precip)
    elev_m: float | None = None
    wx: dict = field(default_factory=dict)


def path_length_km(path: list[tuple[float, float]]) -> tuple[float, list[float]]:
    """Total great-circle length and the cumulative distance at each vertex."""
    cum = [0.0]
    for (x1, y1), (x2, y2) in zip(path, path[1:]):
        cum.append(cum[-1] + haversine_km(x1, y1, x2, y2))
    return cum[-1], cum


def plan(path: list[tuple[float, float]], depart: datetime, *,
         speed_kmh: float | None = None, legs_h: list[float] | None = None,
         samples: int | None = None, every_km: float | None = None) -> list[Sample]:
    """Resample a polyline into timed samples.

    Timing comes from `speed_kmh` (constant) or `legs_h` (one duration per
    segment, so a client that already has a routing engine's leg times can
    hand them over). Sample spacing defaults to one every 30 minutes of
    travel, which is what makes "the weather when I am there" legible on a
    strip chart without hammering the store.
    """
    path = [(float(_wrap_lon(x)), float(y)) for x, y in path][:MAX_PATH_POINTS]
    if len(path) < 2:
        raise ValueError("a route needs at least two points")
    total, cum = path_length_km(path)
    if total <= 0:
        raise ValueError("route has zero length")

    if legs_h is not None:
        if len(legs_h) != len(path) - 1:
            raise ValueError(f"legs must have one duration per segment ({len(path) - 1})")
        if any(h < 0 for h in legs_h):
            raise ValueError("leg durations must be positive")
        tcum = [0.0]
        for h in legs_h:
            tcum.append(tcum[-1] + float(h))
        duration = tcum[-1]
    else:
        if not speed_kmh or speed_kmh <= 0:
            raise ValueError("speed_kmh must be positive")
        duration = total / float(speed_kmh)
        tcum = [d / float(speed_kmh) for d in cum]
    if duration <= 0:
        raise ValueError("route has zero duration")

    if every_km and every_km > 0:
        n = int(total // every_km) + 1
        ds = [min(k * every_km, total) for k in range(n)]
        if ds[-1] < total - 1e-6:
            ds.append(total)
    else:
        n = samples if samples else round(duration * 2) + 1     # a sample every 30 min
        n = max(2, min(MAX_SAMPLES, int(n)))
        ds = [total * k / (n - 1) for k in range(n)]

    out: list[Sample] = []
    seg = 0
    for d in ds:
        while seg < len(cum) - 2 and d > cum[seg + 1]:
            seg += 1
        span = cum[seg + 1] - cum[seg]
        f = 0.0 if span <= 0 else min(1.0, max(0.0, (d - cum[seg]) / span))
        lon, lat = _gc_interp(path[seg], path[seg + 1], f)
        hours = tcum[seg] + (tcum[seg + 1] - tcum[seg]) * f
        out.append(Sample(lon=round(lon, 4), lat=round(lat, 4), dist_km=round(d, 2),
                          hours=round(hours, 4), eta=depart + timedelta(hours=hours)))
    # Each sample stands for the half-interval either side of it — that is the
    # weight its precipitation rate gets in the route total.
    for k, s in enumerate(out):
        prev = out[k - 1].hours if k else out[0].hours
        nxt = out[k + 1].hours if k + 1 < len(out) else out[-1].hours
        s.leg_h = round((nxt - prev) / 2 if 0 < k < len(out) - 1 else (nxt - prev), 4)
    return out


# ── derived weather ───────────────────────────────────────────────────────

def visibility_km(rh_pct: float | None, rate_mm_h: float | None, ptype: str | None) -> float | None:
    """A visibility PROXY, not a model field — none of the free global models
    publish visibility. Two power laws, whichever is worse:

      humidity  Vis = -5.19e-10·RH^5.44 + 40.10 km   (Gultepe et al. 2006 fit;
                ≈0.7 km at RH 100 %, ≈18 km at 90 %)
      precip    rain  Vis = 1.5·R^-0.63 km, snow Vis = 0.62·S^-0.74 km
                (Atlas/Rasmussen-type fits, R and S in mm/h; snow kills
                visibility far faster than rain at the same water rate)

    Good enough to colour a strip chart "you will not see much here". Not an
    aviation figure — no fog physics, no orography, no aerosol.
    """
    vals = []
    if rh_pct is not None:
        vals.append(max(0.05, min(40.0, -5.19e-10 * (max(0.0, rh_pct) ** 5.44) + 40.10)))
    if rate_mm_h and rate_mm_h > 0.02:
        if ptype == "snow":
            vals.append(max(0.02, 0.62 * rate_mm_h ** -0.74))
        elif ptype == "mixed":
            vals.append(max(0.03, 1.0 * rate_mm_h ** -0.68))
        else:
            vals.append(max(0.05, 1.5 * rate_mm_h ** -0.63))
    return None if not vals else round(min(vals), 2)


def precip_type(rate_mm_h: float | None, snow_mm_h: float | None, t2m_k: float | None,
                frz_m: float | None, elev_m: float | None) -> str | None:
    """snow / mixed / rain / None. Prefers the model's own snowfall split when
    the run carries sf6; otherwise falls back to surface temperature and the
    height of the freezing level above the ground."""
    if not rate_mm_h or rate_mm_h <= 0.02:
        return None
    if snow_mm_h is not None:
        frac = snow_mm_h / rate_mm_h if rate_mm_h else 0.0
        if frac >= 0.7:
            return "snow"
        if frac >= 0.15:
            return "mixed"
        return "rain"
    t_c = None if t2m_k is None else t2m_k - 273.15
    above = None if (frz_m is None or elev_m is None) else frz_m - elev_m
    if (t_c is not None and t_c <= 0.5) or (above is not None and above <= 100):
        return "snow"
    if (t_c is not None and t_c <= 2.0) or (above is not None and above <= 300):
        return "mixed"
    return "rain"


def hazards(wx: dict, elev_m: float | None, thr: dict) -> tuple[int, list[str]]:
    """Per-sample hazard flags and a 0/1/2 severity. Deliberately blunt: the
    strip chart wants "is this stretch bad", not a probability."""
    flags: list[str] = []
    level = 0
    gust = wx.get("gust") if wx.get("gust") is not None else wx.get("wind")
    if gust is not None and gust >= thr["gust_ms"]:
        flags.append("gust")
        level = max(level, 2 if gust >= thr["gust_ms"] * 1.4 else 1)
    rate = wx.get("precip_mm_h")
    ptype = wx.get("ptype")
    if rate and rate >= thr["precip_mm_h"]:
        flags.append("rain" if ptype != "snow" else "snow")
        level = max(level, 2 if rate >= thr["precip_mm_h"] * 2 else 1)
    snow_rate = wx.get("snow_mm_h")
    if ptype in ("snow", "mixed") and (snow_rate or rate or 0) > 0.05:
        if "snow" not in flags:
            flags.append("snow")
        level = max(level, 2 if (snow_rate or 0) >= thr["snow_mm_h"] else 1)
    frz, t2m = wx.get("freezing_level_m"), wx.get("t2m")
    if frz is not None and elev_m is not None and frz <= elev_m + thr["freezing_margin_m"]:
        flags.append("freezing")
        level = max(level, 2 if (rate or 0) > 0.05 else 1)
    # Freezing rain: liquid aloft falling into a sub-zero surface.
    if (rate or 0) > 0.05 and ptype in ("rain", "mixed") and t2m is not None and t2m <= 273.65:
        flags.append("ice")
        level = 2
    vis = wx.get("vis_km")
    if vis is not None and vis <= thr["vis_km"]:
        flags.append("vis")
        level = max(level, 2 if vis <= thr["vis_km"] * 0.4 else 1)
    return level, flags


# ── store reads ───────────────────────────────────────────────────────────

def _grid_key(lat: float, lon: float) -> tuple[int, int]:
    """The gridpoint a lat/lon lands on — samples that share one only read once."""
    i = int(round((90.0 - lat) / GRID_RES))
    j = int(round((lon + 180.0) / GRID_RES)) % GRID_LON_N
    return (min(max(i, 0), 720), j)


def _series(reader: RunReader, lat: float, lon: float, levels: list[int]) -> dict:
    """Every series a route sample needs at one gridpoint, plus the derived
    freezing level. Mirrors /api/point's handling: aloft variables live on 6 h
    steps and get gap-filled so they read at every step."""
    n = len(reader.steps)
    want = list(SURFACE_VARS) + [f"{p}_{l}" for l in levels for p in ("t", "gh")]
    out = {v: _clean(reader.point(v, lat, lon)) for v in want if v in reader.variables}
    for var in list(out):
        if "_" in var and var.split("_")[0] in ("t", "gh"):
            out[var] = _fill_gaps(out[var])
    out["freezing_level_m"] = _freezing_level(out, levels, n) if levels else [None] * n
    if "u10" in out and "v10" in out:
        out["wind"], out["wdir"] = _wind_pair(out["u10"], out["v10"])
    return out


def _lerp_at(steps: list[int], vals: list, k: int, h: float):
    """Linear interpolation of a per-step series at forecast hour `h`, given
    that `steps[k] <= h <= steps[k+1]` (the caller walks k forward)."""
    if not vals:
        return None
    if k >= len(steps) - 1:
        return vals[-1]
    a, b = vals[k], vals[k + 1]
    if a is None:
        return b
    if b is None:
        return a
    span = steps[k + 1] - steps[k]
    f = 0.0 if span <= 0 else (h - steps[k]) / span
    return a + (b - a) * f


def _bucket_at(steps: list[int], vals: list, h: float) -> tuple[float | None, float]:
    """An accumulation bucket covering forecast hour `h`, as (mm, window_h).

    tp6/sf6 hold the amount since the PREVIOUS STORED STEP (3 h or 6 h
    depending on the model — see ingest), so the bucket you are driving
    through is the first stored step at or after your ETA, and its window is
    that step's own gap.
    """
    if not vals:
        return None, 0.0
    for k in range(1, len(steps)):
        if steps[k] >= h:
            return vals[k], float(steps[k] - steps[k - 1])
    return None, 0.0


def forecast(reader: RunReader, samples: list[Sample], *, elevs: list | None = None,
             thresholds: dict | None = None, alerts: dict | None = None) -> dict:
    """Read the run at every sample's own valid time. Returns the API payload."""
    thr = {**THRESHOLDS, **(thresholds or {})}
    t0 = parse_run_id(reader.rid)
    steps = reader.steps
    levels = _levels_for(reader)
    cache: dict[tuple[int, int], dict] = {}
    if elevs is not None and len(elevs) != len(samples):
        elevs = None

    k = 0                       # walks forward through the run's steps, never back
    n_outside = 0
    out_samples = []
    for idx, s in enumerate(samples):
        if elevs is not None:
            s.elev_m = None if elevs[idx] is None else round(float(elevs[idx]), 1)
        h = (s.eta - t0).total_seconds() / 3600.0
        # The run cannot answer for a time it does not cover; say so rather
        # than silently clamping to the last step and pretending.
        outside = not (steps[0] - 1e-6 <= h <= steps[-1] + 1e-6)
        hc = min(max(h, steps[0]), steps[-1])
        while k < len(steps) - 2 and hc > steps[k + 1]:
            k += 1
        key = _grid_key(s.lat, s.lon)
        ser = cache.get(key)
        if ser is None:
            ser = cache[key] = _series(reader, s.lat, s.lon, levels)

        def at(var, _s=steps, _ser=ser, _k=k, _h=hc):
            return _lerp_at(_s, _ser.get(var, []), _k, _h)

        tp, window = _bucket_at(steps, ser.get("tp6", []), hc)
        sf, _ = _bucket_at(steps, ser.get("sf6", []), hc)
        rate = None if (tp is None or window <= 0) else round(tp / window, 3)
        snow_rate = None if (sf is None or window <= 0) else round(sf / window, 3)
        t2m, d2m, gust, tcc = at("t2m"), at("d2m"), at("gust"), at("tcc")
        msl, cape, frz = at("msl"), at("cape"), at("freezing_level_m")
        rh = None
        if t2m is not None and d2m is not None:
            a_, b_ = 17.625, 243.04
            tc, dc = t2m - 273.15, d2m - 273.15
            rh = round(min(100.0, max(0.0, 100.0 * math.exp(a_ * dc / (b_ + dc) - a_ * tc / (b_ + tc)))), 1)
        # Direction is circular — interpolate the components, not the bearing,
        # or 350° and 10° average to 180° and the arrow points backwards.
        u, v = at("u10"), at("v10")
        wind = wdir = None
        if u is not None and v is not None:
            spd, dirs = _wind_pair([u], [v])
            wind, wdir = spd[0], dirs[0]
        ptype = precip_type(rate, snow_rate, t2m, frz, s.elev_m)
        wx = {
            "t2m": None if t2m is None else round(t2m, 2),
            "wind": wind, "wdir": None if wdir is None else int(wdir),
            "gust": None if gust is None else round(gust, 2),
            "precip_mm_h": rate, "snow_mm_h": snow_rate,
            "precip_bucket_mm": None if tp is None else round(tp, 2),
            "bucket_h": window or None,
            "ptype": ptype,
            "cloud": None if tcc is None else round(tcc, 3),
            "rh": rh,
            "msl": None if msl is None else round(msl, 1),
            "cape": None if cape is None else round(cape, 1),
            "freezing_level_m": None if frz is None else round(frz),
            "vis_km": visibility_km(rh, rate, ptype),
        }
        if outside:
            n_outside += 1
            wx = {kk: (wx[kk] if kk == "bucket_h" else None) for kk in wx}
        level, flags = (0, []) if outside else hazards(wx, s.elev_m, thr)
        s.wx = wx
        out_samples.append({
            "i": idx, "lon": s.lon, "lat": s.lat, "dist_km": s.dist_km,
            "hours": s.hours, "leg_h": s.leg_h, "eta": s.eta.isoformat(),
            "step_h": round(h, 2), "elev_m": s.elev_m,
            "outside_run": outside, **wx,
            "hazard": level, "flags": flags,
        })

    if n_outside:
        log.info("route: %d/%d samples fall outside run %s/%s", n_outside, len(samples), reader.model, reader.rid)
    return {
        "model": reader.model, "run": reader.rid,
        "depart": samples[0].eta.isoformat(), "arrive": samples[-1].eta.isoformat(),
        "length_km": samples[-1].dist_km, "duration_h": round(samples[-1].hours, 3),
        "run_valid_to": (t0 + timedelta(hours=steps[-1])).isoformat(),
        "samples": out_samples,
        "summary": summarize(out_samples, alerts),
        "thresholds": thr,
        "units": {"t2m": "K", "wind": "m/s", "gust": "m/s", "wdir": "deg", "msl": "Pa",
                  "precip_mm_h": "mm/h", "snow_mm_h": "mm/h w.e.", "precip_bucket_mm": "mm",
                  "cloud": "fraction", "rh": "%", "vis_km": "km", "cape": "J/kg",
                  "freezing_level_m": "m", "elev_m": "m", "dist_km": "km", "length_km": "km"},
    }


# ── summary ───────────────────────────────────────────────────────────────

def _worst(rows: list[dict], key: str, biggest: bool = True) -> dict | None:
    have = [r for r in rows if r.get(key) is not None]
    if not have:
        return None
    r = (max if biggest else min)(have, key=lambda x: x[key])
    return {"value": r[key], "at": r["eta"], "dist_km": r["dist_km"],
            "lon": r["lon"], "lat": r["lat"], "i": r["i"]}


def _segments(rows: list[dict]) -> list[dict]:
    """Contiguous stretches where something is wrong — what the strip chart
    shades and the summary counts."""
    segs, cur = [], None
    for r in rows:
        if r["hazard"] > 0:
            if cur is None:
                cur = {"from_i": r["i"], "to_i": r["i"], "from_km": r["dist_km"], "to_km": r["dist_km"],
                       "from_eta": r["eta"], "to_eta": r["eta"], "level": r["hazard"], "flags": list(r["flags"])}
            else:
                cur["to_i"] = r["i"]; cur["to_km"] = r["dist_km"]; cur["to_eta"] = r["eta"]
                cur["level"] = max(cur["level"], r["hazard"])
                cur["flags"] = sorted(set(cur["flags"]) | set(r["flags"]))
        elif cur is not None:
            segs.append(cur); cur = None
    if cur is not None:
        segs.append(cur)
    return segs


def crossed_alerts(rows: list[dict], layer: dict | None) -> list[dict]:
    """Warning polygons the route passes through, from the alerts cache
    (wxgrid.ext.alerts_layer()). Bounding box first — the layer is a few
    thousand features and a full point-in-polygon test on every sample is
    wasted work."""
    if not layer:
        return []
    hits: dict[str, dict] = {}
    for f in layer.get("features") or []:
        geom, props = f.get("geometry"), f.get("properties") or {}
        if not geom:
            continue
        for r in rows:
            if not _bbox_hit(r["lon"], r["lat"], geom) or not _in_geom(r["lon"], r["lat"], geom):
                continue
            key = str(props.get("id") or f"{props.get('event')}:{props.get('area')}")
            hit = hits.get(key)
            if hit is None:
                hits[key] = {**{k: props.get(k) for k in ("event", "severity", "sev", "color", "headline", "area", "onset", "ends", "source")},
                             "from_km": r["dist_km"], "to_km": r["dist_km"], "from_eta": r["eta"], "to_eta": r["eta"], "samples": 1}
            else:
                hit["to_km"] = r["dist_km"]; hit["to_eta"] = r["eta"]; hit["samples"] += 1
    return sorted(hits.values(), key=lambda a: -(a.get("sev") or 0))


def summarize(rows: list[dict], alerts: dict | None = None) -> dict:
    counts: dict[str, int] = {}
    for r in rows:
        for fl in r["flags"]:
            counts[fl] = counts.get(fl, 0) + 1
    total_precip = 0.0
    total_snow = 0.0
    for r in rows:
        if r.get("precip_mm_h"):
            total_precip += r["precip_mm_h"] * (r.get("leg_h") or 0.0)
        if r.get("snow_mm_h"):
            total_snow += r["snow_mm_h"] * (r.get("leg_h") or 0.0)
    crossed = crossed_alerts(rows, alerts)
    return {
        "hazard": max([r["hazard"] for r in rows] or [0]),
        "flags": sorted(counts, key=lambda k: -counts[k]),
        "counts": counts,
        "segments": _segments(rows),
        "worst_gust": _worst(rows, "gust"),
        "max_wind": _worst(rows, "wind"),
        "min_temp": _worst(rows, "t2m", biggest=False),
        "max_temp": _worst(rows, "t2m"),
        "min_vis_km": _worst(rows, "vis_km", biggest=False),
        "peak_precip_mm_h": _worst(rows, "precip_mm_h"),
        "total_precip_mm": round(total_precip, 2),
        "total_snow_mm": round(total_snow, 2),
        "outside_run": sum(1 for r in rows if r["outside_run"]),
        "crosses_warning": bool(crossed),
        "alerts": crossed,
    }


def route_forecast(reader: RunReader, path: list[tuple[float, float]], depart: datetime, *,
                   speed_kmh: float | None = None, legs_h: list[float] | None = None,
                   samples: int | None = None, every_km: float | None = None,
                   elevs: list | None = None, thresholds: dict | None = None,
                   alerts: dict | None = None) -> dict:
    """plan() + forecast() in one call, for callers that need no elevations."""
    pts = plan(path, depart, speed_kmh=speed_kmh, legs_h=legs_h, samples=samples, every_km=every_km)
    return forecast(reader, pts, elevs=elevs, thresholds=thresholds, alerts=alerts)
