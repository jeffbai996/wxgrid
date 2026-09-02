"""WeatherNext 2 adapter against a local Zarr shaped like Google's."""
import dataclasses
from datetime import datetime, timezone

import numpy as np
import pytest
import xarray as xr

from wxgrid import wn2
from wxgrid.models import MODELS
from wxgrid.store import RunReader

INIT = np.datetime64("2026-09-01T00:00:00", "s")
LATS = np.arange(-90.0, 90.01, 0.25)          # south → north, the way the dataset is published
LONS = np.arange(0.0, 360.0, 0.25)            # 0 … 359.75


def _field(scale=1.0, members=2, leads=2, nan_last=False):
    lat = LATS[None, None, :, None]; lon = LONS[None, None, None, :]
    base = (lat + lon / 1000.0) * scale
    data = np.broadcast_to(base, (members, leads, LATS.size, LONS.size)).astype(np.float32).copy()
    if nan_last:
        data[:, -1] = np.nan
    return data


def synthetic(tmp_path, nan_last=False):
    ds = xr.Dataset(
        {
            "2m_temperature": (("sample", "time", "prediction_timedelta", "latitude", "longitude"), _field(1.0, nan_last=nan_last)[:, None]),
            "total_precipitation_6hr": (("sample", "time", "prediction_timedelta", "latitude", "longitude"), _field(0.001)[:, None]),
            "geopotential": (("sample", "time", "prediction_timedelta", "level", "latitude", "longitude"), _field(9.80665)[:, None, :, None]),
        },
        coords={"sample": [0, 1], "time": [INIT], "prediction_timedelta": np.array([0, 6], dtype="timedelta64[h]"),
                "level": [500], "latitude": LATS, "longitude": LONS},
    )
    # member 1 runs 2 K warmer so the mean is checkable
    ds["2m_temperature"][1] += 2.0
    path = tmp_path / "wn2.zarr"
    ds.to_zarr(path, mode="w")
    return str(path)


@pytest.fixture
def model():
    return dataclasses.replace(MODELS["wn2"], steps=[0, 6], levels=(500,))


def test_latest_init_needs_the_final_lead_present(tmp_path, model):
    ds = wn2.open_dataset(synthetic(tmp_path))
    assert wn2.latest_init(ds, model.steps) == datetime(2026, 9, 1, tzinfo=timezone.utc)
    ds2 = wn2.open_dataset(synthetic(tmp_path / "b", nan_last=True))
    assert wn2.latest_init(ds2, model.steps) is None


def test_ingest_writes_a_store_run_on_our_grid_with_members_averaged(tmp_path, model):
    ds = wn2.open_dataset(synthetic(tmp_path))
    out = wn2.ingest_wn2(model, datetime(2026, 9, 1, tzinfo=timezone.utc), store_root=tmp_path / "store", ds=ds)
    assert out["fields"] == 6                      # t2m, tp6 at two steps; gh_500 at both
    r = RunReader("wn2", "2026-09-01T00", tmp_path / "store")
    assert r.steps == [0, 6] and {"t2m", "tp6", "gh_500"} <= set(r.variables)
    t2m = r.slab("t2m", 6)
    # store row 0 is 90 N, column 0 is 180 W: value = lat + lon/1000 (+1 K mean offset)
    # float16 store precision at these unphysical kelvins is ~0.25
    assert t2m[0, 0] == pytest.approx(90.0 + 180.0 / 1000.0 + 1.0, abs=0.3)       # lon 180 W ≡ dataset lon 180
    assert t2m[720, 720] == pytest.approx(-90.0 + 0.0 + 1.0, abs=0.3)             # lon 0
    assert r.slab("tp6", 6)[400, 400] == pytest.approx(0.001 * (LATS[320] + LONS[1120] / 1000.0) * 1000.0, abs=0.05)  # m → mm
    assert r.slab("gh_500", 6)[360, 720] == pytest.approx(0.0, abs=0.5)           # m²/s² → m at lat 0, lon 0


def test_unconfigured_box_skips_rather_than_fails(tmp_path, model, monkeypatch):
    monkeypatch.delenv(wn2.ENV_ZARR, raising=False)
    out = wn2.ingest_wn2(model, datetime(2026, 9, 1, tzinfo=timezone.utc), store_root=tmp_path)
    assert out["skipped"] == "no WXGRID_WN2_ZARR"
    with pytest.raises(RuntimeError):
        wn2.resolve_latest(model)


def test_optional_model_stays_out_of_the_catalog_until_it_has_a_run():
    from wxgrid import api
    keys = [m["key"] for m in api._build_models({"ifs": []})["models"]]
    assert "wn2" not in keys and "ifs" in keys
