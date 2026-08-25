"""Nearest open water for a point on land: how far, which way, and the sea
state out there.

The location card used to decide "is this a beach" in the browser, from
whether the model happened to carry a wave height at the exact gridpoint under
the pin. On a 0.25° grid that gridpoint is up to 28 km wide, so a pin dropped
on the promenade at Biarritz, Sitges or Rimini lands on a land cell, reads no
waves and loses the whole module — while a pin 20 km out to sea gets the full
surf report. This walks out from the point across the model's own land/sea
mask instead and brings the sea state back from wherever it found water, so
a place three kilometres inland still gets a surf read.

The mask is geography, not weather: identical at every step of a run and
near-identical between runs. Built once per run, kept, and reused.

Waves live on one model here (the ECMWF wave stream, IFS), so a card showing
AIFS or GEM borrows IFS's water and IFS's waves, sampled at the valid times
the card is actually drawing.
"""
from __future__ import annotations

import logging
import math
import threading
from concurrent.futures import ThreadPoolExecutor

import numpy as np

log = logging.getLogger("wxgrid.coast")

# How far the search walks before giving up, in gridpoints. Four cells is
# ~110 km of latitude on the 0.25° grid — past that the sea is not what you
# came outside for, and the answer belongs to a different card.
MAX_RINGS = 4
# Sampling one run's series at another run's valid times: how far apart two
# times may be and still count as the same moment.
MATCH_HOURS = 3.0
COMPASS = ("N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
           "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW")

VARS = (("swh", 2), ("mwp", 1), ("mwd", 0), ("sst", 2))

_masks: dict[tuple[str, str], np.ndarray | None] = {}
_masks_lock = threading.Lock()
_series_cache: dict[tuple, list | None] = {}
_series_lock = threading.Lock()
# The four field reads are four chunk decompressions, and blosc drops the GIL,
# so they go out together rather than one after another. Its own pool: this
# runs inside a task on the API's pool, and a pool that waits on itself is a
# deadlock looking for a busy afternoon.
_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="coast")


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p = math.pi / 180
    a = 0.5 - math.cos((lat2 - lat1) * p) / 2 + math.cos(lat1 * p) * math.cos(lat2 * p) * (1 - math.cos((lon2 - lon1) * p)) / 2
    return 12742 * math.asin(math.sqrt(a))


def bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> int:
    """Initial great-circle bearing from the first point to the second, in
    degrees clockwise from true north."""
    p = math.pi / 180
    dl = (lon2 - lon1) * p
    y = math.sin(dl) * math.cos(lat2 * p)
    x = math.cos(lat1 * p) * math.sin(lat2 * p) - math.sin(lat1 * p) * math.cos(lat2 * p) * math.cos(dl)
    return int(round(math.degrees(math.atan2(y, x))) % 360)


def compass(deg: float | None) -> str | None:
    return None if deg is None else COMPASS[int(round(float(deg) / 22.5)) % 16]


def sea_var(r) -> str | None:
    """Which of this run's fields is a land/sea mask. The wave height is the
    better one: it is NaN over land AND it is the number the card wants."""
    for var in ("swh", "sst"):
        if var in r.variables:
            return var
    return None


def sea_mask(r) -> np.ndarray | None:
    """True where the run has open water, from whichever field it masks to
    the sea. Cached per run — it costs one chunk read and never changes
    within a run."""
    key = (r.model, r.rid)
    with _masks_lock:
        if key in _masks:
            return _masks[key]
    var = sea_var(r)
    mask = None
    if var is not None:
        try:
            field = r.slab(var, r.steps[0])
            mask = np.isfinite(field)
            if var == "swh":
                # a wave model writes 0 in sheltered water and NaN on land;
                # a negative would be a decode artefact, not a sea
                mask &= field >= 0.0
        except Exception as exc:                                   # noqa: BLE001
            log.warning("coast mask %s/%s failed: %s", r.model, r.rid, exc)
            mask = None
    with _masks_lock:
        if len(_masks) > 8:                    # a handful of runs is the whole store
            _masks.clear()
        _masks[key] = mask
    return mask


def nearest_water(r, mask: np.ndarray, lat: float, lon: float,
                  max_rings: int = MAX_RINGS) -> tuple[float, int, int, float, float] | None:
    """(distance_km, row, col, cell_lat, cell_lon) for the closest water
    gridpoint, or None if the search runs out of rings.

    Walks out in square rings and, once a ring holds water, scans one ring
    further before choosing: near the poles a cell two columns away is
    physically closer than one a row away, so the first ring to answer does
    not always hold the nearest answer."""
    ny, nx = mask.shape
    i0, j0 = r.indices(lat, lon)
    i0, j0 = int(i0), int(j0)
    wrap = tuple(r.domain) == (-180.0, -90.0, 180.0, 90.0)
    best = None
    for rad in range(max_rings + 1):
        if best is not None and rad > best[5] + 1:
            break
        for di in range(-rad, rad + 1):
            for dj in range(-rad, rad + 1):
                if max(abs(di), abs(dj)) != rad:
                    continue                    # interior cells belong to an earlier ring
                i, j = i0 + di, j0 + dj
                if i < 0 or i >= ny:
                    continue
                j = j % nx if wrap else j
                if j < 0 or j >= nx or not mask[i, j]:
                    continue
                cell_lat, cell_lon = float(r.lats[i]), float(r.lons[j])
                d = haversine_km(lat, lon, cell_lat, cell_lon)
                if best is None or d < best[0]:
                    best = (d, i, j, cell_lat, cell_lon, rad)
    return best[:5] if best else None


