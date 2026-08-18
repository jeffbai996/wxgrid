"""Runtime configuration. Env-overridable; nothing here is secret."""
from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("WXGRID_DATA_DIR", BASE_DIR / "data"))
STORE_DIR = DATA_DIR / "store"          # Zarr, one group per model run
GRIB_DIR = DATA_DIR / "grib"            # transient downloads, wiped after ingest
CACHE_DIR = DATA_DIR / "cache"          # rendered PNG/JSON, keyed by (model, run, step, var)
FRONT_DIR = BASE_DIR / "front"

HOST = os.environ.get("WXGRID_HOST", "127.0.0.1")   # loopback; tailscale serve fronts it
PORT = int(os.environ.get("WXGRID_PORT", "8097"))

# Public deployment: refuses to serve front/private/ (fonts and theme bits that
# are licensed for our own use only) and says so in /healthz.
PUBLIC = os.environ.get("WXGRID_PUBLIC", "") == "1"

# Runs kept per model. Two lets the front compare "this run vs the previous".
KEEP_RUNS = int(os.environ.get("WXGRID_KEEP_RUNS", "2"))

# The common grid every model is normalised onto: 0.25°, lat 90 → -90 (721
# rows), lon -180 → 179.75 (1440 cols). ECMWF ships exactly this; GFS ships
# 0 → 359.75 and is rolled.
GRID_LAT_N = 721
GRID_LON_N = 1440
GRID_RES = 0.25
