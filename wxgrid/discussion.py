"""The forecast discussion: why the weather, not just the weather.

An NWS office publishes an Area Forecast Discussion beside every forecast —
the part where a person explains which system is doing what. No consumer app
carries one. This module writes that paragraph deterministically: it reads the
pressure field for the synoptic driver, the point column for what that driver
does here, the freezing level for the vertical story, and the GEFS members for
how sure anyone should be. Plain sentences on purpose (Jeff 2026-08-20:
"don't go too meteorologist on me") — the reader is told what will happen and
why, never handed a vorticity number.

Everything is derived from fields already in the store; nothing here calls
outside. Cached per (model, run, half-degree) because the answer only changes
when the run does.
"""
from __future__ import annotations

import math

import numpy as np

from wxgrid.config import GRID_LAT_N, GRID_LON_N
from wxgrid.store import RunReader

COMPASS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"]


def _bearing_word(dlat: float, dlon_km: float, dlat_km: float) -> str:
    ang = (math.degrees(math.atan2(dlon_km, dlat_km)) + 360) % 360
    return COMPASS[round(ang / 45) % 8]


def _smooth(z: np.ndarray, passes: int = 2) -> np.ndarray:
    for _ in range(passes):
        z = (z + np.roll(z, 1, 0) + np.roll(z, -1, 0) + np.roll(z, 1, 1) + np.roll(z, -1, 1)) / 5.0
    return z


