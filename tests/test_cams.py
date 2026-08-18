"""Global air-quality layers in wxgrid.cams — no network.

The GRIB decoder is exercised against a real GEFS-Aerosol message built here
with eccodes, so the (parameterNumber, constituentType, wavelength) selection
and the longitude roll are tested for real rather than mocked away.
"""
import io
import json
from datetime import datetime, timezone

import numpy as np
import pytest
from PIL import Image

from wxgrid import cams
from wxgrid.config import GRID_LAT_N, GRID_LON_N


# ── fixtures ──────────────────────────────────────────────────────────────

RUN = datetime(2026, 8, 18, 0, tzinfo=timezone.utc)
RID = "2026-08-18T00"


def _grib_message(number: int, constituent: int, values: np.ndarray,
                  wavelength: int | None = None, category: int = 13) -> bytes:
    """A GRIB2 message on the GEFS 0.25° grid (lon 0→359.75) with the keys
    cams._read_grib selects on. Cloned from a stock sample and rewritten.

    Product-definition template 48 ("optical properties of aerosol") is what
    every message in a real gefs.chem file uses — including the particulate
    ones, which is why they too carry a wavelength field (set to zero)."""
    eccodes = pytest.importorskip("eccodes")
    gid = eccodes.codes_grib_new_from_samples("regular_ll_sfc_grib2")
    try:
        eccodes.codes_set(gid, "productDefinitionTemplateNumber", 48)
        eccodes.codes_set(gid, "Ni", GRID_LON_N)
        eccodes.codes_set(gid, "Nj", GRID_LAT_N)
        eccodes.codes_set(gid, "latitudeOfFirstGridPointInDegrees", 90.0)
        eccodes.codes_set(gid, "latitudeOfLastGridPointInDegrees", -90.0)
        eccodes.codes_set(gid, "longitudeOfFirstGridPointInDegrees", 0.0)
        eccodes.codes_set(gid, "longitudeOfLastGridPointInDegrees", 359.75)
        eccodes.codes_set(gid, "iDirectionIncrementInDegrees", 0.25)
        eccodes.codes_set(gid, "jDirectionIncrementInDegrees", 0.25)
        eccodes.codes_set(gid, "jScansPositively", 0)
        eccodes.codes_set(gid, "discipline", 0)
        eccodes.codes_set(gid, "parameterCategory", category)
        eccodes.codes_set(gid, "parameterNumber", number)
        eccodes.codes_set(gid, "constituentType", constituent)
        eccodes.codes_set(gid, "scaleFactorOfFirstWavelength", 9)
        eccodes.codes_set(gid, "scaledValueOfFirstWavelength", 0 if wavelength is None else wavelength)
        eccodes.codes_set_values(gid, np.asarray(values, dtype=np.float64).ravel())
        return eccodes.codes_get_message(gid)
    finally:
        eccodes.codes_release(gid)


@pytest.fixture
def step_grib(tmp_path):
    """A step file holding fine + coarse total PM, fine dust, and AOD at two
    wavelengths — 550 nm (wanted) and 860 nm (must be ignored)."""
    fine = np.full((GRID_LAT_N, GRID_LON_N), 10.0, dtype=np.float32)
    fine[:, 0] = 111.0                     # sits at lon 0 → must land at column 720
    coarse = np.full((GRID_LAT_N, GRID_LON_N), 5.0, dtype=np.float32)
    dust_fine = np.full((GRID_LAT_N, GRID_LON_N), 2.0, dtype=np.float32)
    dust_coarse = np.full((GRID_LAT_N, GRID_LON_N), 3.0, dtype=np.float32)
    aod = np.full((GRID_LAT_N, GRID_LON_N), 0.4, dtype=np.float32)
    other_band = np.full((GRID_LAT_N, GRID_LON_N), 99.0, dtype=np.float32)
    path = tmp_path / "step.grib2"
    path.write_bytes(
        _grib_message(cams.PM_FINE, cams.TOTAL, fine)
        + _grib_message(cams.PM_COARSE, cams.TOTAL, coarse)
        + _grib_message(cams.PM_FINE, cams.DUST, dust_fine)
        + _grib_message(cams.PM_COARSE, cams.DUST, dust_coarse)
        + _grib_message(cams.AOD, cams.TOTAL, aod, wavelength=cams.AOD_550_NM, category=20)
        + _grib_message(cams.AOD, cams.TOTAL, other_band, wavelength=841, category=20))
    return path


