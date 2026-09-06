"""Field frames in WebP: identical values to PNG, smaller on the wire."""
import numpy as np
import io
import pytest
from PIL import Image

from wxgrid import render


@pytest.mark.parametrize("layer,level", [(k, None) for k in render.RAMPS] +
                         [(k, p) for k in ("temp", "wind", "gh", "rh") for p in (250, 500, 850)])
def test_compact_encoder_preserves_legacy_rgb_for_every_layer(layer, level):
    lo, hi = render.field_range(layer, level)
    rng = np.random.default_rng(42)
    x = rng.uniform(lo - (hi-lo), hi + (hi-lo), size=(31, 43)).astype(np.float32)
    x[0, :7] = [np.nan, np.inf, -np.inf, lo, hi, 0, (lo+hi)/2]
    original = x.copy()
    step = 1 << (16 - render._FIELD_BITS.get(layer, render.FIELD_BITS))
    good = np.isfinite(x)
    q = np.rint((np.where(good, x, lo) - lo) / (hi-lo) * (65535.0/step)) * step
    q = np.clip(np.nan_to_num(q), 0, 65535-65535%step).astype(np.uint16)
    q[~good] = 0
    expected = np.stack((q >> 8, q & 255, np.where(good, 255, 0)), axis=-1).astype(np.uint8)
    for fmt in ("png", "webp"):
        with Image.open(io.BytesIO(render.encode_field(x, layer, level, fmt))) as image:
            np.testing.assert_array_equal(np.asarray(image), expected)
    np.testing.assert_array_equal(x, original)


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
