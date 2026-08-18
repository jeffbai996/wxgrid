import os
import tempfile

# Point the whole package at a scratch data dir BEFORE anything imports config.
_TMP = tempfile.mkdtemp(prefix="wxgrid-test-")
os.environ["WXGRID_DATA_DIR"] = _TMP
