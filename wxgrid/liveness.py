"""Active liveness probes for every external source wxgrid leans on.

wxgrid.ext's `/api/health` watches host *reachability*: an upstream is "down"
when its most recent try failed. That misses two ways a source can rot while
still answering HTTP 200 — a body that is an error document wearing the
content-type of a real one (GeoMet's WMS answered "InvalidLayersParameter"
inside a 200 for as long as the layer was misnamed "ALERTS", and nobody
noticed until an agent read the response body), and a host nobody has queried
in ordinary traffic yet, which never appears in upstream_health at all.

A liveness probe is not "no exception" — it is an assertion about the SHAPE of
a live answer: a parsed feature count above zero, an expected key present, a
timestamp inside a sane window, a raster with more than one colour in it.
Clearing that bar is what "live" means here; reachability alone is not.

Each entry in PROBES pairs one upstream call with the assertion that decides
whether the answer was actually usable. `run_all` runs every probe with a
bounded per-probe wait and a small concurrency cap, never raises, and returns
one record per source. `sweep()` runs the registry and persists the result
plus a rolling per-source history (so the answer can tell "failed once just
now" from "has been dead for six days"); `ensure_fresh()` is what a
user-facing endpoint calls — it serves the last stored sweep and kicks a
background refresh only when that sweep is older than SWEEP_TTL. Probing
never happens inline on a request.

Design notes that matter for reading the assertions below:

  * Every probe talks straight to ONE upstream host with its own request,
    independent of wxgrid.ext's shared TTL cache — a probe on its own liveness
    schedule must not be satisfied by a stale cached success, and must not be
    fooled by a merged/fallback wrapper (wxgrid.ext.avy_point tries Avalanche
    Canada then falls back to avalanche.org; calling it would hide either one
    going dark behind the other still answering).
  * Where a sibling module already owns the parsing of a single-source feed
    with no such fallback (wxgrid.radar's WMS-capabilities and OVATION/Kp
    readers, wxgrid.cams's NOMADS directory listing, wxgrid.resorts's Overpass
    client), the probe calls that function directly rather than
    re-implementing the parser — one less place for the two copies to drift
    apart.
  * A handful of assertions require a non-zero count where the true count
    could in principle be zero (BoM's CAP-AU directory during a lull, the
    Canadian wildfire feeds outside fire season). That trade-off is
    deliberate: at the moment this module was written it is wildfire season
    and Australia reliably carries active marine/land warnings, so a zero
    reads as a broken feed far more often than as reality. If this ever runs
    through a genuinely quiet season, tighten thresholds first, not the
    other way round.
"""
from __future__ import annotations

import argparse
import ftplib
import io
import json
import logging
import re
import sys
import threading
import time
import uuid
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, wait as _wait
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Sequence

import requests
from PIL import Image

from wxgrid import cams, radar, resorts
from wxgrid.config import CACHE_DIR
from wxgrid.ext import (
    AVCAN, AVORG, EC_ALERTS_LAYER, EC_BBOX, GEOMET as EC_GEOMET, MA_ATOM, NWS,
    _webmerc,
)

log = logging.getLogger("wxgrid.liveness")

UA = "wxgrid/0.2 (+https://github.com/jeffbai996/wxgrid)"
_session = requests.Session()
_session.headers["User-Agent"] = UA

PROBE_TIMEOUT = 90.0        # wall-clock bound on the whole sweep waiting for stragglers
POOL_SIZE = 6               # a low concurrency cap: a liveness sweep must not itself be a load spike
SWEEP_TTL = 25 * 60         # a running instance polls each source at most a few times an hour
HISTORY_LEN = 60            # bounded rolling history per source (weeks of 25-min sweeps)

STATE_PATH = Path(CACHE_DIR) / "liveness.json"


# ── small parsing helpers ─────────────────────────────────────────────────

def _require(cond: Any, message: str) -> None:
    if not cond:
        raise AssertionError(message)


def _parse_ts(value: Any) -> datetime | None:
    """Best-effort timestamp parse: epoch seconds, or an ISO-ish string with
    or without a trailing Z, milliseconds, or a timezone at all. None when the
    value is missing or not a timestamp — callers treat that as "can't judge
    freshness", not as failure, since not every field is guaranteed present."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        try:
            return datetime.fromtimestamp(float(value), tz=timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    s = str(value).strip()
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _age_seconds(value: Any) -> float | None:
    dt = _parse_ts(value)
    return None if dt is None else (datetime.now(timezone.utc) - dt).total_seconds()


def _distinct_colors(png_bytes: bytes, cap: int = 4096) -> int:
    """How many distinct RGBA colours a PNG carries, capped for speed. A count
    at or above `cap` is reported as `cap + 1` — unambiguously "more than
    one" without enumerating a busy image pixel by pixel."""
    im = Image.open(io.BytesIO(png_bytes)).convert("RGBA")
    colors = im.getcolors(maxcolors=cap)
    return cap + 1 if colors is None else len(colors)