def nearest_system(msl: np.ndarray, lat: float, lon: float, radius_km: float = 1300.0) -> dict | None:
    """The most consequential pressure centre within reach of a point: the
    strongest local low or high on a smoothed half-degree field."""
    z = _smooth(np.asarray(msl[::2, ::2], dtype=np.float64) / 100.0)
    ny, nx = z.shape
    i0 = min(ny - 1, max(0, int(round((90.0 - lat) / 0.5))))
    j0 = int(round((lon + 180.0) / 0.5)) % nx
    # search window in gridpoints: 0.5° ≈ 55 km meridionally
    w = int(radius_km / 55.0)
    best = None
    for di in range(-w, w + 1):
        i = i0 + di
        if i < 1 or i >= ny - 1:
            continue
        coslat = max(0.2, math.cos(math.radians(90.0 - i * 0.5)))
        wj = min(nx // 2 - 1, int(radius_km / (55.0 * coslat)))
        for dj in range(-wj, wj + 1):
            j = (j0 + dj) % nx
            v = z[i, j]
            neigh = [z[i - 1, j], z[i + 1, j], z[i, (j - 1) % nx], z[i, (j + 1) % nx]]
            # A relative extremum is not enough: a 1021 hPa dimple in a ridge
            # is a col, not "a low", and calling it one reads as nonsense.
            is_low = v < min(neigh) and v <= 1011.0
            is_high = v > max(neigh) and v >= 1017.0
            if not (is_low or is_high):
                continue
            dist = math.hypot(di * 55.0, dj * 55.0 * coslat)
            if dist > radius_km:
                continue
            # how consequential: departure from 1013, scaled down with distance
            score = abs(v - 1013.0) * (1.0 - dist / (radius_km * 1.4))
            if is_low:
                score *= 1.35                     # lows drive more weather
            if best is None or score > best["score"]:
                best = {"kind": "low" if is_low else "high", "hpa": round(v),
                        "km": round(dist / 50) * 50, "score": score,
                        "dir": _bearing_word(0, dj * 55.0 * coslat, -di * 55.0),
                        "i": i, "j": j}
    if best and best["score"] < 2.0:
        return None                                # nothing worth a sentence
    return best


def _fmt_when(hours: float, run_hour_local) -> str:
    if hours <= 3:
        return "now"
    if hours <= 9:
        return "later today" if run_hour_local(hours) < 21 else "tonight"
    if hours <= 30:
        return "tomorrow"
    if hours <= 54:
        return "the day after"
    return "later in the week"


def compose(r: RunReader, lat: float, lon: float, point: dict, prob: dict | None) -> dict:
    """The discussion paragraphs for one point. `point` is api_point's payload
    (so the column is read once); `prob` is prob_point's, or None."""
    s = point["series"]
    steps = point["steps"]
    paras: list[str] = []

    # ── the driver ────────────────────────────────────────────────────
    now_k = 0
    msl_now = r.slab("msl", steps[now_k]) if "msl" in r.variables else None
    sys_now = nearest_system(msl_now, lat, lon) if msl_now is not None else None
    driver = ""
    if sys_now:
        later_h = next((h for h in steps if h >= steps[now_k] + 24), None)
        trend = ""
        if later_h is not None:
            sys_later = nearest_system(r.slab("msl", later_h), lat, lon)
            if sys_later and sys_later["kind"] == sys_now["kind"]:
                d = sys_later["hpa"] - sys_now["hpa"]
                if sys_now["kind"] == "low":
                    trend = ", deepening" if d <= -2 else ", filling" if d >= 2 else ""
                else:
                    trend = ", building" if d >= 2 else ", weakening" if d <= -2 else ""
        place = "overhead" if sys_now["km"] <= 150 else f"about {sys_now['km']} km to the {sys_now['dir']}"
        driver = (f"The weather here is being run by a {sys_now['hpa']} hPa "
                  f"{sys_now['kind']} {place}{trend}.")
    ptend = None
    if s.get("msl") and s["msl"][0] is not None:
        nxt = next((k for k, h in enumerate(steps) if h >= steps[0] + 6), None)
        if nxt and s["msl"][nxt] is not None:
            ptend = (s["msl"][nxt] - s["msl"][0]) / 100.0
    if ptend is not None and abs(ptend) >= 1.5:
        glass = "falling" if ptend < 0 else "rising"
        why = "usually the sign of weather arriving" if ptend < 0 else "which generally means it is clearing out"
        driver += f" The pressure here is {glass} {abs(ptend):.0f} hPa over the next six hours, {why}."
    if driver:
        paras.append(driver.strip())

    # ── what it does here ─────────────────────────────────────────────
    here = []
    idx48 = [k for k, h in enumerate(steps) if h <= steps[0] + 48]
    wet = [(k, (s.get("tp6", [None] * len(steps))[k] or 0) + (s.get("sf6", [None] * len(steps))[k] or 0)) for k in idx48]
    total = sum(v for _, v in wet if v)
    if total >= 1:
        first = next((k for k, v in wet if v and v > 0.2), None)
        snowy = s.get("sf6") and first is not None and (s["sf6"][first] or 0) > (s.get("tp6", [0] * len(steps))[first] or 0)
        kind = "snow" if snowy else "rain"
        when = _fmt_when(steps[first] - steps[0], lambda h: 12) if first is not None else "soon"
        here.append(f"That means {kind} for this point, {total:.0f} mm of it in the next two days, starting {when}.")
    elif sys_now and sys_now["kind"] == "high":
        here.append("For this point that means settled weather: the high sits on the moisture and not much gets past a ridge.")
    gusts = [v for v in (s.get("gust") or s.get("wind") or [])[:len(idx48)] if v is not None]
    if gusts and max(gusts) * 3.6 >= 45:
        here.append(f"Wind is part of the story too, gusts to {max(gusts) * 3.6:.0f} km/h as the gradient tightens.")
    if here:
        paras.append(" ".join(here))

    # ── the vertical story ────────────────────────────────────────────
    fl = (point.get("derived") or {}).get("freezing_level_m")
    if fl:
        fls = [(k, v) for k, v in enumerate(fl) if v is not None and k < len(steps) and steps[k] <= steps[0] + 48]
        if len(fls) >= 3:
            v0, vend = fls[0][1], fls[-1][1]
            if vend - v0 <= -600:
                paras.append(f"Colder air moves in aloft: the freezing level drops from about {round(v0 / 100) * 100} m "
                             f"to {round(vend / 100) * 100} m within two days, so whatever falls turns more wintry with time.")
            elif vend - v0 >= 600:
                paras.append(f"The air aloft is warming: the freezing level climbs from about {round(v0 / 100) * 100} m "
                             f"to {round(vend / 100) * 100} m, so the snow line retreats uphill.")

    # ── confidence, from the members ──────────────────────────────────
    if prob and prob.get("series", {}).get("prob_rain"):
        pr = [v for v in prob["series"]["prob_rain"][:16] if v is not None]
        if pr:
            mx = max(pr)
            if total >= 1 and mx >= 70:
                paras.append(f"The ensemble is fairly sure about this: at the wettest window, {mx:.0f}% of the 30 members bring precipitation.")
            elif total >= 1 and mx <= 45:
                paras.append(f"Worth knowing: the members are split, only {mx:.0f}% of 30 carry the precipitation. This one could miss.")
            elif total < 1 and mx >= 55:
                paras.append(f"One caveat: this run keeps it dry, but {mx:.0f}% of the ensemble's members disagree. Do not wash the car on this forecast alone.")

    return {"model": point["model"], "run": point["run"], "paras": paras}
