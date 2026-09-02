"""Turn a (721, 1440) lat/lon field into what the browser wants.

- `to_mercator`   : resample the equirectangular grid onto a Web-Mercator
                    image (lat ±89.99°) so MapLibre's globe has no polar hole
                    with four corner coordinates and no local distortion.
- `colorize`      : fixed per-variable colour ramps → RGBA PNG bytes. Fixed
                    ranges, not per-frame min/max, so colours mean the same
                    thing at every step and across models.
- `encode_field`  : the same Mercator field as DATA — a lossless 16-bit PNG
                    the browser colourises on the GPU (front/field.js). The
                    ramps, the alpha rules and the encoding range are
                    published in the catalog so the two paths agree.
- `wind_json`     : coarse u/v grid for the particle layer.

Pure functions; the API layer caches their output on disk.
"""
from __future__ import annotations

import io
import json

import numpy as np
from PIL import Image
from scipy.ndimage import distance_transform_edt, zoom

from wxgrid.config import GRID_LAT_N, GRID_LON_N, GRID_RES

MERC_LAT_MAX = 89.99                # finite ImageSource edge; visually closes the globe
MERC_H = 1440                        # output rows; square with the 1440 columns

_merc_src_rows: np.ndarray | None = None
_merc_frac: np.ndarray | None = None


def _mercator_rows() -> tuple[np.ndarray, np.ndarray]:
    """For each output row, the fractional source-row index in the lat/lon grid."""
    global _merc_src_rows, _merc_frac
    if _merc_src_rows is None:
        r = (np.arange(MERC_H, dtype=np.float64) + 0.5) / MERC_H          # 0..1 top→bottom
        y_max = np.arcsinh(np.tan(np.deg2rad(MERC_LAT_MAX)))
        y = y_max * (1.0 - 2.0 * r)
        lat = np.degrees(np.arctan(np.sinh(y)))                            # 89.99..-89.99
        src = (90.0 - lat) / GRID_RES                                      # fractional row
        src = np.clip(src, 0, GRID_LAT_N - 1 - 1e-6)
        _merc_src_rows = np.floor(src).astype(np.int32)
        _merc_frac = (src - _merc_src_rows).astype(np.float32)
    return _merc_src_rows, _merc_frac


def to_mercator(field: np.ndarray, *, lat0: float = 90.0, lon0: float = -180.0,
                dlat: float = -GRID_RES, dlon: float = GRID_RES) -> np.ndarray:
    """Resample a regular lat/lon field into a Web-Mercator image.

    The original global grid keeps its exact 1440-square sampling path. A
    regional grid uses its own latitude extent and a Mercator-correct output
    aspect ratio; longitude columns never move.
    """
    ny, nx = field.shape
    if (ny, nx, lat0, lon0, dlat, dlon) == (GRID_LAT_N, GRID_LON_N, 90.0, -180.0, -GRID_RES, GRID_RES):
        rows, frac = _mercator_rows()
    else:
        last_lat = lat0 + (ny - 1) * dlat
        north = min(MERC_LAT_MAX, max(lat0, last_lat))
        south = max(-MERC_LAT_MAX, min(lat0, last_lat))
        lon_span = max(abs((nx - 1) * dlon), abs(dlon))
        y_n = np.arcsinh(np.tan(np.deg2rad(north)))
        y_s = np.arcsinh(np.tan(np.deg2rad(south)))
        out_h = max(2, int(round(nx * abs(y_n - y_s) / np.deg2rad(lon_span))))
        y = np.linspace(y_n, y_s, out_h, dtype=np.float64)
        target_lats = np.rad2deg(np.arctan(np.sinh(y)))
        src = (target_lats - lat0) / dlat
        src = np.clip(src, 0, ny - 1 - 1e-6)
        rows = np.floor(src).astype(np.int32)
        frac = (src - rows).astype(np.float32)
    a = field[rows]
    b = field[np.minimum(rows + 1, ny - 1)]
    return (a * (1.0 - frac)[:, None] + b * frac[:, None]).astype(np.float32)


