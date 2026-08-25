from datetime import datetime, timedelta, timezone

import numpy as np

from wxgrid import coast


class _Reader:
    """A tiny run on a 1° grid: rows north to south, water in whichever
    columns the test asks for."""

    def __init__(self, model, rid, steps, fields, water_cols, nrows=7, ncols=12):
        self.model, self.rid, self.steps = model, rid, list(steps)
        self.variables = list(fields)
        self.grid_shape = (nrows, ncols)
        self.lat0, self.lon0, self.dlat, self.dlon = 46.0, 0.0, -1.0, 1.0
        self.lats = np.array([self.lat0 + i * self.dlat for i in range(nrows)], dtype=np.float32)
        self.lons = np.array([self.lon0 + j * self.dlon for j in range(ncols)], dtype=np.float32)
        self.domain = (self.lon0, float(self.lats[-1]), float(self.lons[-1]), self.lat0)
        self._fields = fields
        self._water = set(water_cols)
        self.reads = []

    def contains(self, lat, lon):
        west, south, east, north = self.domain
        return south <= lat <= north and west <= lon <= east

    def indices(self, lat, lon):
        i = int(round((lat - self.lat0) / self.dlat))
        j = int(round((lon - self.lon0) / self.dlon))
        return min(max(i, 0), self.grid_shape[0] - 1), min(max(j, 0), self.grid_shape[1] - 1)

    def slab(self, var, step):
        self.reads.append((var, step))
        out = np.full(self.grid_shape, np.nan, np.float32)
        for j in self._water:
            out[:, j] = 1.0
        return out

    def point(self, var, lat, lon):
        i, j = self.indices(lat, lon)
        if j not in self._water:
            return np.full(len(self.steps), np.nan, np.float32)
        return np.asarray(self._fields[var], dtype=np.float32)


def _valid(rid, steps):
    t0 = datetime.strptime(rid, "%Y-%m-%dT%H").replace(tzinfo=timezone.utc)
    return [t0 + timedelta(hours=h) for h in steps]


def setup_function():
    coast._masks.clear()
    coast._series_cache.clear()      # the fakes reuse run ids; the cache keys on them


def test_nearest_water_walks_out_to_the_sea_and_names_the_direction():
    r = _Reader("ifs", "2026-08-25T00", [0, 6], {"swh": [1.4, 1.2]}, water_cols=[0, 1])
    hit = coast.nearest_water(r, coast.sea_mask(r), 43.0, 4.0)
    assert hit is not None
    dist, _i, _j, cell_lat, cell_lon = hit
    assert (cell_lat, cell_lon) == (43.0, 1.0)          # three columns west, same row
    assert 230 < dist < 250                             # 3° of longitude at 43 N
    assert coast.compass(coast.bearing_deg(43.0, 4.0, cell_lat, cell_lon)) == "W"


def test_nearest_water_gives_up_rather_than_calling_a_distant_sea_the_coast():
    r = _Reader("ifs", "2026-08-25T00", [0], {"swh": [1.0]}, water_cols=[0])
    assert coast.nearest_water(r, coast.sea_mask(r), 43.0, 9.0) is None


def test_sea_mask_reads_the_field_once_per_run():
    r = _Reader("ifs", "2026-08-25T00", [0], {"swh": [1.0]}, water_cols=[0])
    coast.sea_mask(r)
    coast.sea_mask(r)
    assert r.reads == [("swh", 0)]


def test_align_skips_the_empty_samples_a_six_hourly_wave_field_leaves():
    src_valid = _valid("2026-08-25T00", [0, 3, 6, 9, 12])
    vals = [1.4, None, 1.2, None, 1.0]                  # waves only on the 6 h steps
    dst = _valid("2026-08-25T00", [0, 3, 6, 9, 12])
    assert coast.align(src_valid, vals, dst) == [1.4, 1.4, 1.2, 1.2, 1.0]


def test_align_stops_at_the_source_horizon_instead_of_inventing_a_forecast():
    src_valid = _valid("2026-08-25T00", [0, 6])
    dst = _valid("2026-08-25T00", [0, 6, 24])
    assert coast.align(src_valid, [1.4, 1.2], dst) == [1.4, 1.2, None]


def test_probe_borrows_waves_and_sea_temperature_from_different_runs():
    # the card is on a model with no marine field at all
    card = _Reader("aifs", "2026-08-25T06", [0, 6], {"t2m": [290.0, 291.0]}, water_cols=[])
    waves = _Reader("ifs", "2026-08-25T00", [0, 6, 12],
                    {"swh": [1.4, 1.2, 1.0], "mwp": [9.0, 8.5, 8.0], "mwd": [280.0, 285.0, 290.0]},
                    water_cols=[0, 1])
    sst = _Reader("gfs", "2026-08-25T06", [0, 6], {"sst": [292.0, 292.4]}, water_cols=[0, 1])
    got = coast.probe(card, 43.0, 3.0, _valid("2026-08-25T06", [0, 6]), [waves, sst])
    assert got["model"] == "ifs" and got["compass"] == "W"
    # the IFS run starts six hours before the card's, so its 6 h and 12 h
    # steps are the card's 0 h and 6 h
    assert got["swh"] == [1.2, 1.0] and got["mwp"] == [8.5, 8.0] and got["mwd"] == [285.0, 290.0]
    assert got["sst"] == [292.0, 292.4]


def test_probe_returns_nothing_for_a_point_with_no_sea_in_reach():
    card = _Reader("aifs", "2026-08-25T06", [0], {"t2m": [290.0]}, water_cols=[])
    waves = _Reader("ifs", "2026-08-25T00", [0], {"swh": [1.4]}, water_cols=[0])
    assert coast.probe(card, 43.0, 9.0, _valid("2026-08-25T06", [0]), [waves]) is None


def test_probe_falls_back_to_a_runs_own_water_when_the_masks_disagree():
    """The wave grid and the SST mask part company by a cell along any coast;
    a sea temperature must not vanish because the waves chose the cell."""
    card = _Reader("aifs", "2026-08-25T00", [0], {"t2m": [290.0]}, water_cols=[])
    waves = _Reader("ifs", "2026-08-25T00", [0], {"swh": [1.4]}, water_cols=[0])
    sst = _Reader("gfs", "2026-08-25T00", [0], {"sst": [292.0]}, water_cols=[1])
    got = coast.probe(card, 43.0, 3.0, _valid("2026-08-25T00", [0]), [waves, sst])
    assert got["lon"] == 0.0                             # the waves fixed the spot
    assert got["swh"] == [1.4] and got["sst"] == [292.0]
