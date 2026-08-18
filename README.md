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

| key  | model            | source            | surface steps                 | surface variables                                    | aloft (925/850/700/500/300/250 hPa, 6 h) |
|------|------------------|-------------------|-------------------------------|------------------------------------------------------|------------------------------------------|
| ifs  | ECMWF IFS 0.25°  | ecmwf-opendata    | 3 h to 144 h, then 6 h to 240 | u10 v10 t2m d2m msl tp sf sd gust tcc cape + waves swh mwd mwp (6 h) | u v t gh                                 |
| aifs | ECMWF AIFS (AI)  | ecmwf-opendata    | 6 h to 240 h                  | u10 v10 t2m d2m msl tp sf tcc                        | u v t gh                                 |
| gfs  | NOAA GFS 0.25°   | NOMADS filter CGI | 3 h to 240 h                  | u10 v10 t2m d2m msl tp sf(derived) sd gust tcc cape  | u v t gh                                 |

Precipitation and snowfall are stored as the amount since the previous stored
step (`tp6`/`sf6` — the names predate the 3-hourly tier); snow depth is `sd_cm`.
Pressure levels are fetched on 6 h steps and linearly filled between them for
point products. IFS also carries the ECMWF **wave** stream (significant
height, mean direction, mean period) on 6 h steps.

Derived layers need no extra data: relative humidity (from t2m/d2m),
24 h / 72 h rain and snow accumulations (sum of the buckets after the selected
step), freezing level, and wave-propagation vectors for the particle layer.

After a run lands, ingest re-chunks it into a **point cube** (`pt/<var>`,
all steps × 24×24-gridpoint tiles) so a point series decompresses one small
chunk instead of every step (~50 ms instead of seconds). Runs ingested before
this existed: `python -m wxgrid.ingest --model <m> --point-cube`; older IFS
runs can pick up waves with `--augment-waves`.

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

## Overlays and external feeds

All free, all keyless, proxied by `wxgrid/ext.py` (server-side cache, mirrored
to `data/cache/ext.json`) unless marked *direct*:

- **Radar** — RainViewer composite (past 2 h + nowcast), *direct* tiles
- **Satellite** — GOES-East/West GeoColor from NASA GIBS, latest frame, *direct* tiles
- **Alerts** — NWS (US), MeteoAlarm (Europe, Atom/CAP + EMMA_ID regions; attribution required, redistribution per meteoalarm.org terms) and BoM (Australia, CAP-AU over anonymous FTP + AMOC district shapes; © Commonwealth of Australia) merged into one polygon layer and point lookup, plus Environment Canada's ALERTS WMS layer (*direct*)
- **Storms** — NHC/CPHC active tropical cyclones: position, cone, forecast track (KMZ → GeoJSON)
- **Avalanche** — Avalanche Canada (point product + regions) and avalanche.org (zones + products)
- **Observations** — nearest METAR + TAF via aviationweather.gov
- **Air quality / UV** — Open-Meteo air-quality API
- **Tides** — DFO (Canada) and NOAA CO-OPS (US) nearest station, next highs/lows
- **Places** — Nominatim search + reverse (1 req/s honoured), Open-Meteo elevation
- **Ski resorts** — OpenStreetMap via Overpass (catalog + lifts + boundary), DEM for base/summit when OSM has none; with a snow layer showing, pins are coloured by the next 72 h of forecast snowfall (`/api/resorts/snow`)
- **Private overlay** — `front/private/` (gitignored) may carry `theme.css` and `theme.js`; the latter can supply agency marks for the met-service badge (`window.WX_PRIVATE.logos`). Absent, the app shows wordmarks. `WXGRID_PUBLIC=1` never serves the directory.

## Front end

`front/` is static — `app.js` (boot, state, controls, point card shell),
`overlays.js` (radar/isolines/avalanche/resorts/alerts/storms/satellite/measure),
`tape.js` (the Windy-style forecast table), `search.js`, `panes.js` (card
panes), `particles.js` (wind particles + barbs), `static-api.js` (Pages
shim). MapLibre GL (vendored) on OpenFreeMap's dark style (positron in the
light theme; dark theme is OLED black), one
`image` source draped over the world in Web Mercator (the server reprojects
the lat/lon grid so the drape is exact), a 2-D canvas particle layer above it
(cambecc/earth lineage), a Windy-style weather tape + scrubber (← → keys,
space to play), a model picker that keeps the *valid time* when you switch,
altitude picker for wind/temp (surface, 925…250 hPa), live radar overlay with
its own timeline (RainViewer, last 2 h + nowcast), place search (Nominatim),
and a tap-anywhere point card: Now (hero, alerts, air quality, station obs,
meteogram), Aloft (winds/temps per level, freezing level, cloud, CAPE, QNH,
TAF), Airgram, Winter (new snow, snow depth, freezing/snow level, ridge wind,
rain-on-snow, avalanche forecast), Outdoors (precip type, 24 h rain, gusts,
wind chill/humidex, dry windows, tides), Compare (all models on the same valid
times), Resort (elevation-band forecast + lifts). Layers: wind, temp, gusts,
rain, new snow, snow depth, clouds, pressure, dew point, freezing level, CAPE;
altitude picker for wind/temp; isolines; wind barbs. Units km/h · kt · m/s,
permalinks in the URL hash, measure tool. Fonts: Inter / Plus Jakarta Sans / Geist
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

## Static demo (GitHub Pages)

`scripts/publish_pages.sh` builds `dist-pages/` with `wxgrid.static_demo`
(one model, 12-hourly, coarse point tiles, prebuilt resort details) and
force-pushes it to `gh-pages`. `deploy/wxgrid-pages.timer` does it twice a
day. The front detects the snapshot and answers point/profile queries from
the tiles; feeds that need a server (METAR, other-model compare, new resort
lifts) degrade quietly.

## Roadmap

- WeatherNext 2 (DeepMind FGN ensemble) via BigQuery once the data-request
  form clears — needs a GCP project. Ensembles generally: AIFS-ens, GEFS →
  spread/plume layers.
- HRRR 3 km, ICON; hourly GFS surface tier; GFS waves (WW3).
- Model split-screen; webcams (needs a keyed API).
- Self-hosted AI model via ECMWF `ai-models` (Aurora / GraphCast-small).

## Tests

`pytest -q` — render (Mercator, colour, wind JSON), store roundtrip/prune,
GRIB grid normalisation, API contract (layers, levels, point, profile,
isolines), external-feed parsers (METAR pick, avalanche, NWS, KMZ), resorts,
static builder. Tests use a scratch data dir and stub every network call.
