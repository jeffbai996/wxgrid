"""Climate normals for a point: what this date usually looks like.

ERA5 daily values for 1991–2020 come from Open-Meteo's archive (keyless,
CC BY 4.0, one request per 0.25° cell every 30 days), and become a 366-row
table of the mean daily high, low, mean and precipitation for every day of
the year, smoothed over a ±7-day window so a single freak year does not own
a date. The card shows the forecast against it as a quiet "+4° vs normal";
the tape and the week strip can read the same table.

Day-of-year here is a fixed 366-slot calendar (index 59 is 29 February in
every year, Mar 1 is always 60), so the window arithmetic is the same in
leap and common years and wraps across New Year.
"""
from __future__ import annotations

import logging
from datetime import date
from typing import Any, Callable

log = logging.getLogger("wxgrid.normals")

ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
PERIOD = ("1991-01-01", "2020-12-31")
WINDOW_DAYS = 7
CACHE_TTL_S = 30 * 24 * 3600
CACHE_VERSION = "v1"
_CUM = (0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335)   # leap-calendar month starts


def day366(d: date) -> int:
    """0-based slot in the fixed 366-day calendar (Feb 29 = 59, Mar 1 = 60)."""
    return _CUM[d.month - 1] + d.day - 1


def normals_from_daily(dates: list[str], tmax: list, tmin: list, tmean: list, precip: list,
                       window: int = WINDOW_DAYS) -> dict:
    """Per-slot means over every year, each slot pooling ±window days.
    None values are skipped; a slot with no samples at all is None."""
    n = 366
    sums = {k: [0.0] * n for k in ("tmax", "tmin", "tmean", "precip")}
    counts = {k: [0] * n for k in sums}
    series = {"tmax": tmax, "tmin": tmin, "tmean": tmean, "precip": precip}
    for i, ds in enumerate(dates):
        y, m, dd = (int(x) for x in ds[:10].split("-"))
        slot = day366(date(y, m, dd))
        for k, arr in series.items():
            v = arr[i] if i < len(arr) else None
            if v is None:
                continue
            for off in range(-window, window + 1):
                j = (slot + off) % n
                sums[k][j] += float(v)
                counts[k][j] += 1
    out = {k: [round(sums[k][j] / counts[k][j], 1) if counts[k][j] else None for j in range(n)] for k in sums}
    out["years"] = f"{PERIOD[0][:4]}–{PERIOD[1][:4]}"
    out["window_days"] = window
    return out


def normals_for(lat: float, lon: float, *, get_json: Callable[..., Any], cache_get: Callable[..., Any]) -> dict | None:
    """The table for the 0.25° cell around a point, from the shared cache;
    None when the archive did not answer (the card simply says nothing)."""
    clat, clon = round(round(lat * 4) / 4, 2), round(round(lon * 4) / 4, 2)
    key = f"normals:{CACHE_VERSION}:{clat}:{clon}"

    def fetch():
        try:
            r = get_json(ARCHIVE_URL, {
                "latitude": clat, "longitude": clon, "start_date": PERIOD[0], "end_date": PERIOD[1],
                "daily": "temperature_2m_max,temperature_2m_min,temperature_2m_mean,precipitation_sum", "timezone": "UTC",
            }, timeout=60)
            d = r.get("daily") or {}
            if not d.get("time"):
                return None
            out = normals_from_daily(d["time"], d.get("temperature_2m_max") or [], d.get("temperature_2m_min") or [],
                                     d.get("temperature_2m_mean") or [], d.get("precipitation_sum") or [])
            out["lat"], out["lon"], out["source"] = clat, clon, "ERA5 via Open-Meteo, CC BY 4.0"
            return out
        except Exception as exc:                  # a card without the line is the whole failure mode
            log.warning("normals fetch failed for %s,%s: %s", clat, clon, exc)
            return None
    return cache_get(key, CACHE_TTL_S, fetch)