# ── the probe type ────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Probe:
    key: str
    label: str
    call: Callable[[], Any]           # makes the request(s); returns raw data or raises
    assertion: Callable[[Any], str]   # raw data -> a short "why this is live" string, or raises


@dataclass(frozen=True)
class ProbeRecord:
    key: str
    label: str
    ok: bool
    detail: str
    error: str
    ms: int
    ts: float

    def to_json(self) -> dict:
        return {"key": self.key, "label": self.label, "ok": self.ok, "detail": self.detail,
                "error": self.error, "ms": self.ms, "ts": self.ts}


# ── geocoding (Nominatim) ─────────────────────────────────────────────────

def _call_nominatim() -> Any:
    r = _session.get("https://nominatim.openstreetmap.org/search",
                      params={"q": "Vancouver", "format": "jsonv2", "limit": 1}, timeout=20)
    r.raise_for_status()
    return r.json()


def _assert_nominatim(data: Any) -> str:
    _require(isinstance(data, list) and data, "no search results returned")
    hit = data[0]
    lat, lon = float(hit["lat"]), float(hit["lon"])
    _require(-90 <= lat <= 90 and -180 <= lon <= 180, f"implausible coordinates {lat},{lon}")
    return f"{len(data)} hit(s), first: {hit.get('display_name', '')[:60]}"


# ── elevation + timezone (Open-Meteo) ─────────────────────────────────────

def _call_elevation() -> Any:
    r = _session.get("https://api.open-meteo.com/v1/elevation",
                      params={"latitude": 39.7392, "longitude": -104.9903}, timeout=15)  # Denver, ~1600 m
    r.raise_for_status()
    return r.json()


def _assert_elevation(data: Any) -> str:
    vals = (data or {}).get("elevation") or []
    _require(vals, "no elevation value returned")
    v = float(vals[0])
    _require(500.0 <= v <= 3000.0, f"implausible elevation {v} m for a point known to be ~1600 m")
    return f"{v:.0f} m at a known ~1600 m point"


def _call_timezone() -> Any:
    r = _session.get("https://api.open-meteo.com/v1/forecast",
                      params={"latitude": 49.2827, "longitude": -123.1207, "timezone": "auto",
                              "forecast_days": 1, "daily": "sunrise"}, timeout=15)
    r.raise_for_status()
    return r.json()


def _assert_timezone(data: Any) -> str:
    tz = (data or {}).get("timezone")
    off = (data or {}).get("utc_offset_seconds")
    _require(tz == "America/Vancouver", f"unexpected zone for a Vancouver point: {tz!r}")
    _require(isinstance(off, int), "no utc_offset_seconds in the response")
    return f"{tz} ({off // 3600:+d}h)"


# ── observations: METAR / TAF (aviationweather.gov) ───────────────────────

def _call_metar() -> Any:
    r = _session.get("https://aviationweather.gov/api/data/metar",
                      params={"ids": "KSEA", "format": "json", "hours": 3}, timeout=15)
    r.raise_for_status()
    return r.json()


def _assert_metar(data: Any) -> str:
    _require(isinstance(data, list) and data, "no METAR returned for KSEA")
    ob = data[0]
    age = _age_seconds(ob.get("reportTime"))
    _require(age is not None and age < 6 * 3600, f"report time {ob.get('reportTime')!r} is stale or unparseable")
    return f"KSEA {ob.get('reportTime')} ({age / 60:.0f} min old)"


def _call_taf() -> Any:
    r = _session.get("https://aviationweather.gov/api/data/taf",
                      params={"ids": "KSEA", "format": "json"}, timeout=15)
    r.raise_for_status()
    return r.json()


def _assert_taf(data: Any) -> str:
    _require(isinstance(data, list) and data, "no TAF returned for KSEA")
    raw = data[0].get("rawTAF") or ""
    _require(raw.startswith("TAF"), f"TAF body does not start with 'TAF': {raw[:40]!r}")
    return f"KSEA issued {data[0].get('issueTime')}"


# ── avalanche ──────────────────────────────────────────────────────────────

def _call_avalanche_ca() -> Any:
    r = _session.get(f"{AVCAN}/areas", timeout=30)
    r.raise_for_status()
    return r.json()


def _assert_avalanche_ca(data: Any) -> str:
    feats = (data or {}).get("features") or []
    _require(len(feats) > 0, "zero forecast regions")
    return f"{len(feats)} forecast region(s)"


