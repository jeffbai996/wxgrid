"""Nearby webcams for a point: the mountain pass, the coast road, the view
from the hill — the check on the forecast you can do with your eyes.

Providers are public, keyless feeds with an open licence. Each one yields
plain `Cam` records; the shared TTL cache keeps one copy of each provider's
catalogue (a thousand-odd records) and `nearest()` does the geometry. Image
URLs are the provider's own — the browser fetches them directly, so nothing
here proxies pixels — and every record names who to credit.

    DriveBC   BC highways incl. the mountain passes (Coquihalla, Rogers,
              Kootenay, Sea-to-Sky). ~1,060 cams, refreshed every few minutes,
              Open Government Licence – British Columbia.
"""
from __future__ import annotations

import logging
import math
from dataclasses import asdict, dataclass
from typing import Any, Callable, Iterable

log = logging.getLogger("wxgrid.webcams")

CATALOG_TTL_S = 20 * 60
# A provider that did not answer is remembered as empty this long, then asked
# again. It used to be stored as a real empty catalogue for CATALOG_TTL_S.
FAIL_TTL_S = 5 * 60
# Fetches share the card's five-second budget with everything else on the
# card; a provider that has not answered by now is not going to.
FETCH_TIMEOUT_S = 12
# Windy mirrors the DOT feeds, so a DriveBC cam came back twice. A Windy
# record this close to a provider's own is the same camera; the provider's
# record (live image URL, no 15-minute link expiry) wins.
WINDY_TWIN_M = 120
# Bump when a parser changes what it stores: the shared cache is mirrored to
# disk and would otherwise serve the old records for a TTL after a deploy.
CATALOG_VERSION = "v2"
MAX_KM = 120.0


@dataclass(frozen=True)
class Cam:
    id: str
    provider: str
    name: str
    lat: float
    lon: float
    image: str
    page: str
    credit: str
    caption: str = ""
    elevation_m: float | None = None
    updated: str | None = None
    stale: bool = False


