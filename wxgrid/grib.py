"""GRIB2 → numpy on the common grid.

Raw eccodes rather than cfgrib: the open-data files mix levels (10 m wind,
2 m temperature, mean sea level) that cfgrib refuses to stack into one
Dataset, and all we need is "shortName + step → 2-D array" anyway.

Every field comes out as float32 (721, 1440), latitude 90 → -90, longitude
-180 → 179.75, regardless of how the producer stored it. Producers already on
0.25° (ECMWF, GFS, GEFS surface) are only rolled in longitude — no resampling.
Anything else (GEM at 0.15°, the GEFS ensemble mean's 0.5° pressure levels) is
bilinearly regridded; see `regrid_to_common`.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

import numpy as np

from wxgrid.config import GRID_LAT_N, GRID_LON_N, GRID_RES

# Target axes. Latitudes ascending here because interpolation wants monotonic
# increasing; the result is flipped back to N→S before it leaves this module.
_TGT_LAT_ASC = np.linspace(-90.0, 90.0, GRID_LAT_N)
_TGT_LON = np.arange(GRID_LON_N) * GRID_RES - 180.0


@dataclass
class Field:
    short_name: str
    step: int              # forecast hour
    values: np.ndarray     # (721, 1440) float32 on the common grid
    level_type: str = ""
    level: int = 0
    units: str = ""
    start_step: int = 0    # accumulation start (hours) for accum fields; == step for instant


def _weights(src: np.ndarray, dst: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Left-neighbour index and fractional weight of `dst` in ascending `src`."""
    idx = np.clip(np.searchsorted(src, dst) - 1, 0, len(src) - 2)
    w = (dst - src[idx]) / (src[idx + 1] - src[idx])
    return idx, np.clip(w, 0.0, 1.0)


def regrid_to_common(grid: np.ndarray, src_lats: np.ndarray, src_lons: np.ndarray) -> np.ndarray:
    """Bilinear resample of a regular lat-lon field onto the common grid.

    `src_lats` / `src_lons` are the source axes in the order the rows and
    columns are stored (either direction). Longitudes may run 0→360 or
    -180→180; they are wrapped and sorted, and the field is treated as
    periodic in longitude so the dateline seam interpolates properly.

    NaN (a missing-value bitmap, e.g. GEM's CAPE over 37 % of the globe) is
    handled by renormalising the weights: a target cell is NaN only when all
    four of its source neighbours are.
    """
    grid = np.asarray(grid, dtype=np.float32)
    lats = np.asarray(src_lats, dtype=np.float64)
    lons = np.asarray(src_lons, dtype=np.float64)
    if lats[0] > lats[-1]:
        lats, grid = lats[::-1], grid[::-1]
    lons = ((lons + 180.0) % 360.0) - 180.0
    order = np.argsort(lons)
    lons, grid = lons[order], grid[:, order]
    # periodic wrap column so targets east of the last source column interpolate
    lons = np.append(lons, lons[0] + 360.0)
    grid = np.concatenate([grid, grid[:, :1]], axis=1)

    iy, wy = _weights(lats, _TGT_LAT_ASC)
    ix, wx = _weights(lons, _TGT_LON)
    wy = wy[:, None].astype(np.float32)
    wx = wx.astype(np.float32)

    def _bilinear(g: np.ndarray) -> np.ndarray:
        top = g[iy][:, ix] * (1.0 - wx) + g[iy][:, ix + 1] * wx
        bot = g[iy + 1][:, ix] * (1.0 - wx) + g[iy + 1][:, ix + 1] * wx
        return top * (1.0 - wy) + bot * wy

    bad = ~np.isfinite(grid)
    if bad.any():
        num = _bilinear(np.where(bad, np.float32(0.0), grid))
        den = _bilinear((~bad).astype(np.float32))
        with np.errstate(invalid="ignore", divide="ignore"):
            out = np.where(den > 1e-6, num / den, np.nan)
    else:
        out = _bilinear(grid)
    return np.ascontiguousarray(out[::-1], dtype=np.float32)


def _normalise(values: np.ndarray, lat0: float, lat1: float, lon0: float, lon_step: float,
               lat_n: int, lon_n: int, scan_south_to_north: bool) -> np.ndarray:
    """Put a producer's grid on ours (N→S rows, -180→180 columns)."""
    grid = np.asarray(values, dtype=np.float32).reshape(lat_n, lon_n)
    if scan_south_to_north:
        grid = grid[::-1]
        lat0, lat1 = lat1, lat0
    if (lat_n, lon_n) == (GRID_LAT_N, GRID_LON_N):
        # Already 0.25° global: only the longitude origin can differ (ECMWF
        # starts at -180, GFS/GEFS at 0). Roll rather than resample.
        origin = ((lon0 + 180.0) % 360.0) - 180.0
        if abs(origin + 180.0) > 1e-6:
            grid = np.roll(grid, int(round((origin + 180.0) / (360.0 / lon_n))), axis=1)
        return grid
    lats = np.linspace(lat0, lat1, lat_n)
    lons = lon0 + np.arange(lon_n) * lon_step
    return regrid_to_common(grid, lats, lons)


def iter_fields(path: str | Path, short_name: str | None = None,
                units: str | None = None) -> Iterator[Field]:
    """Yield every message in a GRIB file as a normalised Field.

    `short_name`/`units` override what eccodes reports. One-file-per-variable
    sources (MSC datamart) need this: several GEM parameters are outside the
    stock eccodes tables and decode as shortName "unknown", but the fetcher
    knows exactly which variable it asked for.
    """
    import eccodes  # imported here so the API process without GRIBs stays light

    with open(path, "rb") as fh:
        while True:
            gid = eccodes.codes_grib_new_from_file(fh)
            if gid is None:
                return
            try:
                short = short_name or eccodes.codes_get(gid, "shortName")
                step = int(eccodes.codes_get(gid, "endStep"))
                lat_n = int(eccodes.codes_get(gid, "Nj"))
                lon_n = int(eccodes.codes_get(gid, "Ni"))
                lat0 = float(eccodes.codes_get(gid, "latitudeOfFirstGridPointInDegrees"))
                lat1 = float(eccodes.codes_get(gid, "latitudeOfLastGridPointInDegrees"))
                lon0 = float(eccodes.codes_get(gid, "longitudeOfFirstGridPointInDegrees"))
                lon_step = float(eccodes.codes_get(gid, "iDirectionIncrementInDegrees"))
                if int(eccodes.codes_get(gid, "iScansNegatively")):
                    lon_step = -lon_step
                # jScansPositively == 1 means rows run south → north.
                south_north = int(eccodes.codes_get(gid, "jScansPositively")) == 1
                level_type = str(eccodes.codes_get(gid, "typeOfLevel"))
                level = int(eccodes.codes_get(gid, "level"))
                unit = units if units is not None else str(eccodes.codes_get(gid, "units"))
                try:
                    start_step = int(eccodes.codes_get(gid, "startStep"))
                except Exception:
                    start_step = step
                values = np.asarray(eccodes.codes_get_values(gid), dtype=np.float32)
                # Mask BEFORE regridding: a 9999 sentinel run through a
                # bilinear kernel would smear nonsense across the valid edge.
                missing = eccodes.codes_get(gid, "missingValue")
                if missing is not None:
                    values[values == np.float32(missing)] = np.nan
                grid = _normalise(values, lat0, lat1, lon0, lon_step, lat_n, lon_n, south_north)
                yield Field(short, step, grid, level_type, level, unit, start_step)
            finally:
                eccodes.codes_release(gid)
