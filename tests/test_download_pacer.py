"""Downloads are paced like writes: a token bucket per process, so a cycle's
~25 GB of GRIB arrives at a bounded rate instead of at line speed."""
import os
import time
from pathlib import Path

import pytest

from wxgrid import fetch, store


class _Resp:
    status_code = 200
    def __init__(self, chunks): self._chunks = chunks
    def raise_for_status(self): pass
    def iter_content(self, n): yield from self._chunks
    def __enter__(self): return self
    def __exit__(self, *a): pass


class _Session:
    def __init__(self, chunks): self.chunks = chunks
    def get(self, url, timeout=None, stream=False): return _Resp(self.chunks)


def test_pacer_reads_its_rate_from_the_named_env(monkeypatch):
    monkeypatch.setenv("WXGRID_DOWNLOAD_MBPS", "7")
    monkeypatch.setenv("WXGRID_WRITE_MBPS", "60")
    assert store._Pacer(env="WXGRID_DOWNLOAD_MBPS").rate == 7e6
    assert store._Pacer().rate == 60e6


def test_download_spends_every_chunk_on_the_pacer(tmp_path, monkeypatch):
    spent = []
    monkeypatch.setattr(fetch, "_dl_pacer", type("P", (), {"spend": lambda self, n: spent.append(n)})())
    chunks = [b"x" * 4000, b"y" * 3000]
    assert fetch._download(_Session(chunks), "http://example.invalid/f.grib2", tmp_path / "f.grib2")
    assert spent == [4000, 3000]
    assert (tmp_path / "f.grib2").stat().st_size == 7000


def test_download_pacer_slows_a_fast_source(tmp_path, monkeypatch):
    monkeypatch.setenv("WXGRID_DOWNLOAD_MBPS", "2")      # 2 MB/s
    monkeypatch.setattr(fetch, "_dl_pacer", store._Pacer(env="WXGRID_DOWNLOAD_MBPS"))
    chunks = [b"x" * 1_000_000] * 4                       # 4 MB, 2 s of budget past the 1 s credit
    t = time.monotonic()
    fetch._download(_Session(chunks), "http://example.invalid/f.grib2", tmp_path / "f.grib2")
    assert time.monotonic() - t >= 0.9


def test_ecmwf_get_charges_the_file_after_retrieve(tmp_path, monkeypatch):
    spent = []
    monkeypatch.setattr(fetch, "_dl_pacer", type("P", (), {"spend": lambda self, n: spent.append(n)})())
    class Client:
        def retrieve(self, **kw): Path(kw["target"]).write_bytes(b"z" * 5000)
    from wxgrid.models import get_model
    from datetime import datetime
    ok = fetch._ecmwf_get(Client(), get_model("aifs"), datetime(2026, 1, 1), 0, tmp_path / "s.grib2", {"param": ["2t"]})
    assert ok and spent == [5000]