def _call_avalanche_org() -> Any:
    r = _session.get(f"{AVORG}/products/map-layer", timeout=30)
    r.raise_for_status()
    return r.json()


def _assert_avalanche_org(data: Any) -> str:
    feats = (data or {}).get("features") or []
    _require(len(feats) > 0, "zero forecast zones")
    return f"{len(feats)} forecast zone(s)"


# ── alerts: NWS ────────────────────────────────────────────────────────────

def _call_nws_alerts() -> Any:
    r = _session.get(f"{NWS}/alerts/active/count", timeout=20)
    r.raise_for_status()
    return r.json()


def _assert_nws_alerts(data: Any) -> str:
    total = (data or {}).get("total")
    areas = (data or {}).get("areas")
    _require(isinstance(total, int) and total >= 0, f"no numeric total in the response ({total!r})")
    _require(isinstance(areas, dict), "no per-area breakdown in the response")
    return f"{total} active alert(s) nationwide"


# ── alerts: MeteoAlarm (Europe) ────────────────────────────────────────────

def _call_meteoalarm() -> Any:
    r = _session.get(MA_ATOM.format("france"), timeout=25)
    r.raise_for_status()
    return r.text


def _assert_meteoalarm(text: Any) -> str:
    root = ET.fromstring(text)
    tag = root.tag.split("}")[-1]
    _require(tag == "feed", f"root element is <{tag}>, not an Atom <feed>")
    title = next((c.text for c in root if c.tag.split("}")[-1] == "title"), None)
    _require(title, "atom feed carries no <title>")
    entries = sum(1 for c in root if c.tag.split("}")[-1] == "entry")
    return f"Atom feed OK, {entries} entr{'y' if entries == 1 else 'ies'}"


# ── alerts: BoM (Australia) ────────────────────────────────────────────────

BOM_FTP_HOST = "ftp.bom.gov.au"
BOM_CAP_DIR = "anon/gen/fwo"


def _call_bom() -> Any:
    ftp = ftplib.FTP(BOM_FTP_HOST, timeout=25)
    try:
        ftp.login()
        ftp.cwd(BOM_CAP_DIR)
        names = ftp.nlst()
    finally:
        try:
            ftp.quit()
        except Exception:
            ftp.close()
    return [n for n in names if n.lower().endswith(".cap.xml")]


def _assert_bom(names: Any) -> str:
    _require(isinstance(names, list), "FTP directory listing was not a list of names")
    _require(len(names) > 0, "zero active CAP-AU products listed")
    return f"{len(names)} active CAP-AU product(s)"


# ── alerts: Environment Canada GeoMet ──────────────────────────────────────
# Two probes for one layer, because the bug that started this module broke
# the raster and the feature query the same way but was found in only one of
# them — the layer name is shared, but nothing else guarantees the WMS
# GetMap and GetFeatureInfo request paths fail (or recover) together.

def _call_ec_feature_info() -> Any:
    x, y = _webmerc(45.4215, -75.6919)   # Ottawa: any point inside EC_BBOX will do
    half = 1000.0
    r = _session.get(EC_GEOMET, params={
        "SERVICE": "WMS", "VERSION": "1.3.0", "REQUEST": "GetFeatureInfo",
        "LAYERS": EC_ALERTS_LAYER, "QUERY_LAYERS": EC_ALERTS_LAYER, "CRS": "EPSG:3857",
        "BBOX": f"{x - half},{y - half},{x + half},{y + half}",
        "WIDTH": 3, "HEIGHT": 3, "I": 1, "J": 1, "STYLES": "",
        "INFO_FORMAT": "application/json", "FEATURE_COUNT": 5,
    }, timeout=20)
    r.raise_for_status()
    return r.json()


def _assert_ec_feature_info(data: Any) -> str:
    # This is the shape the ALERTS-vs-Current-Alerts bug broke: GeoMet answered
    # 200 with an XML ServiceExceptionReport when INFO_FORMAT=application/json
    # was requested. r.json() above would already raise on that body; the
    # explicit shape check here is the belt to that exception's suspenders.
    _require(isinstance(data, dict) and data.get("type") == "FeatureCollection",
              f"not a FeatureCollection: {str(data)[:120]!r}")
    _require(isinstance(data.get("features"), list), "no features list in the response")
    return f"GetFeatureInfo OK, {len(data['features'])} feature(s) at the test point"