@pytest.fixture
def cached_run(tmp_path):
    """A two-step cache root, as refresh() would leave it."""
    root = tmp_path / "cams"
    d = root / RID
    d.mkdir(parents=True)
    for step in (0, 3):
        np.savez_compressed(
            d / f"s{step:03d}.npz",
            pm2_5=np.full((GRID_LAT_N, GRID_LON_N), 12.0 + step, dtype=np.float16),
            pm10=np.full((GRID_LAT_N, GRID_LON_N), 30.0 + step, dtype=np.float16),
            dust=np.full((GRID_LAT_N, GRID_LON_N), 4.0, dtype=np.float16),
            aod550=np.full((GRID_LAT_N, GRID_LON_N), 0.25, dtype=np.float16))
    (d / "catalog.json").write_text(json.dumps(
        {"run": RID, "source": cams.ATTRIBUTION, "steps": [0, 3],
         "vars": {k: {"label": v["label"], "units": v["units"], "desc": v["desc"]}
                  for k, v in cams.VARS.items()}}))
    return root


class FakeResponse:
    def __init__(self, text="", status=200, content=b""):
        self.text, self.status_code, self.content = text, status, content

    def raise_for_status(self):
        if self.status_code >= 400:
            raise cams.requests.HTTPError(f"status {self.status_code}")

    def json(self):
        return json.loads(self.text)

    def iter_content(self, n):
        yield self.content

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


# ── GRIB decoding ─────────────────────────────────────────────────────────

def test_read_grib_selects_and_sums_the_configured_parts(step_grib):
    got = cams._read_grib(step_grib)
    assert set(got) == set(cams.VARS)
    assert got["pm2_5"][0, 0] == pytest.approx(10.0, abs=1e-3)
    assert got["pm10"][0, 0] == pytest.approx(15.0, abs=1e-3)      # fine + coarse
    assert got["dust"][0, 0] == pytest.approx(5.0, abs=1e-3)       # fine + coarse dust


def test_read_grib_takes_the_550nm_band_and_ignores_the_others(step_grib):
    got = cams._read_grib(step_grib)
    assert got["aod550"][0, 0] == pytest.approx(0.4, abs=1e-3)     # not 99.0


def test_read_grib_rolls_longitude_onto_the_common_grid(step_grib):
    """Source column 0 is lon 0°, which is column 720 of the -180→180 grid."""
    pm = cams._read_grib(step_grib)["pm2_5"]
    assert pm.shape == (GRID_LAT_N, GRID_LON_N)
    assert pm[0, 720] == pytest.approx(111.0, abs=1e-2)
    assert pm[0, 0] == pytest.approx(10.0, abs=1e-2)


# ── URL construction ──────────────────────────────────────────────────────

def test_step_url_subsets_to_the_messages_we_use():
    url = cams._step_url(RUN, 24)
    assert url.startswith(cams.NOMADS_CHEM)
    assert "gefs.chem.t00z.a2d_0p25.f024.grib2" in url
    for flag in ("var_PMTF=on", "var_PMTC=on", "var_AOTK=on", "lev_surface=on"):
        assert flag in url
    assert "gefs.20260818%2F00%2Fchem%2Fpgrb2ap25" in url


def test_available_steps_parses_the_cgi_listing(monkeypatch):
    html = ('<option value="gefs.chem.t00z.a2d_0p25.f000.grib2">'
            '<option value="gefs.chem.t00z.a2d_0p25.f003.grib2">'
            '<option value="gefs.chem.t00z.a2d_0p25.f003.grib2.idx">'
            '<option value="gefs.chem.t00z.a2d_0p25.f120.grib2">')

    class S:
        def get(self, url, params=None, timeout=None):
            return FakeResponse(text=html)

    assert cams.available_steps(RUN, S()) == {0, 3, 120}


