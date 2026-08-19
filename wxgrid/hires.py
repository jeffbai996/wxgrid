"""Convection-allowing models, as point forecasts only.

wxgrid's store is one global 0.25° grid. HRRR is 3 km over CONUS: putting it on
that grid would throw away the entire reason to want it, and giving the store a
second geometry touches the writer, the reader, every renderer and the map's
world extent. So the high-resolution models live here instead — fetched per
point from Open-Meteo, in the same series shape `/api/point` returns, and never
drawn as a layer.

What that buys: hourly detail, gusts and CAPE that a 0.25° field smooths flat,
at the one place a person actually asked about. What it costs: no map, no
cross-section, no soundings, and a hard domain edge that the API reports as
"not available here" rather than guessing.
"""
from __future__ import annotations

import logging
from typing import Any

import requests

from wxgrid.ext import cache

log = logging.getLogger(__name__)

OPEN_METEO = "https://api.open-meteo.com/v1/forecast"
UA = "wxgrid/0.2 (+https://github.com/jeffbai996/wxgrid)"

# Open-Meteo's name → ours. Everything here is a surface field; there are no
# pressure levels, which is why these models never reach the aloft panes.
_FIELDS = {
    "temperature_2m": "t2m", "dew_point_2m": "d2m", "wind_speed_10m": "wind",
    "wind_direction_10m": "wdir", "wind_gusts_10m": "gust", "precipitation": "tp6",
    "snowfall": "sf6", "cloud_cover": "tcc", "pressure_msl": "msl", "cape": "cape",
}

MODELS: dict[str, dict[str, Any]] = {
    "hrrr": {"om": "gfs_hrrr", "label": "NOAA HRRR", "short": "HRRR", "grid": "3km",
             "hours": 48, "area": "United States and southern Canada",
             "attribution": "NOAA HRRR via Open-Meteo, CC BY 4.0"},
}


def _convert(name: str, value: float | None) -> float | None:
    """Open-Meteo's units into the store's: kelvin, m/s, mm, fraction, pascals.
    Snowfall arrives as centimetres of snow and is banked as water equivalent
    at 10:1, which is what every other model in the store holds."""
    if value is None:
        return None
    if name in ("t2m", "d2m"):
        return value + 273.15
    if name == "msl":
        return value * 100.0
    if name == "tcc":
        return value / 100.0
    if name == "sf6":
        return value / 10.0
    return value


def point(key: str, lat: float, lon: float) -> dict:
    """One model's hourly forecast at a point, or `available: false` outside its
    domain. Open-Meteo answers out-of-domain with an explicit error rather than
    silently extrapolating, so the edge is exact."""
    spec = MODELS.get(key)
    if spec is None:
        raise KeyError(key)

    def fetch() -> dict:
        params = {
            "latitude": f"{lat:.4f}", "longitude": f"{lon:.4f}",
            "hourly": ",".join(_FIELDS), "models": spec["om"],
            "wind_speed_unit": "ms", "temperature_unit": "celsius",
            "precipitation_unit": "mm", "timeformat": "iso8601", "timezone": "GMT",
            "forecast_days": 3,
        }
        try:
            r = requests.get(OPEN_METEO, params=params, headers={"User-Agent": UA}, timeout=20)
            body = r.json()
        except (requests.RequestException, ValueError) as exc:
            log.debug("%s point failed: %s", key, exc)
            return {"available": False, "reason": "upstream unavailable"}
        if body.get("error"):
            # "No data is available for this location" — outside the domain.
            return {"available": False, "reason": str(body.get("reason", ""))[:120]}
        hourly = body.get("hourly") or {}
        times = hourly.get("time") or []
        if not times:
            return {"available": False, "reason": "no hours returned"}
        series = {ours: [_convert(ours, v) for v in hourly.get(om) or []]
                  for om, ours in _FIELDS.items() if hourly.get(om)}
        # Open-Meteo pads the request out to whole days; HRRR itself stops at
        # 48 h and the rest comes back null. Cut the series where the model
        # ends rather than showing a day and a half of blanks.
        ref = series.get("t2m") or next(iter(series.values()), [])
        last = max((k for k, v in enumerate(ref) if v is not None), default=-1)
        if last < 0:
            return {"available": False, "reason": "no values returned"}
        n = last + 1
        series = {k: v[:n] for k, v in series.items()}
        times = times[:n]
        valid = [f"{t}:00+00:00" if len(t) == 16 else t for t in times]
        return {"available": True, "model": key, "label": spec["label"], "short": spec["short"],
                "grid": spec["grid"], "attribution": spec["attribution"], "area": spec["area"],
                "lat": body.get("latitude", lat), "lon": body.get("longitude", lon),
                "elevation_m": body.get("elevation"),
                "steps": list(range(len(times))), "valid": valid, "series": series}

    return cache.get(f"hires-v2:{key}:{lat:.2f}:{lon:.2f}", 900, fetch)