def _call_ec_wms_raster() -> Any:
    x0, y0 = _webmerc(EC_BBOX[1], EC_BBOX[0])
    x1, y1 = _webmerc(EC_BBOX[3], EC_BBOX[2])
    r = _session.get(EC_GEOMET, params={
        "SERVICE": "WMS", "VERSION": "1.3.0", "REQUEST": "GetMap", "LAYERS": EC_ALERTS_LAYER,
        "CRS": "EPSG:3857", "BBOX": f"{x0},{y0},{x1},{y1}", "WIDTH": 512, "HEIGHT": 512,
        "FORMAT": "image/png", "TRANSPARENT": "TRUE", "STYLES": "",
    }, timeout=30)
    r.raise_for_status()
    return r.headers.get("Content-Type", ""), r.content


def _assert_ec_wms_raster(data: Any) -> str:
    ct, content = data
    _require("image" in ct, f"GetMap answered with content-type {ct!r}, not an image")
    n = _distinct_colors(content)
    _require(n > 1, f"raster carries only {n} distinct colour over the whole country — "
                     "GeoMet is likely serving a blank or error tile")
    return f"{n} distinct colour(s) over the national extent"


# ── tropical systems: NHC, JTWC, ATCF a-deck ───────────────────────────────

def _call_nhc() -> Any:
    r = _session.get("https://www.nhc.noaa.gov/CurrentStorms.json", timeout=20)
    r.raise_for_status()
    return r.json()


def _assert_nhc(data: Any) -> str:
    _require(isinstance(data, dict) and isinstance(data.get("activeStorms"), list),
              "no activeStorms list in the response")
    return f"{len(data['activeStorms'])} active NHC/CPHC storm(s)"


def _call_jtwc() -> Any:
    r = _session.get("https://www.metoc.navy.mil/jtwc/rss/jtwc.rss", timeout=25)
    r.raise_for_status()
    return r.text


def _assert_jtwc(text: Any) -> str:
    root = ET.fromstring(text)
    _require(root.tag.lower() == "rss", f"root element is <{root.tag}>, not <rss>")
    channel = next((c for c in root if c.tag == "channel"), None)
    _require(channel is not None, "rss carries no <channel>")
    items = sum(1 for c in channel if c.tag == "item")
    return f"RSS OK, {items} basin bulletin(s)"


_ATCF_ADECK_DIR = "https://ftp.nhc.noaa.gov/atcf/aid_public/"
_ADECK_ENTRY = re.compile(r'href="(a[a-z]{2}\d{6}\.dat\.gz)"')


def _call_atcf_adeck() -> Any:
    r = _session.get(_ATCF_ADECK_DIR, timeout=25)
    r.raise_for_status()
    return r.text


def _assert_atcf_adeck(html: Any) -> str:
    names = _ADECK_ENTRY.findall(html)
    _require(names, "directory listing carried no a-deck files")
    this_year, last_year = str(datetime.now(timezone.utc).year), str(datetime.now(timezone.utc).year - 1)
    recent = [n for n in names if this_year in n or last_year in n]
    _require(recent, f"no a-deck file from {last_year} or {this_year} in the listing")
    return f"{len(names)} a-deck file(s) listed, current season present"


# ── air quality (Open-Meteo) ───────────────────────────────────────────────
# Same host backs wxgrid.ext.air() (point card) and wxgrid.cams.openmeteo_point
# (gas-phase species CAMS's own GRIB has none of) — one probe covers both.

def _call_air_quality() -> Any:
    r = _session.get("https://air-quality-api.open-meteo.com/v1/air-quality",
                      params={"latitude": 49.2827, "longitude": -123.1207, "current": "us_aqi,pm2_5"}, timeout=15)
    r.raise_for_status()
    return r.json()


def _assert_air_quality(data: Any) -> str:
    cur = (data or {}).get("current") or {}
    _require(cur.get("us_aqi") is not None, "no us_aqi in the current block")
    age = _age_seconds(cur.get("time"))
    _require(age is None or age < 6 * 3600, f"current block timestamp {cur.get('time')!r} is stale")
    return f"AQI {cur.get('us_aqi')} at {cur.get('time')}"


# ── tides: DFO (Canada) + NOAA CO-OPS (US) ─────────────────────────────────

def _call_dfo_tides() -> Any:
    r = _session.get("https://api-iwls.dfo-mpo.gc.ca/api/v1/stations", timeout=30)
    r.raise_for_status()
    return r.json()


def _assert_dfo_tides(data: Any) -> str:
    _require(isinstance(data, list) and len(data) > 100, f"only {len(data) if isinstance(data, list) else 0} stations")
    _require("latitude" in data[0] and "longitude" in data[0], "station record missing coordinates")
    return f"{len(data)} station(s)"


def _call_noaa_tides() -> Any:
    r = _session.get("https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json",
                      params={"type": "tidepredictions"}, timeout=30)
    r.raise_for_status()
    return r.json()


