# wxgrid

Self-hosted, Windy-style weather map on free model data. Global weather-model
grids, one store, two consumers: a map in the browser (wind particles, layers
at the surface and aloft, live radar, a weather tape, aviation and outdoors
readouts) and Python readers for signal engines downstream. MIT.

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

| key  | model            | source            | steps        | surface variables                     | aloft (925/850/700/500/300/250 hPa) |
|------|------------------|-------------------|--------------|---------------------------------------|-------------------------------------|
| ifs  | ECMWF IFS 0.25°  | ecmwf-opendata    | 0–240 h / 6h | u10 v10 t2m msl tp6 gust tcc cape     | u v t gh                            |
| aifs | ECMWF AIFS (AI)  | ecmwf-opendata    | 0–240 h / 6h | u10 v10 t2m msl tp6 tcc               | u v t gh                            |
| gfs  | NOAA GFS 0.25°   | NOMADS filter CGI | 0–240 h / 6h | u10 v10 t2m msl tp6 gust tcc cape     | u v t gh                            |

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
kept (`WXGRID_KEEP_RUNS`); each run is ~0.9–1.2 GB compressed with the aloft
levels (winds/heights aloft are stored float16, temperatures float32).

`WXGRID_PUBLIC=1` (see `deploy/wxgrid-public.service`) runs a second instance
that never serves `front/private/` — the place for an operator's own fonts or
theme overlay that shouldn't leave the house. Put it behind any reverse proxy
or tunnel.

## Front end

`front/` is static: MapLibre GL (vendored) on OpenFreeMap's dark style, one
`image` source draped over the world in Web Mercator (the server reprojects
the lat/lon grid so the drape is exact), a 2-D canvas particle layer above it
(cambecc/earth lineage), a Windy-style weather tape + scrubber (← → keys,
space to play), a model picker that keeps the *valid time* when you switch,
altitude picker for wind/temp (surface, 925…250 hPa), live radar overlay with
its own timeline (RainViewer, last 2 h + nowcast), place search (Nominatim),
and a tap-anywhere point card: Now (meteogram), Aloft (winds/temps per level,
freezing level, cloud, CAPE, QNH), Outdoors (precip type, 24 h rain, snow
level, gusts, wind chill). Layers: wind, temp, gusts, rain, clouds, pressure,
CAPE. Units toggle km/h · kt · m/s. Fonts: Inter / Plus Jakarta Sans / Geist
Mono (OFL, see `front/fonts/LICENSES.md`).

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
