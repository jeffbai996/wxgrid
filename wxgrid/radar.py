"""Agency weather radar frame lists, plus the OVATION aurora nowcast.

The front end used to draw RainViewer's global composite and nothing else.
RainViewer is fine as a worldwide fallback but it is a re-mosaic of other
people's radars; where a national agency publishes its own composite we would
rather show that one, at its own cadence and colour table:

  ECCC GeoMet WMS       RADAR_1KM_RRAI / RADAR_1KM_RSNO, 1 km North American
                        composite, one frame every 6 min over a 3 h window.
                        Frame list comes from a WMS GetCapabilities `time`
                        dimension written as start/end/period.
  NOAA MRMS (NCEP)      conus_cref_qcd — quality-controlled 1 km CONUS
                        composite reflectivity, a frame roughly every 2 min
                        over ~2 h. Its `time` dimension is an explicit list.
  Iowa State (IEM)      a pre-seeded XYZ tile cache of the NEXRAD N0Q
                        composite at 5-minute offsets (…-m05m, -m10m, …).
                        No capabilities call at all, so it is the standby
                        when the MRMS GetCapabilities is slow or down.
  RainViewer            everywhere else, and the last resort everywhere.

All four are keyless and all four send `Access-Control-Allow-Origin: *`, which
is what MapLibre needs to pull their tiles into WebGL. This module only ever
fetches *frame lists* — the tiles themselves go straight from the browser to
the agency, so the server never proxies imagery.

Aurora is the exception: NOAA SWPC publishes OVATION as a JSON grid of
probabilities, not as tiles, so we render it here into a Web-Mercator PNG the
map can drape.

Everything is cached in memory with a short TTL. Nothing here touches the store.
"""
from __future__ import annotations

import io
import logging
import math
import re
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from typing import Any

import numpy as np
import requests
from PIL import Image

from wxgrid.ext import cache

log = logging.getLogger("wxgrid.radar")
UA = "wxgrid/0.2 (+https://github.com/jeffbai996/wxgrid)"
_session = requests.Session()
_session.headers["User-Agent"] = UA

GEOMET = "https://geo.weather.gc.ca/geomet"
MRMS_WMS = "https://opengeo.ncep.noaa.gov/geoserver/conus/conus_cref_qcd/ows"
IEM_TILES = "https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0"
RAINVIEWER = "https://api.rainviewer.com/public/weather-maps.json"
OVATION = "https://services.swpc.noaa.gov/json/ovation_aurora_latest.json"
KP_1M = "https://services.swpc.noaa.gov/json/planetary_k_index_1m.json"

FRAMES_TTL = 120.0        # radar frame lists; every source updates on minutes
AURORA_TTL = 300.0        # OVATION is recomputed every ~5 min
KP_TTL = 300.0
MAX_FRAMES = 36           # what the tape can scrub without becoming soup


# ── ISO 8601 time dimensions ─────────────────────────────────────────────
# WMS 1.3.0 lets a server write the `time` dimension either way, and the two
# agencies we use picked one each: GeoMet writes an interval
# ("…19:06:00Z/…22:06:00Z/PT6M"), GeoServer writes every value it holds.

_DUR = re.compile(r"^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?"
                  r"(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$")


def parse_duration(text: str) -> float:
    """ISO 8601 duration → seconds. Years/months are nominal (365 d / 30 d);
    radar periods are minutes, so the approximation never bites."""
    m = _DUR.match(text.strip())
    if not m or not any(m.groups()):
        raise ValueError(f"not an ISO 8601 duration: {text!r}")
    y, mo, d, h, mi, s = (float(g or 0) for g in m.groups())
    return y * 365 * 86400 + mo * 30 * 86400 + d * 86400 + h * 3600 + mi * 60 + s


