"""accumulation_bucket turns a producer's accumulation into the amount that
fell since the PREVIOUS stored step. Three producer conventions:

  since_start  ECMWF/HRRR: every field accumulates from t0.
  bucket6      GFS: fields accumulate from the bucket start (startStep),
               buckets restart every 6 h (3 h/6 h alternating past 120 h).
  per_step     already an increment; passed through.

A wrong sign or a missed bucket boundary corrupts every precip/snow layer
and every route forecast silently — there is no crash to notice.
"""
import numpy as np
import pytest

from wxgrid.ingest import accumulation_bucket


def _a(v):
    return np.full((2, 2), float(v))


def test_step_zero_is_always_zero_regardless_of_mode():
    for mode in ("since_start", "bucket6", "per_step"):
        out = accumulation_bucket(mode, 0, 0, _a(7.0), None)
        assert np.all(out == 0.0) and out.shape == (2, 2)


def test_per_step_is_passed_through():
    out = accumulation_bucket("per_step", 3, 0, _a(1.5), (0, 2, _a(9.0)))
    assert np.all(out == 1.5)


def test_since_start_first_step_is_the_total_since_t0():
    # No previous stored step: the accumulation since t0 IS the increment.
    out = accumulation_bucket("since_start", 1, 0, _a(2.0), None)
    assert np.all(out == 2.0)


def test_since_start_differences_against_the_previous_step():
    prev = (0, 2, _a(5.0))
    out = accumulation_bucket("since_start", 3, 0, _a(8.0), prev)
    assert np.all(out == 3.0)


def test_since_start_never_goes_negative_when_the_producer_rounds_down():
    # ECMWF totals occasionally tick down a hair between steps (packing).
    prev = (0, 5, _a(4.0001))
    out = accumulation_bucket("since_start", 6, 0, _a(4.0), prev)
    assert np.all(out == 0.0)


def test_bucket6_first_hour_of_a_new_bucket_is_the_raw_value():
    # f007: startStep 6, previous stored step came from the 0-6 bucket.
    prev = (0, 6, _a(12.0))
    out = accumulation_bucket("bucket6", 7, 6, _a(1.0), prev)
    assert np.all(out == 1.0)


def test_bucket6_inside_a_bucket_differences_against_the_previous_step():
    prev = (6, 7, _a(1.0))
    out = accumulation_bucket("bucket6", 8, 6, _a(3.0), prev)
    assert np.all(out == 2.0)


def test_bucket6_closing_hour_of_a_bucket_still_differences():
    # f012 closes the 6-12 bucket: start matches, previous step is 11.
    prev = (6, 11, _a(5.0))
    out = accumulation_bucket("bucket6", 12, 6, _a(6.0), prev)
    assert np.all(out == 1.0)


def test_bucket6_three_hourly_tail_alternates_bucket_lengths():
    # Past 120 h GFS publishes f123 (3 h bucket from 120) then f126 (6 h
    # bucket from 120): same start, so f126 differences against f123.
    prev = (120, 123, _a(2.0))
    out = accumulation_bucket("bucket6", 126, 120, _a(5.0), prev)
    assert np.all(out == 3.0)
    # f129 opens a new bucket at 126: raw value again.
    prev = (120, 126, _a(5.0))
    out = accumulation_bucket("bucket6", 129, 126, _a(1.5), prev)
    assert np.all(out == 1.5)


def test_bucket6_ignores_a_previous_that_is_not_older():
    # A re-ingested step must not difference against itself.
    prev = (6, 8, _a(3.0))
    out = accumulation_bucket("bucket6", 8, 6, _a(3.0), prev)
    assert np.all(out == 3.0)


@pytest.mark.parametrize("mode", ["since_start", "bucket6"])
def test_increments_are_clipped_at_zero(mode):
    prev = (0, 3, _a(10.0))
    out = accumulation_bucket(mode, 4, 0, _a(9.0), prev)
    assert np.all(out == 0.0)
