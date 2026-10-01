"""Published WeatherNext layout, using small synthetic fixtures and no network."""
import dataclasses
from datetime import datetime, timezone

import numpy as np
import pytest
import xarray as xr

from wxgrid import wn2
from wxgrid.models import MODELS
from wxgrid.store import RunReader

UTC = timezone.utc
INIT = datetime(2025, 1, 1, tzinfo=UTC)


def published_dataset(init=INIT, *, nan_last=False, full_grid=False):
    """Observed schema: scalar CF init_time, timedelta time, decreasing lat.

    The live 721x1440, 60-step store is never downloaded. Most tests use a
    3x4, two-step equivalent; the writer regression uses the normal grid.
    """
    lats = np.arange(90.0, -90.01, -0.25) if full_grid else np.array([90., 89.75, 89.5])
    lons = np.arange(0.0, 360.0, 0.25) if full_grid else np.arange(4) * 0.25
    leads = np.array([6, 12], dtype="timedelta64[h]")
    init64 = np.datetime64(init.replace(tzinfo=None), "ns")
    base = 280.0 + lats[:, None] / 10.0 + np.arange(len(lons))[None, :] / 1000.0
    values = np.stack([base + 6, base + 12]).astype(np.float32)
    if nan_last:
        values[-1] = np.nan
    ds = xr.Dataset(
        {"2m_temperature": (("time", "lat", "lon"), values),
         "init_time": init64, "datetime": ("time", init64 + leads)},
        coords={"time": leads, "lat": lats, "lon": lons},
    )
    # These encodings mirror the observed .zmetadata, including xarray's
    # timedelta dtype hint. No live coordinate or field values are retained.
    ds["time"].encoding.update(units="hours", dtype="int64")
    ds["init_time"].encoding.update(units=f"days since {init:%Y-%m-%d %H:%M:%S}", dtype="int64")
    ds["datetime"].encoding.update(units=f"hours since {init:%Y-%m-%d %H:%M:%S}", dtype="int64")
    ds["lat"].attrs.update(stored_direction="decreasing", units="degrees_north")
    ds["lon"].attrs.update(units="degrees_east")
    return ds


def published_run(root, init=INIT, *, partition="2025_to_present", success=True,
                  metadata=True, dataset=None):
    path = root / partition / f"{init:%Y%m%d_%H}hr_01_preds"
    store = path / "predictions.zarr"
    store.mkdir(parents=True)
    if dataset is not None:
        dataset.to_zarr(store, mode="w", zarr_format=2, consolidated=True)
    elif metadata:
        (store / ".zgroup").write_text('{"zarr_format": 2}')
    if success:
        (path / "success").touch()
    return store


def test_collection_discovers_completed_stores_newest_first(tmp_path):
    old = datetime(2024, 12, 31, 18, tzinfo=UTC)
    newest = datetime(2025, 1, 1, 6, tzinfo=UTC)
    old_store = published_run(tmp_path, old, partition="2024_to_2025")
    first_store = published_run(tmp_path)
    newest_store = published_run(tmp_path, newest)
    published_run(tmp_path, datetime(2025, 1, 1, 12, tzinfo=UTC), success=False)
    published_run(tmp_path, datetime(2025, 1, 1, 18, tzinfo=UTC), metadata=False)
    (tmp_path / "structure.pdf").write_bytes(b"synthetic documentation")
    assert list(wn2.discover_sources(str(tmp_path))) == [
        (newest, str(newest_store)), (INIT, str(first_store)), (old, str(old_store)),
    ]


@pytest.mark.parametrize("start_at", ["collection", "partition", "run", "store"])
def test_supported_source_roots(tmp_path, start_at):
    store = published_run(tmp_path)
    root = {"collection": tmp_path, "partition": store.parent.parent,
            "run": store.parent, "store": store}[start_at]
    sources = list(wn2.discover_sources(str(root)))
    assert sources == [(None if start_at == "store" else INIT, str(store))]


def test_requested_init_never_falls_back_to_a_different_run(tmp_path):
    store = published_run(tmp_path)
    newer = datetime(2025, 1, 1, 6, tzinfo=UTC)
    published_run(tmp_path, newer)
    assert list(wn2.discover_sources(str(tmp_path), INIT)) == [(INIT, str(store))]
    with pytest.raises(FileNotFoundError, match="no published WeatherNext"):
        wn2.open_dataset(str(tmp_path), datetime(2025, 1, 2, tzinfo=UTC))


def test_malformed_run_directories_are_ignored(tmp_path):
    partition = tmp_path / "2025_to_present"
    for name in ("20251301_00hr_01_preds", "20250101_24hr_01_preds", "20250101_00hr_00_preds"):
        run = partition / name
        (run / "predictions.zarr").mkdir(parents=True)
        (run / "success").touch()
        (run / "predictions.zarr" / ".zgroup").write_text('{"zarr_format": 2}')
    assert list(wn2.discover_sources(str(tmp_path))) == []


