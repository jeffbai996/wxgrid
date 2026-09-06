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

## Follow-up: bounded alerts, background workers, encoding and browser storage

Point-alert HTTP responses have a 5 s work budget plus 250 ms boundary grace,
including the existing card pool's queue. Cooperative budgets also cover
cache single-flight waits and network operations. No new resident pool is
added. Relevant providers are selected by conservative geographic envelopes;
official point queries/polygons still decide actual applicability. Overlapping
providers share the remaining budget. Unsupported points and failed/partial
providers have explicit status; empty failures are not cached as successful
all-clears. Real warnings survive a failed detail lookup. A cold/missing
geometry index is incomplete, not evidence that there is no warning.

Socket deadlines cannot forcibly interrupt DNS or a peer dribbling bytes.
The async HTTP boundary returns independently; running work expires
cooperatively. At most two standalone alert jobs may be queued/running in
the existing card pool, including jobs whose HTTP client has already left.
Admission stays held until a worker actually exits; an expired queued job
does no upstream IO. Further fallbacks return unavailable without enqueueing.
The card stream continues to cancel its own queued context jobs on close.
MeteoAlarm retains the single-flight
until its existing eight temporary feed workers finish, so timed-out callers
cannot stack replacement pools. Successful country feeds survive partial
refreshes on disk inside the same byte-bounded cache. No extra geodata set
or dependency is introduced. The cold geometry-index writer also has its
previously missing UUID import restored.

The global, regional, ensemble, aerosol and Pages units now carry the same
native-thread/allocator limits as the API. Existing memory caps, CPU/IO
weights, write pacing, memory gates, timers and run retention are unchanged.
Apply via systemd drop-ins and daemon-reload; a running ingest adopts the
settings on its next invocation, not by interrupting current work.

`scripts/profile_background.py` exercises three GFS-grid steps, two variables,
normal quantization/compression and point-cube construction in a disposable
store. Under the same 1 GiB/one-core scope, the prior environment measured
7.667 s, 134.9 MiB peak and 109.3 MiB retained; the bounded environment measured
8.556 s, 94.2 MiB peak and 59.3 MiB retained. Both produced exactly 23,403,871
stored bytes and identical data hashes. This is a bounded processing sample,
not a measurement of a full ingest's peak or duration.

The field encoder uses one owned float32 scratch buffer with unchanged
operation order, quantization, ranges and validity mask. Lossless WebP uses
method 1 / quality 75 (compression effort, not lossy quality). Existing field
URLs remain valid: decoded data has not changed, so old rendered files are
reused rather than regenerated. `scripts/profile_field_encoder.py` compares
against a specified Git revision without writing to the model/render store.
Against 0163bd52, fresh processes encoding HRRR 2026-09-06T00 wind measured
2.6232 s / 256.9 MiB peak before and 1.5358 s / 245.1 MiB after. Retained RSS
was 122.4 / 121.3 MiB; WebP bytes increased 0.50%. All 21 real wind/feels/RH
comparisons across AIFS, AIGFS, GEM, GFS, IFS, HRRR and HRDPS had identical
decoded pixels. File sizes increased 0.06–2.11%. Unit tests also compare legacy
RGB for every layer, pressure-level samples, missing and clipped values.

Browser shell versions no longer invalidate weather/basemap caches. Their
independent schema versions retain the existing 220/400 entry ceilings and
expired-run pruning. Activation moves only the newest legacy cache, one entry
at a time; older browser cache generations are removed. API fallback data is
capped at 128 entries (an entry-count limit, not a byte quota). The old
unbounded API-data cache is not migrated. Card streams, current point alerts
and health responses bypass offline fallback; no-store/NDJSON responses are
not cached. Ordinary cached API documents retain the existing offline/stale
notification behavior.

Final follow-up validation: 695 pytest tests passed, 20 skipped, including
18 Node frontend runtime tests, under a 1536 MiB/one-core scope. The four
installed scheduled units (global/regional/ensemble/Pages) have verified live
drop-ins; the aerosol unit template is updated but that service is not
installed on this host. No browser surface was available for visual QA.

