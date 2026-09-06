"""Cooperative upstream budgets, including time spent waiting for a cache fill.

The HTTP boundary separately enforces wall time: socket timeouts alone cannot
bound DNS or a peer that keeps dribbling bytes. No worker or timer lives here.
"""
from contextlib import contextmanager
from contextvars import ContextVar
import time

_expires = ContextVar("upstream_deadline", default=None)


def expires() -> float | None:
    return _expires.get()


def remaining(limit: float = 30) -> float:
    end = expires()
    left = limit if end is None else min(limit, end - time.monotonic())
    if left <= 0:
        raise TimeoutError("upstream deadline exceeded")
    return left


def request_timeout(limit: float) -> float:
    # requests applies this separately to connect and read.
    return limit if expires() is None else remaining(limit * 2) / 2


@contextmanager
def budget(seconds: float, *, until: float | None = None):
    end = min(time.monotonic() + seconds, until or float("inf"), expires() or float("inf"))
    token = _expires.set(end)
    try:
        yield
    finally:
        _expires.reset(token)
