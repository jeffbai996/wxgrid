"""Field frames in WebP: identical values to PNG, smaller on the wire."""
import numpy as np

from wxgrid import render


def _field():
    rng = np.random.default_rng(3)
    f = rng.uniform(-30, 35, size=(90, 180)).astype(np.float32)
    f[10:20, 30:40] = np.nan
    return f


def test_webp_and_png_decode_to_the_same_values():
    f = _field()
    png = render.decode_field(render.encode_field(f, "temp", fmt="png"), "temp")
    webp = render.decode_field(render.encode_field(f, "temp", fmt="webp"), "temp")
    assert np.array_equal(np.isnan(png), np.isnan(webp))
    np.testing.assert_array_equal(png[~np.isnan(png)], webp[~np.isnan(webp)])


def test_webp_is_smaller_and_negotiated_by_accept():
    f = _field()
    assert len(render.encode_field(f, "temp", fmt="webp")) < len(render.encode_field(f, "temp", fmt="png"))
    assert render.field_format("image/webp,image/png") == "webp"
    assert render.field_format("image/png,*/*") == "png"
    assert render.field_format(None) == "png"
    assert render.field_cache_name(6, "temp", "webp").endswith("-temp.webp")
    assert render.field_cache_name(6, "temp").endswith("-temp.png")