def test_latest_run_walks_back_until_a_run_is_deep_enough(monkeypatch):
    now = datetime(2026, 8, 18, 14, tzinfo=timezone.utc)
    seen = []

    def fake(run, session):
        seen.append(run)
        return {0, 3, 6} if run.hour == 12 else set(range(0, 121, 3))

    monkeypatch.setattr(cams, "available_steps", fake)
    got = cams.latest_run(now=now, session=object(), need=72)
    assert got == datetime(2026, 8, 18, 6, tzinfo=timezone.utc)   # 18Z is future, 12Z too shallow
    assert seen[0].hour == 12


def test_latest_run_returns_none_when_nothing_is_published(monkeypatch):
    monkeypatch.setattr(cams, "available_steps", lambda run, session: set())
    assert cams.latest_run(now=datetime(2026, 8, 18, 14, tzinfo=timezone.utc), session=object()) is None


# ── refresh ───────────────────────────────────────────────────────────────

def test_refresh_writes_steps_and_a_catalog(tmp_path, step_grib, monkeypatch):
    root = tmp_path / "cams"
    payload = step_grib.read_bytes()

    class S:
        def get(self, url, timeout=None, stream=False, params=None):
            return FakeResponse(content=payload)

    cat = cams.refresh(run=RUN, steps=(0, 3), root=root, session=S())
    assert cat["run"] == RID and cat["steps"] == [0, 3]
    assert set(cat["vars"]) == set(cams.VARS)
    assert cat["source"] == cams.ATTRIBUTION
    assert (root / RID / "s000.npz").exists() and (root / RID / "s003.npz").exists()
    assert cams.load_step(RID, 0, root)["pm10"][0, 0] == pytest.approx(15.0, abs=0.05)


def test_refresh_skips_a_run_already_cached(cached_run):
    calls = []

    class S:
        def get(self, *a, **k):
            calls.append(a)
            raise AssertionError("should not download")

    cams.refresh(run=RUN, steps=(0, 3), root=cached_run, session=S())
    assert not calls


def test_refresh_tops_up_a_run_cached_at_a_shallower_depth(cached_run, step_grib):
    """The cache holds steps 0 and 3; asking for 0, 3 and 6 must fetch only 6."""
    payload = step_grib.read_bytes()
    urls = []

    class S:
        def get(self, url, timeout=None, stream=False, params=None):
            urls.append(url)
            return FakeResponse(content=payload)

    cat = cams.refresh(run=RUN, steps=(0, 3, 6), root=cached_run, session=S())
    assert len(urls) == 1 and "f006" in urls[0]
    assert cat["steps"] == [0, 3, 6]


def test_refresh_survives_a_step_that_fails_to_download(tmp_path, step_grib):
    root = tmp_path / "cams"
    payload = step_grib.read_bytes()
    seen = []

    class S:
        def get(self, url, timeout=None, stream=False, params=None):
            seen.append(url)
            if "f003" in url:
                raise cams.requests.ConnectionError("boom")
            return FakeResponse(content=payload)

    cat = cams.refresh(run=RUN, steps=(0, 3, 6), root=root, session=S())
    assert cat["steps"] == [0, 6]
    assert len(seen) == 3


def test_refresh_raises_when_no_step_survives(tmp_path):
    root = tmp_path / "cams"

    class S:
        def get(self, *a, **k):
            raise cams.requests.ConnectionError("down")

    with pytest.raises(RuntimeError):
        cams.refresh(run=RUN, steps=(0, 3), root=root, session=S())
    assert not (root / RID).exists()


def test_refresh_prunes_older_runs(tmp_path, step_grib):
    root = tmp_path / "cams"
    stale = root / "2026-08-01T00"
    stale.mkdir(parents=True)
    (stale / "catalog.json").write_text("{}")
    payload = step_grib.read_bytes()

    class S:
        def get(self, *a, **k):
            return FakeResponse(content=payload)

    cams.refresh(run=RUN, steps=(0,), root=root, session=S())
    assert not stale.exists()
    assert (root / RID).exists()


