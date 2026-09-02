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
STEPS_3H = list(range(0, 241, 3))                                # GEM, GEFS: ten days
# GFS alone publishes past day ten: 3-hourly to 240, then 6-hourly to 384.
# GEM GDPS and the GEFS products we read both stop at 240, so they keep the
# short list rather than 404 their way through a day of steps that do not exist.
STEPS_GFS = STEPS_3H + list(range(246, 385, 6))
# AI-GFS publishes 6-hourly out to 384 h. The extra six days are the cheapest
# long range we have anywhere, so it keeps them.
STEPS_AI = list(range(0, 385, 6))
LEVEL_EVERY = 6                                                  # pressure levels are fetched on 6 h steps only
# 150/100 hPa (≈FL450/FL530) ride along for IFS, AIFS, GFS and GEM — all four
# sources publish them. GEFS keeps its own trimmed tuple; HRDPS/HRRR store no
# pressure levels at all.
LEVELS = (1000, 925, 850, 700, 600, 500, 400, 300, 250, 200, 150, 100)
# ≈ surface, 2.5k ft, 5k ft, 10k ft, 14k ft, FL180, FL240, FL300, FL340, FL390.
# A model that does not publish one of these simply never writes it; the API's
# _levels_for() advertises only the levels a run actually contains, so runs
# ingested against an older LEVELS keep working.

# GRIB typeOfLevel values that mean "a surface-ish single layer" for our purposes.
SURFACE_LEVEL_TYPES = {"surface", "heightAboveGround", "meanSea", "atmosphere",
                       "entireAtmosphere", "atmosphereSingleLayer", "lowCloudLayer",
                       "mediumCloudLayer", "highCloudLayer", "unknown",
                       # IFS mucape decodes at this level type; without it the
                       # field was silently dropped and IFS never had CAPE.
                       "mostUnstableParcel"}


@dataclass(frozen=True)
class Model:
    key: str                 # store key + API name
    label: str               # UI label
    short: str               # tiny label for segmented controls
    source: str              # "ecmwf" | "nomads" | "nomads-gefs" | "datamart" | "weathernext"
    # An optional model is one this install may not have access to (gated
    # data). The catalog leaves it out until a run exists, so the model row
    # never shows a pill nobody can press.
    optional: bool = False
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
    # The producer's nominal resolution, for the UI. For global models this
    # describes the forecast rather than our 0.25° sampling; regional models
    # also declare their separate store grid below.
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
    # Regular lat/lon store grid. Global models retain the original 721x1440
    # layout byte-for-byte; regional producers are reprojected onto their own
    # finer subgrid at ingest.
    grid_shape: tuple[int, int] = (721, 1440)
    lat0: float = 90.0
    lon0: float = -180.0
    dlat: float = -0.25
    dlon: float = 0.25
    # west, south, east, north — the image footprint and point-validity gate.
    domain: tuple[float, float, float, float] = (-180.0, -90.0, 180.0, 90.0)
    keep_runs: int | None = None

    @property
    def regional(self) -> bool:
        return self.domain != (-180.0, -90.0, 180.0, 90.0)

    def contains(self, lat: float, lon: float) -> bool:
        west, south, east, north = self.domain
        return south <= lat <= north and west <= lon <= east

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

    def wave_variables(self) -> list[str]:
        """Wave variables the store carries: the published ones minus the
        `_`-prefixed inputs, plus the swell height derived from the bands."""
        out = [v for v in self.wave_params.values() if not v.startswith("_")]
        if any(v in WAVE_BAND_INPUTS for v in self.wave_params.values()):
            out.append(SWELL_VAR)
        return out

    def store_variables(self) -> list[str]:
        out = []
        for canon in self.sfc_params.values():
            if canon in ("csnow", "tsk", "lsm"):
                continue                        # inputs only: csnow → sf6, tsk+lsm → sst
            out.append({"tp": "tp6", "sf": "sf6", "sd": "sd_cm"}.get(canon, canon))
        if "csnow" in self.sfc_params.values() and "tp" in self.sfc_params.values():
            out.append("sf6")
        if "tsk" in self.sfc_params.values() and "lsm" in self.sfc_params.values():
            out.append("sst")
        for prefix in self.pl_params.values():
            out.extend(f"{prefix}_{lvl}" for lvl in self.levels)
        out.extend(self.wave_variables())
        spread = list(self.spread_params.values())
        # u10_sd/v10_sd are only inputs: what is stored is the wind SPEED spread.
        if "u10_sd" in spread and "v10_sd" in spread:
            out.append("wind_sd")
        out.extend(v for v in spread if v not in ("u10_sd", "v10_sd"))
        return out


