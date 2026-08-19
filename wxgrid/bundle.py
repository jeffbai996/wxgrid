"""One script instead of eleven.

The front end is plain files on window.WX, loaded by a column of
`<script defer>` tags whose ORDER is the module system. The service worker
fetches the shell network-first, so every page load revalidated each file over
its own request. Concatenating the eager scripts into one body — in the order
index.html declares them — keeps the no-bundler workflow (the source files stay
the source) and turns eleven conditional requests into one.

The bundle is built from index.html, not from a list kept here: the page is
already the single place that knows the load order, and a second copy of that
order is the copy that goes stale. Anything in vendor/ (MapLibre) or private/
(the overlay, absent from the public tree) keeps its own tag.

Served with an ETag over the content, `Cache-Control: no-cache`: one request,
usually answered 304, and a deployed edit shows up on the next load — the
stale-JS class of bug ends here rather than in the service worker.
"""
from __future__ import annotations

import hashlib
import re
import threading
from pathlib import Path

_LIST = re.compile(r'<script type="application/json" data-bundled>([^<]+)</script>')


def eager_scripts(index_html: str) -> list[str]:
    """The bundle's file list, in load order, read from index.html's own
    data-bundled element — the page stays the single owner of the order."""
    m = _LIST.search(index_html)
    if not m:
        raise RuntimeError("index.html has no data-bundled script list")
    return m.group(1).split()


def build(front_dir: Path, scripts: list[str] | None = None) -> tuple[bytes, str]:
    """Concatenate the eager scripts; returns (body, etag). Each file is an
    IIFE, so plain concatenation with a separator is semantically the same as
    the tags it replaces."""
    if scripts is None:
        scripts = eager_scripts((front_dir / "index.html").read_text())
    parts = []
    for rel in scripts:
        p = front_dir / rel
        parts.append(f"// ── {rel} " + "─" * max(4, 60 - len(rel)) + "\n" + p.read_text())
    body = "\n;\n".join(parts).encode()
    return body, hashlib.sha1(body).hexdigest()[:16]


class Bundler:
    """Caches the built bundle; rebuilds when any source mtime moves, so an
    edit under a live server shows up without a restart."""

    def __init__(self, front_dir: Path) -> None:
        self.front = front_dir
        self._lock = threading.Lock()
        self._sig: tuple = ()
        self._body = b""
        self._etag = ""

    def get(self) -> tuple[bytes, str]:
        scripts = eager_scripts((self.front / "index.html").read_text())
        sig = tuple((s, (self.front / s).stat().st_mtime_ns) for s in scripts)
        with self._lock:
            if sig != self._sig:
                self._body, self._etag = build(self.front, scripts)
                self._sig = sig
            return self._body, self._etag