# ── cache reads ───────────────────────────────────────────────────────────

def test_catalog_is_empty_but_shaped_when_nothing_is_cached(tmp_path):
    cat = cams.catalog(tmp_path / "nope")
    assert cat["run"] is None and cat["steps"] == [] and cat["runs"] == []


def test_catalog_lists_runs_newest_first(cached_run):
    (cached_run / "2026-08-17T12").mkdir()
    (cached_run / "2026-08-17T12" / "catalog.json").write_text("{}")
    assert cams.catalog(cached_run)["runs"] == [RID, "2026-08-17T12"]


def test_load_step_missing_raises(cached_run):
    with pytest.raises(FileNotFoundError):
        cams.load_step(RID, 99, cached_run)


# ── render ────────────────────────────────────────────────────────────────

def test_layer_png_is_a_mercator_rgba_image_and_is_cached(cached_run):
    png = cams.layer_png("pm2_5", 0, root=cached_run)
    img = Image.open(io.BytesIO(png))
    assert img.mode == "RGBA"
    assert img.size == (GRID_LON_N, render_h())
    assert (cached_run / RID / "png" / "pm2_5-000.png").exists()
    assert cams.layer_png("pm2_5", 0, root=cached_run) == png     # second call reads the cache


def render_h():
    from wxgrid.render import MERC_H
    return MERC_H


def test_layer_png_rejects_an_unknown_variable(cached_run):
    with pytest.raises(KeyError):
        cams.layer_png("ozone", 0, root=cached_run)


def test_colorize_is_transparent_where_the_air_is_clean():
    clean = np.zeros((4, 4), dtype=np.float32)
    rgba = np.asarray(Image.open(io.BytesIO(cams.colorize(clean, "pm2_5"))))
    assert rgba[..., 3].max() == 0


def test_colorize_is_opaque_in_thick_smoke():
    thick = np.full((4, 4), 300.0, dtype=np.float32)
    rgba = np.asarray(Image.open(io.BytesIO(cams.colorize(thick, "pm2_5"))))
    assert rgba[..., 3].min() >= int(cams.DEFAULT_ALPHA * 255) - 1


def test_colorize_of_an_all_nan_field_is_fully_transparent():
    nan = np.full((4, 4), np.nan, dtype=np.float32)
    rgba = np.asarray(Image.open(io.BytesIO(cams.colorize(nan, "dust"))))
    assert rgba[..., 3].max() == 0


def test_every_variable_has_a_ramp_and_a_legend():
    for name in cams.VARS:
        assert name in cams.RAMPS
        lg = cams.legend(name)
        assert lg["stops"] and lg["hi"] > lg["lo"]
        assert lg["stops"][0]["v"] == lg["lo"] and lg["stops"][-1]["v"] == lg["hi"]


# ── point ─────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("lat,lon,row,col", [
    (90.0, -180.0, 0, 0), (0.0, 0.0, 360, 720), (-90.0, 179.75, 720, 1439), (49.25, -123.0, 163, 228)])
def test_nearest_maps_coordinates_onto_the_common_grid(lat, lon, row, col):
    assert cams._nearest(lat, lon) == (row, col)


def test_grid_point_returns_a_series_per_variable(cached_run):
    p = cams.grid_point(49.25, -123.0, root=cached_run)
    assert p["run"] == RID and p["steps"] == [0, 3]
    assert p["values"]["pm2_5"] == [12.0, 15.0]
    assert p["valid"][0].startswith("2026-08-18T00:00")
    assert p["valid"][1].startswith("2026-08-18T03:00")
    assert p["lat"] == pytest.approx(49.25) and p["lon"] == pytest.approx(-123.0)


def test_grid_point_is_empty_when_nothing_is_cached(tmp_path):
    assert cams.grid_point(0, 0, root=tmp_path / "nope")["steps"] == []


