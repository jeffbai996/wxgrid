"""ext._Cache: concurrent misses on one key make one upstream call."""
import threading
import time

from wxgrid.ext import _Cache


def test_concurrent_misses_share_one_fetch():
    c = _Cache()
    calls = []
    gate = threading.Event()
    def fetch():
        calls.append(1)
        gate.wait(2)
        return "answer"
    out = []
    threads = [threading.Thread(target=lambda: out.append(c.get("k", 60, fetch))) for _ in range(12)]
    for t in threads: t.start()
    time.sleep(0.1)
    gate.set()
    for t in threads: t.join(5)
    assert calls == [1]
    assert out == ["answer"] * 12


def test_a_failing_fetch_releases_the_waiters_who_then_fetch_themselves():
    c = _Cache()
    n = {"calls": 0}
    def fetch():
        n["calls"] += 1
        if n["calls"] == 1:
            time.sleep(0.05)
            raise RuntimeError("upstream down")
        return "second try"
    results, errors = [], []
    def first():
        try: c.get("k", 60, fetch)
        except RuntimeError as e: errors.append(str(e))
    def second():
        time.sleep(0.01)
        results.append(c.get("k", 60, fetch))
    a, b = threading.Thread(target=first), threading.Thread(target=second)
    a.start(); b.start(); a.join(5); b.join(5)
    assert errors == ["upstream down"] and results == ["second try"]
    assert c._inflight == {}


def test_different_keys_do_not_wait_on_each_other():
    c = _Cache()
    slow = threading.Event()
    def slow_fetch():
        slow.wait(2); return "slow"
    t = threading.Thread(target=lambda: c.get("a", 60, slow_fetch)); t.start()
    time.sleep(0.05)
    t0 = time.time()
    assert c.get("b", 60, lambda: "fast") == "fast"
    assert time.time() - t0 < 0.5
    slow.set(); t.join(5)


def test_hits_still_bypass_everything():
    c = _Cache()
    assert c.get("k", 60, lambda: 1) == 1
    assert c.get("k", 60, lambda: 2) == 1