def _assert_noaa_tides(data: Any) -> str:
    stations = (data or {}).get("stations") or []
    _require(len(stations) > 100, f"only {len(stations)} stations")
    return f"{len(stations)} station(s)"


# ── radar + space weather (wxgrid.radar) ───────────────────────────────────
# These call radar.py's own single-source functions rather than rebuild WMS
# capabilities / OVATION parsing here — see the module docstring.

def _assert_radar_frames(frames: Any, max_age_s: float, label: str) -> str:
    _require(frames, f"no {label} frames returned")
    newest = max(f["time"] for f in frames)
    age = time.time() - newest
    _require(age < max_age_s, f"newest {label} frame is {age / 60:.0f} min old")
    return f"{len(frames)} frame(s), newest {age:.0f}s old"


def _call_eccc_radar() -> Any:
    return radar.eccc_frames()


def _assert_eccc_radar(frames: Any) -> str:
    return _assert_radar_frames(frames, 1200, "ECCC radar")   # 6-min cadence + buffer


def _call_mrms_radar() -> Any:
    return radar.mrms_frames()


def _assert_mrms_radar(frames: Any) -> str:
    return _assert_radar_frames(frames, 900, "MRMS radar")    # 2-min cadence + buffer


IEM_TILE_URL = "https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913-m05m/0/0/0.png"


def _call_iem_tile() -> Any:
    r = _session.get(IEM_TILE_URL, timeout=20)
    r.raise_for_status()
    return r.headers.get("Content-Type", ""), r.content


def _assert_iem_tile(data: Any) -> str:
    ct, content = data
    _require("image" in ct, f"unexpected content-type {ct!r}")
    _require(len(content) > 200, f"tile suspiciously small ({len(content)} bytes)")
    Image.open(io.BytesIO(content)).verify()
    return f"{ct}, {len(content)} bytes"


def _call_rainviewer() -> Any:
    return radar.rainviewer_frames()


def _assert_rainviewer(frames: Any) -> str:
    past = [f for f in (frames or []) if f.get("kind") == "past"]
    _require(past, "no past radar frames from rainviewer")
    newest = max(f["time"] for f in past)
    age = time.time() - newest
    _require(0 <= age < 1800, f"newest rainviewer frame is {age / 60:.0f} min old")
    return f"{len(past)} past frame(s), newest {age:.0f}s old"


def _call_ovation() -> Any:
    return radar.ovation()


def _assert_ovation(data: Any) -> str:
    _require((data or {}).get("grid"), "no aurora grid returned")
    obs = data.get("observation_time")
    age = _age_seconds(obs)
    _require(age is not None and age < 3 * 3600, f"observation time {obs!r} is stale or unparseable")
    return f"observation {obs}, max {data.get('max_pct')}%"


def _call_kp() -> Any:
    return radar.kp_now()


def _assert_kp(data: Any) -> str:
    _require(data is not None, "SWPC Kp feed returned nothing")
    age = _age_seconds(data.get("time"))
    _require(age is not None and age < 3600, f"Kp time {data.get('time')!r} is stale or unparseable")
    return f"Kp {data.get('kp')} at {data.get('time')}"


# ── composition: NOAA GEFS-Aerosol via NOMADS (wxgrid.cams) ────────────────

