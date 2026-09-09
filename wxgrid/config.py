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
# A GRIB is written once, decoded once and deleted. On this host that round
# trip was ~36 GB a day onto the store disk for nothing: measured 2026-09-09,
# unlinking each file as its step decoded saved not one byte, because ext4
# mounts data=ordered and its five-second journal commit forces the pages out
# well before the unlink. The only way not to write them is not to put them on
# a disk. One step's files at a time (~100 MB at the worst source) so RAM holds
# it easily. ECMWF is excluded: it alone resumes from validated downloads after
# a deferral, and those have to outlive the process.
GRIB_RAM_DIR = Path(os.environ.get("WXGRID_GRIB_RAM_DIR", "/dev/shm/wxgrid-grib"))
# Below this much free space the RAM disk is refused and downloads go to
# GRIB_DIR. Filling /dev/shm would push the box into swap, which is a worse
# problem than the writes.
GRIB_RAM_MIN_FREE = int(os.environ.get("WXGRID_GRIB_RAM_MIN_FREE", 2 * 1024 ** 3))
# Rendered PNG/JSON, keyed by (model, run, step, var). Separately overridable
# so a second instance can read a live store without writing into its cache.
CACHE_DIR = Path(os.environ.get("WXGRID_CACHE_DIR", DATA_DIR / "cache"))
FRONT_DIR = BASE_DIR / "front"

HOST = os.environ.get("WXGRID_HOST", "127.0.0.1")   # loopback; tailscale serve fronts it
PORT = int(os.environ.get("WXGRID_PORT", "8097"))

# Public deployment: refuses to serve front/private/ (fonts and theme bits that
# are licensed for our own use only) and says so in /healthz.
PUBLIC = os.environ.get("WXGRID_PUBLIC", "") == "1"

# Runs kept per model. Two lets the front compare "this run vs the previous".
# Four runs = a day of history for the run picker (each model updates 2-4x
# daily). ~5 GB per extra run across six models against a 2/3-free disk;
# the picker with only "latest and one before" read as decoration
# (Jeff 2026-08-20). Override per deployment with WXGRID_KEEP_RUNS.
KEEP_RUNS = int(os.environ.get("WXGRID_KEEP_RUNS", "4"))

# The common grid every model is normalised onto: 0.25°, lat 90 → -90 (721
# rows), lon -180 → 179.75 (1440 cols). ECMWF ships exactly this; GFS ships
# 0 → 359.75 and is rolled.
GRID_LAT_N = 721
GRID_LON_N = 1440
GRID_RES = 0.25
