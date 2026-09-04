"""Rain now: what falls in the next two hours, fifteen minutes at a time.

Open-Meteo's `minutely_15` series is genuine 15-minute output where a
rapid-refresh model exists (HRRR over North America, ICON-D2 over central
Europe, both radar-assimilating) and an interpolation of the hourly run
elsewhere. One keyless request per 0.05° cell every five minutes gives an
hour of recent history and two hours ahead; the card shows it as the
Apple-style strip with a plain headline ("Light rain stopping in 30 min").
"""
from __future__ import annotations

import logging
import time
from datetime import datetime, timezone
from typing import Any, Callable

log = logging.getLogger("wxgrid.nowcast")

FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
STEP_MIN = 15
PAST_STEPS = 4            # one hour of what already fell
AHEAD_STEPS = 8           # two hours ahead
CACHE_TTL_S = 5 * 60
CACHE_VERSION = "v1"
TRACE_MM = 0.1            # a step at or below this is dry
# 15-minute totals at the usual hourly breaks: light < 2.5 mm/h < moderate < 7.5 mm/h < heavy
BANDS = (("light", 2.5), ("moderate", 7.5), ("heavy", float("inf")))


def band(mm: float, step_min: int = STEP_MIN) -> str:
    rate = mm * 60.0 / step_min
    for name, top in BANDS:
        if rate < top:
            return name
    return "heavy"


def _span(minutes: int) -> str:
    if minutes % 60 == 0:
        h = minutes // 60
        return f"{h} hour{'s' if h != 1 else ''}"
    return f"{minutes} min"


def headline(mm: list[float], step_min: int, now: int, snow: list[float] | None = None) -> str | None:
    """One line about the window from `now` on: when it starts, when it stops,
    or that it keeps going. None when nothing worth a coat falls."""
    ahead = [max(0.0, float(v or 0)) for v in mm[now:]]
    wet = [v > TRACE_MM for v in ahead]
    if not any(wet):
        return None
    snowy = bool(snow) and sum(float(v or 0) for v in snow[now:]) >= 0.5 * sum(ahead)
    what = "snow" if snowy else "rain"
    if wet[0]:
        try:
            stop = wet.index(False)
        except ValueError:
            stop = None
        peak = band(max(ahead[:stop] if stop else ahead), step_min).capitalize()
        if stop is None:
            return f"{peak} {what} for the next {_span(len(ahead) * step_min)}"
        return f"{peak} {what} stopping in {_span(stop * step_min)}"
    start = wet.index(True)
    peak = band(max(ahead[start:]), step_min).capitalize()
    return f"{peak} {what} starting in {_span(start * step_min)}"


def nowcast_for(lat: float, lon: float, *, get_json: Callable[..., Any], cache_get: Callable[..., Any],
                now_ms: float | None = None) -> dict | None:
    key = f"nowcast-{CACHE_VERSION}:{lat:.2f}:{lon:.2f}"

    def fetch() -> dict | None:
        try:
            j = get_json(FORECAST_URL, {"latitude": round(lat, 3), "longitude": round(lon, 3), "timezone": "UTC",
                                        "minutely_15": "precipitation,snowfall,weather_code",
                                        "past_minutely_15": PAST_STEPS, "forecast_minutely_15": AHEAD_STEPS},
                         timeout=12)
            m = j["minutely_15"]
            times = [t if t.endswith("Z") else t + "Z" for t in m["time"]]
            mm = [round(float(v or 0), 2) for v in m["precipitation"]]
            snow = [round(float(v or 0), 2) for v in m.get("snowfall") or [0] * len(mm)]
        except Exception as exc:               # noqa: BLE001 - upstream down means no strip, not a broken card
            log.debug("nowcast fetch failed: %s", exc)
            return None
        t_now = (now_ms if now_ms is not None else time.time() * 1000) / 1000
        stamps = [datetime.strptime(t, "%Y-%m-%dT%H:%MZ").replace(tzinfo=timezone.utc).timestamp() for t in times]
        now = max([k for k, s in enumerate(stamps) if s <= t_now] or [0])
        return {"times": times, "mm": mm, "snow": snow, "step_min": STEP_MIN, "now": now,
                "headline": headline(mm, STEP_MIN, now, snow), "source": "Open-Meteo 15-min"}

    return cache_get(key, CACHE_TTL_S, fetch)