# ── colour ramps ──────────────────────────────────────────────────────────
# (value, (r, g, b)) stops in DISPLAY units; alpha handled per variable.
RAMPS: dict[str, dict] = {
    "temp": {"units": "°C", "lo": -70, "hi": 45, "stops": [
        (-70, (40, 10, 70)), (-55, (90, 20, 130)), (-40, (130, 22, 146)), (-30, (75, 42, 180)),
        (-20, (35, 90, 200)), (-10, (40, 150, 220)), (0, (100, 200, 200)), (10, (110, 210, 110)),
        (20, (240, 220, 80)), (30, (240, 130, 40)), (40, (200, 30, 30)), (45, (140, 0, 60))]},
    # The conventional meteorological wind ramp: calm blues, green through the
    # middle, yellow and orange for a strong breeze, red at gale force and
    # purple beyond it. Capped at 32 m/s (115 km/h) so everyday weather uses
    # the whole scale instead of living in the blue third.
    "wind": {"units": "m/s", "lo": 0, "hi": 32, "stops": [
        (0, (28, 38, 92)), (2.5, (38, 88, 190)), (5, (26, 150, 220)), (7.5, (0, 198, 196)),
        (10, (58, 214, 108)), (12.5, (154, 228, 58)), (15, (250, 224, 56)), (18, (255, 176, 38)),
        (21, (250, 118, 36)), (24, (240, 58, 48)), (28, (204, 36, 124)), (32, (150, 40, 196))]},
    "gust": {"units": "m/s", "lo": 0, "hi": 44, "stops": [
        (0, (28, 38, 92)), (4, (38, 88, 190)), (8, (26, 150, 220)), (12, (0, 198, 196)),
        (16, (58, 214, 108)), (20, (154, 228, 58)), (24, (250, 224, 56)), (28, (255, 176, 38)),
        (32, (250, 118, 36)), (36, (240, 58, 48)), (40, (204, 36, 124)), (44, (150, 40, 196))]},
    "msl": {"units": "hPa", "lo": 950, "hi": 1050, "stops": [
        (950, (92, 24, 150)), (970, (54, 66, 204)), (990, (34, 148, 222)), (1005, (48, 196, 188)),
        (1013, (190, 216, 226)), (1025, (120, 202, 118)), (1040, (244, 192, 58)), (1050, (226, 72, 58))]},
    "tp6": {"units": "mm/6h", "lo": 0, "hi": 40, "stops": [
        (0, (110, 160, 230)), (1, (80, 130, 220)), (3, (40, 100, 200)), (8, (30, 170, 90)),
        (15, (240, 220, 40)), (25, (240, 120, 30)), (40, (200, 20, 60))]},
    "tcc": {"units": "%", "lo": 0, "hi": 100, "stops": [
        (0, (20, 30, 50)), (30, (90, 110, 140)), (60, (170, 180, 195)), (100, (245, 245, 250))]},
    "cloudlow": {"units": "%", "lo": 0, "hi": 100, "stops": [
        (0, (18, 34, 48)), (30, (62, 105, 126)), (60, (135, 170, 182)), (100, (230, 240, 242))]},
    "cloudmid": {"units": "%", "lo": 0, "hi": 100, "stops": [
        (0, (24, 28, 52)), (30, (75, 84, 137)), (60, (145, 151, 191)), (100, (232, 230, 247))]},
    "cloudhigh": {"units": "%", "lo": 0, "hi": 100, "stops": [
        (0, (31, 25, 51)), (30, (94, 72, 128)), (60, (164, 143, 184)), (100, (244, 225, 244))]},
    "fog": {"units": "%", "lo": 0, "hi": 100, "stops": [
        (0, (40, 55, 65)), (20, (86, 112, 122)), (50, (154, 180, 184)), (80, (216, 229, 227)), (100, (250, 252, 248))]},
    "solar": {"units": "W/m²", "lo": 0, "hi": 1050, "stops": [
        (0, (35, 30, 70)), (100, (83, 58, 145)), (300, (185, 76, 125)), (550, (241, 118, 61)),
        (800, (250, 194, 52)), (1050, (255, 244, 144))]},
    "sf6": {"units": "cm/6h", "lo": 0, "hi": 30, "stops": [
        (0, (150, 170, 220)), (1, (120, 150, 230)), (3, (80, 120, 230)), (8, (140, 90, 220)),
        (15, (200, 80, 200)), (30, (240, 60, 120))]},
    "sd_cm": {"units": "cm", "lo": 0, "hi": 300, "stops": [
        (0, (40, 60, 90)), (5, (90, 130, 190)), (30, (140, 190, 240)), (100, (220, 235, 250)),
        (200, (250, 250, 255)), (300, (200, 180, 255))]},
    "d2m": {"units": "°C", "lo": -30, "hi": 30, "stops": [
        (-30, (120, 60, 30)), (-10, (200, 150, 70)), (0, (200, 210, 120)), (10, (100, 190, 150)),
        (20, (40, 130, 200)), (30, (90, 30, 160))]},
    "frz": {"units": "m", "lo": 0, "hi": 5000, "stops": [
        (0, (240, 240, 255)), (500, (170, 200, 240)), (1000, (100, 160, 220)), (1500, (60, 190, 170)),
        (2000, (110, 210, 100)), (3000, (240, 220, 70)), (4000, (240, 130, 40)), (5000, (200, 30, 40))]},
    "cape": {"units": "J/kg", "lo": 0, "hi": 4000, "stops": [
        (0, (30, 30, 60)), (250, (60, 90, 190)), (700, (40, 170, 120)), (1500, (240, 220, 40)),
        (2500, (240, 120, 30)), (4000, (200, 20, 60))]},
    "rh": {"units": "%", "lo": 0, "hi": 100, "stops": [
        (0, (150, 90, 30)), (30, (200, 170, 90)), (50, (200, 210, 160)), (70, (110, 190, 190)),
        (85, (50, 130, 210)), (100, (60, 40, 170))]},
    "tp24": {"units": "mm/24h", "lo": 0, "hi": 120, "stops": [
        (0, (110, 160, 230)), (2, (80, 130, 220)), (10, (40, 100, 200)), (25, (30, 170, 90)),
        (50, (240, 220, 40)), (80, (240, 120, 30)), (120, (200, 20, 60))]},
    "tp72": {"units": "mm/72h", "lo": 0, "hi": 250, "stops": [
        (0, (110, 160, 230)), (5, (80, 130, 220)), (20, (40, 100, 200)), (50, (30, 170, 90)),
        (100, (240, 220, 40)), (170, (240, 120, 30)), (250, (200, 20, 60))]},
    "sf24": {"units": "cm/24h", "lo": 0, "hi": 60, "stops": [
        (0, (150, 170, 220)), (2, (120, 150, 230)), (8, (80, 120, 230)), (20, (140, 90, 220)),
        (35, (200, 80, 200)), (60, (240, 60, 120))]},
    "sf72": {"units": "cm/72h", "lo": 0, "hi": 150, "stops": [
        (0, (150, 170, 220)), (5, (120, 150, 230)), (20, (80, 120, 230)), (50, (140, 90, 220)),
        (90, (200, 80, 200)), (150, (240, 60, 120))]},
    "uvi": {"units": "UVI", "lo": 0, "hi": 12, "stops": [
        (0, (40, 60, 40)), (1, (60, 160, 70)), (3, (140, 200, 60)), (5, (240, 220, 40)),
        (6, (240, 150, 40)), (8, (220, 60, 40)), (10, (170, 40, 150)), (12, (110, 20, 140))]},
    "waves": {"units": "m", "lo": 0, "hi": 10, "stops": [
        (0, (40, 60, 120)), (1, (40, 120, 200)), (2, (40, 190, 190)), (3, (90, 210, 110)),
        (4.5, (230, 220, 60)), (6, (240, 130, 40)), (8, (220, 50, 40)), (10, (150, 0, 80))]},
    "wperiod": {"units": "s", "lo": 0, "hi": 20, "stops": [
        (0, (40, 40, 80)), (5, (60, 100, 190)), (8, (60, 180, 170)), (11, (150, 210, 90)),
        (14, (240, 200, 60)), (17, (240, 120, 40)), (20, (200, 30, 60))]},
    "swell": {"units": "m", "lo": 0, "hi": 8, "stops": [
        (0, (40, 60, 120)), (1, (40, 120, 200)), (2, (40, 190, 190)), (3, (90, 210, 110)),
        (4.5, (230, 220, 60)), (6, (240, 130, 40)), (8, (220, 50, 40)), (10, (150, 0, 80))]},
    "windsea": {"units": "m", "lo": 0, "hi": 6, "stops": [
        (0, (40, 60, 120)), (1, (40, 120, 200)), (2, (40, 190, 190)), (3, (90, 210, 110)),
        (4.5, (230, 220, 60)), (6, (240, 130, 40)), (8, (220, 50, 40)), (10, (150, 0, 80))]},
    "pp1d": {"units": "s", "lo": 0, "hi": 25, "stops": [
        (0, (40, 40, 80)), (5, (60, 100, 190)), (8, (60, 180, 170)), (11, (150, 210, 90)),
        (14, (240, 200, 60)), (17, (240, 120, 40)), (20, (200, 30, 60))]},
    "feels": {"units": "°C", "lo": -70, "hi": 45, "stops": [
        (-70, (40, 10, 70)), (-55, (90, 20, 130)), (-40, (130, 22, 146)), (-30, (75, 42, 180)),
        (-20, (35, 90, 200)), (-10, (40, 150, 220)), (0, (100, 200, 200)), (10, (110, 210, 110)),
        (20, (240, 220, 80)), (30, (240, 130, 40)), (40, (200, 30, 30)), (45, (140, 0, 60))]},
    # member share, not intensity: cool neutral up to a warm certainty
    "prob_rain": {"units": "%", "lo": 0, "hi": 100, "stops": [
        (0, (30, 40, 70)), (20, (45, 90, 160)), (40, (35, 130, 210)), (60, (30, 175, 190)),
        (80, (90, 210, 120)), (100, (240, 220, 70))]},
    "vis": {"units": "km", "lo": 0, "hi": 20, "stops": [
        (0, (150, 30, 120)), (0.4, (200, 40, 60)), (1, (240, 120, 40)), (3, (240, 210, 60)),
        (6, (140, 200, 90)), (10, (70, 160, 190)), (20, (40, 70, 120))]},
    "sst": {"units": "°C", "lo": -2, "hi": 32, "stops": [
        (-2, (180, 200, 240)), (2, (70, 90, 200)), (8, (40, 140, 220)), (14, (30, 190, 180)),
        (20, (90, 210, 100)), (24, (240, 220, 70)), (28, (240, 130, 40)), (32, (200, 30, 60))]},
    # categorical: 0 none · 1 rain · 2 mixed · 3 snow
    "ptype": {"units": "", "lo": 0, "hi": 3, "stops": [
        (0, (0, 0, 0)), (0.99, (60, 130, 220)), (1.01, (60, 130, 220)),
        (1.99, (190, 110, 220)), (2.01, (190, 110, 220)), (2.99, (235, 240, 255)), (3, (235, 240, 255))]},
    # relative vorticity at 500 hPa, 10⁻⁵ s⁻¹: red cyclonic, blue anticyclonic
    "vort500": {"units": "10⁻⁵/s", "lo": -20, "hi": 20, "stops": [
        (-20, (30, 60, 180)), (-8, (70, 130, 220)), (-2, (150, 180, 220)), (0, (235, 235, 235)),
        (2, (230, 180, 150)), (8, (230, 110, 70)), (20, (180, 20, 40))]},
    # ±hPa/3h, diverging: falling glass red (storm side), rising blue-green
    "ptend": {"units": "hPa/3h", "lo": -6, "hi": 6, "stops": [
        (-6, (170, 20, 60)), (-3, (230, 90, 60)), (-1, (240, 180, 120)), (0, (235, 235, 235)),
        (1, (150, 210, 190)), (3, (70, 160, 200)), (6, (40, 80, 190))]},
    "cbase": {"units": "m", "lo": 0, "hi": 3000, "stops": [
        (0, (120, 120, 140)), (300, (150, 150, 170)), (700, (110, 170, 210)), (1200, (80, 190, 160)),
        (2000, (170, 210, 90)), (3000, (240, 210, 70))]},
    "wbt": {"units": "°C", "lo": -20, "hi": 36, "stops": [
        (-20, (90, 60, 160)), (-10, (60, 100, 200)), (0, (60, 170, 200)), (10, (90, 200, 130)),
        (18, (220, 220, 90)), (24, (240, 160, 60)), (28, (230, 90, 50)), (32, (190, 30, 60)), (36, (120, 0, 80))]},
    # ±°C against yesterday's same hour, diverging
    "dt24": {"units": "°C/24h", "lo": -15, "hi": 15, "stops": [
        (-15, (40, 60, 190)), (-8, (60, 130, 220)), (-3, (150, 195, 230)), (0, (235, 235, 235)),
        (3, (240, 190, 140)), (8, (235, 110, 60)), (15, (180, 20, 50))]},
    "gfactor": {"units": "m/s", "lo": 0, "hi": 15, "stops": [
        (0, (40, 60, 90)), (3, (60, 150, 190)), (6, (120, 210, 130)), (9, (240, 210, 60)),
        (12, (245, 130, 40)), (15, (210, 40, 60))]},
    "wavepower": {"units": "kW/m", "lo": 0, "hi": 100, "stops": [
        (0, (30, 48, 95)), (5, (36, 111, 180)), (15, (30, 184, 178)), (30, (103, 208, 102)),
        (50, (238, 217, 62)), (75, (241, 117, 43)), (100, (196, 38, 80))]},
    "prob_gust": {"units": "%", "lo": 0, "hi": 100, "stops": [
        (0, (40, 35, 60)), (20, (120, 80, 170)), (40, (190, 80, 170)), (60, (240, 100, 110)),
        (80, (250, 150, 60)), (100, (250, 220, 60))]},
    # Geopotential height, written for 500 hPa: the chart every synoptician
    # reads first. Cold troughs at the low end, warm ridges at the high end.
    # Every other level slides this same shape onto its own window — see
    # GH_WINDOW and ramp_for().
    "gh": {"units": "m", "lo": 4900, "hi": 6000, "stops": [
        (4900, (60, 20, 110)), (5030, (45, 60, 175)), (5175, (35, 120, 210)), (5320, (40, 175, 195)),
        (5450, (70, 200, 130)), (5580, (170, 215, 70)), (5725, (245, 210, 55)), (5870, (245, 130, 45)),
        (6000, (205, 40, 55))]},
}

