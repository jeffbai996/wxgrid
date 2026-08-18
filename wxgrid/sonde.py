"""Observed radiosonde soundings — the actual balloon ascent, so a Skew-T can
show what the atmosphere *did* next to what a model says it will do.

Two keyless upstreams, picked per station:

  Iowa Environmental Mesonet   https://mesonet.agron.iastate.edu/json/raob.py
      Clean JSON, ~150-250 levels, ~20 KB. North America only (124 active
      stations: US, Canada, Mexico, a few Caribbean). Preferred wherever it
      reaches — it is a public API, it is cheap, and it keeps load off a
      university box.

  University of Wyoming        https://weather.uwyo.edu/wsgi/sounding
      The global archive, 800+ stations, HTML-wrapped fixed-width text. The
      fallback everywhere IEM does not reach. It is a research service run by
      one person, so: one request per station per cache cycle, a hard 3 s gap
      between requests process-wide, results cached for hours, and never a
      bulk crawl. Their legacy /cgi-bin/sounding interface is gone — the new
      server is /wsgi/sounding?datetime=&id=&src=&type= and it 404s with
      "Unable to retrieve the data" when a slot has nothing.

Two more were evaluated and rejected:

  NOAA rucsoundings (get_soundings.cgi, GSD format) is DEAD. NOAA GSL removed
      it along with its other legacy sites; the host refuses connections. No
      GSD parser is carried here because there is nothing left to parse.

  IGRA v2 / NCEI is the archive of record but not a live product: the
      year-to-date file for a single station is a 2 MB zip and lands about a
      day late. Its *station list* is exactly what we want, though, and that
      is what we use it for.

  SondeHub (api.v2.sondehub.org) is live amateur-received telemetry, per
      flight rather than per station. The frames carry altitude, temperature
      and humidity but no pressure and no wind vector — you would have to
      invent the pressure axis hydrostatically and read wind off the balloon's
      GPS drift. Next to a model profile that is a home-made axis pretending
      to be an observation, so it is left out.

Everything is cached through wxgrid.ext's disk-backed TTL cache: the station
list for 30 days, a sounding for 3 hours (launches are 00Z/12Z, some 06Z/18Z).
Every upstream failure is caught and logged; callers get None or [], never an
exception.
"""
from __future__ import annotations

import html as _html
import logging
import math
import re
import threading
import time
from datetime import datetime, timedelta, timezone

from wxgrid.ext import _haversine_km, _session, cache

log = logging.getLogger("wxgrid.sonde")

IGRA_STATIONS = "https://www.ncei.noaa.gov/pub/data/igra/igra2-station-list.txt"
IEM_NETWORK = "https://mesonet.agron.iastate.edu/geojson/network/RAOB.geojson"
IEM_RAOB = "https://mesonet.agron.iastate.edu/json/raob.py"
UWYO_SOUNDING = "https://weather.uwyo.edu/wsgi/sounding"

STATION_TTL = 30 * 24 * 3600
SOUNDING_TTL = 3 * 3600            # 00Z/12Z launches; nothing new inside 3 h
MISS_TTL = 1200                    # a slot that is merely not posted yet
POST_LAG_H = 1.0                   # a 12Z ascent is flown, coded and posted by ~13Z
MAX_TRIES = 4                      # candidate synoptic slots per "latest" lookup
MAX_LEVELS = 320                   # thinned payload cap; BUFR ascents run to 4000
UWYO_MIN_GAP = 3.0                 # seconds between requests to the university box

_uwyo_lock = threading.Lock()
_uwyo_last = 0.0

# Levels a Skew-T reader expects to find, kept through thinning whatever else goes.
MANDATORY_HPA = (1000, 925, 850, 700, 500, 400, 300, 250, 200, 150, 100, 70, 50, 30, 20, 10)

UNITS = {"p": "hPa", "z": "m", "t": "C", "td": "C", "wdir": "deg", "wspd": "m/s"}


# ── cache helper ──────────────────────────────────────────────────────────

