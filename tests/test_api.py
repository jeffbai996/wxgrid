import numpy as np
from fastapi.testclient import TestClient

from wxgrid import api
from wxgrid.config import GRID_LAT_N, GRID_LON_N, STORE_DIR
from wxgrid.store import RunWriter


def _full(val):
    return np.full((GRID_LAT_N, GRID_LON_N), val, np.float32)


class _TinyReader:
    def __init__(self, fields):
        self.fields = fields
        self.variables = list(fields)
        self.grid_shape = next(iter(fields.values())).shape
        self.rid = "2026-06-21T12"
        self.lat0 = 1.0
        self.lon0 = -1.0
        self.dlat = -1.0
        self.dlon = 1.0
        self.steps = [0]

    def slab(self, name, step):
        assert step == 0
        return self.fields[name]


def test_new_windy_style_layers_are_physical_or_plainly_potential():
    shape = (3, 4)
    reader = _TinyReader({
        "t2m": np.full(shape, 283.15, np.float32),
        "d2m": np.full(shape, 282.95, np.float32),
        "tcc": np.full(shape, 0.4, np.float32),
        "lcc": np.full(shape, 0.8, np.float32),
        "mcc": np.full(shape, 0.5, np.float32),
        "hcc": np.full(shape, 0.2, np.float32),
        "swh": np.full(shape, 2.0, np.float32),
        "mwp": np.full(shape, 10.0, np.float32),
    })
    np.testing.assert_allclose(api.field_for(reader, "cloudlow", None, 0), 0.8)
    np.testing.assert_allclose(api.field_for(reader, "cloudmid", None, 0), 0.5)
    np.testing.assert_allclose(api.field_for(reader, "cloudhigh", None, 0), 0.2)
    assert api.field_for(reader, "fog", None, 0).min() > 70
    assert api.field_for(reader, "solar", None, 0).max() > 500
    np.testing.assert_allclose(api.field_for(reader, "wavepower", None, 0), 19.6, rtol=0.01)


def test_cloud_bands_fall_back_to_pressure_level_cloud_cover():
    shape = (2, 2)
    reader = _TinyReader({
        "cc_1000": np.full(shape, 0.2, np.float32),
        "cc_925": np.full(shape, 0.6, np.float32),
        "cc_850": np.full(shape, 0.4, np.float32),
        "cc_700": np.full(shape, 0.3, np.float32),
        "cc_600": np.full(shape, 0.7, np.float32),
        "cc_500": np.full(shape, 0.5, np.float32),
        "cc_400": np.full(shape, 0.1, np.float32),
        "cc_300": np.full(shape, 0.8, np.float32),
        "cc_250": np.full(shape, 0.6, np.float32),
        "cc_200": np.full(shape, 0.2, np.float32),
    })
    np.testing.assert_allclose(api.field_for(reader, "cloudlow", None, 0), 0.6)
    np.testing.assert_allclose(api.field_for(reader, "cloudmid", None, 0), 0.7)
    np.testing.assert_allclose(api.field_for(reader, "cloudhigh", None, 0), 0.8)


def _seed():
    variables = ["u10", "v10", "t2m", "tp6", "u_850", "v_850", "t_850", "gh_850", "u_700", "v_700", "t_700", "gh_700"]
    w = RunWriter("aifs", "2026-01-01T00", [0, 6], variables, root=STORE_DIR)
    for s, val in [(0, 1.0), (6, 2.0)]:
        w.write("u10", s, _full(val)); w.write("v10", s, _full(0.0))
        w.write("t2m", s, _full(273.15 + 10 * val))
        w.write("tp6", s, _full(4.0))                  # 4 mm of water in the column
        # 850 hPa: +5 °C at 1500 m; 700 hPa: -5 °C at 3000 m → freezing level 2250 m
        w.write("u_850", s, _full(10.0)); w.write("v_850", s, _full(0.0)); w.write("t_850", s, _full(278.15)); w.write("gh_850", s, _full(1500.0))
        w.write("u_700", s, _full(20.0)); w.write("v_700", s, _full(0.0)); w.write("t_700", s, _full(268.15)); w.write("gh_700", s, _full(3000.0))
    w.finish()


def test_models_layers_levels_and_point():
    _seed()
    c = TestClient(api.app)
    m = c.get("/api/models").json()
    aifs = next(x for x in m["models"] if x["key"] == "aifs")
    # frz derives from the two seeded levels; the rain windows derive from tp6
    assert aifs["runs"][0]["layers"] == ["wind", "temp", "dt24", "tp6", "tp24", "tp72", "frz", "ptype"]
    assert aifs["runs"][0]["levels"] == [850, 700]
    p = c.get("/api/point", params={"lat": 49.28, "lon": -123.12, "model": "aifs"}).json()
    assert p["series"]["wind"] == [1.0, 2.0] and p["series"]["wdir"] == [270, 270]
    assert p["aloft"]["850"]["wind"] == [10.0, 10.0]
    assert p["derived"]["freezing_level_m"] == [2250, 2250]
    assert c.get("/api/layer/aifs/latest/6/wind.png").headers["content-type"] == "image/png"
    assert c.get("/api/layer/aifs/latest/6/wind.png?level=850").status_code == 200
    assert c.get("/api/layer/aifs/latest/6/temp.png?level=500").status_code == 404
    assert c.get("/api/layer/aifs/latest/6/t2m.png").status_code == 200   # legacy alias
    assert c.get("/api/layer/aifs/latest/6/msl.png").status_code == 404
    assert c.get("/api/wind/aifs/2026-01-01T00/0.json?level=700").json()["u"][0] == 20.0