# The height band each pressure level actually occupies, in metres. A single
# fixed ramp would put 850 hPa (~1.5 km) and 200 hPa (~12 km) in one colour
# each; these windows are the standard-atmosphere height with room either side
# for the ridges and troughs a synoptic chart is drawn to show.
GH_DEFAULT_LEVEL = 500
GH_WINDOW: dict[int, tuple[float, float]] = {
    1000: (-150, 350), 925: (500, 1000), 850: (1150, 1650), 700: (2650, 3250),
    600: (3800, 4500), 500: (4900, 6000), 400: (6300, 7700), 300: (8200, 9800),
    250: (9300, 11000), 200: (10600, 12500), 150: (12900, 14500), 100: (15600, 17000),
}


def ramp_for(layer: str, level: int | None = None) -> dict:
    """The ramp a layer uses at a pressure level.

    Only geopotential height moves: its 500 hPa stops are slid and stretched
    onto the level's own window, so the ramp keeps its shape and every level
    spends the whole 256-entry scale on the heights it actually reaches.
    """
    ramp = RAMPS[layer]
    if layer != "gh" or level in (None, 0, GH_DEFAULT_LEVEL) or level not in GH_WINDOW:
        return ramp
    lo, hi = GH_WINDOW[level]
    blo, bhi = ramp["lo"], ramp["hi"]
    span = float(bhi - blo)
    return {**ramp, "lo": lo, "hi": hi,
            "stops": [(round(lo + (hi - lo) * (v - blo) / span), rgb) for v, rgb in ramp["stops"]]}

