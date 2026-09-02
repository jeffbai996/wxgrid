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
    # png regardless of Accept since 2026-08-21 — see pick_format's docstring
    assert name.endswith("-temp.png") and fmt == "png" and media == "image/png"


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


def test_height_ramp_slides_onto_each_pressure_level():
    base = render.RAMPS["gh"]
    assert (base["lo"], base["hi"]) == (4900, 6000)          # the 500 hPa chart
    assert render.ramp_for("gh", None) is base and render.ramp_for("gh", 500) is base
    at850 = render.ramp_for("gh", 850)
    assert (at850["lo"], at850["hi"]) == render.GH_WINDOW[850]
    # same colours in the same places: only the values move
    assert [rgb for _, rgb in at850["stops"]] == [rgb for _, rgb in base["stops"]]
    frac = lambda r: [(v - r["lo"]) / (r["hi"] - r["lo"]) for v, _ in r["stops"]]
    np.testing.assert_allclose(frac(at850), frac(base), atol=0.002)
    # every other layer reads the same at every level
    assert render.ramp_for("temp", 850) is render.RAMPS["temp"]


def test_height_colours_are_relative_to_the_level():
    def rgb(level, value):
        field = np.full((4, 4), value, dtype=np.float32)
        img = Image.open(io.BytesIO(render.colorize(field, "gh", level=level))).convert("RGBA")
        return tuple(int(x) for x in np.asarray(img)[0, 0, :3])

    mid = {lvl: sum(win) / 2 for lvl, win in render.GH_WINDOW.items()}
    assert rgb(850, mid[850]) == rgb(500, mid[500]) == rgb(200, mid[200])
    # a normal 500 hPa height is off the top of the 850 hPa scale
    assert rgb(850, 5500) == tuple(render.RAMPS["gh"]["stops"][-1][1])


def test_height_legend_carries_a_ramp_for_every_level():
    lg = render.legend("gh")
    assert set(lg["levels"]) == {str(l) for l in render.GH_WINDOW}
    assert lg["levels"]["200"]["lo"] == render.GH_WINDOW[200][0]
    # only the catalog entry carries the table; a level's own legend is flat
    assert "levels" not in render.legend("gh", 850)
    assert "levels" not in render.legend("temp")


# ── the field path ────────────────────────────────────────────────────────

def test_field_roundtrip_is_within_one_code_and_keeps_the_mask():
    field = np.linspace(-60, 50, 64, dtype=np.float32)[None, :].repeat(3, axis=0)
    field[1, 10:20] = np.nan
    png = render.encode_field(field, "temp")
    img = Image.open(io.BytesIO(png))
    assert img.mode == "RGB" and img.size == (64, 3)
    back = render.decode_field(png, "temp")
    assert np.array_equal(np.isnan(back), np.isnan(field))
    assert np.nanmax(np.abs(back - field)) <= render.field_resolution("temp")
    assert render.field_resolution("temp") < 0.05                 # 12 bits over 160 °C
    # missing pixels are all-zero so the mask channel is the only signal
    px = np.asarray(img)
    assert px[1, 15].tolist() == [0, 0, 0] and px[0, 15, 2] == 255


def test_field_categories_survive_the_encoding_exactly():
    field = np.array([[0.0, 1.0, 2.0, 3.0]], dtype=np.float32)
    back = render.decode_field(render.encode_field(field, "ptype"), "ptype")
    np.testing.assert_allclose(back, field, atol=1e-4)


def test_field_values_are_clamped_to_the_published_range():
    lo, hi = render.field_range("tp6")
    back = render.decode_field(render.encode_field(np.array([[-5.0, hi + 100.0]], dtype=np.float32), "tp6"), "tp6")
    assert back[0, 0] == lo and abs(back[0, 1] - hi) <= render.field_resolution("tp6")


def test_field_range_covers_every_ramp_at_every_level():
    for layer, ramp in render.RAMPS.items():
        lo, hi = render.field_range(layer)
        assert lo <= ramp["lo"] and hi >= ramp["hi"], layer
    for level, (wlo, whi) in render.GH_WINDOW.items():
        lo, hi = render.field_range("gh", level)
        assert lo < wlo and hi > whi


