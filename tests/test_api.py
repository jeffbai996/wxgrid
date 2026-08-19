import numpy as np
from fastapi.testclient import TestClient

from wxgrid import api
from wxgrid.config import GRID_LAT_N, GRID_LON_N, STORE_DIR
from wxgrid.store import RunWriter


def _full(val):
    return np.full((GRID_LAT_N, GRID_LON_N), val, np.float32)


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
    assert aifs["runs"][0]["layers"] == ["wind", "temp", "tp6", "tp24", "tp72", "frz"]
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
    assert iso["unit"] == "°C" and "features" in iso              # a flat field has no lines; shape only
    frz_iso = c.get("/api/isolines/aifs/latest/6/frz.json")
    assert frz_iso.status_code == 200
