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
  swh, mwd, mwp  significant wave height m, mean wave direction °(from), mean period s
            (ECMWF wave stream, IFS only, 6 h steps; NaN over land)

Canonical ENSEMBLE-SPREAD variables (`_sd`), same units as the field they
describe — the across-member standard deviation, i.e. how much the ensemble
disagrees with itself. Only ensemble models carry them (see `spread_params`):
  t2m_sd    2 m temperature spread, K
  wind_sd   10 m wind SPEED spread, m/s   (derived: the producer ships the
            spread of the u and v COMPONENTS, not of the speed — see
            wxgrid.ens.wind_speed_spread)
  msl_sd    mean sea-level pressure spread, Pa
  tp6_sd    precipitation spread, mm, over the accumulation window the
            producer published for that step. NOT differenced between steps:
            you cannot difference standard deviations, so this is the spread
            of the producer's own bucket (3 h at GEFS' odd steps, 6 h at the
            6-hourly ones) while `tp6` is the per-step increment.

Canonical PRESSURE-LEVEL variables, one per level in LEVELS (hPa):
  u_<lvl>, v_<lvl>  wind, m/s      t_<lvl>  temperature, K     gh_<lvl>  geopotential height, m
"""
from __future__ import annotations

from dataclasses import dataclass, field

STEPS_6H = list(range(0, 241, 6))
STEPS_IFS = list(range(0, 145, 3)) + list(range(150, 241, 6))   # IFS open data: 3-hourly to 144 h, then 6-hourly
STEPS_3H = list(range(0, 241, 3))                                # GFS: 3-hourly all the way
LEVEL_EVERY = 6                                                  # pressure levels are fetched on 6 h steps only
LEVELS = (1000, 925, 850, 700, 600, 500, 400, 300, 250, 200)
# ≈ surface, 2.5k ft, 5k ft, 10k ft, 14k ft, FL180, FL240, FL300, FL340, FL390.
# A model that does not publish one of these simply never writes it; the API's
# _levels_for() advertises only the levels a run actually contains, so runs
# ingested against an older LEVELS keep working.

# GRIB typeOfLevel values that mean "a surface-ish single layer" for our purposes.
SURFACE_LEVEL_TYPES = {"surface", "heightAboveGround", "meanSea", "atmosphere",
                       "entireAtmosphere", "atmosphereSingleLayer", "unknown"}


@dataclass(frozen=True)
class Model:
    key: str                 # store key + API name
    label: str               # UI label
    short: str               # tiny label for segmented controls
    source: str              # "ecmwf" | "nomads" | "nomads-gefs" | "datamart"
    steps: list[int] = field(default_factory=lambda: STEPS_6H)
    ecmwf_model: str = ""    # opendata client model id
    # source-native surface shortName → canonical name
    sfc_params: dict[str, str] = field(default_factory=dict)
    # source-native pressure-level shortName → canonical prefix
    pl_params: dict[str, str] = field(default_factory=dict)
    levels: tuple[int, ...] = LEVELS
    # accumulated-precip semantics: "since_start" (ECMWF tp) or "bucket6" (GFS APCP at 6 h steps)
    precip_mode: str = "since_start"
    # snow depth as shipped → cm. ECMWF sends m of water equivalent (×400 at
    # 250 kg/m³); GFS/GEFS/GEM send physical depth in m (×100).
    snow_depth_factor: float = 400.0
    attribution: str = ""
    # The model's own resolution, for the UI. Every model is stored on the
    # common 0.25° grid, so this describes the FORECAST, not our sampling of
    # it — the same number Windy and the agencies quote.
    grid: str = ""
    # ECMWF wave-stream shortName → canonical name (fetched on LEVEL_EVERY steps; IFS only)
    wave_params: dict[str, str] = field(default_factory=dict)
    # Ensemble-SPREAD stream: source-native shortName → canonical `_sd` name.
    # It needs a mapping of its own rather than sharing sfc_params, because the
    # spread file decodes to exactly the SAME shortNames as the mean — NOMADS'
    # gespr carries the identical parameter list to geavg and differs only in
    # the GRIB2 "derived forecast" octet, which eccodes does not put in the
    # shortName. Fed to the writer from a separately named GRIB (see
    # fetch.SPREAD_SUFFIX), so provenance comes from the file, not the message.
    spread_params: dict[str, str] = field(default_factory=dict)
    # One-file-per-variable sources (MSC datamart): shortName → filename token.
    # The keys are the shortName we FORCE on the decoded message, because a few
    # GEM parameters are outside the stock eccodes tables and decode as
    # "unknown"; the fetcher knows what it asked for, so it says so.
    file_params: dict[str, str] = field(default_factory=dict)
    file_pl_params: dict[str, str] = field(default_factory=dict)
    # shortName → units string to trust instead of the GRIB's own (GEM's cloud
    # cover is percent but declares no units).
    unit_override: dict[str, str] = field(default_factory=dict)

    def canonical(self, short_name: str, level_type: str, level: int) -> str | None:
        """Map a decoded GRIB field to its store variable, or None to skip."""
        if short_name in self.wave_params:
            return self.wave_params[short_name]
        if level_type == "isobaricInhPa":
            prefix = self.pl_params.get(short_name)
            if prefix and level in self.levels:
                return f"{prefix}_{level}"
            return None
        if level_type in SURFACE_LEVEL_TYPES:
            return self.sfc_params.get(short_name)
        return None

    def canonical_spread(self, short_name: str, level_type: str, level: int = 0) -> str | None:
        """Same job as `canonical`, for a message read out of the spread file."""
        if level_type in SURFACE_LEVEL_TYPES:
            return self.spread_params.get(short_name)
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
        out.extend(self.wave_params.values())
        spread = list(self.spread_params.values())
        # u10_sd/v10_sd are only inputs: what is stored is the wind SPEED spread.
        if "u10_sd" in spread and "v10_sd" in spread:
            out.append("wind_sd")
        out.extend(v for v in spread if v not in ("u10_sd", "v10_sd"))
        return out


_ECMWF_PL = {"u": "u", "v": "v", "t": "t", "gh": "gh"}

MODELS: dict[str, Model] = {
    "ifs": Model(
        key="ifs", label="ECMWF IFS", short="IFS", grid="9 km", source="ecmwf", ecmwf_model="ifs", steps=STEPS_IFS,
        sfc_params={"10u": "u10", "10v": "v10", "2t": "t2m", "msl": "msl", "tp": "tp",
                    "10fg": "gust", "tcc": "tcc", "mucape": "cape", "2d": "d2m", "sf": "sf", "sd": "sd"},
        pl_params=_ECMWF_PL,
        precip_mode="since_start",
        attribution="ECMWF open data, CC BY 4.0",
        wave_params={"swh": "swh", "mwd": "mwd", "mwp": "mwp"},
    ),
    "aifs": Model(
        key="aifs", label="ECMWF AIFS (AI)", short="AIFS", grid="28 km", source="ecmwf", ecmwf_model="aifs-single",
        sfc_params={"10u": "u10", "10v": "v10", "2t": "t2m", "msl": "msl", "tp": "tp", "tcc": "tcc",
                    "2d": "d2m", "sf": "sf"},
        pl_params=_ECMWF_PL,
        precip_mode="since_start",
        attribution="ECMWF open data (AIFS), CC BY 4.0",
    ),
    "gfs": Model(
        key="gfs", label="NOAA GFS", short="GFS", grid="13 km", source="nomads", steps=STEPS_3H,
        sfc_params={"10u": "u10", "10v": "v10", "2t": "t2m", "prmsl": "msl", "tp": "tp",
                    "gust": "gust", "tcc": "tcc", "cape": "cape", "2d": "d2m", "sde": "sd", "csnow": "csnow"},
        pl_params=_ECMWF_PL,
        precip_mode="bucket6",
        snow_depth_factor=100.0,
        attribution="NOAA NCEP GFS via NOMADS, public domain",
    ),
    "gem": Model(
        key="gem", label="ECCC GEM GDPS", short="GEM", grid="15 km", source="datamart", steps=STEPS_3H,
        # Keys are the shortNames we force on each single-variable file.
        sfc_params={"10u": "u10", "10v": "v10", "2t": "t2m", "2d": "d2m", "prmsl": "msl",
                    "tp": "tp", "sf": "sf", "sde": "sd", "gust": "gust", "tcc": "tcc", "cape": "cape"},
        file_params={"10u": "WindU_AGL-10m", "10v": "WindV_AGL-10m", "2t": "AirTemp_AGL-2m",
                     "2d": "DewPoint_AGL-2m", "prmsl": "Pressure_MSL", "tp": "Precip-Accum_Sfc",
                     "sf": "Snow-Accum_Sfc", "sde": "SnowDepth_Sfc", "gust": "WindGust_AGL-10m",
                     "tcc": "TotalCloudCover_Sfc", "cape": "CAPE_Sfc"},
        pl_params=_ECMWF_PL,
        file_pl_params={"t": "AirTemp", "u": "WindU", "v": "WindV", "gh": "GeopotentialHeight"},
        unit_override={"tcc": "%", "tp": "kg m-2", "sf": "kg m-2", "cape": "J kg-1"},
        precip_mode="since_start",
        snow_depth_factor=100.0,
        attribution="Environment and Climate Change Canada, Open Government Licence",
    ),
    "gefs": Model(
        key="gefs", label="NOAA GEFS mean", short="GEFS", grid="25 km", source="nomads-gefs", steps=STEPS_3H,
        sfc_params={"10u": "u10", "10v": "v10", "2t": "t2m", "prmsl": "msl", "tp": "tp",
                    "gust": "gust", "tcc": "tcc", "cape": "cape", "2d": "d2m", "sde": "sd",
                    "csnow": "csnow"},
        pl_params=_ECMWF_PL,
        # The ensemble mean has no 0.25° pressure levels; we take the 0.5°
        # "a" file and regrid. It carries t+gh+u+v on these levels only —
        # 300/400 hPa ship winds without temperature and 600 hPa not at all,
        # so those are left out rather than stored half-empty.
        levels=(1000, 925, 850, 700, 500, 250, 200),
        # The 31-member ensemble's across-member standard deviation, published
        # as `gespr.tHHz.pgrb2s.0p25.fHHH` beside the mean in pgrb2sp25 — same
        # grid, same steps, same parameter list, so it costs one more filtered
        # GET per step and lands on the existing 0.25° machinery unchanged.
        spread_params={"2t": "t2m_sd", "10u": "u10_sd", "10v": "v10_sd",
                       "prmsl": "msl_sd", "tp": "tp6_sd"},
        precip_mode="bucket6",
        snow_depth_factor=100.0,
        attribution="NOAA NCEP GEFS ensemble mean via NOMADS, public domain",
    ),
}

# Variables stored as float16 (range-safe, halves the store): winds/temps/heights aloft.
HALF_PRECISION_PREFIXES = ("u_", "v_", "gh_")   # temps stay float32: 0.25 K steps would bend the freezing level


def get_model(key: str) -> Model:
    try:
        return MODELS[key]
    except KeyError:
        raise KeyError(f"unknown model {key!r}; known: {sorted(MODELS)}") from None
