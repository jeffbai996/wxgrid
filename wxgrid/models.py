"""Model registry: what we fetch, from where, and how it maps onto the store.

Canonical variables (every model normalises onto these):
  u10, v10  10 m wind components, m/s
  t2m       2 m temperature, K
  msl       mean sea-level pressure, Pa
  tp6       precipitation over the PREVIOUS 6 h, mm   (derived, see ingest)
  gust      10 m wind gust, m/s                       (only models that ship it)
"""
from __future__ import annotations

from dataclasses import dataclass, field

STEPS_6H = list(range(0, 241, 6))


@dataclass(frozen=True)
class Model:
    key: str                 # store key + API name
    label: str               # UI label
    source: str              # "ecmwf" | "nomads"
    steps: list[int] = field(default_factory=lambda: STEPS_6H)
    # ecmwf: opendata client model id; nomads: unused
    ecmwf_model: str = ""
    # source-native param names → canonical names
    params: dict[str, str] = field(default_factory=dict)
    # accumulated-precip semantics: "since_start" (ECMWF tp) or "bucket6" (GFS APCP at 6 h steps)
    precip_mode: str = "since_start"
    cycles: tuple[int, ...] = (0, 6, 12, 18)
    attribution: str = ""


MODELS: dict[str, Model] = {
    "ifs": Model(
        key="ifs", label="ECMWF IFS", source="ecmwf", ecmwf_model="ifs",
        params={"10u": "u10", "10v": "v10", "2t": "t2m", "msl": "msl", "tp": "tp",
                "10fg": "gust"},
        precip_mode="since_start",
        attribution="ECMWF open data, CC BY 4.0",
    ),
    "aifs": Model(
        key="aifs", label="ECMWF AIFS (AI)", source="ecmwf", ecmwf_model="aifs-single",
        params={"10u": "u10", "10v": "v10", "2t": "t2m", "msl": "msl", "tp": "tp"},
        precip_mode="since_start",
        attribution="ECMWF open data (AIFS), CC BY 4.0",
    ),
    "gfs": Model(
        key="gfs", label="NOAA GFS", source="nomads",
        params={"10u": "u10", "10v": "v10", "2t": "t2m", "prmsl": "msl", "tp": "tp",
                "gust": "gust"},
        precip_mode="bucket6",
        attribution="NOAA NCEP GFS via NOMADS, public domain",
    ),
}

# Canonical variables the store may hold, in display order.
STORE_VARS = ("u10", "v10", "t2m", "msl", "tp6", "gust")


def get_model(key: str) -> Model:
    try:
        return MODELS[key]
    except KeyError:
        raise KeyError(f"unknown model {key!r}; known: {sorted(MODELS)}") from None
