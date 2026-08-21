import numpy as np
import pytest

from wxgrid.config import GRID_LAT_N, GRID_LON_N, GRID_RES
from wxgrid.grib import _hour_step, _normalise, regrid_to_common


def test_analysis_minute_step_is_normalised_to_hour_zero():
    assert _hour_step("0m") == 0
    assert _hour_step("60m") == 1
    assert _hour_step(6) == 6


def test_gfs_style_grid_is_rolled_to_minus180_origin():
    # Column value = source longitude index; GFS starts at 0°E.
    src = np.tile(np.arange(GRID_LON_N, dtype=np.float32), (GRID_LAT_N, 1))
    out = _normalise(src.ravel(), 90.0, -90.0, 0.0, GRID_RES, GRID_LAT_N, GRID_LON_N,
                     scan_south_to_north=False)
    assert out[0, 0] == 720          # -180° is source column 720 (=180°E)
    assert out[0, 720] == 0          # 0° lands in the middle


def test_south_to_north_scan_is_flipped():
    src = np.tile(np.arange(GRID_LAT_N, dtype=np.float32)[:, None], (1, GRID_LON_N))
    out = _normalise(src.ravel(), -90.0, 90.0, -180.0, GRID_RES, GRID_LAT_N, GRID_LON_N,
                     scan_south_to_north=True)
    assert out[0, 0] == GRID_LAT_N - 1 and out[-1, 0] == 0


# ── regridding (GEM 0.15°, GEFS-mean 0.5°) ────────────────────────────────

def _linear_field(lats, lons):
    """f(lat, lon) = lat + lon/1000 — exactly reproducible by bilinear
    interpolation, so any error is the regridder's, not the test's."""
    return (lats[:, None] + lons[None, :] / 1000.0).astype(np.float32)


def test_gem_015_regrids_onto_the_common_grid():
    lats = np.linspace(-90.0, 90.0, 1201)        # GEM scans south → north
    lons = np.arange(2400) * 0.15                # ... and starts at 0°E
    out = regrid_to_common(_linear_field(lats, lons), lats, lons)
    assert out.shape == (GRID_LAT_N, GRID_LON_N)
    assert out.dtype == np.float32
    tgt_lat = np.linspace(90.0, -90.0, GRID_LAT_N)
    tgt_lon = np.arange(GRID_LON_N) * GRID_RES - 180.0
    want = tgt_lat[:, None] + (tgt_lon[None, :] % 360.0) / 1000.0
    # Ignore the wrap column pair either side of the seam, where "lon/1000"
    # is discontinuous (0 vs 0.35985) and no interpolant can match.
    assert np.allclose(out[:, 2:-2], want[:, 2:-2], atol=2e-3)


def test_gefs_half_degree_pressure_levels_regrid_and_keep_row_order():
    lats = np.linspace(90.0, -90.0, 361)         # 0.5° "a" file, north → south
    lons = np.arange(720) * 0.5
    out = regrid_to_common(_linear_field(lats, lons), lats, lons)
    assert out.shape == (GRID_LAT_N, GRID_LON_N)
    assert out[0, 720] == pytest.approx(90.0, abs=1e-3)      # row 0 = 90 °N
    assert out[-1, 720] == pytest.approx(-90.0, abs=1e-3)    # last row = 90 °S
    assert out[360, 720] == pytest.approx(0.0, abs=1e-3)     # equator, 0 °E


def test_regrid_does_not_smear_missing_values_into_valid_ones():
    """GEM's CAPE is masked over a third of the globe; a plain bilinear kernel
    would eat a cell of good data at every edge of the mask."""
    lats = np.linspace(-90.0, 90.0, 1201)
    lons = np.arange(2400) * 0.15
    src = np.ones((1201, 2400), dtype=np.float32)
    src[:600] = np.nan                            # rows 0..599 = 90 °S .. 0.15 °S
    out = regrid_to_common(src, lats, lons)
    assert np.isnan(out[-1]).all()                # deep south still missing
    # Output row 360 is the equator; everything north of it must survive whole.
    assert np.all(out[:360] == 1.0)               # not NaN-eroded at the mask edge


def test_regrid_wraps_the_dateline():
    lats = np.array([-90.0, 0.0, 90.0])
    lons = np.array([0.0, 180.0])                 # only two columns: 0° and 180°
    src = np.array([[0.0, 10.0]] * 3, dtype=np.float32)
    out = regrid_to_common(src, lats, lons)
    # 90 °W is halfway between 180° and 0° going east → 5
    assert out[360, 360] == pytest.approx(5.0, abs=1e-3)
    assert out[360, 720] == pytest.approx(0.0, abs=1e-3)     # 0°E is a source point