def _gefs_chem_target_run() -> datetime:
    """A run recent enough to matter but old enough to plausibly be fully
    published — walking back through cams.latest_run()'s whole search window
    on every sweep would mean up to eight sequential NOMADS requests in the
    worst case; one computed, likely-published run keeps this probe to a
    single request."""
    lag = datetime.now(timezone.utc) - timedelta(hours=8)
    hour = (lag.hour // 6) * 6
    return lag.replace(hour=hour, minute=0, second=0, microsecond=0)


def _call_gefs_chem() -> Any:
    run = _gefs_chem_target_run()
    steps = cams.available_steps(run, cams._session())
    return run, steps


def _assert_gefs_chem(data: Any) -> str:
    run, steps = data
    _require(steps, f"no forecast hours published for the {run:%Y-%m-%d %HZ} run")
    return f"{run:%Y-%m-%d %HZ} run, {len(steps)} step(s) out to +{max(steps)}h"


# ── SIGMET/AIRMET (aviationweather.gov, via wxgrid.sigmet's host) ──────────

def _call_gairmet() -> Any:
    r = _session.get("https://aviationweather.gov/api/data/gairmet",
                      params={"type": "all", "format": "json"}, timeout=20)
    r.raise_for_status()
    return r.json()


def _assert_gairmet(data: Any) -> str:
    _require(isinstance(data, list) and data, "no G-AIRMET rows returned")
    return f"{len(data)} G-AIRMET row(s)"


# ── soundings (wxgrid.sonde) ────────────────────────────────────────────────
# University of Wyoming is explicitly excluded: it is a research service run
# by one person with a hard process-wide rate limit (sonde.UWYO_MIN_GAP), and
# adding a recurring liveness probe against it — even a gentle one — is not
# the kind of load a fragile single-operator box should carry just so this
# module can watch it. IGRA + IEM cover the same module's two other upstreams.

def _call_igra() -> Any:
    r = _session.get("https://www.ncei.noaa.gov/pub/data/igra/igra2-station-list.txt", timeout=30)
    r.raise_for_status()
    return r.text


def _assert_igra(text: Any) -> str:
    lines = [ln for ln in text.splitlines() if ln.strip()]
    _require(len(lines) > 1000, f"only {len(lines)} station rows, expected thousands")
    parts = lines[0].split()
    _require(len(parts) >= 3 and len(parts[0]) == 11, f"unexpected row shape: {lines[0][:40]!r}")
    lat = float(parts[1])
    _require(-90 <= lat <= 90, f"implausible latitude in the first row: {lat}")
    return f"{len(lines)} station rows"


def _call_iem_raob_network() -> Any:
    r = _session.get("https://mesonet.agron.iastate.edu/geojson/network/RAOB.geojson", timeout=20)
    r.raise_for_status()
    return r.json()


def _assert_iem_raob_network(data: Any) -> str:
    feats = (data or {}).get("features") or []
    _require(len(feats) > 50, f"only {len(feats)} stations, expected 100+")
    return f"{len(feats)} station(s) in the network"


# ── resorts (Overpass / OpenStreetMap) ─────────────────────────────────────
# A minimal count query, not the heavy per-tile catalogue queries build_catalog
# uses — Overpass is a shared community resource and this runs on its own
# schedule, unprompted by any user action.

_OVERPASS_UA = "wxgrid/0.1 (+https://github.com/jeffbai996/wxgrid)"
_OVERPASS_QL = '[out:json][timeout:25];node["place"="city"](49.0,-123.5,49.4,-122.9);out count;'


def _call_overpass() -> Any:
    session = requests.Session()
    session.headers["User-Agent"] = _OVERPASS_UA
    return resorts._overpass_query(session, _OVERPASS_QL, timeout=30)


def _assert_overpass(elements: Any) -> str:
    _require(elements is not None, "overpass query failed after its retry")
    _require(len(elements) == 1 and elements[0].get("type") == "count",
              f"unexpected response shape: {str(elements)[:120]!r}")
    total = int((elements[0].get("tags") or {}).get("total", -1))
    _require(total >= 0, "no total in the overpass count response")
    return f"{total} node(s) in the test bbox"


# ── the registry ────────────────────────────────────────────────────────────

PROBES: tuple[Probe, ...] = (
    Probe("nominatim", "Nominatim geocoding", _call_nominatim, _assert_nominatim),
    Probe("elevation", "Open-Meteo elevation", _call_elevation, _assert_elevation),
    Probe("timezone", "Open-Meteo timezone", _call_timezone, _assert_timezone),
    Probe("metar", "aviationweather.gov METAR", _call_metar, _assert_metar),
    Probe("taf", "aviationweather.gov TAF", _call_taf, _assert_taf),
    Probe("gairmet", "aviationweather.gov G-AIRMET", _call_gairmet, _assert_gairmet),
    Probe("avalanche_ca", "Avalanche Canada", _call_avalanche_ca, _assert_avalanche_ca),
    Probe("avalanche_org", "avalanche.org", _call_avalanche_org, _assert_avalanche_org),
    Probe("nws_alerts", "NWS alerts", _call_nws_alerts, _assert_nws_alerts),
    Probe("meteoalarm", "MeteoAlarm (Europe)", _call_meteoalarm, _assert_meteoalarm),
    Probe("bom", "Bureau of Meteorology (AU)", _call_bom, _assert_bom),
    Probe("ec_feature_info", "Environment Canada GeoMet (GetFeatureInfo)",
          _call_ec_feature_info, _assert_ec_feature_info),
    Probe("ec_wms_raster", "Environment Canada GeoMet (WMS raster)",
          _call_ec_wms_raster, _assert_ec_wms_raster),
    Probe("nhc", "NHC current storms", _call_nhc, _assert_nhc),
    Probe("jtwc", "JTWC RSS", _call_jtwc, _assert_jtwc),
    Probe("atcf_adeck", "ATCF a-deck (ensemble tracks)", _call_atcf_adeck, _assert_atcf_adeck),
    Probe("air_quality", "Open-Meteo air quality / UV", _call_air_quality, _assert_air_quality),
    Probe("dfo_tides", "DFO CHS tide stations", _call_dfo_tides, _assert_dfo_tides),
    Probe("noaa_tides", "NOAA CO-OPS tide stations", _call_noaa_tides, _assert_noaa_tides),
    Probe("eccc_radar", "ECCC radar (GeoMet WMS)", _call_eccc_radar, _assert_eccc_radar),
    Probe("mrms_radar", "NOAA MRMS radar", _call_mrms_radar, _assert_mrms_radar),
    Probe("iem_radar_tile", "IEM NEXRAD tile cache", _call_iem_tile, _assert_iem_tile),
    Probe("rainviewer", "RainViewer", _call_rainviewer, _assert_rainviewer),
    Probe("aurora_ovation", "NOAA SWPC OVATION aurora", _call_ovation, _assert_ovation),
    Probe("swpc_kp", "NOAA SWPC planetary Kp", _call_kp, _assert_kp),
    Probe("gefs_chem", "NOAA GEFS-Aerosol (NOMADS)", _call_gefs_chem, _assert_gefs_chem),
    Probe("igra_stations", "IGRA v2 station list", _call_igra, _assert_igra),
    Probe("iem_raob_network", "IEM RAOB station network", _call_iem_raob_network, _assert_iem_raob_network),
    Probe("overpass", "Overpass API (OpenStreetMap)", _call_overpass, _assert_overpass),
)

# discussion.py is deliberately absent: it composes text from an already-fetched
# model run and the outputs of other probed sources (nearest_system reads a
# local mean-sea-level array); it makes no external call of its own.


# ── running the registry ────────────────────────────────────────────────────

def _invoke(probe: Probe) -> ProbeRecord:
    """Run one probe. Never raises — a bad probe is a DOWN record, not a crash
    that takes the sweep down with it."""
    t0 = time.monotonic()
    try:
        data = probe.call()
        detail = probe.assertion(data)
        ok, error = True, ""
    except Exception as exc:                                    # noqa: BLE001 - a probe must never raise out
        ok, detail, error = False, "", str(exc)[:200]
    ms = int((time.monotonic() - t0) * 1000)
    return ProbeRecord(probe.key, probe.label, ok, detail, error, ms, time.time())


def run_all(probes: Sequence[Probe] = PROBES, pool_size: int = POOL_SIZE,
           timeout: float = PROBE_TIMEOUT) -> list[ProbeRecord]:
    """Every probe, concurrently, bounded to `timeout` total wall time no
    matter how slow a straggler is. A probe that has not finished by then is
    recorded as down and its thread is abandoned (not cancelled — Python
    cannot interrupt a blocking network call — but the pool is shut down
    without waiting on it, so this call itself never hangs)."""
    pool = ThreadPoolExecutor(max_workers=pool_size, thread_name_prefix="liveness")
    try:
        futures = {pool.submit(_invoke, p): p for p in probes}
        _done, not_done = _wait(futures, timeout=timeout)
        records = []
        for fut, p in futures.items():
            if fut in not_done:
                records.append(ProbeRecord(p.key, p.label, False, "",
                                            f"did not finish within {timeout:.0f}s",
                                            int(timeout * 1000), time.time()))
                continue
            try:
                records.append(fut.result())
            except Exception as exc:                             # noqa: BLE001 - _invoke shouldn't raise, but be defensive
                records.append(ProbeRecord(p.key, p.label, False, "", f"probe crashed: {exc}"[:200], 0, time.time()))
        return records
    finally:
        pool.shutdown(wait=False)


# ── persistence + streaks ───────────────────────────────────────────────────

_state_lock = threading.Lock()


def _load_state() -> dict:
    try:
        if STATE_PATH.exists():
            return json.loads(STATE_PATH.read_text())
    except Exception as exc:                                     # noqa: BLE001
        log.warning("liveness state unreadable: %s", exc)
    return {"last_sweep_ts": 0.0, "sources": {}}


def _save_state(state: dict) -> None:
    try:
        STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = STATE_PATH.with_suffix(f".part-{uuid.uuid4().hex[:8]}")
        tmp.write_text(json.dumps(state, separators=(",", ":")))
        tmp.replace(STATE_PATH)
    except Exception as exc:                                     # noqa: BLE001 - a cache that can't persist still cached
        log.warning("liveness state flush failed: %s", exc)


def _update_history(state: dict, records: list[ProbeRecord]) -> dict:
    now = time.time()
    sources = state.setdefault("sources", {})
    for r in records:
        entry = sources.setdefault(r.key, {"label": r.label, "history": [], "down_since": None})
        entry["label"] = r.label
        entry["last"] = {"ok": r.ok, "detail": r.detail, "error": r.error, "ms": r.ms, "ts": r.ts}
        entry["history"].append({"ok": r.ok, "ts": r.ts})
        if len(entry["history"]) > HISTORY_LEN:
            entry["history"] = entry["history"][-HISTORY_LEN:]
        if r.ok:
            entry["down_since"] = None
        elif entry.get("down_since") is None:
            entry["down_since"] = r.ts
    state["last_sweep_ts"] = now
    return state


def sweep(probes: Sequence[Probe] = PROBES) -> dict:
    """Run every probe and persist the result. This is the only function in
    this module that touches the network on its own initiative — call it from
    a cron job, the CLI below, or the background thread ensure_fresh starts."""
    records = run_all(probes)
    with _state_lock:
        state = _load_state()
        state = _update_history(state, records)
        _save_state(state)
    return state


def _iso(epoch: float | None) -> str | None:
    if not epoch:
        return None
    return datetime.fromtimestamp(epoch, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def summary(state: dict | None = None) -> dict:
    """The last stored sweep, shaped for /api/health: per-source records plus
    the list of keys currently down and how long each has been down."""
    state = _load_state() if state is None else state
    now = time.time()
    sources: dict[str, dict] = {}
    down_keys = []
    for key, entry in sorted((state.get("sources") or {}).items()):
        last = entry.get("last") or {}
        down_since = entry.get("down_since")
        ok = bool(last.get("ok", False))
        sources[key] = {
            "label": entry.get("label", key), "ok": ok,
            "detail": last.get("detail", ""), "error": last.get("error", ""),
            "ms": last.get("ms"), "checked_at": _iso(last.get("ts")),
            "down_since": _iso(down_since) if down_since else None,
            "down_for_s": int(now - down_since) if down_since else 0,
        }
        if not ok:
            down_keys.append(key)
    return {"sources": sources, "sources_down": down_keys,
            "checked_at": _iso(state.get("last_sweep_ts")) if state.get("last_sweep_ts") else None}


# ── background refresh ──────────────────────────────────────────────────────

_bg_lock = threading.Lock()
_bg_running = False


def _trigger_background_sweep() -> None:
    global _bg_running
    with _bg_lock:
        if _bg_running:
            return
        _bg_running = True

    def work() -> None:
        global _bg_running
        try:
            sweep()
        except Exception as exc:                                 # noqa: BLE001
            log.warning("liveness background sweep failed: %s", exc)
        finally:
            with _bg_lock:
                _bg_running = False

    threading.Thread(target=work, name="wxgrid-liveness-sweep", daemon=True).start()


def ensure_fresh(ttl: float = SWEEP_TTL) -> dict:
    """What a user-facing endpoint calls: the last stored sweep, plus a kicked
    background refresh if that sweep is older than `ttl`. Never blocks on a
    probe — the caller always gets the last known answer immediately."""
    state = _load_state()
    if time.time() - state.get("last_sweep_ts", 0.0) > ttl:
        _trigger_background_sweep()
    return summary(state)


# ── CLI ──────────────────────────────────────────────────────────────────────

def _print_table(records: list[ProbeRecord]) -> None:
    width = max((len(r.key) for r in records), default=10)
    for r in sorted(records, key=lambda r: (r.ok, r.key)):
        mark = "OK  " if r.ok else "DOWN"
        msg = r.detail if r.ok else r.error
        print(f"{mark}  {r.key.ljust(width)}  {r.ms:6d} ms  {msg}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m wxgrid.liveness",
                                 description="Probe every external source wxgrid depends on and report which are live.")
    ap.add_argument("--json", action="store_true", help="print the raw records as JSON instead of a table")
    ap.add_argument("--only", help="comma-separated probe keys to run (default: all)")
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.WARNING, format="%(asctime)s %(levelname)s %(message)s")

    probes = PROBES
    if a.only:
        keys = {k.strip() for k in a.only.split(",") if k.strip()}
        probes = tuple(p for p in PROBES if p.key in keys)
        missing = keys - {p.key for p in probes}
        if missing:
            print(f"unknown probe key(s): {', '.join(sorted(missing))}", file=sys.stderr)
            return 2

    records = run_all(probes)
    with _state_lock:
        state = _load_state()
        state = _update_history(state, records)
        _save_state(state)

    if a.json:
        print(json.dumps([r.to_json() for r in records], indent=1))
    else:
        _print_table(records)
    return 1 if any(not r.ok for r in records) else 0


if __name__ == "__main__":
    _code = main()
    # os._exit, not SystemExit: a probe whose own timeout failed to bound a
    # true socket-level hang leaves a non-daemon thread running, which would
    # otherwise keep the interpreter alive waiting for it at normal exit.
    import os
    sys.stdout.flush()
    os._exit(_code)
