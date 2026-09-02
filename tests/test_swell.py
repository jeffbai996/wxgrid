"""Swell from the period bands, wind sea from what is left, and the store
manifest that carries them (ECMWF open data has no shww/shts split)."""
import numpy as np
import pytest

from wxgrid import render
from wxgrid.ingest import derive_swell, swell_from_bands
from wxgrid.models import MODELS, SWELL_VAR, WAVE_BAND_INPUTS


def test_swell_is_the_root_sum_square_of_the_bands():
    out = swell_from_bands([np.array([[3.0, np.nan]]), np.array([[4.0, np.nan]])])
    assert out[0, 0] == pytest.approx(5.0)
    assert np.isnan(out[0, 1])                       # land in every band stays land


def test_a_band_missing_over_water_counts_as_zero_not_nan():
    out = swell_from_bands([np.array([[np.nan]]), np.array([[2.0]])])
    assert out[0, 0] == pytest.approx(2.0)


def test_no_bands_means_no_swell():
    assert swell_from_bands([]) is None
    got = {"swh": np.ones((1, 1))}
    derive_swell(got)
    assert SWELL_VAR not in got


def test_derive_swell_replaces_the_inputs_in_place():
    got = {"swh": np.full((1, 1), 2.0), **{k: np.full((1, 1), 1.0) for k in WAVE_BAND_INPUTS}}
    derive_swell(got)
    assert not any(k in got for k in WAVE_BAND_INPUTS)
    assert got[SWELL_VAR][0, 0] == pytest.approx(np.sqrt(len(WAVE_BAND_INPUTS)))


def test_wind_sea_is_what_is_left_and_never_negative():
    total = np.array([[5.0, 2.0, np.nan]]); swell = np.array([[4.0, 3.0, 1.0]])
    out = render.wind_sea(total, swell)
    assert out[0, 0] == pytest.approx(3.0)
    assert out[0, 1] == 0.0                          # swell taller than the total: rounding, not physics
    assert np.isnan(out[0, 2])


def test_ifs_store_manifest_carries_swell_and_peak_period_but_not_the_bands():
    vars_ = MODELS["ifs"].store_variables()
    assert "swell" in vars_ and "pp1d" in vars_ and "swh" in vars_
    assert not any(v.startswith("_") for v in vars_)
    assert set(MODELS["ifs"].wave_params.values()) >= set(WAVE_BAND_INPUTS)


def test_new_wave_layers_have_ramps_ranges_and_masks():
    for layer in ("swell", "windsea", "pp1d"):
        lg = render.legend(layer)
        assert lg["alpha"]["kind"] == "mask"
        assert lg["enc"]["lo"] == 0.0
    assert render.legend("swell")["units"] == "m" and render.legend("pp1d")["units"] == "s"
