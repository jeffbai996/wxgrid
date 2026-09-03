"""North-American ski-resort catalog + per-resort lift/boundary detail.

Source: OpenStreetMap via the Overpass API (free, no key). Two on-disk
caches under data/resorts/ (data/ is gitignored, so nothing here is
committed):

  data/resorts/catalog.json   every resort we know about (name, coords,
                               elevations, country/region) — rebuilt by
                               build_catalog(), read lazily by search()/
                               nearest()/resort_detail().
  data/resorts/<id>.json      per-resort lifts + boundary GeoJSON, cached
                               30 days (Overpass is a shared free service;
                               a resort's lift network doesn't change daily).

build_catalog() merges in wxgrid.resorts_seed.SEED_RESORTS so the catalog
is never empty even before the first Overpass run, and so well-known
resorts keep sane elevations when their OSM tags don't carry ele:min/max.
"""
from __future__ import annotations

import json
import logging
import re
import time
import uuid
from datetime import datetime, timedelta, timezone
from math import asin, cos, radians, sin, sqrt
from pathlib import Path

import requests

from wxgrid.config import DATA_DIR
from wxgrid.resorts_seed import SEED_RESORTS

log = logging.getLogger("wxgrid.resorts")

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
USER_AGENT = "wxgrid/0.1 (+https://github.com/jeffbai996/wxgrid)"
_DETAIL_TTL = timedelta(days=30)

# North America, tiled 2 (lat) x 3 (lon) so no single Overpass request has to
# scan the whole continent — cheaper for their server and less likely to hit
# the query timeout. "A few tiles", not fine-grained: this is a catalog
# build that runs occasionally, not a live map pan.
_TILES: tuple[tuple[float, float, float, float], ...] = tuple(
    (south, west, south + 23.5, west + 40.0)
    for south in (25.0, 48.5)
    for west in (-170.0, -130.0, -90.0)
)


# ── Overpass plumbing ────────────────────────────────────────────────────

def _overpass_query(session: requests.Session, ql: str, timeout: int = 180) -> list[dict] | None:
    """POST one Overpass QL query. Returns the `elements` list, or None if
    both the request and its one retry failed — callers skip that tile/
    fetch rather than aborting the whole catalog build over one bad tile."""
    headers = {"User-Agent": USER_AGENT}
    for attempt in range(2):
        try:
            resp = session.post(OVERPASS_URL, data={"data": ql}, headers=headers, timeout=timeout)
            resp.raise_for_status()
            return resp.json().get("elements", [])
        except (requests.RequestException, ValueError) as exc:
            log.warning("overpass query failed (attempt %d/2): %s", attempt + 1, exc)
            if attempt == 0:
                time.sleep(1.0)
    return None


def _tile_ql(south: float, west: float, north: float, east: float) -> str:
    bbox = f"{south},{west},{north},{east}"
    return (
        "[out:json][timeout:180];\n"
        "(\n"
        f'  way["landuse"="winter_sports"]({bbox});\n'
        f'  relation["landuse"="winter_sports"]({bbox});\n'
        f'  relation["site"="piste"]({bbox});\n'
        f'  relation["sport"="skiing"]({bbox});\n'
        ");\n"
        "out center tags;"
    )


# ── id / coordinate / value helpers ─────────────────────────────────────

_SLUG_RE = re.compile(r"[^a-z0-9]+")


def _coord_tag(v: float) -> str:
    """Rounded-coordinate fragment for a stable id: 2 decimal places
    (~1 km), sign folded into an 'n' prefix so ids stay URL/filename-safe."""
    iv = int(round(v * 100))
    return f"n{abs(iv)}" if iv < 0 else str(iv)


def _slug(name: str, lat: float, lon: float) -> str:
    base = _SLUG_RE.sub("-", name.lower()).strip("-") or "resort"
    return f"{base}-{_coord_tag(lat)}-{_coord_tag(lon)}"


def _parse_ele(v) -> int | None:
    """Parse an OSM `ele`-style tag. OSM elevations are sometimes plain
    numbers, sometimes "1500 m", sometimes carry a stray '~'. Anything that
    doesn't parse cleanly is dropped rather than guessed at."""
    if v is None:
        return None
    try:
        cleaned = str(v).strip().replace("m", "").replace("~", "").strip()
        return int(round(float(cleaned)))
    except (TypeError, ValueError):
        return None


def _parse_int(v) -> int | None:
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