def _cached(key: str, ttl: float, fn):
    """ext.cache, but a miss expires sooner than a hit. A sounding that simply
    has not been posted yet must not be written off for three hours, and a
    station that never reports must not be re-asked on every request."""
    box = cache.get(key, ttl, lambda: [time.time(), fn()])
    stamp, val = box[0], box[1]
    if val is None and time.time() - stamp > MISS_TTL:
        box = [time.time(), fn()]
        cache.get(key, 0.0, lambda: box)      # ttl 0 always misses, so this rewrites
    return box[1]


# ── station list ──────────────────────────────────────────────────────────

def _parse_igra(text: str, min_last_year: int) -> list[dict]:
    """IGRA v2's fixed-width station list. Columns (1-based, from their
    readme): ID 1-11, LAT 13-20, LON 22-30, ELEV 32-37, STATE 39-40,
    NAME 42-71, FSTYEAR 73-76, LSTYEAR 78-81, NOBS 83-88. An ID whose third
    character is 'M' carries the five-digit WMO number in its last five —
    that is the id the Wyoming archive answers to."""
    out = []
    for line in text.splitlines():
        if len(line) < 88:
            continue
        sid = line[0:11].strip()
        if len(sid) != 11:
            continue
        try:
            last = int(line[77:81])
            lat, lon = float(line[12:20]), float(line[21:30])
            elev = float(line[31:37])
        except ValueError:
            continue
        if last < min_last_year or abs(lat) > 90 or abs(lon) > 180:
            continue
        wmo = sid[6:11] if sid[2] == "M" and sid[6:11].isdigit() else None
        out.append({"id": wmo or sid, "wmo": wmo, "icao": None, "igra_id": sid,
                    "name": _title(line[41:71].strip().replace(";", ",")),
                    "lat": round(lat, 4), "lon": round(lon, 4),
                    "elev_m": round(elev, 1) if elev > -998 else None,
                    "country": sid[0:2], "sources": ["uwyo"]})
    return out


# Tokens that are abbreviations rather than shouting, and stay as they are.
_KEEP_UPPER = {"USA", "UK", "UAE", "AFB", "INTL", "UA", "AWS", "RAF", "AB", "BC", "MB", "NB",
               "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"}


def _title(name: str) -> str:
    """IGRA and IEM both shout their station names. Title-case the words and
    leave the abbreviations — "QUILLAYUTE; WA., USA" is a place, "Quillayute,
    Wa., Usa" is a typo."""
    parts = []
    for word in re.split(r"(\s+)", name):
        core = word.strip(".,;:()[]")
        if not word or word.isspace() or not word.isupper() or len(core) <= 2 \
                or not core.isalpha() or core in _KEEP_UPPER:
            parts.append(word)
        else:
            parts.append(word.title())
    return re.sub(r"\s+", " ", "".join(parts)).strip()


def _parse_iem_network(geojson: dict) -> list[dict]:
    """IEM's RAOB network as {icao, name, lat, lon, elev}. Ids beginning with
    an underscore are merged historical pseudo-sites, and a station with an
    archive_end has stopped reporting; neither is any use live."""
    out = []
    for f in geojson.get("features") or []:
        sid = str(f.get("id") or "")
        p = f.get("properties") or {}
        geom = f.get("geometry") or {}
        coords = geom.get("coordinates") or []
        if not sid or sid.startswith("_") or p.get("archive_end") or len(coords) < 2:
            continue
        out.append({"id": sid, "wmo": None, "icao": sid, "igra_id": None,
                    "name": _title(re.sub(r"\s+", " ", str(p.get("sname") or sid))),
                    "lat": round(float(coords[1]), 4), "lon": round(float(coords[0]), 4),
                    "elev_m": round(float(p["elevation"]), 1) if p.get("elevation") is not None else None,
                    "country": p.get("country") or "", "sources": ["iem"]})
    return out


