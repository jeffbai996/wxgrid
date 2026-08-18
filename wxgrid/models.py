"""Model registry: what we fetch, from where, and how it maps onto the store.

Canonical SURFACE variables (every model normalises onto these):
  u10, v10  10 m wind components, m/s
  t2m       2 m temperature, K
  msl       mean sea-level pressure, Pa
  tp6       precipitation over the PREVIOUS 6 h, mm   (derived, see ingest)
  gust      10 m wind gust, m/s                       (only models that ship it)
  tcc       total cloud cover, 0–1 (GFS ships %, converted)
  cape      CAPE, J/kg                                (only models that ship it)
  d2m       2 m dew point, K
  sf6       snowfall over the PREVIOUS 6 h, mm water-equivalent (derived)
  sd_cm     snow depth, cm (ECMWF ships m w.e. → ×400 assumes 250 kg/m³; GFS ships depth)

Canonical PRESSURE-LEVEL variables, one per level in LEVELS (hPa):
  u_<lvl>, v_<lvl>  wind, m/s      t_<lvl>  temperature, K     gh_<lvl>  geopotential height, m
"""
from __future__ import annotations

from dataclasses import dataclass, field

STEPS_6H = list(range(0, 241, 6))
STEPS_IFS = list(range(0, 145, 3)) + list(range(150, 241, 6))   # IFS open data: 3-hourly to 144 h, then 6-hourly
STEPS_3H = list(range(0, 241, 3))                                # GFS: 3-hourly all the way
LEVEL_EVERY = 6                                                  # pressure levels are fetched on 6 h steps only
LEVELS = (925, 850, 700, 500, 300, 250)          # ≈ 2.5k ft, 5k ft, 10k ft, FL180, FL300, FL340

# GRIB typeOfLevel values that mean "a surface-ish single layer" for our purposes.
SURFACE_LEVEL_TYPES = {"surface", "heightAboveGround", "meanSea", "atmosphere",
                       "entireAtmosphere", "atmosphereSingleLayer", "unknown"}


@dataclass(frozen=True)
class Model:
    key: str                 # store key + API name
    label: str               # UI label
    short: str               # tiny label for segmented controls
    source: str              # "ecmwf" | "nomads"
    steps: list[int] = field(default_factory=lambda: STEPS_6H)
    ecmwf_model: str = ""    # opendata client model id
    # source-native surface shortName → canonical name
    sfc_params: dict[str, str] = field(default_factory=dict)
    # source-native pressure-level shortName → canonical prefix
    pl_params: dict[str, str] = field(default_factory=dict)
    levels: tuple[int, ...] = LEVELS
    # accumulated-precip semantics: "since_start" (ECMWF tp) or "bucket6" (GFS APCP at 6 h steps)
    precip_mode: str = "since_start"
    attribution: str = ""

    def canonical(self, short_name: str, level_type: str, level: int) -> str | None:
        """Map a decoded GRIB field to its store variable, or None to skip."""
        if level_type == "isobaricInhPa":
            prefix = self.pl_params.get(short_name)
            if prefix and level in self.levels:
                return f"{prefix}_{level}"
            return None
        if level_type in SURFACE_LEVEL_TYPES:
            return self.sfc_params.get(short_name)
        return None

    def store_variables(self) -> list[str]:
        out = []
        for canon in self.sfc_params.values():
            if canon == "csnow":
                continue                        # only used to derive sf6
            out.append({"tp": "tp6", "sf": "sf6", "sd": "sd_cm"}.get(canon, canon))
        if "csnow" in self.sfc_params.values() and "tp" in self.sfc_params.values():
            out.append("sf6")
        for prefix in self.pl_params.values():
            out.extend(f"{prefix}_{lvl}" for lvl in self.levels)
        return out


_ECMWF_PL = {"u": "u", "v": "v", "t": "t", "gh": "gh"}

MODELS: dict[str, Model] = {
    "ifs": Model(
        key="ifs", label="ECMWF IFS", short="IFS", source="ecmwf", ecmwf_model="ifs", steps=STEPS_IFS,
        sfc_params={"10u": "u10", "10v": "v10", "2t": "t2m", "msl": "msl", "tp": "tp",
                    "10fg": "gust", "tcc": "tcc", "mucape": "cape", "2d": "d2m", "sf": "sf", "sd": "sd"},
        pl_params=_ECMWF_PL,
        precip_mode="since_start",
        attribution="ECMWF open data, CC BY 4.0",
    ),
    "aifs": Model(
        key="aifs", label="ECMWF AIFS (AI)", short="AIFS", source="ecmwf", ecmwf_model="aifs-single",
        sfc_params={"10u": "u10", "10v": "v10", "2t": "t2m", "msl": "msl", "tp": "tp", "tcc": "tcc",
                    "2d": "d2m", "sf": "sf"},
        pl_params=_ECMWF_PL,
        precip_mode="since_start",
        attribution="ECMWF open data (AIFS), CC BY 4.0",
    ),
    "gfs": Model(
        key="gfs", label="NOAA GFS", short="GFS", source="nomads", steps=STEPS_3H,
        sfc_params={"10u": "u10", "10v": "v10", "2t": "t2m", "prmsl": "msl", "tp": "tp",
                    "gust": "gust", "tcc": "tcc", "cape": "cape", "2d": "d2m", "sde": "sd", "csnow": "csnow"},
        pl_params=_ECMWF_PL,
        precip_mode="bucket6",
        attribution="NOAA NCEP GFS via NOMADS, public domain",
    ),
}

# Variables stored as float16 (range-safe, halves the store): winds/temps/heights aloft.
HALF_PRECISION_PREFIXES = ("u_", "v_", "gh_")   # temps stay float32: 0.25 K steps would bend the freezing level


def get_model(key: str) -> Model:
    try:
        return MODELS[key]
    except KeyError:
        raise KeyError(f"unknown model {key!r}; known: {sorted(MODELS)}") from None