def parse_time(text: str) -> datetime:
    """One ISO 8601 instant, with or without fractional seconds, as UTC."""
    t = text.strip().replace("Z", "+00:00")
    dt = datetime.fromisoformat(t)
    return dt.astimezone(timezone.utc) if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def parse_time_dimension(text: str, max_frames: int = MAX_FRAMES) -> list[datetime]:
    """A WMS `time` dimension value → the newest `max_frames` instants.

    Accepts a comma-separated list, one or more start/end/period intervals, or
    a mix of the two (the spec allows it, and GeoServer does emit it). When a
    source offers more frames than we want, thin evenly rather than truncating
    — a 2 h loop at half the cadence still reads as a loop; the last 20 min of
    a 2 h window does not."""
    out: list[datetime] = []
    for part in text.replace("\n", " ").split(","):
        part = part.strip()
        if not part:
            continue
        if part.count("/") == 2:
            start, end, period = part.split("/")
            try:
                t0, t1, step = parse_time(start), parse_time(end), parse_duration(period)
            except ValueError:
                continue
            if step <= 0 or t1 < t0:
                continue
            n = min(int((t1 - t0).total_seconds() // step), 4096)   # a malformed period can't blow the heap
            out.extend(t0 + timedelta(seconds=i * step) for i in range(n + 1))
        else:
            try:
                out.append(parse_time(part))
            except ValueError:
                continue
    out = sorted(set(out))
    if len(out) > max_frames:
        # Keep the newest frame exactly; step back through the rest evenly.
        idx = sorted({len(out) - 1 - round(i * (len(out) - 1) / (max_frames - 1)) for i in range(max_frames)})
        out = [out[i] for i in idx]
    return out


MAX_CAPS_BYTES = 8 * 1024 * 1024      # NCEP's full catalogue is ~2.4 MB


def wms_time_dimension(xml: str | bytes, layer: str) -> str | None:
    """The raw `time` dimension text for one named layer of a WMS
    GetCapabilities document.

    WMS namespaces the 1.3.0 document and leaves 1.1.1 bare, and dimensions are
    inherited by nested layers, so: find the <Layer> whose <Name> matches, then
    walk back up its ancestors until a time dimension turns up.

    ElementTree is safe enough here: CPython's expat binding never resolves
    external entities and raises on undefined internal ones, so neither XXE nor
    billion-laughs applies. The size cap is the remaining guard, against an
    upstream that starts streaming something enormous."""
    if len(xml) > MAX_CAPS_BYTES:
        raise ValueError(f"WMS capabilities document too large ({len(xml)} bytes)")
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return None
    parent = {c: p for p in root.iter() for c in p}

    def tag(e) -> str:
        return e.tag.split("}")[-1]

    def time_dim(e) -> str | None:
        for c in e:
            if tag(c) in ("Dimension", "Extent") and c.get("name", "").lower() == "time" and (c.text or "").strip():
                return c.text.strip()
        return None

    for el in root.iter():
        if tag(el) != "Layer":
            continue
        name = next((c.text for c in el if tag(c) == "Name"), None)
        if (name or "").strip() != layer:
            continue
        node = el
        while node is not None:
            found = time_dim(node)
            if found:
                return found
            node = parent.get(node)
    return None


def _get_text(url: str, params: dict | None = None, timeout: int = 25) -> str:
    r = _session.get(url, params=params, timeout=timeout)
    r.raise_for_status()
    return r.text


def _get_json(url: str, params: dict | None = None, timeout: int = 25) -> Any:
    r = _session.get(url, params=params, timeout=timeout)
    r.raise_for_status()
    return r.json()


# ── which agency owns the view ───────────────────────────────────────────
# ECCC's mosaic is North American and MRMS reaches a little into Canada, so a
# misclassification near the border still shows radar — but the label would be
# wrong, and the label is half the point. Rather than a rectangle that calls
# Toronto American, interpolate the actual border latitude by longitude.

_BORDER = [        # (lon, border latitude) west → east
    (-141.0, 60.0), (-141.0, 49.0), (-123.0, 49.0), (-95.15, 49.0),
    (-92.0, 48.4), (-89.5, 48.0), (-84.5, 46.5), (-83.1, 45.9),
    (-82.4, 43.0), (-79.0, 43.2), (-76.8, 43.6), (-74.7, 45.0),
    (-71.5, 45.0), (-69.2, 47.4), (-67.8, 47.1), (-67.0, 45.1),
    # East of the Bay of Fundy there is no land border, only water, so the line
    # drops south of Nova Scotia — otherwise Halifax reads as nobody's.
    (-66.5, 43.4), (-60.0, 43.3), (-52.0, 43.3),
]
CANADA_BOX = (41.0, 84.5, -141.5, -50.0)     # lat_min, lat_max, lon_min, lon_max
CONUS_BOX = (23.5, 50.0, -127.0, -65.0)


def border_lat(lon: float) -> float:
    """The Canada/US border latitude at this longitude, linearly interpolated
    between the vertices above. Outside the table, the nearest endpoint."""
    lons = [p[0] for p in _BORDER]
    lats = [p[1] for p in _BORDER]
    return float(np.interp(lon, lons, lats))


def _in_box(lat: float, lon: float, box: tuple[float, float, float, float]) -> bool:
    return box[0] <= lat <= box[1] and box[2] <= lon <= box[3]


def pick_source(lat: float, lon: float) -> str:
    """Which radar source covers this map centre best.

    Canada wins the border because ECCC's composite is the authoritative one
    north of it; MRMS wins CONUS because it is NOAA's own quality-controlled
    product rather than a re-mosaic. Anywhere else there is no keyless agency
    composite, so RainViewer."""
    if _in_box(lat, lon, CANADA_BOX) and lat > border_lat(lon):
        return "eccc"
    if _in_box(lat, lon, CONUS_BOX):
        return "mrms"
    return "rainviewer"


# ── frame lists, one function per source ─────────────────────────────────

def _epoch(dt: datetime) -> int:
    return int(dt.timestamp())


def _frames_from_times(times: list[datetime]) -> list[dict]:
    return [{"time": _epoch(t), "iso": t.strftime("%Y-%m-%dT%H:%M:%SZ"),
             "token": t.strftime("%Y-%m-%dT%H:%M:%SZ"), "kind": "past"} for t in times]


def eccc_frames() -> list[dict]:
    """ECCC GeoMet: one GetCapabilities per layer, both carrying the same
    6-minute time dimension. We ask for RRAI's and reuse it for RSNO."""
    xml = _get_text(GEOMET, {"SERVICE": "WMS", "VERSION": "1.3.0",
                             "REQUEST": "GetCapabilities", "LAYERS": "RADAR_1KM_RRAI"}, timeout=30)
    dim = wms_time_dimension(xml, "RADAR_1KM_RRAI")
    if not dim:
        raise ValueError("GeoMet capabilities carried no time dimension for RADAR_1KM_RRAI")
    return _frames_from_times(parse_time_dimension(dim))


def mrms_frames() -> list[dict]:
    xml = _get_text(MRMS_WMS, {"service": "WMS", "version": "1.3.0",
                               "request": "GetCapabilities"}, timeout=30)
    dim = wms_time_dimension(xml, "conus_cref_qcd")
    if not dim:
        raise ValueError("NCEP capabilities carried no time dimension for conus_cref_qcd")
    return _frames_from_times(parse_time_dimension(dim))


def iem_frames(now: float | None = None) -> list[dict]:
    """The IEM tile cache keeps one layer per 5-minute offset, named -m05m …
    -m55m, plus the unsuffixed 'latest'. No network call: the naming *is* the
    time index, and IEM re-seeds the caches in place."""
    now = time.time() if now is None else now
    latest = math.floor(now / 300.0) * 300.0      # tiles are seeded on the 5s
    out = []
    for mins in range(55, -1, -5):
        out.append({"time": int(latest - mins * 60),
                    "iso": datetime.fromtimestamp(latest - mins * 60, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "token": f"-m{mins:02d}m" if mins else "", "kind": "past"})
    return out


def rainviewer_frames() -> list[dict]:
    j = _get_json(RAINVIEWER, timeout=20)
    host = j.get("host", "")
    radar = j.get("radar") or {}
    out = []
    for kind in ("past", "nowcast"):
        for fr in radar.get(kind) or []:
            out.append({"time": int(fr["time"]), "token": fr["path"],
                        "iso": datetime.fromtimestamp(fr["time"], timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                        "kind": kind})
    return [{"host": host, **f} for f in out]


# ── the catalogue the front end builds its timeline from ─────────────────
# `{token}` is whatever identifies a frame for that source: an ISO instant for
# the two WMS services, a cache-name suffix for IEM, a path for RainViewer.
# {bbox-epsg-3857} and {z}/{x}/{y} are MapLibre's own placeholders.

_WMS = ("{base}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS={layers}&CRS=EPSG:3857"
        "&BBOX={{bbox-epsg-3857}}&WIDTH=256&HEIGHT=256&FORMAT=image/png&TRANSPARENT=TRUE"
        "&STYLES={styles}&TIME={{token}}")

SOURCE_SPECS: dict[str, dict] = {
    "eccc": {
        "label": "ECCC 1 km composite",
        "detail": "Environment and Climate Change Canada · rain + snow rate · 6 min",
        "attribution": 'Radar © <a href="https://eccc-msc.github.io/open-data/">Environment and Climate Change Canada</a>',
        "templates": [
            _WMS.format(base=GEOMET, layers="RADAR_1KM_RRAI", styles="RADARURPPRECIPR14"),
            _WMS.format(base=GEOMET, layers="RADAR_1KM_RSNO", styles="RADARURPPRECIPS14"),
        ],
        "bounds": [-141.5, 41.0, -50.0, 84.5],
        "fetch": eccc_frames,
    },
    "mrms": {
        "label": "NOAA MRMS",
        "detail": "Multi-Radar Multi-Sensor · quality-controlled composite reflectivity · 2 min",
        "attribution": 'Radar © <a href="https://www.nssl.noaa.gov/projects/mrms/">NOAA MRMS</a>',
        "templates": [
            ("{base}?service=WMS&version=1.3.0&request=GetMap&layers=conus_cref_qcd&crs=EPSG:3857"
             "&bbox={{bbox-epsg-3857}}&width=256&height=256&format=image/png&transparent=true"
             "&styles=radar_reflectivity&time={{token}}").format(base=MRMS_WMS),
        ],
        "bounds": [-127.0, 23.5, -65.0, 50.0],
        "fetch": mrms_frames,
    },
    "iem": {
        "label": "NEXRAD N0Q (IEM)",
        "detail": "Iowa State mesonet cache of the NWS base-reflectivity composite · 5 min",
        "attribution": 'Radar © <a href="https://mesonet.agron.iastate.edu/">Iowa Environmental Mesonet</a> / NWS NEXRAD',
        "templates": [IEM_TILES + "/nexrad-n0q-900913{token}/{z}/{x}/{y}.png"],
        "bounds": [-127.0, 23.5, -65.0, 50.0],
        "fetch": iem_frames,
    },
    "rainviewer": {
        "label": "RainViewer",
        "detail": "Global composite · last 2 h plus nowcast · 10 min",
        "attribution": 'Radar © <a href="https://www.rainviewer.com/">RainViewer</a>',
        "templates": ["{host}{token}/256/{z}/{x}/{y}/2/1_1.png"],
        "bounds": [-180.0, -85.0, 180.0, 85.0],
        "fetch": rainviewer_frames,
    },
}

# Where a source is preferred but broken, try the next one down its chain.
FALLBACK = {"eccc": ["rainviewer"], "mrms": ["iem", "rainviewer"], "iem": ["rainviewer"], "rainviewer": []}


def source(sid: str) -> dict:
    """One source with its frame list. Never raises: a source that cannot be
    reached comes back with `frames: []` and an `error`, and the caller falls
    down the chain."""
    spec = SOURCE_SPECS[sid]

    def fetch():
        try:
            frames = spec["fetch"]()
            err = None
        except Exception as exc:                    # upstream down, slow, or reshaped
            log.warning("radar source %s unavailable: %s", sid, exc)
            frames, err = [], str(exc)[:200]
        return {"frames": frames, "error": err}

    got = cache.get(f"radar:frames:{sid}", FRAMES_TTL, fetch)
    templates = list(spec["templates"])
    frames = got["frames"]
    if sid == "rainviewer" and frames:              # host is per-response, bake it in
        templates = [t.replace("{host}", frames[0].get("host", "")) for t in templates]
    return {"id": sid, "label": spec["label"], "detail": spec["detail"],
            "attribution": spec["attribution"], "bounds": spec["bounds"],
            "templates": templates,
            "frames": [{k: v for k, v in f.items() if k != "host"} for f in frames],
            "error": got["error"]}


def sources(lat: float | None = None, lon: float | None = None) -> dict:
    """Every source, plus the id the given map centre should use. `order` is
    the preference chain the front end walks when `picked` comes back empty."""
    out = [source(s) for s in SOURCE_SPECS]
    picked = pick_source(lat, lon) if lat is not None and lon is not None else "rainviewer"
    order = [picked] + [s for s in FALLBACK.get(picked, []) if s != picked]
    if "rainviewer" not in order:
        order.append("rainviewer")
    return {"picked": picked, "order": order, "sources": out}


# ── aurora: NOAA SWPC OVATION ────────────────────────────────────────────
# The nowcast is a 1° JSON grid of "chance of seeing the aurora", not tiles, so
# it gets projected and coloured here and served as one image the map drapes
# over the whole world — the same trick the model layers use.

OV_LON, OV_LAT = 360, 181         # lon 0..359, lat -90..90
MERC_LAT_MAX = 85.05112878
OUT_W, OUT_H = 720, 720

# (probability %, rgb). Green through yellow into magenta: the ramp aurora
# photographers already read, and it keeps the low end legible over dark maps.
AURORA_STOPS = [(0, (0, 90, 60)), (2, (0, 130, 70)), (8, (30, 190, 90)),
                (20, (150, 225, 70)), (35, (245, 220, 70)), (55, (255, 130, 90)),
                (75, (255, 70, 170)), (100, (255, 110, 245))]
AURORA_MIN_PCT = 2.0              # below this the layer is fully transparent


def ovation() -> dict:
    """The raw nowcast, cached. `grid` is (181, 360) float32, row 0 = 90°S,
    column 0 = 0°E."""
    def fetch():
        j = _get_json(OVATION, timeout=40)
        pts = j.get("coordinates") or []
        grid = np.zeros((OV_LAT, OV_LON), dtype=np.float32)
        for lon, lat, prob in pts:
            grid[int(lat) + 90, int(lon) % OV_LON] = prob
        return {"observation_time": j.get("Observation Time"),
                "forecast_time": j.get("Forecast Time"),
                "max_pct": float(grid.max()),
                "grid": grid.tolist()}
    return cache.get("radar:ovation", AURORA_TTL, fetch)


def kp_now() -> dict | None:
    """Latest 1-minute planetary K index. `estimated_kp` is the continuous
    value; `kp_index` is the rounded one people quote."""
    def fetch():
        rows = _get_json(KP_1M, timeout=25)
        if not rows:
            return None
        last = rows[-1]
        return {"time": last.get("time_tag"), "kp": float(last.get("estimated_kp", last.get("kp_index", 0))),
                "kp_index": int(last.get("kp_index", 0)), "label": last.get("kp")}
    try:
        return cache.get("radar:kp", KP_TTL, fetch)
    except Exception as exc:
        log.warning("SWPC Kp unavailable: %s", exc)
        return None


def _aurora_lut() -> np.ndarray:
    """256×4 RGBA lookup over 0..100 %, alpha ramping in above the noise floor."""
    xs = np.array([s[0] for s in AURORA_STOPS], dtype=np.float64)
    cols = np.array([s[1] for s in AURORA_STOPS], dtype=np.float64)
    v = np.arange(256) * 100.0 / 255.0
    lut = np.zeros((256, 4), dtype=np.uint8)
    for c in range(3):
        lut[:, c] = np.clip(np.interp(v, xs, cols[:, c]), 0, 255).astype(np.uint8)
    # Transparent under 2 %, full strength by ~12 %; the visible band is thin
    # and a hard edge at the cut-off looks like a bug rather than a boundary.
    a = np.clip((v - AURORA_MIN_PCT) / 10.0, 0.0, 1.0) ** 0.8
    lut[:, 3] = (a * 0.85 * 255).astype(np.uint8)
    lut[0, 3] = 0
    return lut


_LUT: np.ndarray | None = None


def to_mercator(grid: np.ndarray, width: int = OUT_W, height: int = OUT_H) -> np.ndarray:
    """(181, 360) lat/lon, row 0 = 90°S, col 0 = 0°E → (height, width) Web
    Mercator, row 0 = +85.05°, col 0 = 180°W.

    Cubic, not bilinear: at 1° the oval's edge is a diagonal across very few
    cells, and bilinear resampling turns that into visible staircase facets
    that look like a rendering bug rather than the coarse grid it is. Cubic
    still passes through every data point; the clip catches its overshoot."""
    from scipy.ndimage import map_coordinates
    r = (np.arange(height, dtype=np.float64) + 0.5) / height
    lat = np.degrees(np.arctan(np.sinh(math.pi * (1.0 - 2.0 * r))))
    rows = np.clip(lat + 90.0, 0, OV_LAT - 1)                  # +90 → index
    lon = -180.0 + 360.0 * (np.arange(width, dtype=np.float64) + 0.5) / width
    cols = (lon % 360.0) / 360.0 * OV_LON
    rr, cc = np.meshgrid(rows, cols, indexing="ij")
    out = map_coordinates(grid, [rr, cc], order=3, mode="grid-wrap")
    return np.clip(out, 0.0, 100.0).astype(np.float32)


def aurora_png(width: int = OUT_W, height: int = OUT_H) -> bytes:
    """The nowcast as an RGBA PNG spanning the whole Mercator world, ready for
    a MapLibre ImageSource with the usual four world corners."""
    global _LUT
    if _LUT is None:
        _LUT = _aurora_lut()
    grid = np.asarray(ovation()["grid"], dtype=np.float32)
    merc = to_mercator(grid, width, height)
    idx = np.clip(merc / 100.0 * 255.0, 0, 255).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(_LUT[idx], "RGBA").save(buf, format="PNG", optimize=False, compress_level=6)
    return buf.getvalue()


def aurora_meta() -> dict:
    """What the label needs: when the nowcast is valid for, how strong it gets,
    and the current Kp."""
    ov = ovation()
    return {"observation_time": ov["observation_time"], "forecast_time": ov["forecast_time"],
            "max_pct": round(ov["max_pct"], 1), "min_pct": AURORA_MIN_PCT,
            "kp": kp_now(),
            "source": "NOAA SWPC OVATION aurora nowcast",
            "stops": [{"pct": p, "rgb": list(c)} for p, c in AURORA_STOPS]}


# ── lightning ────────────────────────────────────────────────────────────
# Deliberately not implemented. Everything checked on 2026-08-18:
#
#   NASA GIBS         carries no near-real-time GOES GLM layer. Its lightning
#                     products are LIS/OTD/DMSP climatologies, and the GOES-East
#                     set stops at ABI (GeoColor, Band 13, Air Mass, Dust,
#                     FireTemp) — there is no GLM or FLASH imagery layer.
#   NOAA/NWS          mapservices.weather.noaa.gov publishes no lightning
#                     service in any folder (eventdriven/raster/vector/static),
#                     and the NCEP GeoServer only exposes radar and QPE.
#                     nowCOAST, which used to carry GLM, was retired.
#   SSEC RealEarth    has GLM products but every tile request without an API
#                     key returns 404.
#   Blitzortung       is a volunteer network: raw and archive access is gated
#                     behind a station-operator login, and the real-time
#                     WebSocket its own maps use is undocumented and unofficial.
#                     lightningmaps.org is the same data under the same terms.
#                     Scraping either would be taking data the project has
#                     chosen not to publish openly, so we do not.
#
# The honest answer is that there is no keyless, redistributable, near-real-time
# lightning observation feed. `WX.ov.loadThunder()` already draws model-derived
# thunderstorm marks from CAPE + precipitation, which is a forecast, not an
# observation, and is labelled as such.

LIGHTNING_STATUS = {
    "available": False,
    "reason": ("No keyless near-real-time lightning observation feed exists. NASA GIBS carries only "
               "LIS/OTD/DMSP climatologies (no operational GOES GLM); NWS mapservices and the NCEP "
               "GeoServer publish no lightning layer since nowCOAST was retired; SSEC RealEarth's GLM "
               "products need an API key. Blitzortung/LightningMaps gate raw and archive access behind "
               "a contributing-station login and their live socket is undocumented, so we do not scrape it."),
    "checked": "2026-08-18",
    "alternative": "The Thunder overlay marks model CAPE + precipitation — a forecast, not observed strikes.",
}
