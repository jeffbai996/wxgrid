import numpy as np

from wxgrid.config import GRID_LAT_N, GRID_LON_N
from wxgrid.grib import _normalise


def test_gfs_style_grid_is_rolled_to_minus180_origin():
    # Column value = source longitude index; GFS starts at 0°E.
    src = np.tile(np.arange(GRID_LON_N, dtype=np.float32), (GRID_LAT_N, 1))
    out = _normalise(src.ravel(), 90.0, 0.0, GRID_LAT_N, GRID_LON_N, scan_south_to_north=False)
    assert out[0, 0] == 720          # -180° is source column 720 (=180°E)
    assert out[0, 720] == 0          # 0° lands in the middle


def test_south_to_north_scan_is_flipped():
    src = np.tile(np.arange(GRID_LAT_N, dtype=np.float32)[:, None], (1, GRID_LON_N))
    out = _normalise(src.ravel(), -90.0, -180.0, GRID_LAT_N, GRID_LON_N, scan_south_to_north=True)
    assert out[0, 0] == GRID_LAT_N - 1 and out[-1, 0] == 0
