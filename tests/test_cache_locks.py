"""Render locks: one renderer per cache key, bounded memory."""
from pathlib import Path

from wxgrid import api


def test_same_path_always_gets_the_same_lock():
    a = api._cache_lock(Path("/c/ifs/r/wind-3.png"))
    assert a is api._cache_lock(Path("/c/ifs/r/wind-3.png"))
    assert a is api._cache_lock("/c/ifs/r/wind-3.png")


def test_lock_table_does_not_grow_with_the_number_of_keys():
    before = len(api._cache_locks)
    for i in range(20000):
        api._cache_lock(Path(f"/c/gfs/run/{i}/temp.png"))
    assert len(api._cache_locks) == before == api._CACHE_STRIPES


def test_distinct_keys_spread_across_stripes():
    seen = {id(api._cache_lock(Path(f"/c/m/r/{i}.png"))) for i in range(2000)}
    assert len(seen) > api._CACHE_STRIPES * 0.9
