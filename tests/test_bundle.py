"""The bundle is the load order, concatenated. What matters: the order comes
from index.html, the ETag tracks content, and a 304 answers a matching one."""
from pathlib import Path

from wxgrid import bundle

FRONT = Path(__file__).resolve().parents[1] / "front"


def test_eager_scripts_come_from_the_page_in_order():
    scripts = bundle.eager_scripts((FRONT / "index.html").read_text())
    assert scripts[0] == "particles.js" and scripts[1] == "app.js"
    assert "panes.js" in scripts and "vendor/maplibre-gl.js" not in scripts
    assert not any(s.startswith("private/") for s in scripts)


def test_build_concatenates_in_order_and_hashes_content(tmp_path):
    (tmp_path / "index.html").write_text(
        '<script type="application/json" data-bundled>a.js b.js</script>')
    (tmp_path / "a.js").write_text("(function(){window.A=1})()")
    (tmp_path / "b.js").write_text("(function(){window.B=window.A+1})()")
    body, etag = bundle.build(tmp_path)
    assert body.index(b"window.A=1") < body.index(b"window.B")
    body2, etag2 = bundle.build(tmp_path)
    assert (body2, etag2) == (body, etag)
    (tmp_path / "b.js").write_text("(function(){window.B=3})()")
    assert bundle.build(tmp_path)[1] != etag


def test_bundler_rebuilds_when_a_source_changes(tmp_path):
    (tmp_path / "index.html").write_text(
        '<script type="application/json" data-bundled>a.js</script>')
    (tmp_path / "a.js").write_text("1")
    b = bundle.Bundler(tmp_path)
    _, etag = b.get()
    import os
    (tmp_path / "a.js").write_text("2")
    os.utime(tmp_path / "a.js", ns=((10 ** 9) * 2, (10 ** 9) * 2))
    assert b.get()[1] != etag


def test_route_serves_and_revalidates():
    from fastapi.testclient import TestClient
    from wxgrid.api import app
    with TestClient(app) as c:
        r = c.get("/bundle.js")
        assert r.status_code == 200 and "javascript" in r.headers["content-type"]
        assert r.headers["cache-control"] == "no-cache"
        etag = r.headers["etag"]
        assert c.get("/bundle.js", headers={"If-None-Match": etag}).status_code == 304
