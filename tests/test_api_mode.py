"""The three mode routes. Thin handlers: the logic lives in mode/ingest_control."""
import pytest
from fastapi.testclient import TestClient

from wxgrid import api, ingest_control as ic, mode as m


@pytest.fixture(autouse=True)
def _state_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("WXGRID_STATE_DIR", str(tmp_path / "state"))
    yield


@pytest.fixture
def client(monkeypatch):
    calls: list[list[str]] = []

    def fake(argv):
        calls.append(list(argv))
        return (3, "inactive") if argv and argv[0] == "is-active" else (0, "")

    monkeypatch.setattr(api, "_systemctl", fake)
    c = TestClient(api.app)
    c.calls = calls
    return c


def test_get_mode_defaults_to_simple_and_names_its_models(client):
    body = client.get("/api/mode").json()
    assert body["mode"] == "simple"
    # pass order (regional first), not the constant's order
    assert sorted(body["models"]) == sorted(m.SIMPLE_MODELS)
    assert "last_run" in body


def test_get_mode_in_detailed_names_every_configured_model(client):
    m.write_mode("detailed")
    body = client.get("/api/mode").json()
    assert body["mode"] == "detailed"
    assert set(body["models"]) >= set(m.SIMPLE_MODELS)
    assert len(body["models"]) > len(m.SIMPLE_MODELS)


def test_post_mode_persists_and_is_visible_to_the_next_get(client):
    assert client.post("/api/mode", json={"mode": "paused"}).json()["mode"] == "paused"
    assert client.get("/api/mode").json()["mode"] == "paused"
    assert m.read_mode() == "paused"


def test_post_mode_rejects_a_mode_that_does_not_exist(client):
    assert client.post("/api/mode", json={"mode": "turbo"}).status_code == 400
    assert m.read_mode() == "simple"


def test_post_mode_rejects_a_body_without_a_mode(client):
    assert client.post("/api/mode", json={}).status_code in (400, 422)


def test_refresh_starts_the_units_of_the_current_mode(client):
    m.write_mode("simple")
    body = client.post("/api/ingest/refresh").json()
    assert body["started"] is True
    assert client.calls[0][0] == "start" and "--no-block" in client.calls[0]
    assert ic.ENSEMBLE_UNIT not in client.calls[0]


def test_refresh_does_nothing_while_paused(client):
    m.write_mode("paused")
    assert client.post("/api/ingest/refresh").json()["started"] is False
    assert client.calls == []


def test_status_gives_a_state_per_unit(client):
    body = client.get("/api/ingest/status").json()
    assert set(body["units"]) == set(ic.ALL_UNITS)
    assert body["running"] is False
    assert "last_written" in body