_COUNTRY_NAMES = {
    "united states": "US", "united states of america": "US", "usa": "US", "us": "US",
    "canada": "CA", "ca": "CA",
    "mexico": "MX", "méxico": "MX", "mx": "MX",
}


def _country_heuristic(lat: float, lon: float) -> str:
    # Crude but adequate for a "no addr:country tag" fallback: Mexico sits
    # south of ~30N along the corridor our bbox covers, Canada north of the
    # 49th-parallel border (imprecise east of the Rockies, fine for skiing
    # geography). Not meant to be border-exact.
    if lat < 30.0:
        return "MX"
    if lat >= 49.0:
        return "CA"
    return "US"


def _country_from_tags(tags: dict, lat: float, lon: float) -> str:
    raw = tags.get("addr:country") or tags.get("is_in:country")
    if raw:
        raw = str(raw).strip()
        if raw.upper() in ("CA", "US", "MX"):
            return raw.upper()
        mapped = _COUNTRY_NAMES.get(raw.lower())
        if mapped:
            return mapped
    return _country_heuristic(lat, lon)


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0088
    p1, p2 = radians(lat1), radians(lat2)
    dphi, dlmb = radians(lat2 - lat1), radians(lon2 - lon1)
    a = sin(dphi / 2) ** 2 + cos(p1) * cos(p2) * sin(dlmb / 2) ** 2
    return 2 * r * asin(sqrt(a))


# ── normalization ────────────────────────────────────────────────────────

def normalize_element(el: dict) -> dict | None:
    """Overpass element (way/relation, `out center tags`) -> catalog entry,
    or None if it's unusable (no name, no coordinates)."""
    tags = el.get("tags") or {}
    name = tags.get("name")
    if not name:
        return None
    center = el.get("center") or {"lat": el.get("lat"), "lon": el.get("lon")}
    lat, lon = center.get("lat"), center.get("lon")
    if lat is None or lon is None:
        return None
    lat, lon = float(lat), float(lon)
    return {
        "id": _slug(name, lat, lon),
        "name": name,
        "lat": round(lat, 5),
        "lon": round(lon, 5),
        "country": _country_from_tags(tags, lat, lon),
        "region": tags.get("addr:state") or tags.get("addr:province") or tags.get("addr:province:en"),
        "website": tags.get("website") or tags.get("contact:website"),
        # Only ele:min/ele:max are attributed to base/summit. A bare `ele`
        # tag on a landuse=winter_sports centroid doesn't say which one it
        # is, and per spec we don't invent — so it's left unused here.
        "ele_base_m": _parse_ele(tags.get("ele:min")),
        "ele_summit_m": _parse_ele(tags.get("ele:max")),
        "osm_type": el.get("type"),
        "osm_id": el.get("id"),
    }


def _find_seed_match(resorts: list[dict], seed: dict, max_km: float = 5.0) -> dict | None:
    sname = seed["name"].lower()
    for r in resorts:
        rname = r["name"].lower()
        if (sname in rname or rname in sname) and _haversine_km(seed["lat"], seed["lon"], r["lat"], r["lon"]) <= max_km:
            return r
    return None


def _merge_seed(resorts: list[dict]) -> list[dict]:
    """Fold wxgrid.resorts_seed.SEED_RESORTS into an OSM-built (or empty)
    catalog. A seed resort that matches an existing entry (same-ish name,
    within 5 km) fills in elevation/region only where OSM left them null —
    OSM data wins where it has it. A seed resort with no match is appended
    outright, so the catalog is never missing the well-known names even
    when Overpass didn't surface them."""
    by_id = {r["id"]: r for r in resorts}
    for seed in SEED_RESORTS:
        match = _find_seed_match(resorts, seed)
        if match is not None:
            if match.get("ele_base_m") is None:
                match["ele_base_m"] = seed["ele_base_m"]
            if match.get("ele_summit_m") is None:
                match["ele_summit_m"] = seed["ele_summit_m"]
            if not match.get("region"):
                match["region"] = seed.get("region")
            if not match.get("website"):
                match["website"] = seed.get("website")
            # `featured` is our product decision, not an OSM tag.  The
            # conditions link is likewise curated: it points at the resort's
            # own operational report rather than pretending OSM is live.
            match["featured"] = bool(seed.get("featured"))
            for key in ("conditions_url", "cams_url", "mountain_cams"):
                if seed.get(key):
                    match[key] = seed[key]
            continue
        sid = _slug(seed["name"], seed["lat"], seed["lon"])
        if sid in by_id:
            continue
        entry = {
            "id": sid, "name": seed["name"], "lat": seed["lat"], "lon": seed["lon"],
            "country": seed["country"], "region": seed.get("region"), "website": seed.get("website"),
            "featured": bool(seed.get("featured")), "conditions_url": seed.get("conditions_url"),
            "cams_url": seed.get("cams_url"), "mountain_cams": seed.get("mountain_cams", []),
            "ele_base_m": seed["ele_base_m"], "ele_summit_m": seed["ele_summit_m"],
            "osm_type": None, "osm_id": None,
        }
        by_id[sid] = entry
        resorts.append(entry)
    return resorts