def test_published_cf_zarr_opens_with_canonical_init_and_leads(tmp_path):
    store = published_run(tmp_path, dataset=published_dataset())
    with wn2.open_dataset(str(store)) as ds:
        assert dict(ds.sizes) == {"time": 1, "prediction_timedelta": 2, "lat": 3, "lon": 4}
        assert np.array_equal(ds.time.values, [np.datetime64("2025-01-01T00:00:00", "ns")])
        assert np.array_equal(ds.prediction_timedelta.values, np.array([6, 12], dtype="timedelta64[h]"))
        assert ds["2m_temperature"].dims == ("prediction_timedelta", "lat", "lon")
        assert wn2.latest_init(ds, [6, 12]) == INIT


def test_collection_open_uses_requested_store_instead_of_latest(tmp_path):
    published_run(tmp_path, dataset=published_dataset())
    newer = datetime(2025, 1, 1, 6, tzinfo=UTC)
    published_run(tmp_path, newer, dataset=published_dataset(newer))
    with wn2.open_dataset(str(tmp_path), run=INIT) as ds:
        assert wn2.latest_init(ds, [6, 12]) == INIT


def test_latest_resolution_falls_back_when_newest_final_lead_is_nan(tmp_path):
    published_run(tmp_path, dataset=published_dataset())
    newer = datetime(2025, 1, 1, 6, tzinfo=UTC)
    published_run(tmp_path, newer, dataset=published_dataset(newer, nan_last=True))
    model = dataclasses.replace(MODELS["wn2"], steps=[6, 12])
    assert wn2.resolve_latest(model, str(tmp_path)) == INIT


def test_latest_resolution_bounds_forecast_probes(monkeypatch):
    monkeypatch.setattr(wn2, "discover_sources", lambda url: ((INIT, str(i)) for i in range(1000)))
    opened = []
    def open_store(url):
        opened.append(url)
        return xr.Dataset()
    monkeypatch.setattr(wn2, "_open_store", open_store)
    with pytest.raises(RuntimeError, match="no complete WeatherNext"):
        wn2.resolve_latest(MODELS["wn2"], "synthetic-collection")
    assert len(opened) == wn2.MAX_LATEST_CANDIDATES


def test_permission_errors_are_not_reported_as_missing_runs(monkeypatch):
    def denied(url):
        raise PermissionError("dataset access denied")
    monkeypatch.setattr(wn2, "discover_sources", denied)
    with pytest.raises(PermissionError, match="dataset access denied"):
        wn2.resolve_latest(MODELS["wn2"], "synthetic-collection")


def test_normalization_accepts_valid_datetime_axis_without_mutating_source():
    original = published_dataset()
    original = original.assign_coords(time=original["datetime"].values)
    result = wn2.normalize_dataset(original)
    assert "init_time" in original and original.sizes["time"] == 2
    assert np.array_equal(result.prediction_timedelta.values, np.array([6, 12], dtype="timedelta64[h]"))


def test_legacy_multi_init_shape_is_unchanged():
    ds = xr.Dataset(coords={"time": [np.datetime64("2025-01-01")],
                            "prediction_timedelta": np.array([6, 12], dtype="timedelta64[h]")})
    assert wn2.normalize_dataset(ds) is ds


def test_normalization_never_reads_lazy_field_chunks():
    from xarray.backends import BackendArray
    from xarray.core import indexing

    class UnreadableField(BackendArray):
        shape = (2, 3, 4)
        dtype = np.dtype("float32")

        def __getitem__(self, key):
            raise AssertionError("normalization tried to read forecast chunks")

    ds = published_dataset()
    ds["2m_temperature"] = xr.Variable(
        ("time", "lat", "lon"), indexing.LazilyIndexedArray(UnreadableField()))
    result = wn2.normalize_dataset(ds)
    assert result["2m_temperature"].shape == (2, 3, 4)
    assert result.sizes["time"] == 1


@pytest.mark.parametrize("bad_coord", ["init_time", "time"])
def test_undecoded_numeric_coordinates_fail_clearly(bad_coord):
    ds = published_dataset()
    if bad_coord == "init_time":
        ds["init_time"] = 0
    else:
        ds = ds.assign_coords(time=[6, 12])
    with pytest.raises(ValueError, match=bad_coord):
        wn2.normalize_dataset(ds)


def test_collection_ingest_preserves_requested_init_grid_and_available_steps(tmp_path):
    published_run(tmp_path / "source", dataset=published_dataset(full_grid=True))
    model = dataclasses.replace(MODELS["wn2"], steps=[0, 6, 12], levels=(),
                                sfc_params={"2m_temperature": "t2m"}, pl_params={})
    out = wn2.ingest_wn2(model, INIT, store_root=tmp_path / "store", url=str(tmp_path / "source"))
    assert out["run"] == "2025-01-01T00" and out["fields"] == 2
    reader = RunReader("wn2", "2025-01-01T00", tmp_path / "store")
    assert reader.slab("t2m", 6)[0, 0] == pytest.approx(295.72, abs=0.05)
    assert reader.slab("t2m", 12)[0, 0] == pytest.approx(301.72, abs=0.05)
    assert np.isnan(reader.slab("t2m", 0)).all()  # do not invent an unpublished analysis step
