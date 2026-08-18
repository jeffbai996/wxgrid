# wxgrid

Global weather-model grids, one store, two consumers: a Windy-style map in the
browser and Python readers for signal engines downstream.

```
ECMWF open data (IFS, AIFS) ─┐
NOAA NOMADS (GFS)            ├─ wxgrid.ingest ─▶ data/store/<model>/<run>.zarr
                             ┘        (GRIB2 → common 0.25° grid → Zarr, one step per chunk)
                                             │
              ┌──────────────────────────────┴──────────────────────────┐
     wxgrid.api (FastAPI :8097)                                 wxgrid.reader (xarray)
     /api/layer  Mercator RGBA PNG per model/run/step/layer       open_run · series · region_mean · spread
     /api/wind   coarse u/v for particles
     /api/point  every variable at every step, nearest gridpoint
     front/      MapLibre + canvas particle layer + meteogram
```

## Models

| key  | model            | source            | steps        | variables                     |
|------|------------------|-------------------|--------------|-------------------------------|
| ifs  | ECMWF IFS 0.25°  | ecmwf-opendata    | 0–240 h / 6h | u10 v10 t2m msl tp6 gust      |
| aifs | ECMWF AIFS (AI)  | ecmwf-opendata    | 0–240 h / 6h | u10 v10 t2m msl tp6           |
| gfs  | NOAA GFS 0.25°   | NOMADS filter CGI | 0–240 h / 6h | u10 v10 t2m msl tp6 gust      |

All free and keyless. ECMWF data is CC BY 4.0 (attribute ECMWF); GFS is public
domain. `tp6` is precipitation over the previous 6 h in mm for every model
(ECMWF's since-start accumulation is differenced; GFS's 6 h buckets are used
as-is). Store units: K, Pa, m/s, mm — the API converts for display.

Adding a model = one entry in `wxgrid/models.py` (params map + precip mode)
and, if it is a new source, a fetcher in `wxgrid/fetch.py`.

## Run it

```
python -m venv venv && source venv/bin/activate && pip install -r requirements.txt
python -m wxgrid.ingest --all            # ~10 min first time; ~130 MB GRIB per model run
uvicorn wxgrid.api:app --port 8097       # http://127.0.0.1:8097/
```

Production: `deploy/wxgrid.service` (API) + `deploy/wxgrid-ingest.timer`
(hourly; a run already in the store is skipped, so it costs one HEAD per
model when nothing is new). Tailnet: `tailscale serve --https=8464 http://127.0.0.1:8097`.

`WXGRID_DATA_DIR` moves the store (default `./data`). Two runs per model are
kept (`WXGRID_KEEP_RUNS`); each run is ~250–400 MB compressed.

## Front end

`front/` is static: MapLibre GL (vendored) on OpenFreeMap's dark style, one
`image` source draped over the world in Web Mercator (the server reprojects
the lat/lon grid so the drape is exact), a 2-D canvas particle layer above it
(cambecc/earth lineage), a time scrubber (← → keys, space to play), a model
picker that keeps the *valid time* when you switch, and a tap-anywhere point
card with a meteogram. Layers: wind, gusts, temperature, pressure, rain.

## For Python consumers

```python
from wxgrid.reader import open_run, region_mean, spread
open_run("aifs")                                          # xarray Dataset, latest run
region_mean("ifs", "tp6", lat=(38, 44), lon=(-98, -85))   # corn-belt rain per 6 h step
spread(["ifs", "aifs", "gfs"], "t2m", 49.3, -123.1)       # per-model + mean + range on valid time
```

`pip install -e ~/local-projects/wxgrid` from the consumer's venv, or copy
`wxgrid/reader.py` + `store.py` + `config.py`.

## Roadmap

- WeatherNext 2 (DeepMind FGN ensemble) via BigQuery once the data-request
  form clears — needs a GCP project. Ensembles generally: AIFS-ens, GEFS →
  spread/plume layers.
- Waves (WW3), HRRR 3 km for the PNW, ICON, radar (RainViewer).
- Isobars/isotherms (marching squares client-side), model split-screen.
- Self-hosted AI model on the 3090 via ECMWF `ai-models` (Aurora / GraphCast-small).

## Tests

`pytest -q` — render (Mercator, colour, wind JSON), store roundtrip/prune,
GRIB grid normalisation, API contract. Tests use a scratch data dir.
