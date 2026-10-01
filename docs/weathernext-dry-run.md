# WeatherNext collection dry run

WeatherNext's ensemble-mean collection is organized as
`zarr/<year partition>/<YYYYMMDD_HHhr_01_preds>/predictions.zarr/`.
Completed run directories also contain Google's `success` marker. The adapter
accepts the collection root, a year partition, a run directory, or a direct Zarr
store. Legacy multi-initialization Zarr stores remain supported.

The published per-run schema has a scalar datetime `init_time` and a timedelta
`time` axis. The reader gives it one initialization on `time` and the forecast
axis on `prediction_timedelta`, retaining lazy field arrays. It does not invent
a zero-hour forecast when the source starts at hour six.

## Offline regression check

Activate the existing wxgrid Python environment, then run from the isolated
checkout:

```sh
python -m pytest -q \
  tests/test_wn2.py tests/test_wn2_published.py
```

Fixtures use the observed coordinate encodings with synthetic values. Tests
block outbound sockets and use scratch storage, never the live forecast store.

## Read-only live metadata check

Run this only after the operator approves using the existing ADC for the dataset.
The environment overrides apply to this command only; this does not install or
change any service credential setting, quota project, API, or billing setting.

```sh
GOOGLE_APPLICATION_CREDENTIALS="$HOME/.config/gcloud/application_default_credentials.json" \
WXGRID_WN2_ZARR=gs://weathernext/weathernext_2_0_0_mean/zarr \
python - <<'PY'
import json
from itertools import islice
import fsspec
import xarray as xr
from wxgrid.wn2 import discover_sources, zarr_url

sources = list(islice(discover_sources(zarr_url()), 3))
if not sources:
    raise SystemExit("No completed published run found")
for init, url in sources:
    print(init.isoformat() if init else "direct store", url)

_, url = sources[0]
fs, path = fsspec.core.url_to_fs(url)
raw = fs.cat_file(path.rstrip("/") + "/.zmetadata", start=0, end=524289)
if len(raw) > 524288:
    raise SystemExit("Consolidated metadata exceeds the 512 KiB check limit")
metadata = json.loads(raw)
mapper = fsspec.get_mapper("memory://weathernext-metadata-only")
mapper[".zmetadata"] = raw
for key in (".zgroup", ".zattrs"):
    if key in metadata["metadata"]:
        mapper[key] = json.dumps(metadata["metadata"][key]).encode()
with xr.open_zarr(mapper, consolidated=True, chunks=None, decode_cf=False,
                  create_default_indexes=False) as ds:
    print("dimensions", dict(ds.sizes))
    print("variables", list(ds.data_vars))
PY
```

This inspects directory entries, completion markers, and at most 512 KiB of one
consolidated metadata object. Forecast and coordinate chunks are never read.
The in-memory metadata open deliberately disables CF decoding and index
construction. The offline tests verify the decoded coordinate normalization.

Do not use `resolve_latest`, `open_dataset`, or the ingest CLI for this
metadata-only check: the normal reader loads small coordinates, and latest-run
completeness checks may read a final-lead forecast chunk.

## Subsequent integration boundary

Review the selected run, available forecast steps, variables, and pressure
levels. Decide the service's credential path separately. A separately authorized
single-run ingest should use scratch output first and verify time mapping, grid
orientation, precipitation units, and missing fields before scheduled ingest is
enabled. This draft does not activate ingest or change the existing deployment
drop-in.
