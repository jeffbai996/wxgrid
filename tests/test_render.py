import io

import numpy as np
from PIL import Image

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
    assert m[0, 0] > 84.9 and m[-1, 0] < -84.9  # clipped at ±85.05
    assert np.all(np.diff(m[:, 0]) <= 0)       # monotone north → south


def test_colorize_emits_rgba_png_of_mercator_size():
    field = np.full((render.MERC_H, GRID_LON_N), 20.0, dtype=np.float32)
    png = render.colorize(field, "t2m")
    img = Image.open(io.BytesIO(png))
    assert img.mode == "RGBA" and img.size == (GRID_LON_N, render.MERC_H)


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