def _merge_stations(igra: list[dict], iem: list[dict], max_km: float = 30.0) -> list[dict]:
    """One row per physical site. IEM's ICAO id is attached to the IGRA station
    it sits on top of (same balloon, two catalogues); an IEM station with no
    IGRA twin is kept on its own."""
    out = [dict(s) for s in igra]
    for st in iem:
        best, best_d = None, max_km
        for cand in out:
            d = _haversine_km(st["lat"], st["lon"], cand["lat"], cand["lon"])
            if d < best_d:
                best, best_d = cand, d
        if best is None:
            out.append(dict(st))
            continue
        best["icao"] = st["icao"]
        if best.get("elev_m") is None:
            best["elev_m"] = st["elev_m"]
        if "iem" not in best["sources"]:
            best["sources"] = ["iem"] + best["sources"]
    return out


def stations() -> list[dict]:
    """The active global upper-air network: IGRA v2's station list (global,
    WMO ids) with IEM's ICAO ids merged on top where they overlap. Cached
    30 days on disk. Returns [] if both upstreams are unreachable and nothing
    is cached."""
    def fetch() -> list[dict]:
        year = datetime.now(timezone.utc).year
        igra: list[dict] = []
        try:
            r = _session.get(IGRA_STATIONS, timeout=60)
            r.raise_for_status()
            igra = _parse_igra(r.text, year - 1)
        except Exception as exc:                      # noqa: BLE001 - any failure degrades, none raises
            log.warning("igra station list failed: %s", exc)
        iem: list[dict] = []
        try:
            r = _session.get(IEM_NETWORK, timeout=45)
            r.raise_for_status()
            iem = _parse_iem_network(r.json())
        except Exception as exc:                      # noqa: BLE001
            log.warning("iem raob network failed: %s", exc)
        merged = _merge_stations(igra, iem)
        log.info("sonde station list: %d igra + %d iem → %d", len(igra), len(iem), len(merged))
        return merged
    return _cached("sonde:stations:v2", STATION_TTL, fetch) or []


def _index() -> dict[str, dict]:
    """Every id a caller might reasonably use — WMO number, ICAO, IGRA id —
    pointing at its station."""
    idx: dict[str, dict] = {}
    for st in stations():
        for key in (st.get("wmo"), st.get("icao"), st.get("igra_id"), st.get("id")):
            if key:
                idx.setdefault(str(key).upper(), st)
    return idx


def station(station_id: str) -> dict | None:
    return _index().get(str(station_id).strip().upper())


def nearest_station(lat: float, lon: float, max_km: float = 400.0) -> dict | None:
    """Closest launch site to a point, or None when the nearest is further than
    max_km — half of Africa and most of the Pacific has no sounding within
    400 km and saying so is more honest than drawing a profile from 900 km
    away."""
    best, best_d = None, float(max_km)
    for st in stations():
        d = _haversine_km(lat, lon, st["lat"], st["lon"])
        if d < best_d:
            best, best_d = st, d
    if best is None:
        return None
    return {**best, "distance_km": round(best_d, 1)}


# ── time handling ─────────────────────────────────────────────────────────