# canonical store variable → display transform (store units → ramp units)
DISPLAY = {
    "temp": lambda k: k - 273.15,
    "msl": lambda pa: pa / 100.0,
    "tp6": lambda mm: mm,
    "gust": lambda ms: ms,
    "wind": lambda ms: ms,
    "tcc": lambda frac: frac * 100.0,
    "cloudlow": lambda frac: frac * 100.0,
    "cloudmid": lambda frac: frac * 100.0,
    "cloudhigh": lambda frac: frac * 100.0,
    "fog": lambda pct: pct,
    "solar": lambda wm2: wm2,
    "cape": lambda j: j,
    "sf6": lambda mm_we: mm_we,      # ramp is labelled cm at a 10:1 ratio: 1 mm w.e. ≈ 1 cm fresh snow
    "sd_cm": lambda cm: cm,
    "d2m": lambda k: k - 273.15,
    "frz": lambda m: m,
    "rh": lambda pct: pct,
    "tp24": lambda mm: mm,
    "tp72": lambda mm: mm,
    "sf24": lambda mm_we: mm_we,     # 1 mm w.e. ≈ 1 cm fresh snow, as sf6
    "sf72": lambda mm_we: mm_we,
    "waves": lambda m: m,
    "wperiod": lambda s: s,
    "wavepower": lambda kwm: kwm,
    "swell": lambda m: m,
    "windsea": lambda m: m,
    "pp1d": lambda s: s,
    "uvi": lambda u: u,
    "feels": lambda k: k - 273.15,
    "prob_rain": lambda pct: pct,
    "prob_gust": lambda pct: pct,
    "gfactor": lambda ms: ms,
    "vis": lambda m: m / 1000.0,
    "sst": lambda k: k - 273.15,
    "ptype": lambda c: c,
    "vort500": lambda z: z * 1e5,
    "ptend": lambda pa: pa / 100.0,
    "cbase": lambda m: m,
    "wbt": lambda k: k - 273.15,
    "dt24": lambda dk: dk,
    "gh": lambda m: m,
}


def uv_index_point(tcc: list, valid: list, lat: float, lon: float) -> list:
    """Same estimate as uv_index() for one point over a run's valid times."""
    out = []
    for c, when in zip(tcc, valid):
        if c is None:
            out.append(None); continue
        doy = when.timetuple().tm_yday
        hour = when.hour + when.minute / 60.0
        decl = np.deg2rad(23.44) * np.sin(2 * np.pi * (284 + doy) / 365.0)
        ha = np.deg2rad(15.0 * (hour - 12.0) + lon)
        mu = np.sin(np.deg2rad(lat)) * np.sin(decl) + np.cos(np.deg2rad(lat)) * np.cos(decl) * np.cos(ha)
        mu = max(0.0, min(1.0, float(mu)))
        out.append(round(12.5 * mu ** 2.42 * (1.0 - 0.56 * max(0.0, min(1.0, c))), 1))
    return out


def uv_index(tcc: np.ndarray, when, *, lat0: float = 90.0, lon0: float = -180.0,
             dlat: float = -GRID_RES, dlon: float = GRID_RES) -> np.ndarray:
    """Estimated UV index on the whole grid at a UTC datetime: clear-sky index
    from solar elevation (UVI ≈ 12.5·μ₀^2.42, sea level, ~300 DU ozone; Allaart
    et al. 2004 fit) reduced by cloud (1 − 0.56·tcc). No ozone, aerosol or
    altitude term — a planning number, not a measurement."""
    doy = when.timetuple().tm_yday
    hour = when.hour + when.minute / 60.0
    decl = np.deg2rad(23.44) * np.sin(2 * np.pi * (284 + doy) / 365.0)
    lats = np.deg2rad(lat0 + np.arange(tcc.shape[0]) * dlat)[:, None]
    lons = (lon0 + np.arange(tcc.shape[1]) * dlon)[None, :]
    ha = np.deg2rad(15.0 * (hour - 12.0) + lons)
    mu = np.sin(lats) * np.sin(decl) + np.cos(lats) * np.cos(decl) * np.cos(ha)
    mu = np.clip(mu, 0.0, 1.0)
    clear = 12.5 * mu ** 2.42
    cloud = 1.0 - 0.56 * np.clip(np.nan_to_num(tcc), 0.0, 1.0)
    return (clear * cloud).astype(np.float32)


