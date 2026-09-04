"""Run frontend calculation and scheduling contracts without browser packages."""
import shutil
import subprocess
from pathlib import Path

import pytest


def test_frontend_runtime_contracts():
    node = shutil.which("node")
    if not node:
        pytest.skip("Node is required for frontend runtime tests")
    root = Path(__file__).resolve().parents[1]
    tests = sorted(str(p) for p in (root / "tests" / "frontend").glob("*.test.cjs"))
    result = subprocess.run([node, "--test", *tests], cwd=root, capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr
