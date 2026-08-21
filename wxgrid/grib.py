"""GRIB2 → numpy on a model's regular lat/lon store grid.

Raw eccodes rather than cfgrib: the open-data files mix levels (10 m wind,
2 m temperature, mean sea level) that cfgrib refuses to stack into one
Dataset, and all we need is "shortName + step → 2-D array" anyway.

Global fields retain the original float32 (721, 1440) common-grid path.
Regional Lambert/rotated grids are reprojected at ingest onto the fine regular
lat/lon grid declared by their Model.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

import numpy as np

from wxgrid.config import GRID_LAT_N, GRID_LON_N, GRID_RES
from wxgrid.models import Model

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


_REPROJECT_INDEX_CACHE: dict[tuple, tuple[np.ndarray, np.ndarray]] = {}


def _code(gid, key: str, default=None):
    import eccodes
    try:
        return eccodes.codes_get(gid, key)
    except Exception:
        return default


def _hour_step(value) -> int:
    """ecCodes may spell analysis time as ``0m`` instead of integer hour 0."""
    text = str(value).strip()
    if text.endswith("m"):
        return int(round(float(text[:-1]) / 60.0))
    if text.endswith("h"):
        text = text[:-1]
    return int(float(text))


def _target_indices(gid, model: Model) -> tuple[np.ndarray, np.ndarray]:
    """Fractional native row/column for every target-model grid point."""
    from pyproj import CRS, Transformer

    grid_type = str(_code(gid, "gridType", ""))
    ni, nj = int(_code(gid, "Ni", _code(gid, "Nx"))), int(_code(gid, "Nj", _code(gid, "Ny")))
    i_neg = bool(int(_code(gid, "iScansNegatively", 0)))
    j_pos = bool(int(_code(gid, "jScansPositively", 0)))
    lat_first = float(_code(gid, "latitudeOfFirstGridPointInDegrees"))
    lon_first = float(_code(gid, "longitudeOfFirstGridPointInDegrees"))
    key = (model.key, model.grid_shape, model.lat0, model.lon0, model.dlat, model.dlon,
           grid_type, ni, nj, i_neg, j_pos, lat_first, lon_first,
           _code(gid, "projTargetString"), _code(gid, "latitudeOfSouthernPoleInDegrees"),
           _code(gid, "longitudeOfSouthernPoleInDegrees"), _code(gid, "DxInMetres"),
           _code(gid, "DyInMetres"), _code(gid, "iDirectionIncrementInDegrees"),
           _code(gid, "jDirectionIncrementInDegrees"))
    hit = _REPROJECT_INDEX_CACHE.get(key)
    if hit is not None:
        return hit

    target_lats = model.lat0 + np.arange(model.grid_shape[0], dtype=np.float64) * model.dlat
    target_lons = model.lon0 + np.arange(model.grid_shape[1], dtype=np.float64) * model.dlon
    lon2, lat2 = np.meshgrid(target_lons, target_lats)
    if grid_type == "lambert":
        native = CRS.from_user_input(str(_code(gid, "projTargetString")))
        to_native = Transformer.from_crs("EPSG:4326", native, always_xy=True)
        x, y = to_native.transform(lon2, lat2)
        x0, y0 = to_native.transform(((lon_first + 180.0) % 360.0) - 180.0, lat_first)
        dx = float(_code(gid, "DxInMetres")) * (-1.0 if i_neg else 1.0)
        dy = float(_code(gid, "DyInMetres")) * (1.0 if j_pos else -1.0)
        cols = (x - x0) / dx
        rows = (y - y0) / dy
    elif grid_type == "rotated_ll":
        south_lat = float(_code(gid, "latitudeOfSouthernPoleInDegrees"))
        south_lon = float(_code(gid, "longitudeOfSouthernPoleInDegrees"))
        rotated = CRS.from_cf({
            "grid_mapping_name": "rotated_latitude_longitude",
            "grid_north_pole_latitude": -south_lat,
            "grid_north_pole_longitude": ((south_lon + 180.0 + 180.0) % 360.0) - 180.0,
            "north_pole_grid_longitude": 0.0,
        })
        to_native = Transformer.from_crs("EPSG:4326", rotated, always_xy=True)
        rlon, rlat = to_native.transform(lon2, lat2)
        rlon = lon_first + ((rlon - lon_first + 180.0) % 360.0) - 180.0
        di = float(_code(gid, "iDirectionIncrementInDegrees")) * (-1.0 if i_neg else 1.0)
        dj = float(_code(gid, "jDirectionIncrementInDegrees")) * (1.0 if j_pos else -1.0)
        cols = (rlon - lon_first) / di
        rows = (rlat - lat_first) / dj
    else:
        raise ValueError(f"unsupported regional GRIB grid {grid_type!r}")
    out = np.asarray(rows, dtype=np.float32), np.asarray(cols, dtype=np.float32)
    _REPROJECT_INDEX_CACHE[key] = out
    return out


def reproject_to_model(values: np.ndarray, gid, model: Model, *, order: int = 1) -> np.ndarray:
    """Lambert/rotated producer grid → the model's regular lat/lon subgrid."""
    from scipy.ndimage import map_coordinates

    ni, nj = int(_code(gid, "Ni", _code(gid, "Nx"))), int(_code(gid, "Nj", _code(gid, "Ny")))
    if int(_code(gid, "jPointsAreConsecutive", 0)):
        native = np.asarray(values, dtype=np.float32).reshape(ni, nj).T
    else:
        native = np.asarray(values, dtype=np.float32).reshape(nj, ni)
    rows, cols = _target_indices(gid, model)
    coords = np.asarray([rows.ravel(), cols.ravel()])
    if order == 0:
        out = map_coordinates(native, coords, order=0, mode="constant", cval=np.nan, prefilter=False)
    else:
        valid = np.isfinite(native)
        num = map_coordinates(np.where(valid, native, 0.0), coords, order=1,
                              mode="constant", cval=0.0, prefilter=False)
        den = map_coordinates(valid.astype(np.float32), coords, order=1,
                              mode="constant", cval=0.0, prefilter=False)
        with np.errstate(invalid="ignore", divide="ignore"):
            out = np.where(den > 1e-6, num / den, np.nan)
    return np.ascontiguousarray(out.reshape(model.grid_shape), dtype=np.float32)


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
                units: str | None = None, target_model: Model | None = None) -> Iterator[Field]:
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
                step = _hour_step(eccodes.codes_get(gid, "endStep"))
                lat_n = int(eccodes.codes_get(gid, "Nj"))
                lon_n = int(eccodes.codes_get(gid, "Ni"))
                lat0 = float(eccodes.codes_get(gid, "latitudeOfFirstGridPointInDegrees"))
                lat1 = float(_code(gid, "latitudeOfLastGridPointInDegrees", lat0))
                lon0 = float(eccodes.codes_get(gid, "longitudeOfFirstGridPointInDegrees"))
                lon_step = float(_code(gid, "iDirectionIncrementInDegrees", 0.0))
                if int(eccodes.codes_get(gid, "iScansNegatively")):
                    lon_step = -lon_step
                # jScansPositively == 1 means rows run south → north.
                south_north = int(eccodes.codes_get(gid, "jScansPositively")) == 1
                level_type = str(eccodes.codes_get(gid, "typeOfLevel"))
                level = int(eccodes.codes_get(gid, "level"))
                unit = units if units is not None else str(eccodes.codes_get(gid, "units"))
                try:
                    start_step = _hour_step(eccodes.codes_get(gid, "startStep"))
                except Exception:
                    start_step = step
                values = np.asarray(eccodes.codes_get_values(gid), dtype=np.float32)
                # Mask BEFORE regridding: a 9999 sentinel run through a
                # bilinear kernel would smear nonsense across the valid edge.
                missing = eccodes.codes_get(gid, "missingValue")
                if missing is not None:
                    values[values == np.float32(missing)] = np.nan
                if target_model is not None and target_model.regional:
                    grid = reproject_to_model(values, gid, target_model, order=0 if short in {"ptype"} else 1)
                else:
                    grid = _normalise(values, lat0, lat1, lon0, lon_step, lat_n, lon_n, south_north)
                yield Field(short, step, grid, level_type, level, unit, start_step)
            finally:
                eccodes.codes_release(gid)