def solar_power(tcc: np.ndarray, when, *, lat0: float = 90.0, lon0: float = -180.0,
                dlat: float = -GRID_RES, dlon: float = GRID_RES) -> np.ndarray:
    """Approximate downwelling shortwave power at the surface in W/m².

    Solar geometry supplies the honest day/night and seasonal signal; total
    cloud supplies an empirical attenuation. This is a planning layer, not a
    pyranometer or a PV-production forecast (no aerosol, terrain or panel
    geometry).
    """
    doy = when.timetuple().tm_yday
    hour = when.hour + when.minute / 60.0
    decl = np.deg2rad(23.44) * np.sin(2 * np.pi * (284 + doy) / 365.0)
    lats = np.deg2rad(lat0 + np.arange(tcc.shape[0]) * dlat)[:, None]
    lons = (lon0 + np.arange(tcc.shape[1]) * dlon)[None, :]
    ha = np.deg2rad(15.0 * (hour - 12.0) + lons)
    mu = np.clip(np.sin(lats) * np.sin(decl) + np.cos(lats) * np.cos(decl) * np.cos(ha), 0.0, 1.0)
    cloud = np.clip(np.nan_to_num(tcc, nan=1.0), 0.0, 1.0)
    attenuation = 1.0 - 0.75 * cloud ** 3.4
    return (1100.0 * mu * attenuation).astype(np.float32)


def wind_sea(total_m: np.ndarray, swell_m: np.ndarray) -> np.ndarray:
    """Wind-sea height: what is left of the total significant height once
    the swell (periods ≥ 10 s) is taken out, energies adding in quadrature."""
    return np.sqrt(np.clip(np.square(total_m) - np.square(swell_m), 0.0, None)).astype(np.float32)


def wave_power(height_m: np.ndarray, period_s: np.ndarray) -> np.ndarray:
    """Deep-water wave-energy flux in kW per metre of wave crest."""
    return (0.49 * np.square(height_m) * period_s).astype(np.float32)


def fog_potential(rh_pct: np.ndarray, low_cloud: np.ndarray) -> np.ndarray:
    """A deliberately labelled fog *potential* from saturation and low cloud.

    RH below 80 % contributes nothing; the final 20 points scale to 100 and
    low-cloud fraction gates the result. It avoids pretending the model has a
    direct visibility diagnosis where it does not.
    """
    return (np.clip((rh_pct - 80.0) * 5.0, 0.0, 100.0) * np.clip(low_cloud, 0.0, 1.0)).astype(np.float32)


def relative_humidity(t_k: np.ndarray, td_k: np.ndarray) -> np.ndarray:
    """RH % from temperature and dew point (Magnus, over water)."""
    t = t_k - 273.15
    td = td_k - 273.15
    a, b = 17.625, 243.04
    with np.errstate(invalid="ignore", divide="ignore"):
        rh = 100.0 * np.exp(a * td / (b + td) - a * t / (b + t))
    return np.clip(rh, 0.0, 100.0).astype(np.float32)


def _lut(ramp: dict) -> np.ndarray:
    """256×4 uint8 lookup for values linearly binned lo..hi."""
    lo, hi, stops = ramp["lo"], ramp["hi"], ramp["stops"]
    xs = np.array([s[0] for s in stops], dtype=np.float64)
    cols = np.array([s[1] for s in stops], dtype=np.float64)
    v = lo + (hi - lo) * np.arange(256) / 255.0
    lut = np.zeros((256, 4), dtype=np.uint8)
    for c in range(3):
        lut[:, c] = np.clip(np.interp(v, xs, cols[:, c]), 0, 255).astype(np.uint8)
    lut[:, 3] = 255
    return lut


_LUTS = {k: _lut(v) for k, v in RAMPS.items()}
# Per-level lookups, built once each. Only geopotential height needs them.
_LEVEL_LUTS: dict[tuple[str, int], np.ndarray] = {}


def _lut_for(layer: str, level: int | None) -> np.ndarray:
    ramp = ramp_for(layer, level)
    if ramp is RAMPS[layer]:
        return _LUTS[layer]
    key = (layer, int(level))
    if key not in _LEVEL_LUTS:
        _LEVEL_LUTS[key] = _lut(ramp)
    return _LEVEL_LUTS[key]


# ── alpha rules ───────────────────────────────────────────────────────────
# How see-through a pixel is as a function of its DISPLAY-unit value. One
# table, used by `colorize` here and published in the catalog for the GPU
# path, so the browser cannot drift from the server's picture:
#   ramp  clip((x - x0) / k) ** p     rain fades in over the first millimetre
#   abs   clip(|x| / k)               diverging fields: nothing at zero
#   fall  clip((x0 - x) / k)          visibility: good visibility is the map
#   step  1 where x >= x0             precip type: any kind, or nothing
#   mask  1                           land is NaN: sea temp, waves
# Layers not listed here have constant alpha (the palette PNGs).
# Missing data is transparent under every rule.
ALPHA_RULES: dict[str, dict] = {
    "tp6": {"kind": "ramp", "k": 1.0}, "tp24": {"kind": "ramp", "k": 2.0}, "tp72": {"kind": "ramp", "k": 4.0},
    "sf6": {"kind": "ramp", "k": 0.5}, "sf24": {"kind": "ramp", "k": 1.0}, "sf72": {"kind": "ramp", "k": 2.0},
    "waves": {"kind": "mask"}, "wperiod": {"kind": "mask"}, "wavepower": {"kind": "mask"}, "sst": {"kind": "mask"},
    "swell": {"kind": "mask"}, "windsea": {"kind": "mask"}, "pp1d": {"kind": "mask"},
    "solar": {"kind": "ramp", "k": 120.0},        # night is the bare map
    "uvi": {"kind": "ramp", "k": 1.0},            # night is transparent
    "sd_cm": {"kind": "ramp", "k": 2.0},
    "cape": {"kind": "ramp", "k": 300.0},         # nothing to see under ~300 J/kg
    "prob_rain": {"kind": "ramp", "k": 30.0},     # a 5 % chance is the map, not a colour
    "prob_gust": {"kind": "ramp", "k": 30.0},
    "gfactor": {"kind": "ramp", "k": 3.0, "x0": 1.5},    # steady flow is the map
    "vis": {"kind": "fall", "k": 8.0, "x0": 12.0},       # good visibility is the map itself
    "ptype": {"kind": "step", "x0": 0.99},
    "vort500": {"kind": "abs", "k": 4.0},         # quiescent air is transparent
    "ptend": {"kind": "abs", "k": 1.2},           # a steady glass is the map
    "dt24": {"kind": "abs", "k": 2.5},            # same-as-yesterday is the map
    # clear sky shows the map through
    "tcc": {"kind": "ramp", "k": 100.0, "p": 0.7}, "cloudlow": {"kind": "ramp", "k": 100.0, "p": 0.7},
    "cloudmid": {"kind": "ramp", "k": 100.0, "p": 0.7}, "cloudhigh": {"kind": "ramp", "k": 100.0, "p": 0.7},
    "fog": {"kind": "ramp", "k": 100.0, "p": 0.7},
}
# The alpha every rendered pixel is scaled by before the front end applies
# its own per-layer opacity (LAYER_ALPHA in app.js). Both paths multiply it in.
BASE_ALPHA = 0.78


