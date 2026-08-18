"""GRIB2 → numpy on the common grid.

Raw eccodes rather than cfgrib: the open-data files mix levels (10 m wind,
2 m temperature, mean sea level) that cfgrib refuses to stack into one
Dataset, and all we need is "shortName + step → 2-D array" anyway.

Every field comes out as float32 (721, 1440), latitude 90 → -90, longitude
-180 → 179.75, regardless of how the producer stored it.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

import numpy as np

from wxgrid.config import GRID_LAT_N, GRID_LON_N


@dataclass
class Field:
    short_name: str
    step: int              # forecast hour
    values: np.ndarray     # (721, 1440) float32 on the common grid
    level_type: str = ""
    level: int = 0
    units: str = ""


def _normalise(values: np.ndarray, lat0: float, lon0: float, lat_n: int, lon_n: int,
               scan_south_to_north: bool) -> np.ndarray:
    """Reorder a producer's grid onto ours (N→S rows, -180→180 columns)."""
    grid = np.asarray(values, dtype=np.float32).reshape(lat_n, lon_n)
    if scan_south_to_north:
        grid = grid[::-1]
    # Longitude origin: ECMWF starts at -180, GFS at 0. Roll so col 0 = -180.
    lon0 = ((lon0 + 180.0) % 360.0) - 180.0
    if abs(lon0 + 180.0) > 1e-6:
        shift = int(round((lon0 + 180.0) / (360.0 / lon_n)))
        grid = np.roll(grid, shift, axis=1)
    if grid.shape != (GRID_LAT_N, GRID_LON_N):
        raise ValueError(f"unexpected grid {grid.shape}, want {(GRID_LAT_N, GRID_LON_N)}")
    return grid


def iter_fields(path: str | Path) -> Iterator[Field]:
    """Yield every message in a GRIB file as a normalised Field."""
    import eccodes  # imported here so the API process without GRIBs stays light

    with open(path, "rb") as fh:
        while True:
            gid = eccodes.codes_grib_new_from_file(fh)
            if gid is None:
                return
            try:
                short = eccodes.codes_get(gid, "shortName")
                step = int(eccodes.codes_get(gid, "endStep"))
                lat_n = int(eccodes.codes_get(gid, "Nj"))
                lon_n = int(eccodes.codes_get(gid, "Ni"))
                lat0 = float(eccodes.codes_get(gid, "latitudeOfFirstGridPointInDegrees"))
                lon0 = float(eccodes.codes_get(gid, "longitudeOfFirstGridPointInDegrees"))
                # jScansPositively == 1 means rows run south → north.
                south_north = int(eccodes.codes_get(gid, "jScansPositively")) == 1
                level_type = str(eccodes.codes_get(gid, "typeOfLevel"))
                level = int(eccodes.codes_get(gid, "level"))
                units = str(eccodes.codes_get(gid, "units"))
                values = eccodes.codes_get_values(gid)
                missing = eccodes.codes_get(gid, "missingValue")
                grid = _normalise(values, lat0, lon0, lat_n, lon_n, south_north)
                if missing is not None:
                    grid[grid == np.float32(missing)] = np.nan
                yield Field(short, step, grid, level_type, level, units)
            finally:
                eccodes.codes_release(gid)
