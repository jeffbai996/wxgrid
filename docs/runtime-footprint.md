# Runtime footprint

The API unit caps native scientific-library pools at one thread each and sets
glibc arena/trim thresholds so completed image encodes release their working
memory. These environment settings must be present in the effective service
unit, including private deployment overrides. Zarr's own concurrency and the
two cold-render slots remain unchanged.

Catalog discovery reads root Zarr metadata and does not construct data
readers. Actual data requests share a maximum of twelve recently used readers;
simultaneous requests construct each reader once.

External-service and ensemble caches use SQLite, opened on first access.
Each cache retains at most 256 serialized JSON values totaling 2 MiB, with a
256 KiB per-value admission limit, and a 1 MiB SQLite page cache. Large values
are decoded from disk only when requested. Expired rows are reclaimed in
batches; freed pages are reused and incrementally vacuumed. A disk failure
degrades to the same bounded hot set. No cache maintenance thread is added.

Legacy `ext.json` and `ens.json` are not loaded. Leave them available for
rollback during the transition; missing values refill on demand under the
existing per-key single-flight guard. No model runs or derived render caches
are removed by this change. Restoring the previous revision and service
environment is sufficient to roll back.

For a reproducible Linux memory check, run `scripts/profile_runtime.py` with
`PYTHONPATH` pointing at the checkout under test and an explicit `--run` that
exists in the HRRR store. It reports RSS, peak RSS, thread counts, catalog and
image hashes without writing rendered files or making upstream requests. Run
one profile at a time inside a memory/CPU-capped scope. The regression suite
is `venv/bin/python -m pytest -q tests`; always name `tests` to avoid walking
the model store during collection.

Measured with HRRR 2026-09-04T18, steps 0/1/2, WebP/PNG/WebP: the prior worker
retained 338.0 MiB after GC (422.9 MiB peak); the revised code and environment
retained 99.8 MiB (251.4 MiB peak). Initial catalog construction fell from
1.7296 s to 0.0066 s. Catalog and image SHA-256 values matched. These are
isolated process measurements, not promises about total service memory under
all combinations of requests.