def test_freezing_level_layer_profile_and_isolines():
    _seed()
    c = TestClient(api.app)
    assert c.get("/api/layer/aifs/latest/6/frz.png").status_code == 200
    p = c.get("/api/profile", params={"lat": 49.28, "lon": -123.12, "model": "aifs", "elevs": "1500,2250,3000"}).json()
    assert p["freezing_level_m"] == [2250, 2250]
    bands = {b["elev_m"]: b for b in p["bands"]}
    assert bands[1500.0]["temp"][0] == 278.15 and bands[3000.0]["temp"][0] == 268.15
    assert abs(bands[2250.0]["temp"][0] - 273.15) < 0.01          # halfway between the two levels
    assert bands[2250.0]["wind"][0] == 15.0                       # 10 m/s at 850 → 20 m/s at 700
    # each band splits the column's precipitation by ITS own temperature: the
    # cold band banks snow, the warm one gets the same water as rain
    cold, warm = bands[3000.0], bands[1500.0]
    assert cold["ptype"][0] == "snow" and warm["ptype"][0] == "rain"
    assert cold["snow_cm"][0] > 0 and cold["rain_mm"][0] == 0
    assert warm["snow_cm"][0] == 0 and warm["rain_mm"][0] > 0
    assert api._snow_ratio(-20) == 15.0 and api._snow_ratio(5) == 5.0 and api._snow_ratio(None) == 10.0
    iso = c.get("/api/isolines/aifs/latest/6/temp.json").json()
    assert iso["unit"] == "°C" and iso["interval"] == 2.0 and iso["grid_degrees"] == 0.25
    assert "features" in iso                                        # a flat field has no lines; shape only
    frz_iso = c.get("/api/isolines/aifs/latest/6/frz.json")
    assert frz_iso.status_code == 200


def _seed_heights():
    variables = ["u_500", "v_500", "t_500", "gh_500", "u_850", "v_850", "t_850", "gh_850"]
    w = RunWriter("gfs", "2026-02-02T00", [0, 6], variables, root=STORE_DIR)
    for s in (0, 6):
        w.write("u_500", s, _full(10.0)); w.write("v_500", s, _full(0.0))
        w.write("t_500", s, _full(253.15)); w.write("gh_500", s, _full(5500.0))
        w.write("u_850", s, _full(5.0)); w.write("v_850", s, _full(0.0))
        w.write("t_850", s, _full(278.15)); w.write("gh_850", s, _full(1400.0))
    w.finish()


def test_geopotential_height_is_a_level_aware_layer():
    _seed_heights()
    c = TestClient(api.app)
    # with no level asked for, height is the 500 hPa chart
    assert api._vars_for("gh", None) == ("gh_500",)
    assert api._vars_for("gh", 850) == ("gh_850",)
    m = c.get("/api/models").json()
    gfs = next(x for x in m["models"] if x["key"] == "gfs")
    assert "gh" in gfs["runs"][0]["layers"]
    gh = next(l for l in m["layers"] if l["layer"] == "gh")
    assert gh["units"] == "m" and (gh["lo"], gh["hi"]) == (4900, 6000)
    assert (gh["levels"]["850"]["lo"], gh["levels"]["850"]["hi"]) == (1150, 1650)
    assert c.get("/api/layer/gfs/2026-02-02T00/6/gh.png").status_code == 200
    assert c.get("/api/layer/gfs/2026-02-02T00/6/gh.png?level=850").status_code == 200
    # 300 hPa is a real level, just not one this run stored
    assert c.get("/api/layer/gfs/2026-02-02T00/6/gh.png?level=300").status_code == 404


def test_alert_detail_route_404s_when_nothing_answers_for_that_id(monkeypatch):
    from wxgrid import ext
    monkeypatch.setattr(ext, "alert_detail", lambda aid, source="": None if aid == "gone" else {"id": aid, "description": "x"})
    c = TestClient(api.app)
    assert c.get("/api/alerts/detail", params={"id": "gone"}).status_code == 404
    r = c.get("/api/alerts/detail", params={"id": "here", "source": "NWS"})
    assert r.status_code == 200 and r.json()["description"] == "x"


def test_alerts_ec_route_hands_back_what_geomet_painted(monkeypatch):
    from wxgrid import ext
    monkeypatch.setattr(ext, "ec_alerts_point", lambda lat, lon: [{"event": "Snowfall warning", "sev": 3}])
    c = TestClient(api.app)
    r = c.get("/api/alerts/ec", params={"lat": 49.3, "lon": -123.1})
    assert r.status_code == 200 and r.json()["alerts"][0]["event"] == "Snowfall warning"
