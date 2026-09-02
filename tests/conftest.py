import os
import socket
import tempfile

import pytest

# Point the whole package at a scratch data dir BEFORE anything imports config.
_TMP = tempfile.mkdtemp(prefix="wxgrid-test-")
os.environ["WXGRID_DATA_DIR"] = _TMP

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