# ── catalog build / load / cache ────────────────────────────────────────

def _resorts_dir() -> Path:
    return DATA_DIR / "resorts"


def _catalog_path() -> Path:
    return _resorts_dir() / "catalog.json"


def _save_catalog(resorts: list[dict]) -> None:
    path = _catalog_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"built": datetime.now(timezone.utc).isoformat(), "resorts": resorts}
    tmp = path.with_suffix(f".part-{uuid.uuid4().hex[:8]}")
    tmp.write_text(json.dumps(payload, indent=2))
    tmp.replace(path)


def build_catalog(session: requests.Session | None = None) -> list[dict]:
    """Query Overpass across _TILES, normalize + dedupe, merge the curated
    seed list, and save to disk. If every tile fails (Overpass unreachable),
    the on-disk catalog is left untouched — callers get a seed-only list in
    memory rather than a half-built catalog silently overwriting a good one."""
    s = session or requests.Session()
    elements: list[dict] = []
    tiles_ok = 0
    for south, west, north, east in _TILES:
        got = _overpass_query(s, _tile_ql(south, west, north, east))
        if got is not None:
            tiles_ok += 1
            elements.extend(got)
        time.sleep(1.0)   # polite pacing between requests to a free shared service

    by_id: dict[str, dict] = {}
    for el in elements:
        r = normalize_element(el)
        if r is not None:
            by_id[r["id"]] = r   # last-wins; collisions only from ids landing on the same rounded coord

    resorts = _merge_seed(list(by_id.values()))
    global _catalog_cache
    if tiles_ok == 0:
        log.error("overpass unreachable on all %d tiles; catalog.json left as-is, returning seed only", len(_TILES))
        _catalog_cache = resorts
        return resorts

    log.info("overpass build: %d/%d tiles ok, %d OSM elements, %d resorts after seed merge",
              tiles_ok, len(_TILES), len(elements), len(resorts))
    _save_catalog(resorts)
    _catalog_cache = resorts
    return resorts


def load_catalog() -> list[dict]:
    path = _catalog_path()
    if path.exists():
        try:
            data = json.loads(path.read_text())
            resorts = data.get("resorts") or []
            if resorts:
                # Old catalogs remain valid after the curated list gains
                # metadata such as featured pins or official conditions URLs.
                # No expensive rebuild is required just to teach the UI which
                # mountains belong in its Winter mode.
                return _merge_seed(resorts)
        except (json.JSONDecodeError, OSError) as exc:
            log.warning("catalog.json unreadable (%s); falling back to seed", exc)
    # Never built, or built empty/corrupt.
    return _merge_seed([])


_catalog_cache: list[dict] | None = None


def _catalog() -> list[dict]:
    global _catalog_cache
    if _catalog_cache is None:
        _catalog_cache = load_catalog()
    return _catalog_cache


def _find_resort(resort_id: str) -> dict | None:
    for r in _catalog():
        if r["id"] == resort_id:
            return r
    return None


# ── search / nearest ────────────────────────────────────────────────────

def search(q: str, limit: int = 8) -> list[dict]:
    """Case-insensitive prefix matches first, then substring matches."""
    q = (q or "").strip().lower()
    if not q:
        return []
    prefix, substr = [], []
    for r in _catalog():
        name = r["name"].lower()
        if name.startswith(q):
            prefix.append(r)
        elif q in name:
            substr.append(r)
    return (prefix + substr)[:limit]


def nearest(lat: float, lon: float, limit: int = 5, max_km: float = 60.0) -> list[dict]:
    scored = []
    for r in _catalog():
        d = _haversine_km(lat, lon, r["lat"], r["lon"])
        if d <= max_km:
            scored.append((d, r))
    scored.sort(key=lambda t: t[0])
    return [dict(r, distance_km=round(d, 1)) for d, r in scored[:limit]]