def test_openmeteo_point_normalises_the_response():
    body = {"latitude": 49.25, "longitude": -123.0,
            "hourly_units": {"pm2_5": "μg/m³", "carbon_monoxide": "μg/m³"},
            "hourly": {"time": [1, 2], "pm2_5": [5.0, 6.0], "carbon_monoxide": [90.0, 95.0],
                       "us_aqi": [21, 25], "unwanted": [1, 2]}}

    class S:
        def get(self, url, params=None, timeout=None, headers=None):
            return FakeResponse(text=json.dumps(body))

    got = cams.openmeteo_point(49.25, -123.0, session=S())
    assert got["hourly"]["carbon_monoxide"] == [90.0, 95.0]
    assert got["hourly"]["us_aqi"] == [21, 25]
    assert "unwanted" not in got["hourly"]
    assert got["time"] == [1, 2]


def test_openmeteo_point_degrades_instead_of_raising():
    class S:
        def get(self, *a, **k):
            raise cams.requests.ConnectionError("no dns")

    got = cams.openmeteo_point(0, 0, session=S())
    assert got["hourly"] == {} and "error" in got


def test_point_combines_the_grid_and_the_cams_feed(cached_run, monkeypatch):
    monkeypatch.setattr(cams, "openmeteo_point", lambda lat, lon, session=None: {"hourly": {"us_aqi": [7]}})
    p = cams.point(49.25, -123.0, root=cached_run)
    assert p["grid"]["values"]["pm10"] == [30.0, 33.0]
    assert p["cams"]["hourly"]["us_aqi"] == [7]


# ── open-meteo coarse grid ────────────────────────────────────────────────

def test_openmeteo_grid_points_cover_the_globe_at_the_asked_resolution():
    pts = cams.openmeteo_grid_points(4.0, lat_max=80.0)
    assert len(pts) == 41 * 90
    assert min(a for a, _ in pts) == -80.0 and max(a for a, _ in pts) == 80.0
    assert min(o for _, o in pts) == -180.0 and max(o for _, o in pts) == 176.0


def test_openmeteo_grid_backs_off_on_429_then_succeeds(tmp_path):
    root = tmp_path / "cams"
    calls = {"n": 0}

    class S:
        def get(self, url, params=None, timeout=None, headers=None):
            calls["n"] += 1
            if calls["n"] == 1:
                return FakeResponse(status=429)
            return FakeResponse(text=json.dumps([{"latitude": 0, "longitude": 0, "hourly": {}}]))

    out = cams.refresh_openmeteo_grid(res_deg=90.0, batch=500, root=root, session=S(), pause=0)
    assert calls["n"] == 2
    assert out["returned"] == 1 and out["bytes"] > 0
    assert (root / "openmeteo" / "grid90deg.json").exists()


# ── API router ────────────────────────────────────────────────────────────

def test_router_serves_catalog_layer_and_point(cached_run, monkeypatch):
    fastapi = pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from wxgrid import cams_api

    monkeypatch.setattr(cams, "CAMS_DIR", cached_run)
    monkeypatch.setattr(cams, "openmeteo_point", lambda lat, lon, session=None: {"hourly": {"us_aqi": [9]}})
    app = fastapi.FastAPI()
    app.include_router(cams_api.router)
    c = TestClient(app)

    cat = c.get("/api/cams/catalog").json()
    assert cat["run"] == RID and set(cat["legends"]) == set(cams.VARS)

    png = c.get("/api/cams/layer/pm2_5/0.png")
    assert png.status_code == 200 and png.headers["content-type"] == "image/png"
    assert png.content[:8] == b"\x89PNG\r\n\x1a\n"

    assert c.get("/api/cams/layer/nope/0.png").status_code == 404
    assert c.get("/api/cams/layer/pm2_5/99.png").status_code == 404

    pt = c.get("/api/cams/point", params={"lat": 49.25, "lon": -123.0}).json()
    assert pt["grid"]["values"]["pm2_5"] == [12.0, 15.0]
    assert pt["cams"]["hourly"]["us_aqi"] == [9]

    only = c.get("/api/cams/point", params={"lat": 0, "lon": 0, "grid_only": True}).json()
    assert only["cams"] is None

    assert c.get("/api/cams/point", params={"lat": 100, "lon": 0}).status_code == 422