def _num(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


# ── DriveBC ────────────────────────────────────────────────────────────────
DRIVEBC_LIST = "https://www.drivebc.ca/api/webcams/"
# images.drivebc.ca answers with a "no longer available" card since the 2024
# site; the live still is the `links.imageDisplay` path on www.drivebc.ca.
DRIVEBC_SITE = "https://www.drivebc.ca"
DRIVEBC_IMAGE = DRIVEBC_SITE + "/images/{id}.jpg"
DRIVEBC_PAGE = "https://www.drivebc.ca/cameras/{id}"


def parse_drivebc(payload: Any) -> list[Cam]:
    out: list[Cam] = []
    for o in payload or []:
        if not isinstance(o, dict) or not o.get("is_on", True) or not o.get("should_appear", True):
            continue
        loc = (o.get("location") or {}).get("coordinates") or []
        if len(loc) != 2 or _num(loc[0]) is None or _num(loc[1]) is None:
            continue
        cid = str(o.get("id"))
        shown = ((o.get("links") or {}).get("imageDisplay") or "").split("?")[0]
        image = (DRIVEBC_SITE + shown) if shown.startswith("/") else DRIVEBC_IMAGE.format(id=cid)
        out.append(Cam(
            id=f"drivebc:{cid}", provider="DriveBC", name=str(o.get("name_override") or o.get("name") or f"Camera {cid}"),
            lat=float(loc[1]), lon=float(loc[0]),
            image=image, page=DRIVEBC_PAGE.format(id=cid),
            credit="DriveBC · Province of British Columbia, OGL-BC",
            caption=str(o.get("caption_override") or o.get("caption") or ""),
            elevation_m=_num(o.get("elevation")), updated=o.get("last_update_modified"),
            stale=bool(o.get("marked_stale") or o.get("marked_delayed")),
        ))
    return out


# One provider today. The 511 platforms (Alberta, Ontario, …) serve pages,
# not still images, without a key, and Windy's Webcams API needs a key too;
# both slot in here as (key, list URL, parser) when their access is sorted.
PROVIDERS: tuple[tuple[str, str, Callable[[Any], list[Cam]]], ...] = (
    ("drivebc", DRIVEBC_LIST, parse_drivebc),
)


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p = math.pi / 180
    a = 0.5 - math.cos((lat2 - lat1) * p) / 2 + math.cos(lat1 * p) * math.cos(lat2 * p) * (1 - math.cos((lon2 - lon1) * p)) / 2
    return 12742 * math.asin(math.sqrt(max(0.0, min(1.0, a))))


def bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p = math.pi / 180
    y = math.sin((lon2 - lon1) * p) * math.cos(lat2 * p)
    x = math.cos(lat1 * p) * math.sin(lat2 * p) - math.sin(lat1 * p) * math.cos(lat2 * p) * math.cos((lon2 - lon1) * p)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def nearest(cams: Iterable[Cam], lat: float, lon: float, n: int = 6, max_km: float = MAX_KM) -> list[dict]:
    """The closest `n` cams within `max_km`, nearest first, as JSON-ready
    dicts with distance and bearing from the point."""
    rows = []
    for c in cams:
        d = haversine_km(lat, lon, c.lat, c.lon)
        if d <= max_km:
            rows.append((d, c))
    rows.sort(key=lambda r: r[0])
    out = []
    for d, c in rows[:n]:
        rec = asdict(c)
        rec["distance_km"] = round(d, 1)
        rec["bearing_deg"] = round(bearing_deg(lat, lon, c.lat, c.lon))
        out.append(rec)
    return out


def catalogue(*, get_json: Callable[..., Any], cache_get: Callable[..., Any],
              cache_remember: Callable[..., Any] | None = None) -> list[Cam]:
    """Every provider's cams, each list cached separately so one dead feed
    neither blocks nor evicts the others."""
    cams: list[Cam] = []
    for key, url, parse in PROVIDERS:
        cache_key = f"webcams:{key}:{CATALOG_VERSION}"
        def fetch(url=url, parse=parse):
            return [asdict(c) for c in parse(get_json(url, None, timeout=FETCH_TIMEOUT_S))]
        try:
            rows = cache_get(cache_key, CATALOG_TTL_S, fetch) or []
        except Exception as exc:                  # the card just has fewer cams; the health dot notices
            log.info("webcam catalogue %s failed: %s", key, exc)
            if cache_remember is not None:
                cache_remember(cache_key, FAIL_TTL_S, [])
            rows = []
        cams.extend(Cam(**r) for r in rows)
    return cams


# ── Windy Webcams (keyed) ──────────────────────────────────────────────────
# The one worldwide feed: mountain, beach and town cams contributed to
# windy.com. Free tier: key in a header, image URLs good for ~15 minutes, and
# the card links back to windy.com as the terms ask. Queried per point (the
# catalogue is not downloadable), so it is cached per 0.1° cell for 10 min.
WINDY_URL = "https://api.windy.com/webcams/api/v3/webcams"
WINDY_ENV = "WXGRID_WINDY_WEBCAMS_KEY"
WINDY_TTL_S = 10 * 60
WINDY_RADIUS_KM = 80


def windy_key() -> str | None:
    import os
    return os.environ.get(WINDY_ENV, "").strip() or None


def parse_windy(payload: Any) -> list[Cam]:
    out: list[Cam] = []
    for o in (payload or {}).get("webcams") or []:
        if not isinstance(o, dict) or o.get("status") not in (None, "active"):
            continue
        loc = o.get("location") or {}
        lat, lon = _num(loc.get("latitude")), _num(loc.get("longitude"))
        img = ((o.get("images") or {}).get("current") or {}).get("preview") or ""
        if lat is None or lon is None or not img:
            continue
        cid = str(o.get("webcamId") or o.get("id") or img)
        where = ", ".join(x for x in (loc.get("city"), loc.get("region"), loc.get("country")) if x)
        out.append(Cam(
            id=f"windy:{cid}", provider="Windy", name=str(o.get("title") or f"Webcam {cid}"), lat=lat, lon=lon,
            image=str(img), page=str(((o.get("urls") or {}).get("detail")) or f"https://windy.com/webcams/{cid}"),
            credit="Windy.com Webcams", caption=where, updated=o.get("lastUpdatedOn"),
        ))
    return out


def windy_near(lat: float, lon: float, n: int, *, key: str, get_json: Callable[..., Any], cache_get: Callable[..., Any]) -> list[Cam]:
    cell = f"{round(lat, 1)}:{round(lon, 1)}"

    def fetch():
        try:
            return [asdict(c) for c in parse_windy(get_json(
                # no distance sort on the free tier (sortKey allows popularity/createdOn only); nearest() sorts
                WINDY_URL, {"nearby": f"{lat:.3f},{lon:.3f},{WINDY_RADIUS_KM}", "limit": max(n * 3, 12),
                            "include": "images,location,urls"},
                timeout=FETCH_TIMEOUT_S, headers={"X-WINDY-API-KEY": key}))]
        except Exception as exc:
            log.info("windy webcams failed: %s", exc)
            return []
    rows = cache_get(f"webcams:windy:{cell}", WINDY_TTL_S, fetch) or []
    return [Cam(**r) for r in rows]


def drop_windy_twins(cams: list[Cam]) -> list[Cam]:
    """Windy records within WINDY_TWIN_M of a provider's own cam are that cam."""
    own = [c for c in cams if c.provider != "Windy"]
    def twin(c: Cam) -> bool:
        return any(haversine_km(c.lat, c.lon, o.lat, o.lon) * 1000 <= WINDY_TWIN_M for o in own)
    return own + [c for c in cams if c.provider == "Windy" and not twin(c)]


def near_point(lat: float, lon: float, n: int, *, get_json: Callable[..., Any], cache_get: Callable[..., Any],
               windy: str | None = None, cache_remember: Callable[..., Any] | None = None) -> dict:
    cams = list(catalogue(get_json=get_json, cache_get=cache_get, cache_remember=cache_remember))
    providers = [p[0] for p in PROVIDERS]
    key = windy if windy is not None else windy_key()
    if key:
        cams = drop_windy_twins(cams + windy_near(lat, lon, n, key=key, get_json=get_json, cache_get=cache_get))
        providers.append("windy")
    return {"cams": nearest(cams, lat, lon, n=n), "providers": providers}
