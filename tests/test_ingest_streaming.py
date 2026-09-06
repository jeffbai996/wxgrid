"""Step streaming: lifetime bounds and derived-field semantics."""
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
import weakref

import numpy as np
import pytest

from wxgrid import ingest
from wxgrid.grib import Field


def _ingest(tmp_path, monkeypatch, fields, *, mode="bucket6", steps=(3, 6), record=True, cube=None):
    model = replace(ingest.get_model("gfs"), steps=list(steps), precip_mode=mode)
    # Canonical-name fixtures isolate the streaming contract from GRIB tables.
    monkeypatch.setattr(type(model), "canonical", lambda self, name, *args: name)
    written = {}

    class Writer:
        variables = ["tp6", "sf6"]

        def __init__(self, *args, **kwargs):
            pass

        def write(self, var, step, values):
            if record:
                written[var, step] = np.array(values)

        def finish(self):
            return {}

    def fetch(model, run, root, on_step):
        for step in steps:
            on_step(step, [Path(f"step{step:03d}.grib2")])
        return list(steps)

    monkeypatch.setattr(ingest, "RunWriter", Writer)
    monkeypatch.setattr(ingest.fetch, "fetch_gfs", fetch)
    monkeypatch.setattr(ingest.fetch, "grib_override", lambda p: (None, None))
    monkeypatch.setattr(ingest, "iter_fields", lambda p, **kwargs: fields(int(p.stem[4:])))
    monkeypatch.setattr(ingest, "wait_for_step_gate", lambda: None)
    monkeypatch.setattr(ingest, "build_point_cube", cube or (lambda *args, **kwargs: 0))
    monkeypatch.setattr(ingest, "prune", lambda *args, **kwargs: [])
    monkeypatch.setattr(ingest, "warm_layers", lambda *args, **kwargs: 0)
    ingest._ingest_locked(model, datetime(2026, 9, 6, tzinfo=timezone.utc),
                          "2026-09-06T00", tmp_path / "grib", tmp_path / "store", True)
    return written


def test_independent_fields_are_released_before_next_decode(tmp_path, monkeypatch):
    refs = []

    def fields(step):
        for i in range(40):
            assert all(ref() is None for ref in refs)
            values = np.full((3, 7), i, dtype=np.float32)
            refs.append(weakref.ref(values))
            yield Field(f"t_{i}", step, values)
            del values

    _ingest(tmp_path, monkeypatch, fields, record=False)
    assert len(refs) == 80  # decode errors are deliberately caught by ingest
    assert all(ref() is None for ref in refs)


@pytest.mark.parametrize("mode,expected", [("bucket6", 3), ("since_start", 3), ("per_step", 6)])
def test_streamed_duplicates_units_and_dependencies(tmp_path, monkeypatch, mode, expected):
    def fields(step):
        def f(name, value, units="", start=0):
            return Field(name, step, np.full((2, 3), value, np.float32), units=units, start_step=start)
        yield f("t2m", 270)
        yield f("tp", 0.001, "m")   # final occurrence wins before deaccumulation
        yield f("lsm", 1)
        yield f("csnow", 1)
        yield f("tsk", 290)
        yield f("lsm", 0)
        yield f("tp", step / 1000, "m")
        if mode == "since_start":
            yield f("tp", 999, "m", start=step - 1)  # HRRR last-hour duplicate ignored
        yield f("tcc", 50, "%")
        yield f("sd", 0.1)
        yield f("t2m", 280)
        for band in ingest.WAVE_BAND_INPUTS:
            yield f(band, 2)

    written = _ingest(tmp_path, monkeypatch, fields, mode=mode)
    np.testing.assert_allclose(written["tp6", 6], expected)
    np.testing.assert_allclose(written["t2m", 6], 280)
    np.testing.assert_allclose(written["tcc", 6], 0.5)
    np.testing.assert_allclose(written["sst", 6], 290)
    np.testing.assert_allclose(written["sd_cm", 6], 0.1 * ingest.get_model("gfs").snow_depth_factor)
    np.testing.assert_allclose(written[ingest.SWELL_VAR, 6], np.sqrt(4 * len(ingest.WAVE_BAND_INPUTS)))
    if mode == "bucket6":
        np.testing.assert_allclose(written["sf6", 6], expected)
    assert not any(var in ingest.WAVE_BAND_INPUTS for var, step in written)


def test_spread_streams_independent_fields_and_keeps_partial_decode(tmp_path, monkeypatch):
    refs = []
    writes = {}

    class Writer:
        def write(self, var, step, values):
            writes[var] = float(values[0, 0])

    def fields(path):
        for value in (1, 2):
            assert all(ref() is None for ref in refs)
            values = np.full((2, 3), value, np.float32)
            refs.append(weakref.ref(values))
            yield Field("2t", 6, values, "heightAboveGround", 2)
            del values
        raise ValueError("truncated GRIB")

    monkeypatch.setattr(ingest, "iter_fields", fields)
    names = ingest.write_spread(Writer(), ingest.get_model("gefs"), 6, [tmp_path / "spread"], {})
    assert names == ["t2m_sd"]
    assert writes == {"t2m_sd": 2}


def test_final_accumulations_are_released_before_point_cube(tmp_path, monkeypatch):
    refs = []
    released = []
    original = ingest.accumulation_bucket

    def bucket(mode, step, start, accum, previous):
        refs.append(weakref.ref(accum))
        return original(mode, step, start, accum, previous)

    def fields(step):
        yield Field("tp", step, np.ones((2, 3), np.float32))
        yield Field("sf", step, np.ones((2, 3), np.float32))

    def cube(*args, **kwargs):
        released.append(bool(refs) and all(ref() is None for ref in refs))

    monkeypatch.setattr(ingest, "accumulation_bucket", bucket)
    _ingest(tmp_path, monkeypatch, fields, record=False, cube=cube)
    assert released == [True]
