"""Cache persistence, expiry, resource bounds and degraded-storage behavior."""
import sqlite3

from wxgrid import ttl_cache
from wxgrid.ttl_cache import _Cache


def test_restart_reads_one_key_lazily_and_honors_shorter_ttl(tmp_path, monkeypatch):
    clock = [1000.0]
    monkeypatch.setattr(ttl_cache.time, "time", lambda: clock[0])
    path = tmp_path / "ext.sqlite3"
    c = _Cache(path)
    assert not path.exists()
    assert c.get("a", 60, lambda: {"v": [1, 2]}) == {"v": [1, 2]}
    c.close()
    c = _Cache(path)
    assert c._db is None and not c._d
    assert c.get("a", 60, lambda: None) == {"v": [1, 2]}
    clock[0] += 20
    assert c.get("a", 10, lambda: "fresh") == "fresh"
    c.close()


def test_expired_disk_entries_never_return_and_are_pruned(tmp_path, monkeypatch):
    clock = [1000.0]
    monkeypatch.setattr(ttl_cache.time, "time", lambda: clock[0])
    c = _Cache(tmp_path / "c.sqlite3")
    c.get("a", 10, lambda: 1)
    clock[0] += 61
    c.get("b", 60, lambda: 2)
    assert c._db.execute("SELECT key FROM entries").fetchall() == [("b",)]
    assert c.get("a", 10, lambda: 3) == 3
    c.close()


def test_hot_set_is_byte_and_count_bounded_and_disk_serves_evicted_values(tmp_path):
    c = _Cache(tmp_path / "c.sqlite3", max_entries=3, max_bytes=100)
    for i in range(40):
        c.get(str(i), 60, lambda: "x" * 35)
    assert len(c._d) <= 3
    assert sum(len(k) + len(v[2]) for k, v in c._d.items()) <= 100
    assert c.get("0", 60, lambda: "wrong") == "x" * 35
    c.close()


def test_large_values_live_only_on_disk_and_caller_mutation_is_not_retained(tmp_path):
    c = _Cache(tmp_path / "c.sqlite3")
    value = {"data": "x" * (300 * 1024)}
    c.get("large", 60, lambda: value)
    assert not c._d
    assert c.get("large", 60, lambda: None) == value
    c.get("small", 60, lambda: [1]).append(2)
    assert c.get("small", 60, lambda: None) == [1]
    assert c._db.execute("PRAGMA cache_size").fetchone() == (-1024,)
    assert c._db.execute("PRAGMA mmap_size").fetchone() == (0,)
    c.close()


def test_two_instances_share_committed_values_and_clear_is_persistent(tmp_path):
    path = tmp_path / "c.sqlite3"
    a, b = _Cache(path), _Cache(path)
    assert a.get("x", 60, lambda: None) is None
    assert b.get("x", 60, lambda: "wrong") is None
    b.clear()
    a.close(); b.close()
    c = _Cache(path)
    assert c.get("x", 60, lambda: "new") == "new"
    c.close()


def test_unwritable_or_corrupt_database_keeps_a_bounded_memory_cache(tmp_path):
    bad = tmp_path / "not-a-directory"
    bad.write_text("x")
    for path in (bad / "c.sqlite3", bad):
        c = _Cache(path, max_entries=1)
        assert c.get("a", 60, lambda: 1) == 1
        assert c.get("a", 60, lambda: 2) == 1
        c.get("b", 60, lambda: 3)
        assert len(c._d) == 1 and not c._inflight
        c.close()


def test_busy_database_does_not_fail_the_upstream_response(tmp_path):
    path = tmp_path / "c.sqlite3"
    c = _Cache(path)
    c.get("a", 60, lambda: 1)
    other = sqlite3.connect(path)
    other.execute("BEGIN IMMEDIATE")
    try:
        assert c.get("b", 60, lambda: 2) == 2
        assert c.get("b", 60, lambda: 3) == 2
        assert not c._inflight
    finally:
        other.rollback(); other.close(); c.close()
