import atexit
import os
import shutil
import socket
import tempfile

import pytest

# Test scratch (the package's data dir AND pytest's tmp_path) goes on the
# storage disk when the box has one: a full run writes several GB of scratch
# stores, and on the operator box /tmp sits on a QLC system disk with a 200 TBW
# rating (Jeff 2026-09-06). Anywhere else, the default temp dir as before.
SCRATCH = os.environ.get("WXGRID_TEST_SCRATCH") or next(
    (d for d in ("/mnt/wsl-storage/scratch",) if os.path.isdir(d) and os.access(d, os.W_OK)), None)
if SCRATCH:
    tempfile.tempdir = SCRATCH

# Point the whole package at a scratch data dir BEFORE anything imports config.
_TMP = tempfile.mkdtemp(prefix="wxgrid-test-")
os.environ["WXGRID_DATA_DIR"] = _TMP
atexit.register(shutil.rmtree, _TMP, ignore_errors=True)   # the storage disk is not wiped at boot


def pytest_load_initial_conftests(early_config, parser, args):
    if SCRATCH and not early_config.option.basetemp:
        early_config.option.basetemp = os.path.join(SCRATCH, "pytest-wxgrid")

_real_connect = socket.socket.connect


@pytest.fixture(autouse=True)
def _block_network(request, monkeypatch):
    """Block outbound sockets by default; opt in with @pytest.mark.network."""
    if request.node.get_closest_marker("network"):
        yield
        return

    def _blocked_connect(self, *args, **kwargs):
        raise RuntimeError(
            "network disabled in tests; mark @pytest.mark.network"
        )

    monkeypatch.setattr(socket.socket, "connect", _blocked_connect)
    yield
