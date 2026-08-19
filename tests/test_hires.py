"""The point-only high-resolution models (HRRR)."""
import pytest
from fastapi.testclient import TestClient

from wxgrid import api, hires


class _Resp:
    def __init__(self, body):
        self._body = body

    def json(self):
        return self._body


def _body(hours, temps, **extra):
    return {"latitude": 47.6, "longitude": -122.3, "elevation": 93.0,
            "hourly": {"time": hours, "temperature_2m": temps,
                       "wind_speed_10m": [1.0] * len(hours),
                       "pressure_msl": [1017.7] * len(hours),
                       "cloud_cover": [50] * len(hours),
                       "snowfall": [2.0] * len(hours), **extra}}


def test_units_land_in_the_stores_own_terms(monkeypatch):
    hours = ["2026-08-19T00:00", "2026-08-19T01:00"]
    monkeypatch.setattr(hires.requests, "get", lambda *a, **k: _Resp(_body(hours, [26.85, 20.0])))
    hires.cache._d.clear()
    d = hires.point("hrrr", 47.6, -122.3)
    assert d["available"] and d["grid"] == "3km"
    assert d["series"]["t2m"] == [300.0, 293.15]        # °C → K
    assert d["series"]["msl"] == [101770.0, 101770.0]   # hPa → Pa
    assert d["series"]["tcc"] == [0.5, 0.5]             # % → fraction
    assert d["series"]["sf6"] == [0.2, 0.2]             # cm of snow → mm water
    assert d["valid"][0].endswith("+00:00")


def test_the_series_stops_where_the_model_does(monkeypatch):
    """Open-Meteo pads to whole days; HRRR runs 48 h. The tail comes back null
    and would otherwise render as a day and a half of empty columns."""
    hours = [f"2026-08-19T{h:02d}:00" for h in range(6)]
    monkeypatch.setattr(hires.requests, "get", lambda *a, **k: _Resp(_body(hours, [20.0, 21.0, 22.0, None, None, None])))
    hires.cache._d.clear()
    d = hires.point("hrrr", 47.6, -122.3)
    assert len(d["valid"]) == 3
    assert all(v is not None for v in d["series"]["t2m"])


def test_outside_the_domain_says_so_rather_than_guessing(monkeypatch):
    monkeypatch.setattr(hires.requests, "get", lambda *a, **k:
                        _Resp({"error": True, "reason": "No data is available for this location"}))
    hires.cache._d.clear()
    d = hires.point("hrrr", 51.5, -0.13)
    assert d["available"] is False and "No data" in d["reason"]


def test_the_route_lists_models_and_rejects_unknown_ones():
    c = TestClient(api.app)
    listed = c.get("/api/hires").json()["models"]
    assert [m["key"] for m in listed] == ["hrrr"]
    assert listed[0]["hours"] == 48
    assert c.get("/api/hires/nope", params={"lat": 47.6, "lon": -122.3}).status_code == 404