def _synoptic_slots(now: datetime, tries: int = MAX_TRIES) -> list[datetime]:
    """Candidate observation times, newest first: the 6-hourly synoptic slots
    at least POST_LAG_H old. Most stations fly 00Z and 12Z only, so a 06Z/18Z
    candidate is usually a miss — it is still tried first when it is the newer
    one, because when it does exist it is six hours fresher."""
    edge = now - timedelta(hours=POST_LAG_H)
    slot = edge.replace(minute=0, second=0, microsecond=0, hour=(edge.hour // 6) * 6)
    return [slot - timedelta(hours=6 * i) for i in range(tries)]


def _parse_when(when: str) -> datetime | None:
    """"YYYYMMDDHH", "YYYY-MM-DDTHH" or "YYYY-MM-DD HH:MM" → an aware UTC
    datetime on the hour. None when it is not a timestamp at all."""
    s = (when or "").strip().upper().replace("T", " ").replace("Z", "")
    for fmt in ("%Y%m%d%H", "%Y-%m-%d %H", "%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(s, fmt).replace(tzinfo=timezone.utc, minute=0, second=0, microsecond=0)
        except ValueError:
            continue
    return None


# ── IEM (North America, JSON) ─────────────────────────────────────────────

def _fetch_iem(icao: str, when: datetime) -> dict | None:
    """One profile from IEM. Wind arrives in knots; everything we publish is
    m/s. Levels with no pressure are unusable on a Skew-T and are dropped."""
    try:
        r = _session.get(IEM_RAOB, params={"station": icao, "ts": when.strftime("%Y-%m-%dT%H:%MZ")}, timeout=30)
        r.raise_for_status()
        j = r.json()
    except Exception as exc:                          # noqa: BLE001
        log.info("iem raob %s %s: %s", icao, when, exc)
        return None
    profiles = j.get("profiles") or []
    if not profiles:
        return None
    prof = profiles[0]
    levels = []
    for lv in prof.get("profile") or []:
        p = lv.get("pres")
        if p is None:
            continue
        kt = lv.get("sknt")
        levels.append({"p": round(float(p), 2), "z": _num(lv.get("hght"), 0),
                       "t": _num(lv.get("tmpc"), 1), "td": _num(lv.get("dwpc"), 1),
                       "wdir": _num(lv.get("drct"), 0),
                       "wspd": round(float(kt) * 0.5144444, 1) if kt is not None else None})
    if len(levels) < 3:
        return None
    return {"levels": levels, "time": prof.get("valid"), "source": "iem",
            "source_url": f"{IEM_RAOB}?station={icao}&ts={when.strftime('%Y-%m-%dT%H:%MZ')}",
            "station_name": None, "station_lat": None, "station_lon": None,
            "station_elev_m": None, "source_indices": {}}


def _num(v, digits: int):
    """None-tolerant round; IEM and Wyoming both use null/blank for a level
    where the instrument had nothing to say."""
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if f < -9000:                                     # -9999 sentinels
        return None
    return round(f, digits) if digits else int(round(f))


# ── University of Wyoming (global, fixed-width in HTML) ───────────────────

_UWYO_H1 = re.compile(r"<H1>\s*Observations for Station\s+(\S+)\s+at\s+(\d{1,2})\s+UTC\s+(\d{1,2})\s+(\w{3})\s+(\d{4})", re.I)
_UWYO_H3 = re.compile(r"<H3>(.*?)</H3>", re.I | re.S)
_UWYO_PRE = re.compile(r"<PRE>(.*?)</PRE>", re.I | re.S)
_UWYO_IDX = re.compile(r"Sounding Indices\s*</H3>\s*<TABLE>(.*?)</TABLE>", re.I | re.S)
_UWYO_ROW = re.compile(r"<TR>\s*<TD>\s*([A-Z0-9]{2,8})\s*</TD>\s*<TD>[^<]*</TD>\s*<TD[^>]*>([^<]*)</TD>", re.I | re.S)
_MONTHS = {m: i for i, m in enumerate(
    ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"), 1)}
# Wyoming's own column names → ours. Anything else in the table is ignored.
_UWYO_COLS = {"PRES": "p", "HGHT": "z", "TEMP": "t", "DWPT": "td", "DRCT": "wdir", "SPED": "wspd", "SKNT": "wspd"}


def _spans(header: str) -> list[tuple[str, int, int]]:
    """Fixed-width column spans from the header line: each field ends where its
    name ends. The rows are ragged — a level with no wind leaves those columns
    blank rather than shifting the rest — so they must be sliced, never split."""
    out, prev = [], 0
    for m in re.finditer(r"\S+", header):
        out.append((m.group(0), prev, m.end()))
        prev = m.end()
    return out


def _parse_uwyo(page: str) -> dict | None:
    """The TEXT:LIST page: an <H1> naming station and time, an <H3> naming the
    place, a <PRE> block of the profile, and a table of the indices Wyoming
    computed itself. Stations served from BUFR return the full ascent (up to
    ~4000 levels); stations served from TAC return mandatory and significant
    levels only (~100)."""
    pre = _UWYO_PRE.search(page)
    h1 = _UWYO_H1.search(page)
    if not pre or not h1:
        return None
    lines = [ln for ln in pre.group(1).splitlines() if ln.strip()]
    header = next((ln for ln in lines if "PRES" in ln), None)
    if header is None:
        return None
    hi = lines.index(header)
    cols = _spans(header)
    units = {}
    if hi + 1 < len(lines):
        for name, a, b in cols:
            units[name] = lines[hi + 1][a:b].strip()
    wind_scale = 0.5144444 if units.get("SPED", units.get("SKNT", "")).lower() in ("knot", "knots", "kt", "kts") else 1.0
    levels = []
    for ln in lines[hi + 2:]:
        if set(ln.strip()) <= {"-"}:
            continue
        row: dict = {}
        for i, (name, a, b) in enumerate(cols):
            key = _UWYO_COLS.get(name)
            if not key:
                continue
            raw = (ln[a:] if i == len(cols) - 1 else ln[a:b]).strip()
            if not raw:
                row[key] = None
                continue
            try:
                row[key] = float(raw)
            except ValueError:
                row[key] = None
        if row.get("p") is None:
            continue
        if row.get("wspd") is not None:
            row["wspd"] = round(row["wspd"] * wind_scale, 1)
        levels.append({"p": round(row["p"], 2), "z": _num(row.get("z"), 0), "t": _num(row.get("t"), 1),
                       "td": _num(row.get("td"), 1), "wdir": _num(row.get("wdir"), 0),
                       "wspd": _num(row.get("wspd"), 1)})
    if len(levels) < 3:
        return None
    hour, day, mon, year = int(h1.group(2)), int(h1.group(3)), h1.group(4), int(h1.group(5))
    when = datetime(year, _MONTHS.get(mon.title(), 1), day, hour, tzinfo=timezone.utc)
    idx = {}
    table = _UWYO_IDX.search(page)
    for code, value in _UWYO_ROW.findall(table.group(1) if table else ""):
        try:
            idx[_html.unescape(code).strip()] = float(_html.unescape(value).strip())
        except ValueError:
            continue
    names = [_html.unescape(re.sub(r"<[^>]+>", "", h)).strip() for h in _UWYO_H3.findall(page)]
    place = next((n for n in names if "Indices" not in n and n), None)
    return {"levels": levels, "time": when.strftime("%Y-%m-%dT%H:%M:%SZ"), "source": "uwyo",
            "source_url": f"{UWYO_SOUNDING}?datetime={when:%Y-%m-%d %H}:00:00&id={h1.group(1)}&type=TEXT:LIST&src=UNKNOWN",
            "station_name": _title(place) if place else None,
            "station_lat": idx.get("SLAT"), "station_lon": idx.get("SLON"), "station_elev_m": idx.get("SELV"),
            "source_indices": {k: v for k, v in idx.items() if k not in ("SLAT", "SLON", "SELV")}}


def _fetch_uwyo(wmo: str, when: datetime) -> dict | None:
    """One sounding from the university archive, rate-limited process-wide. A
    slot with no data answers 404 with a one-line body, which is a miss, not a
    failure."""
    global _uwyo_last
    params = {"datetime": when.strftime("%Y-%m-%d %H:00:00"), "id": wmo, "src": "UNKNOWN", "type": "TEXT:LIST"}
    try:
        with _uwyo_lock:                              # their box, their pace
            wait = UWYO_MIN_GAP - (time.time() - _uwyo_last)
            if wait > 0:
                time.sleep(wait)
            _uwyo_last = time.time()
            r = _session.get(UWYO_SOUNDING, params=params, timeout=60)
        if 400 <= r.status_code < 500:      # 404 at most stations, 400 at some: both mean "nothing here"
            return None
        r.raise_for_status()
        return _parse_uwyo(r.text)
    except Exception as exc:                          # noqa: BLE001
        log.info("uwyo sounding %s %s: %s", wmo, when, exc)
        return None


# ── thermodynamics (ours, not the source's) ──────────────────────────────

RD, RV, CPD, LV, G, EPS, KAPPA = 287.04, 461.5, 1005.7, 2.501e6, 9.80665, 0.622, 287.04 / 1005.7


def _es(t_c: float) -> float:
    """Saturation vapour pressure over water, hPa (Bolton 1980 eq. 10)."""
    return 6.112 * math.exp(17.67 * t_c / (t_c + 243.5))


def _mixing_ratio(p_hpa: float, t_c: float) -> float:
    """Saturation mixing ratio, kg/kg. Feed it a dew point for the actual one."""
    e = min(_es(t_c), p_hpa * 0.999)
    return EPS * e / (p_hpa - e)


def _tv(t_c: float, r: float) -> float:
    """Virtual temperature, K. CAPE without it is systematically low in a moist
    boundary layer, and the correction costs one multiply."""
    return (t_c + 273.15) * (1 + r / EPS) / (1 + r)


def _lcl(p_hpa: float, t_c: float, td_c: float) -> tuple[float, float]:
    """Lifting condensation level as (pressure hPa, temperature °C), Bolton
    1980 eq. 15 then Poisson."""
    t_k, td_k = t_c + 273.15, td_c + 273.15
    t_lcl = 1.0 / (1.0 / (td_k - 56.0) + math.log(t_k / td_k) / 800.0) + 56.0
    p_lcl = p_hpa * (t_lcl / t_k) ** (1.0 / KAPPA)
    return p_lcl, t_lcl - 273.15


def _moist_lapse(p0: float, t0_c: float, p1: float, step: float = 2.0) -> float:
    """Integrate the pseudoadiabat from (p0, t0) up to p1, °C. Plain Euler on a
    2 hPa step — the profile is only asked for at sounding levels and the error
    at that step is well under a tenth of a degree."""
    t = t0_c + 273.15
    p = p0
    n = max(1, int(math.ceil(abs(p0 - p1) / step)))
    dp = (p1 - p0) / n
    for _ in range(n):
        rs = _mixing_ratio(p, t - 273.15)
        num = RD * t + LV * rs
        den = CPD + (LV * LV * rs * EPS) / (RD * t * t)
        t += (num / den) / p * dp
        p += dp
    return t - 273.15


def _interp(levels: list[dict], key: str, target: float, field: str) -> float | None:
    """Linear interpolation of `field` at `key` == target, walking the profile
    from the ground up. Returns None when the profile never reaches target."""
    prev = None
    for lv in levels:
        if lv.get(key) is None or lv.get(field) is None:
            continue
        if prev is not None:
            a, b = prev[key], lv[key]
            if (a - target) * (b - target) <= 0 and a != b:
                f = (target - a) / (b - a)
                return prev[field] + f * (lv[field] - prev[field])
        prev = lv
    return None


def _freezing_level(levels: list[dict]) -> float | None:
    """Height of the lowest 0 °C crossing above the surface, m. None when the
    profile is below freezing at the ground (then the freezing level is the
    ground) or carries no heights."""
    usable = [lv for lv in levels if lv.get("t") is not None and lv.get("z") is not None]
    if len(usable) < 2 or usable[0]["t"] <= 0:
        return None
    for a, b in zip(usable, usable[1:]):
        if b["t"] <= 0 < a["t"] and a["t"] != b["t"]:
            f = (0.0 - a["t"]) / (b["t"] - a["t"])
            return round(a["z"] + f * (b["z"] - a["z"]))
    return None


def _pwat(levels: list[dict]) -> float | None:
    """Precipitable water, mm: the column integral of specific humidity."""
    usable = [lv for lv in levels if lv.get("p") and lv.get("td") is not None]
    if len(usable) < 2:
        return None
    total = 0.0
    for a, b in zip(usable, usable[1:]):
        dp = a["p"] - b["p"]
        if dp <= 0:
            continue
        ra, rb = _mixing_ratio(a["p"], a["td"]), _mixing_ratio(b["p"], b["td"])
        q = 0.5 * (ra / (1 + ra) + rb / (1 + rb))
        total += q * dp
    return round(total * 100.0 / G, 1)


def _cape_cin(levels: list[dict]) -> dict:
    """Surface-based CAPE and CIN by lifting the lowest level with a dew point,
    virtual-temperature corrected. Layer-by-layer trapezoid in ln p between
    sounding levels, positive area from the LFC to the EL and negative area
    below the LFC. Textbook method, our arithmetic — not the source's."""
    usable = [lv for lv in levels if lv.get("p") and lv.get("t") is not None and lv.get("td") is not None]
    out: dict = {"sbcape_j_kg": None, "sbcin_j_kg": None, "lcl_hpa": None, "lcl_m": None,
                 "lfc_hpa": None, "el_hpa": None}
    if len(usable) < 5:
        return out
    sfc = usable[0]
    p_lcl, t_lcl = _lcl(sfc["p"], sfc["t"], sfc["td"])
    out["lcl_hpa"] = round(p_lcl, 1)
    z_lcl = _interp(levels, "p", p_lcl, "z")
    out["lcl_m"] = round(z_lcl) if z_lcl is not None else None
    r_sfc = _mixing_ratio(sfc["p"], sfc["td"])

    def parcel(p: float) -> tuple[float, float]:
        """(temperature °C, mixing ratio) of the surface parcel at pressure p."""
        if p >= p_lcl:
            t = (sfc["t"] + 273.15) * (p / sfc["p"]) ** KAPPA - 273.15
            return t, r_sfc
        t = _moist_lapse(p_lcl, t_lcl, p)
        return t, _mixing_ratio(p, t)

    buoy = []                                          # (p, Tv_parcel - Tv_env)
    for lv in usable:
        if lv["p"] > sfc["p"]:
            continue
        tp, rp = parcel(lv["p"])
        buoy.append((lv["p"], _tv(tp, rp) - _tv(lv["t"], _mixing_ratio(lv["p"], lv["td"]))))
    if len(buoy) < 5:
        return out
    lfc_i = next((i for i in range(1, len(buoy)) if buoy[i][1] > 0 and buoy[i][0] <= p_lcl), None)
    if lfc_i is None:
        out["sbcape_j_kg"], out["sbcin_j_kg"] = 0.0, 0.0
        return out
    el_i = next((i for i in range(len(buoy) - 1, lfc_i, -1) if buoy[i][1] > 0), lfc_i)
    cape = cin = 0.0
    for i in range(len(buoy) - 1):
        (pa, ba), (pb, bb) = buoy[i], buoy[i + 1]
        if pb <= 0 or pa <= 0:
            continue
        area = RD * 0.5 * (ba + bb) * math.log(pa / pb)
        if lfc_i <= i < el_i:
            cape += max(area, 0.0)
        elif i < lfc_i:
            cin += min(area, 0.0)
    out["sbcape_j_kg"] = round(cape)
    out["sbcin_j_kg"] = round(cin)
    out["lfc_hpa"] = round(buoy[lfc_i][0], 1)
    out["el_hpa"] = round(buoy[el_i][0], 1)
    return out


def indices(levels: list[dict]) -> dict:
    """Everything we derive ourselves from the profile. Labelled so a reader
    never confuses it with a number the source published."""
    sfc = next((lv for lv in levels if lv.get("t") is not None and lv.get("td") is not None), None)
    out = {"computed_by": "wxgrid", "method": "surface parcel, virtual-temperature corrected"}
    out.update(_cape_cin(levels))
    out["freezing_level_m"] = _freezing_level(levels)
    out["pwat_mm"] = _pwat(levels)
    out["surface"] = {"p": sfc["p"], "t": sfc["t"], "td": sfc["td"]} if sfc else None
    return out


# ── payload shaping ───────────────────────────────────────────────────────

def _thin(levels: list[dict], cap: int = MAX_LEVELS) -> list[dict]:
    """A BUFR ascent is 4000 levels and 300 KB of JSON; a Skew-T is a few
    hundred pixels tall. Keep the ends, keep every mandatory level, and take an
    even stride through the rest."""
    n = len(levels)
    if n <= cap:
        return levels
    keep = {0, n - 1}
    for target in MANDATORY_HPA:
        best, best_d = None, 2.0
        for i, lv in enumerate(levels):
            d = abs(lv["p"] - target)
            if d < best_d:
                best, best_d = i, d
        if best is not None:
            keep.add(best)
    room = max(1, cap - len(keep))
    stride = max(1, math.ceil(n / room))       # ceil, so the fill can never overrun the cap
    keep.update(range(0, n, stride))
    return [levels[i] for i in sorted(keep)]


def _shape(raw: dict, st: dict, cap: int) -> dict:
    """One upstream's parse → the response the front end sees. Indices are
    computed on the full profile before it is thinned."""
    levels = raw["levels"]
    idx = indices(levels)
    when = raw.get("time") or ""
    age = None
    try:
        obs = datetime.fromisoformat(when.replace("Z", "+00:00"))
        age = round((datetime.now(timezone.utc) - obs).total_seconds() / 3600.0, 1)
    except (ValueError, AttributeError):
        pass
    meta = {**{k: st.get(k) for k in ("id", "wmo", "icao", "name", "lat", "lon", "elev_m", "country")},
            **({"distance_km": st["distance_km"]} if "distance_km" in st else {})}
    if raw.get("station_name") and not meta.get("name"):
        meta["name"] = raw["station_name"]
    for key, src in (("lat", "station_lat"), ("lon", "station_lon"), ("elev_m", "station_elev_m")):
        if meta.get(key) is None and raw.get(src) is not None:
            meta[key] = raw[src]
    thinned = _thin(levels, cap)
    return {"station": meta, "time": when, "age_h": age, "source": raw["source"],
            "source_url": raw.get("source_url"), "units": UNITS,
            "levels": thinned, "n_levels": len(thinned), "n_levels_full": len(levels),
            "thinned": len(thinned) < len(levels),
            "indices": idx, "source_indices": raw.get("source_indices") or {}}


# ── public entry point ────────────────────────────────────────────────────

def _fetch_at(st: dict, when: datetime) -> dict | None:
    """One station, one slot, cheapest source first."""
    if st.get("icao"):
        got = _fetch_iem(st["icao"], when)
        if got:
            return got
    if st.get("wmo"):
        return _fetch_uwyo(st["wmo"], when)
    return None


def sounding(station_id: str, when: str = "latest", max_levels: int = MAX_LEVELS) -> dict | None:
    """The observed ascent for a station. `when` is "latest" or a timestamp
    ("YYYYMMDDHH" / "YYYY-MM-DDTHH"). "latest" walks back through the synoptic
    slots — a station that only flies 00Z and 12Z can hand back a sounding up
    to ~14 h old, which is what `time` and `age_h` are for. None when the
    station is unknown or nothing is posted."""
    st = station(station_id)
    if st is None:
        return None
    want = (when or "latest").strip().lower()
    key = f"sonde:obs:v2:{st['id']}:{want}:{max_levels}"

    def fetch() -> dict | None:
        if want in ("latest", "", "now"):
            slots = _synoptic_slots(datetime.now(timezone.utc))
        else:
            at = _parse_when(when)
            if at is None:
                log.info("sonde: unparseable when=%r", when)
                return None
            slots = [at]
        for slot in slots:
            raw = _fetch_at(st, slot)
            if raw:
                return _shape(raw, st, max_levels)
        return None

    return _cached(key, SOUNDING_TTL, fetch)