def alpha_for(layer: str, x: np.ndarray) -> np.ndarray:
    """Per-pixel alpha in 0..1 from a DISPLAY-unit field (NaN already
    substituted; the caller zeroes missing pixels afterwards)."""
    rule = ALPHA_RULES.get(layer)
    if rule is None or rule["kind"] == "mask":
        return np.ones(x.shape, dtype=np.float32)
    kind = rule["kind"]
    if kind == "ramp":
        a = np.clip((x - rule.get("x0", 0.0)) / rule["k"], 0, 1)
        p = rule.get("p", 1.0)
        return a ** p if p != 1.0 else a
    if kind == "abs":
        return np.clip(np.abs(x) / rule["k"], 0, 1)
    if kind == "fall":
        return np.clip((rule["x0"] - x) / rule["k"], 0, 1)
    if kind == "step":
        return np.where(x >= rule["x0"], 1.0, 0.0)
    raise ValueError(f"unknown alpha rule {kind}")


IMAGE_FORMATS = {"png": "image/png", "webp": "image/webp"}
# The rendered pixels changed from native-size linear sampling to 2x
# value-space interpolation. Keep that fact in the immutable cache key so an
# old frame can never masquerade as the new output after deploy.
LAYER_CACHE_VERSION = "r2x-v4"   # v4: warmed frames are real PNGs; v3 held WebP bytes under .png names
# Layers whose alpha varies with the value, so they cannot be palette images.
_RGBA_LAYERS = tuple(ALPHA_RULES)


def pick_format(accept: str | None) -> str:
    """PNG, for everyone. Measured 2026-08-21 at the 2x render scale
    (2880x2880): lossless WebP encodes in 2.9-4.8 s per frame against PNG's
    1.1 s, for only ~20 % fewer bytes -- and the encode happens on the request
    that misses the cache, so the user wears it. Lossy WebP is off the table:
    the probe reads values back out of the rendered colours. The static demo
    already writes PNG on its own path."""
    return "png"


def layer_cache_name(step: int, tag: str, accept: str | None) -> tuple[str, str, str]:
    """(cache filename, format, media type) for one rendered layer. Keeps the
    format decision and the cache key in one place, so a WebP and a PNG of the
    same step never collide on disk."""
    fmt = pick_format(accept)
    return f"{step:03d}-{LAYER_CACHE_VERSION}-{tag}.{fmt}", fmt, IMAGE_FORMATS[fmt]


def upscale_values(field_display: np.ndarray, layer: str, factor: int = 2) -> np.ndarray:
    """Upsample display-unit values before colour mapping.

    Continuous weather fields use cubic interpolation, ensemble probabilities
    stay linear, and precipitation type stays categorical. Missing regions are
    nearest-filled only for the interpolation pass and then masked back out;
    otherwise a cubic kernel sees NaN at a coastline and turns a several-pixel
    fringe into NaN or a coloured halo.
    """
    field = np.asarray(field_display, dtype=np.float32)
    if factor == 1:
        return field.copy()
    order = 0 if layer == "ptype" else 1 if layer.startswith("prob_") else 3
    good = np.isfinite(field)
    if not good.any():
        return np.full(tuple(n * factor for n in field.shape), np.nan, dtype=np.float32)
    if good.all():
        return np.asarray(zoom(field, factor, order=order), dtype=np.float32)

    nearest = distance_transform_edt(~good, return_distances=False, return_indices=True)
    filled = field[tuple(nearest)]
    out = np.asarray(zoom(filled, factor, order=order), dtype=np.float32)
    valid = zoom(good.astype(np.uint8), factor, order=0).astype(bool)
    out[~valid] = np.nan
    return out


# libwebp effort. 1 gets within ~1 pp of the best ratio on the big alpha
# layers for ~1 s per 1440² frame; 2+ costs 3-16 s for that last percent, and
# a layer is encoded on the request that misses the cache, so the user waits.
WEBP_METHOD = 1


def _webp(rgba: np.ndarray, buf: io.BytesIO) -> bytes:
    """Lossless WebP from an RGBA array — the same pixels the PNG carries.

    `exact=True` keeps the colour under fully transparent pixels. libwebp
    would happily rewrite it (nobody can see it, and it compresses better),
    but the GPU can: MapLibre filters the raster bilinearly, so a texel at the
    edge of a rain blob mixes with its invisible neighbour, and a neighbour
    quietly zeroed to black draws a dark fringe. It is not even a real
    trade-off here — measured on tp6, `exact=True` came out *smaller* as well
    as identical, because the zeroed pixels break the run-length structure the
    encoder was exploiting.
    """
    Image.fromarray(rgba, "RGBA").save(buf, format="WEBP", lossless=True, quality=100,
                                       method=WEBP_METHOD, exact=True)
    return buf.getvalue()


