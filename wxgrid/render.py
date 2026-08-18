"""Turn a (721, 1440) lat/lon field into what the browser wants.

- `to_mercator`   : resample the equirectangular grid onto a Web-Mercator
                    image (lat ±85.05°) so MapLibre's ImageSource can drape it
                    with four corner coordinates and no local distortion.
- `colorize`      : fixed per-variable colour ramps → RGBA PNG bytes. Fixed
                    ranges, not per-frame min/max, so colours mean the same
                    thing at every step and across models.
- `wind_json`     : coarse u/v grid for the particle layer.

Pure functions; the API layer caches their output on disk.
"""
from __future__ import annotations

import io
import json
import math

import numpy as np
from PIL import Image

from wxgrid.config import GRID_LAT_N, GRID_LON_N, GRID_RES

MERC_LAT_MAX = 85.05112878          # Web-Mercator clip latitude
MERC_H = 1440                        # output rows; square with the 1440 columns

_merc_src_rows: np.ndarray | None = None
_merc_frac: np.ndarray | None = None


def _mercator_rows() -> tuple[np.ndarray, np.ndarray]:
    """For each output row, the fractional source-row index in the lat/lon grid."""
    global _merc_src_rows, _merc_frac
    if _merc_src_rows is None:
        r = (np.arange(MERC_H, dtype=np.float64) + 0.5) / MERC_H          # 0..1 top→bottom
        y = math.pi * (1.0 - 2.0 * r)                                      # +π..-π
        lat = np.degrees(np.arctan(np.sinh(y)))                            # 85.05..-85.05
        src = (90.0 - lat) / GRID_RES                                      # fractional row
        src = np.clip(src, 0, GRID_LAT_N - 1 - 1e-6)
        _merc_src_rows = np.floor(src).astype(np.int32)
        _merc_frac = (src - _merc_src_rows).astype(np.float32)
    return _merc_src_rows, _merc_frac


def to_mercator(field: np.ndarray) -> np.ndarray:
    """(721, 1440) → (MERC_H, 1440), linear in latitude between grid rows."""
    rows, frac = _mercator_rows()
    a = field[rows]
    b = field[np.minimum(rows + 1, GRID_LAT_N - 1)]
    return (a * (1.0 - frac)[:, None] + b * frac[:, None]).astype(np.float32)


# ── colour ramps ──────────────────────────────────────────────────────────
# (value, (r, g, b)) stops in DISPLAY units; alpha handled per variable.
RAMPS: dict[str, dict] = {
    "temp": {"units": "°C", "lo": -70, "hi": 45, "stops": [
        (-70, (40, 10, 70)), (-55, (90, 20, 130)), (-40, (130, 22, 146)), (-30, (75, 42, 180)),
        (-20, (35, 90, 200)), (-10, (40, 150, 220)), (0, (100, 200, 200)), (10, (110, 210, 110)),
        (20, (240, 220, 80)), (30, (240, 130, 40)), (40, (200, 30, 30)), (45, (140, 0, 60))]},
    "wind": {"units": "m/s", "lo": 0, "hi": 40, "stops": [
        (0, (48, 18, 59)), (5, (60, 80, 180)), (10, (30, 160, 190)), (15, (60, 200, 110)),
        (20, (200, 220, 60)), (25, (250, 160, 30)), (30, (230, 70, 20)), (40, (150, 0, 60))]},
    "gust": {"units": "m/s", "lo": 0, "hi": 50, "stops": [
        (0, (48, 18, 59)), (8, (60, 80, 180)), (15, (30, 160, 190)), (22, (60, 200, 110)),
        (30, (200, 220, 60)), (38, (250, 160, 30)), (45, (230, 70, 20)), (50, (150, 0, 60))]},
    "msl": {"units": "hPa", "lo": 950, "hi": 1050, "stops": [
        (950, (110, 20, 140)), (970, (60, 60, 200)), (990, (40, 150, 220)), (1005, (120, 210, 150)),
        (1013, (240, 240, 200)), (1025, (240, 180, 80)), (1040, (220, 80, 40)), (1050, (150, 0, 60))]},
    "tp6": {"units": "mm/6h", "lo": 0, "hi": 40, "stops": [
        (0, (110, 160, 230)), (1, (80, 130, 220)), (3, (40, 100, 200)), (8, (30, 170, 90)),
        (15, (240, 220, 40)), (25, (240, 120, 30)), (40, (200, 20, 60))]},
    "tcc": {"units": "%", "lo": 0, "hi": 100, "stops": [
        (0, (20, 30, 50)), (30, (90, 110, 140)), (60, (170, 180, 195)), (100, (245, 245, 250))]},
    "cape": {"units": "J/kg", "lo": 0, "hi": 4000, "stops": [
        (0, (30, 30, 60)), (250, (60, 90, 190)), (700, (40, 170, 120)), (1500, (240, 220, 40)),
        (2500, (240, 120, 30)), (4000, (200, 20, 60))]},
}