## Point-cube staging and streamed GRIB writes (2026-09-06)

Variables above 32 MiB now transpose through one anonymous temporary file on
the run's filesystem. Source step chunks are decompressed once, and output
point chunks compressed once; do not replace this with latitude-band reads
from the source (which repeatedly decompress the whole map). Staging writes
share the existing write pacer with output writes. On Linux, fsync and
DONTNEED advice bound dirty scratch pages and evict clean scratch cache.
Variables at or below 32 MiB keep the existing in-memory fast path.

Scratch capacity is one uncompressed variable per concurrent builder, not a
persistent second store: 392.9 MiB for the measured 49-step HRRR variable.
It adds one raw write and one raw read per large variable. The file closes
and is removed on success, exceptions or process death. Disk errors leave
the point variable incomplete and retryable; readers keep using the original
step layout. Advisory eviction can be unavailable on other platforms, so
the Linux cgroup result below is not a cross-platform memory guarantee.

Mean and spread GRIB fields now write independent variables as they decode.
Only accumulation, snow-mask, SST, swell and ensemble-wind dependencies remain
in RAM. Final duplicate messages still win; derived fields use original
float32 inputs rather than re-reading quantized data. Final rain/snow
accumulations are released before point-cube construction. No worker/cache,
coverage, retention, service-limit or native-thread setting changes.

Fresh-process comparisons against `6a8eacd9`, serialized in one-core/1 GiB
scopes with the existing single-thread/allocator settings:

| Sample | Before | After |
| --- | ---: | ---: |
| HRRR t2m point-cube peak RSS | 470.8 MiB | 72.3 MiB |
| Point-cube cgroup peak (includes file cache) | 774.0 MiB | 319.5 MiB |
| Point-cube wall / process CPU | 14.051 / 12.217 s | 33.407 / 13.755 s |
| Synthetic decoded-GRIB peak RSS | 618.0 MiB | 232.0 MiB |
| Synthetic decoded-GRIB cgroup peak | 597.5 MiB | 210.2 MiB |
| Synthetic decoded-GRIB wall / process CPU | 1.814 / 1.812 s | 1.567 / 1.565 s |

All four scopes reported zero peak swap. RSS and cgroup peaks have different
accounting and sampling semantics; do not subtract one from the other.
Point data came from HRRR 2026-09-06T12, shape 49 × 1401 × 3001, with
`WXGRID_WRITE_MBPS=30`. Both variants wrote 123,272,681 point-store bytes and
the same raw-band SHA-256:
`f8babeba62125c4a5e2a33c37a509a3f0396a27e51cc2c3fd47d72e38c7b1cc6`.

The synthetic GRIB fixture uses two HRRR-sized steps, 24 independent fields
plus four dependency inputs, and a float16 hashing writer. All 54 final
outputs matched (aggregate SHA-256
`033c1e696614bb6adf730d4db5a065cffad4bbeb84d2ce97c8505d5e26d28f30`).
It isolates retention after decoding, **not** ecCodes, reprojection, network
or real Zarr write performance. These are bounded phase samples, not full
scheduled-job peaks or a browser-snappiness measurement. The point-cube
memory saving deliberately costs paced disk IO and batch latency.

Reproduce with `PYTHONPATH=. venv/bin/python scripts/profile_ingest_memory.py
point --run 2026-09-06T12` or `... grib`; add `--baseline 6a8eacd9` for the old
path. Run one fresh capped process at a time, with the environment above.
The point profiler copies one compressed variable to disposable scratch and
never writes to the live run. A different retained run is a different sample.

The implementation-ready, unimplemented follow-ups are in
[next-footprint-pass.md](next-footprint-pass.md): ECMWF retry/resume boundaries,
separate browser CPU/GPU budgets, and pressure-aware warming/phase diagnostics.

Final-tree verification: 715 tests passed, 20 skipped in a one-core/1536 MiB
scope. New tests cover chunk-once reads, exact raw bits/encoding attributes,
odd edge bands, staging failure/cleanup/retry, scratch/output pacing, bounded
decoded-field lifetimes, last-message-wins, derived values, partial spread
decode and release of final accumulations before the point-cube phase.