def colorize(field_display: np.ndarray, layer: str, alpha: float = BASE_ALPHA, fmt: str = "png",
             level: int | None = None) -> bytes:
    """PNG (or WebP) for a Mercator-projected field already in display units.

    Constant-alpha layers go out as 8-bit palette PNGs (256 colours is exactly
    the LUT, ~4x smaller than RGBA on the wire); rain, whose alpha varies with
    the value, stays RGBA. A field that is entirely missing (a step the model
    did not publish for this variable) becomes a fully transparent image, so
    the map shows nothing rather than a stale previous step.

    `fmt="webp"` emits the identical RGBA as lossless WebP. WebP has no
    palette mode, so the palette layers are expanded to RGBA first with the
    same constant alpha the PNG's transparency table carries — the decoded
    image is byte-identical either way, only the container differs."""
    if fmt not in IMAGE_FORMATS:
        raise ValueError(f"unknown image format {fmt}")
    ramp, lut = ramp_for(layer, level), _lut_for(layer, level)
    lo, hi = ramp["lo"], ramp["hi"]
    buf = io.BytesIO()
    if np.all(np.isnan(field_display)):
        blank = Image.new("RGBA", (field_display.shape[1], field_display.shape[0]), (0, 0, 0, 0))
        if fmt == "webp":
            blank.save(buf, format="WEBP", lossless=True, method=WEBP_METHOD, exact=True)
        else:
            blank.save(buf, format="PNG")
        return buf.getvalue()
    x = np.nan_to_num(field_display, nan=lo)
    idx = np.clip((x - lo) / (hi - lo) * 255.0, 0, 255).astype(np.uint8)
    if layer in _RGBA_LAYERS:
        rgba = lut[idx].copy()
        a = alpha_for(layer, x)
        # Missing data is transparent under every rule. It used to inherit
        # the lo colour where a rule reads high at lo (the poles of the
        # vorticity chart came out solid blue).
        a = np.where(np.isnan(field_display), 0.0, a)
        rgba[..., 3] = (a * alpha * 255).astype(np.uint8)
        if fmt == "webp":
            return _webp(rgba, buf)
        Image.fromarray(rgba, "RGBA").save(buf, format="PNG", optimize=False, compress_level=6)
        return buf.getvalue()
    missing = np.isnan(field_display)
    if fmt == "webp" or missing.any():
        rgba = lut[idx].copy()
        rgba[..., 3] = int(alpha * 255)
        rgba[missing, 3] = 0
        if fmt == "webp":
            return _webp(rgba, buf)
        Image.fromarray(rgba, "RGBA").save(buf, format="PNG", optimize=False, compress_level=6)
        return buf.getvalue()
    img = Image.fromarray(idx, "P")
    img.putpalette(lut[:, :3].astype(np.uint8).ravel().tolist())
    img.info["transparency"] = bytes([int(alpha * 255)] * 256)
    img.save(buf, format="PNG", optimize=False, compress_level=6, transparency=bytes([int(alpha * 255)] * 256))
    return buf.getvalue()


# ── the field itself ──────────────────────────────────────────────────────
# The GPU path ships the model grid as data and colourises in the browser.
# Each value is a 16-bit integer over a fixed per-layer range, split across
# the red (high byte) and green (low byte) channels of an ordinary RGB PNG:
# every browser decodes that natively and losslessly, and hi*256+lo is
# linear in the channels, so the shader's own bilinear taps reconstruct
# exactly. Blue is the mask: 255 where the model has a value, 0 where it
# does not (land under a wave field, a step the model did not publish). A
# 16-bit grey PNG would carry the same bits, but the canvas and texture
# paths in browsers quietly flatten it to 8.
#
# The grid goes out as stored (721x1440 for the global models, the native
# subgrid for a regional one), not reprojected: the shader turns each
# screen pixel into a latitude and samples the row, which is the same
# interpolation `to_mercator` does for the PNG path with half the pixels
# and no second resampling.
#
# The range is wider than the ramp on purpose: the ramp is what the map
# colours, the range is what the probe can read back. Values are rounded
# to FIELD_BITS of the 16-bit slot (4096 steps over 160 °C is 0.04 °C,
# finer than the store's own float16 and 16 times the LUT's resolution);
# the zeroed low bits are what let deflate work, measured 2026-08-25 at
# 15-45 % fewer bytes than the full 16 bits. The decoder never needs to
# know: it always reads hi*256+lo over lo..hi.
# Changing a range or the depth changes the bytes, so bump FIELD_VERSION
# with it — the version rides in the URL, which is what the service worker
# caches on.
FIELD_VERSION = 1
FIELD_BITS = 12
_FIELD_BITS = {"ptype": 16}         # categorical: the four codes stay exact
FIELD_RANGE: dict[str, tuple[float, float]] = {
    "temp": (-100.0, 60.0), "feels": (-100.0, 60.0), "d2m": (-100.0, 60.0), "wbt": (-100.0, 60.0),
    "sst": (-5.0, 45.0), "dt24": (-50.0, 50.0),
    "wind": (0.0, 120.0), "gust": (0.0, 120.0), "gfactor": (0.0, 60.0),
    "msl": (850.0, 1100.0), "ptend": (-30.0, 30.0),
    "tp6": (0.0, 300.0), "tp24": (0.0, 600.0), "tp72": (0.0, 1500.0),
    "sf6": (0.0, 150.0), "sf24": (0.0, 400.0), "sf72": (0.0, 1000.0), "sd_cm": (0.0, 3000.0),
    "tcc": (0.0, 100.0), "cloudlow": (0.0, 100.0), "cloudmid": (0.0, 100.0), "cloudhigh": (0.0, 100.0),
    "fog": (0.0, 100.0), "rh": (0.0, 100.0), "prob_rain": (0.0, 100.0), "prob_gust": (0.0, 100.0),
    "solar": (0.0, 1400.0), "uvi": (0.0, 20.0), "cape": (0.0, 10000.0),
    "frz": (-500.0, 8000.0), "cbase": (0.0, 20000.0), "vis": (0.0, 100.0),
    "waves": (0.0, 30.0), "wperiod": (0.0, 40.0), "wavepower": (0.0, 2000.0),
    "swell": (0.0, 30.0), "windsea": (0.0, 30.0), "pp1d": (0.0, 40.0),
    "ptype": (0.0, 3.0), "vort500": (-100.0, 100.0),
}


