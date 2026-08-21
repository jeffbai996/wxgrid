import io
from datetime import datetime, timezone

import numpy as np
import pytest
from PIL import Image
from scipy.ndimage import zoom

from wxgrid import render
from wxgrid.config import GRID_LAT_N, GRID_LON_N


def test_mercator_preserves_columns_and_maps_equator_to_middle_row():
    field = np.tile(np.linspace(-90, 90, GRID_LAT_N, dtype=np.float32)[:, None], (1, GRID_LON_N))
    # field value == -latitude (row 0 = 90N holds -90)... use latitude directly:
    field = np.tile(np.linspace(90, -90, GRID_LAT_N, dtype=np.float32)[:, None], (1, GRID_LON_N))
    m = render.to_mercator(field)
    assert m.shape == (render.MERC_H, GRID_LON_N)
    mid = m[render.MERC_H // 2, 0]
    assert abs(mid) < 0.5                       # equator sits at the middle row
    assert m[0, 0] > 89.9 and m[-1, 0] < -89.9  # finite visual poles close the globe
    assert np.all(np.diff(m[:, 0]) <= 0)       # monotone north → south


def test_colorize_emits_palette_png_of_mercator_size():
    field = np.full((render.MERC_H, GRID_LON_N), 20.0, dtype=np.float32)
    png = render.colorize(field, "temp")
    img = Image.open(io.BytesIO(png))
    assert img.mode == "P" and img.size == (GRID_LON_N, render.MERC_H)
    assert np.asarray(img.convert("RGBA"))[0, 0, 3] == int(0.78 * 255)


def test_layer_values_are_upscaled_before_colour_mapping_by_kind():
    field = np.arange(16, dtype=np.float32).reshape(4, 4)
    continuous = render.upscale_values(field, "temp")
    probability = render.upscale_values(field, "prob_rain")
    categorical = render.upscale_values((field % 4).astype(np.float32), "ptype")

    assert continuous.shape == probability.shape == categorical.shape == (8, 8)
    np.testing.assert_allclose(continuous, zoom(field, 2, order=3), atol=1e-5)
    np.testing.assert_allclose(probability, zoom(field, 2, order=1), atol=1e-5)
    assert set(np.unique(categorical)) <= {0.0, 1.0, 2.0, 3.0}


def test_cubic_upscale_restores_nan_mask_without_a_halo():
    field = np.arange(25, dtype=np.float32).reshape(5, 5)
    field[:, 3:] = np.nan
    out = render.upscale_values(field, "temp")

    assert np.isfinite(out[:, :6]).all()
    assert np.isnan(out[:, 6:]).all()
    # Nearest-filling before the cubic pass keeps the last valid column from
    # ringing wildly at the missing-data edge.
    assert np.nanmax(np.abs(out[:, 5] - zoom(field[:, :3], 2, order=3)[:, -1])) < 2.0


def test_layer_cache_name_carries_the_render_version():
    name, fmt, media = render.layer_cache_name(6, "temp", "image/webp")
    assert render.LAYER_CACHE_VERSION in name
    assert name.endswith("-temp.webp") and fmt == "webp" and media == "image/webp"


def test_pressure_neutral_is_cool_instead_of_beige():
    neutral = next(rgb for value, rgb in render.RAMPS["msl"]["stops"] if value == 1013)
    assert neutral[2] >= neutral[0]
    assert abs(neutral[0] - neutral[1]) < 30


def test_solar_power_obeys_sun_and_cloud():
    clear = np.zeros((3, 4), dtype=np.float32)
    overcast = np.ones_like(clear)
    noon = datetime(2026, 6, 21, 12, tzinfo=timezone.utc)
    clear_wm2 = render.solar_power(clear, noon, lat0=1.0, lon0=-1.0, dlat=-1.0, dlon=1.0)
    cloudy_wm2 = render.solar_power(overcast, noon, lat0=1.0, lon0=-1.0, dlat=-1.0, dlon=1.0)
    assert clear_wm2[1, 1] > 900
    assert 0 < cloudy_wm2[1, 1] < clear_wm2[1, 1] * 0.35


def test_wave_power_uses_deep_water_energy_flux():
    height = np.array([[2.0]], dtype=np.float32)
    period = np.array([[10.0]], dtype=np.float32)
    assert render.wave_power(height, period)[0, 0] == pytest.approx(19.6, rel=0.01)


def test_fog_potential_needs_saturated_low_cloud():
    rh = np.array([[75.0, 98.0, 98.0]], dtype=np.float32)
    low = np.array([[1.0, 0.1, 0.9]], dtype=np.float32)
    np.testing.assert_allclose(render.fog_potential(rh, low), [[0.0, 9.0, 81.0]], atol=0.1)


def test_all_missing_field_is_fully_transparent():
    field = np.full((render.MERC_H, GRID_LON_N), np.nan, dtype=np.float32)
    img = Image.open(io.BytesIO(render.colorize(field, "gust")))
    assert np.asarray(img)[..., 3].max() == 0


def test_partial_missing_continuous_field_keeps_missing_pixels_transparent():
    field = np.full((8, 8), 20.0, dtype=np.float32)
    field[:, 5:] = np.nan
    img = Image.open(io.BytesIO(render.colorize(field, "temp"))).convert("RGBA")
    alpha = np.asarray(img)[..., 3]
    assert alpha[:, :5].min() == int(0.78 * 255)
    assert alpha[:, 5:].max() == 0


def test_rain_is_transparent_where_dry():
    field = np.zeros((render.MERC_H, GRID_LON_N), dtype=np.float32)
    field[:, :10] = 20.0
    img = Image.open(io.BytesIO(render.colorize(field, "tp6")))
    a = np.asarray(img)[..., 3]
    assert a[0, 500] == 0 and a[0, 0] > 150


def test_wind_json_coarsens_and_wraps():
    import json
    u = np.random.rand(GRID_LAT_N, GRID_LON_N).astype(np.float32)
    v = np.random.rand(GRID_LAT_N, GRID_LON_N).astype(np.float32)
    d = json.loads(render.wind_json(u, v, factor=4))
    assert d["ny"] == 181 and d["nx"] == 361 and len(d["u"]) == 181 * 361
    assert d["u"][0] == d["u"][360]            # last column duplicates the first
    assert d["dlat"] == -1.0 and d["lat0"] == 90.0


def test_wind_json_optional_mask_coarsens_and_wraps():
    import json
    u = np.ones((GRID_LAT_N, GRID_LON_N), dtype=np.float32)
    v = np.ones_like(u)
    mask = np.zeros_like(u, dtype=bool)
    mask[0, 0] = True
    d = json.loads(render.wind_json(u, v, factor=4, mask=mask))
    assert len(d["mask"]) == d["ny"] * d["nx"]
    assert d["mask"][0] == 1
    assert d["mask"][360] == 1
    assert d["mask"][1] == 0
