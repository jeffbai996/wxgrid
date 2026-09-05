"""Expiry-aware disk cache with a small, byte-bounded hot set.

Only serialized JSON is retained: a small JSON document can expand into many
times its size as Python objects. SQLite reads one key at a time and reuses
freed pages; no full-cache load, rewrite, or background worker is needed.
"""
from __future__ import annotations

import json
import logging
import sqlite3
import threading
import time
from collections import OrderedDict
from pathlib import Path
from typing import Any, Callable

log = logging.getLogger("wxgrid.ext")
_MISSING = object()


class _Cache:
    def __init__(self, path: Path | None = None, *, max_entries: int = 256,
                 max_bytes: int = 2 * 1024 * 1024) -> None:
        self._d: OrderedDict[str, tuple[float, float, str]] = OrderedDict()
        self._max_entries = max_entries
        self._max_bytes = max_bytes
        self._lock = threading.Lock()
        self._inflight: dict[str, threading.Event] = {}
        self._path = path
        self._db: sqlite3.Connection | None = None
        self._retry_at = 0.0
        self._last_prune = 0.0

    def _connection(self) -> sqlite3.Connection | None:
        # All database operations run under _lock. Open lazily so importing
        # proxy helpers during an ingest does not open a database at all.
        if self._db is None and self._path and time.monotonic() >= self._retry_at:
            db = None
            try:
                self._path.parent.mkdir(parents=True, exist_ok=True)
                db = sqlite3.connect(self._path, timeout=0.25, check_same_thread=False)
                db.execute("PRAGMA cache_size=-1024")
                db.execute("PRAGMA mmap_size=0")
                db.execute("PRAGMA auto_vacuum=INCREMENTAL")
                db.execute("PRAGMA journal_mode=WAL")
                db.execute("PRAGMA synchronous=NORMAL")
                db.execute("PRAGMA journal_size_limit=1048576")
                db.execute("PRAGMA wal_autocheckpoint=256")
                db.execute("CREATE TABLE IF NOT EXISTS entries ("
                           "key TEXT PRIMARY KEY, created REAL NOT NULL, "
                           "expires REAL NOT NULL, payload TEXT NOT NULL)")
                db.execute("CREATE INDEX IF NOT EXISTS entries_expiry ON entries(expires)")
                db.commit()
                self._db = db
            except (OSError, sqlite3.Error) as exc:
                if db is not None:
                    db.close()
                self._retry_at = time.monotonic() + 60
                log.debug("ext cache open failed: %s", exc)
        return self._db

    def _remember(self, key: str, record: tuple[float, float, str]) -> None:
        self._d.pop(key, None)
        # Keep megabyte-sized station/geometry lists on disk. Counting ASCII
        # JSON bytes bounds resident strings without traversing decoded data.
        size = len(key.encode("utf-8")) + len(record[2])
        if self._max_entries <= 0 or size > min(self._max_bytes, 256 * 1024):
            return
        self._d[key] = record
        total = sum(len(k.encode("utf-8")) + len(v[2]) for k, v in self._d.items())
        while len(self._d) > self._max_entries or total > self._max_bytes:
            old_key, old = self._d.popitem(last=False)
            total -= len(old_key.encode("utf-8")) + len(old[2])

    def _lookup(self, key: str, ttl: float, now: float) -> Any:
        record = self._d.get(key)
        if record is not None:
            self._d.move_to_end(key)
        else:
            db = self._connection()
            if db is not None:
                try:
                    record = db.execute(
                        "SELECT created, expires, payload FROM entries "
                        "WHERE key=? AND expires>? AND created>?",
                        (key, now, now - ttl),
                    ).fetchone()
                except sqlite3.Error as exc:
                    log.debug("ext cache read failed: %s", exc)
        if record is not None:
            created, expires, payload = record
            if now < expires and now - created < ttl:
                try:
                    value = json.loads(payload)
                except (ValueError, TypeError):
                    pass
                else:
                    self._remember(key, record)
                    return value
            self._d.pop(key, None)
        return _MISSING

    def _store(self, key: str, ttl: float, now: float, value: Any) -> None:
        try:
            payload = json.dumps(value, separators=(",", ":"), ensure_ascii=True)
        except (ValueError, TypeError):
            return  # Non-JSON responses still reach the caller, uncached.
        record = (now, now + ttl, payload)
        self._remember(key, record)
        db = self._connection()
        if db is None:
            return
        try:
            with db:
                db.execute("INSERT OR REPLACE INTO entries VALUES (?, ?, ?, ?)", (key, *record))
                if now - self._last_prune >= 60:
                    db.execute("DELETE FROM entries WHERE key IN "
                               "(SELECT key FROM entries WHERE expires<=? ORDER BY expires LIMIT 256)", (now,))
                    # Bound even a burst of distinct long-lived keys. Extra
                    # rows expire normally; evicted keys can be fetched again.
                    db.execute("DELETE FROM entries WHERE key IN "
                               "(SELECT key FROM entries ORDER BY expires DESC LIMIT 256 OFFSET 20000)")
            if now - self._last_prune >= 60:
                db.execute("PRAGMA incremental_vacuum(128)")
                self._last_prune = now
        except sqlite3.Error as exc:
            log.debug("ext cache write failed: %s", exc)

    def get(self, key: str, ttl: float, fn: Callable[[], Any]) -> Any:
        while True:
            with self._lock:
                hit = self._lookup(key, ttl, time.time())
                if hit is not _MISSING:
                    return hit
                waiter = self._inflight.get(key)
                if waiter is None:
                    self._inflight[key] = threading.Event()
                    break
            waiter.wait(timeout=30)
        try:
            value = fn()
            with self._lock:
                # TTL starts when the upstream answers, not before its wait.
                self._store(key, ttl, time.time(), value)
            return value
        finally:
            with self._lock:
                self._inflight.pop(key).set()

    def clear(self) -> None:
        """Explicit invalidation, including persisted keys."""
        with self._lock:
            self._d.clear()
            db = self._connection()
            if db is not None:
                with db:
                    db.execute("DELETE FROM entries")

    def close(self) -> None:
        with self._lock:
            if self._db is not None:
                self._db.close()
                self._db = None