# canonical store variable → display transform (store units → ramp units)
DISPLAY = {
    "temp": lambda k: k - 273.15,
    "msl": lambda pa: pa / 100.0,
    "tp6": lambda mm: mm,
    "gust": lambda ms: ms,
    "wind": lambda ms: ms,
    "tcc": lambda frac: frac * 100.0,
    "cape": lambda j: j,
}


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


def colorize(field_display: np.ndarray, layer: str, alpha: float = 0.78) -> bytes:
    """PNG for a Mercator-projected field already in display units.

    Constant-alpha layers go out as 8-bit palette PNGs (256 colours is exactly
    the LUT, ~4x smaller than RGBA on the wire); rain, whose alpha varies with
    the value, stays RGBA. A field that is entirely missing (a step the model
    did not publish for this variable) becomes a fully transparent image, so
    the map shows nothing rather than a stale previous step."""
    ramp, lut = RAMPS[layer], _LUTS[layer]
    lo, hi = ramp["lo"], ramp["hi"]
    buf = io.BytesIO()
    if np.all(np.isnan(field_display)):
        Image.new("RGBA", (field_display.shape[1], field_display.shape[0]), (0, 0, 0, 0)).save(buf, format="PNG")
        return buf.getvalue()
    x = np.nan_to_num(field_display, nan=lo)
    idx = np.clip((x - lo) / (hi - lo) * 255.0, 0, 255).astype(np.uint8)
    if layer in ("tp6", "cape", "tcc"):
        rgba = lut[idx].copy()
        if layer == "tp6":
            # Rain: transparent where dry, ramping in over the first millimetre.
            a = np.clip(x / 1.0, 0, 1)
        elif layer == "cape":
            a = np.clip(x / 300.0, 0, 1)            # nothing to see under ~300 J/kg
        else:
            a = np.clip(x / 100.0, 0, 1) ** 0.7     # clear sky shows the map through
        rgba[..., 3] = (a * alpha * 255).astype(np.uint8)
        Image.fromarray(rgba, "RGBA").save(buf, format="PNG", optimize=False, compress_level=6)
        return buf.getvalue()
    img = Image.fromarray(idx, "P")
    img.putpalette(lut[:, :3].astype(np.uint8).ravel().tolist())
    img.info["transparency"] = bytes([int(alpha * 255)] * 256)
    img.save(buf, format="PNG", optimize=False, compress_level=6, transparency=bytes([int(alpha * 255)] * 256))
    return buf.getvalue()


def legend(layer: str) -> dict:
    ramp = RAMPS[layer]
    return {"layer": layer, "units": ramp["units"], "lo": ramp["lo"], "hi": ramp["hi"],
            "stops": [{"v": v, "rgb": list(rgb)} for v, rgb in ramp["stops"]]}


# ── wind vectors for particles ────────────────────────────────────────────

def wind_json(u: np.ndarray, v: np.ndarray, factor: int = 4) -> bytes:
    """Coarsen 0.25° u/v to `factor`×0.25° (default 1°) and emit compact JSON.
    Row 0 = 90°N, col 0 = 180°W; last column duplicates the first so the
    client can wrap longitude without a special case."""
    uu = u[::factor, ::factor]
    vv = v[::factor, ::factor]
    uu = np.concatenate([uu, uu[:, :1]], axis=1)
    vv = np.concatenate([vv, vv[:, :1]], axis=1)
    ny, nx = uu.shape
    payload = {
        "lat0": 90.0, "lon0": -180.0, "dlat": -GRID_RES * factor, "dlon": GRID_RES * factor,
        "ny": int(ny), "nx": int(nx),
        "u": np.round(np.nan_to_num(uu), 1).ravel().tolist(),
        "v": np.round(np.nan_to_num(vv), 1).ravel().tolist(),
    }
    return json.dumps(payload, separators=(",", ":")).encode()


def wind_speed(u: np.ndarray, v: np.ndarray) -> np.ndarray:
    return np.hypot(u, v).astype(np.float32)