# ── per-resort detail (lifts, boundary, elevation) ──────────────────────

def _safe_id(resort_id: str) -> str:
    # ids are already slug-safe from _slug(), but resort_id here can come
    # straight off a URL path param — don't let a crafted id escape the
    # resorts/ cache directory.
    return re.sub(r"[^a-zA-Z0-9_-]", "_", resort_id)


def _detail_path(resort_id: str) -> Path:
    return _resorts_dir() / f"{_safe_id(resort_id)}.json"


def _load_detail_cache(resort_id: str) -> dict | None:
    path = _detail_path(resort_id)
    if not path.exists():
        return None
    age = datetime.now(timezone.utc) - datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
    if age > _DETAIL_TTL:
        return None
    try:
        return json.loads(path.read_text())
    except (json.JSONDecodeError, OSError):
        return None


def _save_detail_cache(resort_id: str, detail: dict) -> None:
    path = _detail_path(resort_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(f".part-{uuid.uuid4().hex[:8]}")
    tmp.write_text(json.dumps(detail, indent=2))
    tmp.replace(path)


def _lift_feature(way: dict) -> dict | None:
    geom = way.get("geometry")
    if not geom:
        return None
    coords = [[pt["lon"], pt["lat"]] for pt in geom]
    tags = way.get("tags") or {}
    props = {
        "name": tags.get("name"),
        "aerialway": tags.get("aerialway"),
        "capacity": _parse_int(tags.get("aerialway:capacity") or tags.get("capacity")),
        "osm_id": way.get("id"),
    }
    return {"type": "Feature", "geometry": {"type": "LineString", "coordinates": coords}, "properties": props}


# Piste difficulty, in the words OSM uses. The map draws these; the legend
# names them. Freeride/extreme are ungroomed, which is a different warning
# from steep, so they keep their own colour rather than being lumped in black.
PISTE_GRADES = ("novice", "easy", "intermediate", "advanced", "expert", "freeride", "extreme")


def _piste_feature(way: dict) -> dict | None:
    geom = way.get("geometry")
    if not geom or len(geom) < 2:
        return None
    tags = way.get("tags") or {}
    grade = (tags.get("piste:difficulty") or "").strip().lower()
    return {"type": "Feature",
            "geometry": {"type": "LineString", "coordinates": [[pt["lon"], pt["lat"]] for pt in geom]},
            "properties": {"name": tags.get("name") or tags.get("piste:name"),
                           "ref": tags.get("ref") or tags.get("piste:ref"),
                           "grade": grade if grade in PISTE_GRADES else "unknown",
                           "gladed": (tags.get("gladed") or tags.get("piste:type:gladed")) == "yes",
                           "grooming": tags.get("piste:grooming"),
                           "osm_id": way.get("id")}}


def _polygon_coords(el: dict) -> list | None:
    if el.get("type") == "way":
        geom = el.get("geometry")
        if not geom or len(geom) < 3:
            return None
        coords = [[pt["lon"], pt["lat"]] for pt in geom]
        if coords[0] != coords[-1]:
            coords.append(coords[0])
        return coords
    if el.get("type") == "relation":
        # Best-effort ring: concatenate outer-role way members in member
        # order. Real multipolygon assembly (stitching disjoint ways into
        # closed rings, honoring inner/hole members) is out of scope for a
        # map overlay — this is good enough to draw a boundary, not to do
        # topology with.
        coords: list = []
        for m in el.get("members", []):
            if m.get("type") == "way" and m.get("role") in ("outer", ""):
                geom = m.get("geometry")
                if geom:
                    coords.extend([[pt["lon"], pt["lat"]] for pt in geom])
        if len(coords) < 3:
            return None
        if coords[0] != coords[-1]:
            coords.append(coords[0])
        return coords
    return None


def _boundary_feature(session: requests.Session, resort: dict) -> dict | None:
    osm_type, osm_id = resort.get("osm_type"), resort.get("osm_id")
    if osm_type and osm_id:
        ql = f"[out:json][timeout:180];\n{osm_type}({osm_id});\nout geom tags;"
    else:
        ql = (
            "[out:json][timeout:180];\n"
            "(\n"
            f'  way["landuse"="winter_sports"](around:6000,{resort["lat"]},{resort["lon"]});\n'
            f'  relation["landuse"="winter_sports"](around:6000,{resort["lat"]},{resort["lon"]});\n'
            ");\n"
            "out geom tags;"
        )
    elements = _overpass_query(session, ql)
    if not elements:
        return None
    coords = _polygon_coords(elements[0])
    if not coords:
        return None
    tags = elements[0].get("tags") or {}
    return {
        "type": "Feature",
        "geometry": {"type": "Polygon", "coordinates": [coords]},
        "properties": {"name": tags.get("name"), "osm_type": elements[0].get("type"), "osm_id": elements[0].get("id")},
    }


def _lift_endpoint_elevations(session: requests.Session, lat: float, lon: float) -> tuple[int | None, int | None]:
    """Fallback elevation source when the resort itself carries no ele:min/
    max: aerialway station nodes (lift bottom/top terminals) often do."""
    ql = f'[out:json][timeout:180];\nnode["aerialway"](around:6000,{lat},{lon});\nout body;'
    elements = _overpass_query(session, ql) or []
    eles = [e for e in (_parse_ele((el.get("tags") or {}).get("ele")) for el in elements) if e is not None]
    if not eles:
        return None, None
    return min(eles), max(eles)


def resort_detail(resort_id: str, session: requests.Session | None = None) -> dict:
    """Lifts (GeoJSON LineStrings) + boundary (GeoJSON Polygon|None) +
    elevation for one resort. Raises ValueError for an unknown id — the
    router turns that into a 404."""
    cached = _load_detail_cache(resort_id)
    if cached is not None and "pistes" not in cached:
        cached = None                    # written before runs were mapped
    if cached is not None:
        # Geometry is deliberately long-lived; catalog metadata is cheap and
        # may have changed since the detail was cached.  Refresh the latter so
        # a new official report link does not wait 30 days to appear.
        current = _find_resort(resort_id)
        if current is not None:
            cached["resort"] = {**(cached.get("resort") or {}), **current}
        return cached

    resort = _find_resort(resort_id)
    if resort is None:
        raise ValueError(f"unknown resort id {resort_id!r}")

    s = session or requests.Session()
    lift_ql = f'[out:json][timeout:180];\nway["aerialway"](around:6000,{resort["lat"]},{resort["lon"]});\nout geom tags;'
    lift_elements = _overpass_query(s, lift_ql) or []
    time.sleep(1.0)
    lifts = [f for f in (_lift_feature(w) for w in lift_elements) if f is not None]

    # The runs themselves. Same radius as the lifts; ways only, because the
    # route relations that group them repeat the same geometry.
    piste_ql = (f'[out:json][timeout:180];\n'
                f'way["piste:type"="downhill"](around:6000,{resort["lat"]},{resort["lon"]});\nout geom tags;')
    piste_elements = _overpass_query(s, piste_ql) or []
    time.sleep(1.0)
    pistes = [f for f in (_piste_feature(w) for w in piste_elements) if f is not None]

    boundary = _boundary_feature(s, resort)
    time.sleep(1.0)

    base_m, summit_m = resort.get("ele_base_m"), resort.get("ele_summit_m")
    if base_m is None or summit_m is None:
        lo, hi = _lift_endpoint_elevations(s, resort["lat"], resort["lon"])
        base_m = base_m if base_m is not None else lo
        summit_m = summit_m if summit_m is not None else hi
    if (base_m is None or summit_m is None) and lifts:
        # OSM rarely tags elevations; ask a DEM for every lift's two ends
        # instead. Bottom of the lowest lift ≈ base, top of the highest ≈ summit.
        from wxgrid.ext import elevations as _dem
        ends = []
        for f in lifts:
            coords = f["geometry"]["coordinates"]
            if len(coords) >= 2:
                ends.append((coords[0][1], coords[0][0]))
                ends.append((coords[-1][1], coords[-1][0]))
        vals = [v for v in _dem(ends[:200]) if v is not None]
        if vals:
            base_m = base_m if base_m is not None else int(round(min(vals)))
            summit_m = summit_m if summit_m is not None else int(round(max(vals)))

    detail = {
        "resort": resort,
        "lifts": {"type": "FeatureCollection", "features": lifts},
        "pistes": {"type": "FeatureCollection", "features": pistes},
        "boundary": boundary,
        "elevation": {"base_m": base_m, "summit_m": summit_m},
    }
    _save_detail_cache(resort_id, detail)
    return detail