def test_legend_carries_the_encoding_and_the_alpha_rule():
    lg = render.legend("tp6")
    assert lg["enc"] == {"lo": 0.0, "hi": 300.0}
    assert lg["alpha"] == {"base": render.BASE_ALPHA, "kind": "ramp", "k": 1.0}
    assert render.legend("temp")["alpha"] == {"base": render.BASE_ALPHA, "kind": "const"}
    gh = render.legend("gh")
    assert gh["levels"]["850"]["enc"]["lo"] < render.GH_WINDOW[850][0]


def _reference_alpha(layer, x, nan):
    """The alpha chain colorize carried before the rules became a table."""
    if layer in ("tp6", "tp24", "tp72"):
        a = np.clip(x / {"tp6": 1.0, "tp24": 2.0, "tp72": 4.0}[layer], 0, 1)
    elif layer in ("sf6", "sf24", "sf72"):
        a = np.clip(x / {"sf6": 0.5, "sf24": 1.0, "sf72": 2.0}[layer], 0, 1)
    elif layer in ("waves", "wperiod", "wavepower", "sst", "swell", "windsea", "pp1d"):
        a = np.where(nan, 0.0, 1.0)
    elif layer == "solar":
        a = np.clip(x / 120.0, 0, 1)
    elif layer == "uvi":
        a = np.clip(x / 1.0, 0, 1)
    elif layer == "sd_cm":
        a = np.clip(x / 2.0, 0, 1)
    elif layer == "cape":
        a = np.clip(x / 300.0, 0, 1)
    elif layer in ("prob_rain", "prob_gust"):
        a = np.clip(x / 30.0, 0, 1)
    elif layer == "gfactor":
        a = np.clip((x - 1.5) / 3.0, 0, 1)
    elif layer == "vis":
        a = np.clip((12.0 - x) / 8.0, 0, 1)
    elif layer == "ptype":
        a = np.where(x >= 0.99, 1.0, 0.0)
    elif layer == "vort500":
        a = np.clip(np.abs(x) / 4.0, 0, 1)
    elif layer == "ptend":
        a = np.clip(np.abs(x) / 1.2, 0, 1)
    elif layer == "dt24":
        a = np.clip(np.abs(x) / 2.5, 0, 1)
    else:
        a = np.clip(x / 100.0, 0, 1) ** 0.7
    return a


def test_alpha_rule_table_reproduces_the_old_alpha_chain():
    for layer in render._RGBA_LAYERS:
        ramp = render.RAMPS[layer]
        lo, hi = ramp["lo"], ramp["hi"]
        field = np.linspace(lo - 0.2 * (hi - lo), hi + 0.2 * (hi - lo), 300, dtype=np.float32)[None, :]
        x = np.nan_to_num(field, nan=lo)
        np.testing.assert_allclose(render.alpha_for(layer, x), _reference_alpha(layer, x, np.isnan(field)), atol=1e-6, err_msg=layer)
        img = Image.open(io.BytesIO(render.colorize(field, layer))).convert("RGBA")
        want = (_reference_alpha(layer, x, np.isnan(field)) * render.BASE_ALPHA * 255).astype(np.uint8)
        assert np.array_equal(np.asarray(img)[0, :, 3], want[0]), layer


def test_missing_data_is_transparent_under_every_alpha_rule():
    for layer in ("vort500", "vis", "ptend", "tp6", "sst"):
        field = np.full((2, 3), np.nan, dtype=np.float32)
        field[0, 0] = 0.0
        a = np.asarray(Image.open(io.BytesIO(render.colorize(field, layer))).convert("RGBA"))[..., 3]
        assert a[1].max() == 0 and a[0, 1:].max() == 0, layer


def test_wind_json_serialises_rounded_values_compactly():
    # Slabs come out of zarr as float32. Rounding float32 to one decimal and
    # handing it to json.dumps printed the float64 expansion of the float32
    # value (-4.699999809265137), 17 digits per number: a 2 MB payload for
    # 65k points. The wire format has to carry what was asked for: "-4.7".
    import json
    import re
    u = np.full((16, 16), -4.7, dtype=np.float32)
    v = np.full((16, 16), 12.34, dtype=np.float32)
    text = render.wind_json(u, v, factor=4).decode()
    d = json.loads(text)
    assert d["u"][0] == -4.7 and d["v"][0] == 12.3
    longest = max(re.findall(r"-?\d+\.\d+", text), key=len)
    assert len(longest) <= 6, longest