_ECMWF_PL = {"u": "u", "v": "v", "t": "t", "gh": "gh"}
_NCEP_PL = {"u": "u", "v": "v", "t": "t", "gh": "gh", "tcc": "cc"}

# Period-band wave heights from the ECMWF wave stream, longest period last.
# Everything at or above a 10 s period is swell by any surfer's or mariner's
# definition; their root-sum-square is the swell height, and what is left of
# the total is the wind sea.
WAVE_BAND_INPUTS: tuple[str, ...] = ("_wb1012", "_wb1214", "_wb1417", "_wb1721", "_wb2125", "_wb2530")
SWELL_VAR = "swell"

MODELS: dict[str, Model] = {
    "ifs": Model(
        key="ifs", label="ECMWF IFS", short="IFS", grid="9km", source="ecmwf", ecmwf_model="ifs", steps=STEPS_IFS,
        sfc_params={"10u": "u10", "10v": "v10", "2t": "t2m", "msl": "msl", "tp": "tp",
                    "10fg": "gust", "tcc": "tcc", "mucape": "cape", "2d": "d2m", "sf": "sf", "sd": "sd"},
        pl_params=_ECMWF_PL,
        precip_mode="since_start",
        attribution="ECMWF open data, CC BY 4.0",
        # swh/mwd/mwp are stored as-is; pp1d is the peak period; the h#### bands
        # (significant height of waves with periods 10–12 … 25–30 s) are inputs
        # only — the ingest folds them into one `swell` height (see
        # ingest.swell_from_bands). ECMWF open data has no shww/shts split.
        wave_params={"swh": "swh", "mwd": "mwd", "mwp": "mwp", "pp1d": "pp1d",
                     "h1012": "_wb1012", "h1214": "_wb1214", "h1417": "_wb1417",
                     "h1721": "_wb1721", "h2125": "_wb2125", "h2530": "_wb2530"},
    ),
    "aifs": Model(
        key="aifs", label="ECMWF AIFS (AI)", short="AIFS", grid="28km", source="ecmwf", ecmwf_model="aifs-single",
        sfc_params={"10u": "u10", "10v": "v10", "2t": "t2m", "msl": "msl", "tp": "tp", "tcc": "tcc",
                    "2d": "d2m", "sf": "sf", "lcc": "lcc", "mcc": "mcc", "hcc": "hcc"},
        pl_params=_ECMWF_PL,
        precip_mode="since_start",
        attribution="ECMWF open data (AIFS), CC BY 4.0",
    ),
    "gfs": Model(
        key="gfs", label="NOAA GFS", short="GFS", grid="13km", source="nomads", steps=STEPS_GFS,
        sfc_params={"10u": "u10", "10v": "v10", "2t": "t2m", "prmsl": "msl", "tp": "tp",
                    "gust": "gust", "tcc": "tcc", "cape": "cape", "2d": "d2m", "sde": "sd", "csnow": "csnow",
                    # skin temperature masked to water at ingest → sst; lsm is the mask
                    "vis": "vis", "t": "tsk", "lsm": "lsm"},
        pl_params=_NCEP_PL,
        precip_mode="bucket6",
        snow_depth_factor=100.0,
        attribution="NOAA NCEP GFS via NOMADS, public domain",
    ),
    "wn2": Model(
        key="wn2", label="Google WeatherNext 2 (AI ensemble mean)", short="WN2", grid="28km", source="weathernext",
        steps=list(range(0, 361, 6)), optional=True,
        # WeatherNext names → canonical; the adapter (wxgrid/wn2.py) maps them,
        # this table only declares what the store carries.
        sfc_params={"2m_temperature": "t2m", "10m_u_component_of_wind": "u10", "10m_v_component_of_wind": "v10",
                    "mean_sea_level_pressure": "msl", "total_precipitation_6hr": "tp", "sea_surface_temperature": "sst"},
        pl_params={"temperature": "t", "u_component_of_wind": "u", "v_component_of_wind": "v", "geopotential": "gh"},
        precip_mode="per_step",
        attribution="Google DeepMind WeatherNext 2, experimental; © DeepMind Technologies Limited",
    ),
    "aigfs": Model(
        key="aigfs", label="NOAA AI-GFS", short="AI-GFS", grid="25km", source="aws-aigfs", steps=STEPS_AI,
        keep_runs=3,   # 16-day runs four times a day: three is a day of history (Jeff 2026-08-22)
        # eccodes gives these the same shortNames as GFS — same GRIB2 tables.
        # No cloud, CAPE, gust or snow in this model's output: the catalog
        # advertises layers per run, so the UI drops them on its own.
        sfc_params={"10u": "u10", "10v": "v10", "2t": "t2m", "2d": "d2m", "prmsl": "msl", "tp": "tp"},
        pl_params=_ECMWF_PL,
        precip_mode="bucket6",
        attribution="NOAA NCEP AI-GFS (GraphCast lineage) via AWS Open Data, public domain",
    ),
    "gem": Model(
        key="gem", label="ECCC GEM GDPS", short="GEM", grid="15km", source="datamart", steps=STEPS_3H,
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
        key="gefs", label="NOAA GEFS mean", short="GEFS", grid="25km", source="nomads-gefs", steps=STEPS_3H,
        sfc_params={"10u": "u10", "10v": "v10", "2t": "t2m", "prmsl": "msl", "tp": "tp",
                    "gust": "gust", "tcc": "tcc", "cape": "cape", "2d": "d2m", "sde": "sd",
                    "csnow": "csnow"},
        pl_params=_NCEP_PL,
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
    "hrdps": Model(
        key="hrdps", label="ECCC HRDPS", short="HRDPS", grid="2.5km", source="hrdps",
        steps=list(range(0, 49)),
        sfc_params={"10u": "u10", "10v": "v10", "gust": "gust", "2t": "t2m", "2d": "d2m",
                    "prmsl": "msl", "tp": "tp", "sf": "sf", "sde": "sd", "tcc": "tcc"},
        file_params={"10u": "UGRD_AGL-10m", "10v": "VGRD_AGL-10m", "gust": "GUST_AGL-10m",
                     "2t": "TMP_AGL-2m", "2d": "DPT_AGL-2m", "prmsl": "PRMSL_MSL",
                     "tp": "APCP-Accum1h_Sfc", "sf": "WEASN-Accum1h_Sfc", "sde": "SNOD_Sfc",
                     "tcc": "TCDC_Sfc"},
        unit_override={"tcc": "%", "tp": "kg m-2", "sf": "kg m-2"},
        precip_mode="per_step", snow_depth_factor=100.0,
        attribution="Environment and Climate Change Canada HRDPS, Open Government Licence",
        grid_shape=(1241, 2481), lat0=70.0, lon0=-152.0, dlat=-0.025, dlon=0.025,
        domain=(-152.0, 39.0, -90.0, 70.0), keep_runs=2,
    ),
    "hrrr": Model(
        key="hrrr", label="NOAA HRRR", short="HRRR", grid="3km", source="aws-hrrr",
        steps=list(range(0, 49)),
        # Some ecCodes builds expose NOAA local-table names differently; all
        # observed aliases map to the same canonical store field.
        sfc_params={"10u": "u10", "10v": "v10", "gust": "gust", "2t": "t2m", "2d": "d2m",
                    "prmsl": "msl", "mslet": "msl", "mslma": "msl", "tp": "tp", "sdwe": "sf", "weasd": "sf",
                    "sde": "sd", "tcc": "tcc"},
        precip_mode="since_start", snow_depth_factor=100.0,
        attribution="NOAA NCEP HRRR via AWS Open Data, public domain",
        grid_shape=(1401, 3001), lat0=55.0, lon0=-135.0, dlat=-0.025, dlon=0.025,
        domain=(-135.0, 20.0, -60.0, 55.0), keep_runs=2,
    ),
}

# Variables stored as float16 (range-safe, halves the store): winds/temps/heights aloft.
HALF_PRECISION_PREFIXES = ("u_", "v_", "gh_")   # temps stay float32: 0.25 K steps would bend the freezing level


def get_model(key: str) -> Model:
    try:
        return MODELS[key]
    except KeyError:
        raise KeyError(f"unknown model {key!r}; known: {sorted(MODELS)}") from None