def align(src_valid: list, vals: list, dst_valid: list, tol_h: float = MATCH_HOURS) -> list:
    """One run's series read at another run's valid times: the nearest sample
    that actually exists, inside a tolerance, None where nothing is that
    close. The card indexes every series by its own step, so a borrowed
    series has to arrive on the card's own clock or it lies by six hours.

    Skipping the empty samples is what makes a 6-hourly wave field usable on
    a 3-hourly card: the wave stream writes nothing at 03, 09, 15 UTC, and a
    plain nearest-time match would hand back that nothing every other step."""
    good = [k for k, v in enumerate(vals) if v is not None]
    if not src_valid or not good or not dst_valid:
        return [None] * len(dst_valid)
    src = np.array([src_valid[k].timestamp() for k in good], dtype=float)
    tol = tol_h * 3600.0
    out = []
    for t in dst_valid:
        gap = np.abs(src - t.timestamp())
        k = int(np.argmin(gap))
        out.append(vals[good[k]] if gap[k] <= tol else None)
    return out


def _series(r, var: str, lat: float, lon: float, nd: int = 2) -> list | None:
    """One field's series at one water cell, remembered.

    A point read decompresses a chunk, and this asks for four fields off a run
    the card is not otherwise touching — enough to double the cost of opening
    a card if every open pays it. The answer depends only on (run, field,
    cell), and a whole coastline shares one cell, so the second card anyone
    opens near the first is free."""
    if var not in r.variables:
        return None
    key = (r.model, r.rid, var, round(lat, 3), round(lon, 3), nd)
    with _series_lock:
        if key in _series_cache:
            return _series_cache[key]
    try:
        raw = r.point(var, lat, lon)
        vals = [None if np.isnan(x) else round(float(x), nd) for x in raw]
    except Exception as exc:                                       # noqa: BLE001
        log.info("coast series %s: %s", var, exc)
        vals = None
    with _series_lock:
        if len(_series_cache) > 512:                               # crude bound
            _series_cache.clear()
        _series_cache[key] = vals
    return vals


def run_valid(r) -> list:
    """A run's valid times, which the reader does not carry itself."""
    from datetime import timedelta

    from wxgrid.store import parse_run_id
    t0 = parse_run_id(r.rid)
    return [t0 + timedelta(hours=h) for h in r.steps]


def probe(r, lat: float, lon: float, valid: list, seas: list | None = None) -> dict | None:
    """The coast under a point: distance, bearing and the sea state there.

    `r` is the run the card is showing. `seas` is the runs that carry water,
    best first — the wave model, then whatever holds a sea-surface
    temperature, then the card's own run. The first one whose mask finds
    water fixes the location; every field is then read from the first run in
    the list that carries it, because waves and sea temperature come from
    different models (the ECMWF wave stream has no SST, GFS has no waves).
    `valid` is the card's own list of valid times and every series comes back
    on it, so the card can index a borrowed series by its own step.

    None when nothing here can see the sea: no masked field anywhere, or no
    water within MAX_RINGS of the point."""
    seas = [s for s in (seas or [r]) if s is not None]
    site = None
    for sea in seas:
        if not sea.contains(lat, lon):
            continue
        mask = sea_mask(sea)
        if mask is None:
            continue
        hit = nearest_water(sea, mask, lat, lon)
        if hit is not None:
            site = (sea, hit)
            break
    if site is None:
        return None
    sea, (dist, _i, _j, cell_lat, cell_lon) = site
    brg = bearing_deg(lat, lon, cell_lat, cell_lon) if dist > 0.01 else None
    out = {"distance_km": round(dist, 1), "bearing_deg": brg, "compass": compass(brg),
           "lat": round(cell_lat, 3), "lon": round(cell_lon, 3),
           "grid_km": round(abs(sea.dlat) * 111.2, 1),
           "model": sea.model, "run": sea.rid}

    def filled(vals) -> bool:
        return bool(vals) and any(v is not None for v in vals)

    # One run per field: the first in the list that carries it.
    plan = []
    for var, nd in VARS:
        src = next((x for x in seas if var in x.variables), None)
        if src is not None:
            plan.append((var, nd, src))
    # Where each of those runs thinks the water is. The wave grid and the SST
    # mask part company by a cell all along a coast, so a field read at
    # another run's cell can come back empty even though that run has the
    # field a gridpoint over.
    sites: dict[int, tuple | None] = {id(sea): site[1]}
    for _var, _nd, src in plan:
        if id(src) in sites:
            continue
        m = sea_mask(src)
        sites[id(src)] = nearest_water(src, m, lat, lon) if (m is not None and src.contains(lat, lon)) else None

    def read(job):
        var, nd, src = job
        vals = _series(src, var, cell_lat, cell_lon, nd) if src.contains(cell_lat, cell_lon) else None
        if not filled(vals):
            own = sites.get(id(src))
            vals = _series(src, var, own[3], own[4], nd) if own else None
        return var, src, vals

    times: dict[int, list] = {}
    for var, src, vals in _pool.map(read, plan):
        if not filled(vals):
            continue
        # Even the card's own run goes through align: the wave fields are
        # stored on 6 h steps under a surface tier that can be 3-hourly, so
        # the holes are there whether or not the run is borrowed.
        src_valid = times.setdefault(id(src), run_valid(src))
        out[var] = align(src_valid, vals, valid)
    return out