def field_range(layer: str, level: int | None = None) -> tuple[float, float]:
    """Encoding range in display units. Height follows its level window with
    half a window of room either side; anything unlisted gets its ramp with
    the same margin."""
    if layer in FIELD_RANGE and layer != "gh":
        return FIELD_RANGE[layer]
    ramp = ramp_for(layer, level)
    lo, hi = float(ramp["lo"]), float(ramp["hi"])
    span = hi - lo
    return (lo - 0.5 * span, hi + 0.5 * span)


# Field frames: lossless WebP where the client takes it, PNG otherwise. At
# the grid's native size (1440x721) lossless WebP method 4 is ~30 % smaller
# than PNG for ~0.5 s of encode against 0.2 s (measured 2026-09-02); the
# ingest pre-encodes the common layers so a visit rarely pays it. The bytes
# decode identically — the mask channel check in field.js still applies.
FIELD_FORMATS = {"png": "image/png", "webp": "image/webp"}


def field_format(accept: str | None) -> str:
    return "webp" if accept and "image/webp" in accept else "png"


def field_cache_name(step: int, tag: str, fmt: str = "png") -> str:
    return f"{step:03d}-field-v{FIELD_VERSION}-{tag}.{fmt}"


def encode_field(field_display: np.ndarray, layer: str, level: int | None = None, fmt: str = "png") -> bytes:
    """RGB image of a grid in display units: R/G the 16-bit value over
    field_range(), B the validity mask. Missing pixels are (0, 0, 0).
    Lossless in either format, so the decoder gets the same bytes back."""
    lo, hi = field_range(layer, level)
    step = 1 << (16 - _FIELD_BITS.get(layer, FIELD_BITS))
    x = np.asarray(field_display, dtype=np.float32)
    good = np.isfinite(x)
    # nearest multiple of `step` on the full 16-bit scale, so the decoder's
    # q/65535 stays exact and the dropped bits are zero
    q = np.rint((np.where(good, x, lo) - lo) / (hi - lo) * (65535.0 / step)) * step
    q = np.clip(np.nan_to_num(q), 0, 65535 - 65535 % step).astype(np.uint16)
    q[~good] = 0
    rgb = np.empty(x.shape + (3,), dtype=np.uint8)
    rgb[..., 0] = q >> 8
    rgb[..., 1] = q & 255
    rgb[..., 2] = np.where(good, 255, 0).astype(np.uint8)
    buf = io.BytesIO()
    if fmt == "webp":
        Image.fromarray(rgb, "RGB").save(buf, format="WEBP", lossless=True, quality=100, method=4)
    else:
        Image.fromarray(rgb, "RGB").save(buf, format="PNG", optimize=False, compress_level=6)
    return buf.getvalue()


def field_resolution(layer: str, level: int | None = None) -> float:
    """The value step one code represents: the most a probe reading can be
    off by, and the honest precision to quote for the field files."""
    lo, hi = field_range(layer, level)
    return (hi - lo) * (1 << (16 - _FIELD_BITS.get(layer, FIELD_BITS))) / 65535.0


def decode_field(png: bytes, layer: str, level: int | None = None) -> np.ndarray:
    """The inverse of encode_field: what the browser reconstructs. For
    tests and Python consumers."""
    lo, hi = field_range(layer, level)
    rgb = np.asarray(Image.open(io.BytesIO(png)).convert("RGB"))
    q = rgb[..., 0].astype(np.float32) * 256.0 + rgb[..., 1].astype(np.float32)
    out = (lo + q / 65535.0 * (hi - lo)).astype(np.float32)
    out[rgb[..., 2] == 0] = np.nan
    return out

def legend(layer: str, level: int | None = None) -> dict:
    ramp = ramp_for(layer, level)
    lo, hi = field_range(layer, level)
    out = {"layer": layer, "units": ramp["units"], "lo": ramp["lo"], "hi": ramp["hi"],
           "stops": [{"v": v, "rgb": list(rgb)} for v, rgb in ramp["stops"]],
           # what the field PNG encodes, and how the browser fades it
           "enc": {"lo": lo, "hi": hi},
           "alpha": {"base": BASE_ALPHA, **ALPHA_RULES.get(layer, {"kind": "const"})}}
    # Height reads on a different scale at every level, so the catalog carries
    # all of them and the legend bar picks the one the map is showing.
    if layer == "gh" and level is None:
        out["levels"] = {str(l): legend(layer, l) for l in GH_WINDOW}
    return out


# ── wind vectors for particles ────────────────────────────────────────────

def wind_json(u: np.ndarray, v: np.ndarray, factor: int = 4, decimals: int = 1,
              mask: np.ndarray | None = None, *, lat0: float = 90.0,
              lon0: float = -180.0, dlat: float = -GRID_RES,
              dlon: float = GRID_RES, wrap: bool = True) -> bytes:
    """Coarsen a regular-grid u/v field and emit compact particle JSON."""
    uu = u[::factor, ::factor]
    vv = v[::factor, ::factor]
    if wrap:
        uu = np.concatenate([uu, uu[:, :1]], axis=1)
        vv = np.concatenate([vv, vv[:, :1]], axis=1)
    mm = None
    if mask is not None:
        mm = np.asarray(mask, dtype=bool)[::factor, ::factor]
        if wrap:
            mm = np.concatenate([mm, mm[:, :1]], axis=1)
    ny, nx = uu.shape

    def _compact(a: np.ndarray) -> list:
        # Round in float64, not float32: json.dumps prints a float32 0.1 as its
        # exact float64 expansion (17 digits), which made this payload 2 MB.
        a = np.nan_to_num(a.astype(np.float64))
        return (np.round(a, decimals) if decimals else np.rint(a).astype(int)).ravel().tolist()

    payload = {
        "lat0": lat0, "lon0": lon0, "dlat": dlat * factor, "dlon": dlon * factor,
        "wrap": wrap,
        "ny": int(ny), "nx": int(nx),
        "u": _compact(uu),
        "v": _compact(vv),
    }
    if mm is not None:
        payload["mask"] = mm.astype(np.uint8).ravel().tolist()
    return json.dumps(payload, separators=(",", ":")).encode()


def wind_speed(u: np.ndarray, v: np.ndarray) -> np.ndarray:
    return np.hypot(u, v).astype(np.float32)
