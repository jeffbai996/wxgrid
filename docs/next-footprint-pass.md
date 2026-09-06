# Next footprint pass: items 3–5

Status, 2026-09-06: items 3 and 5 implemented and verified; item 4 implemented
on the separate `codex/field-cache-acceptance` candidate, awaiting visual
sign-off before production deployment. Items 1–2 shipped in the previous
batch. The contracts below remain the acceptance checklist. See
`runtime-footprint.md` for measured evidence and rollout limitations.

## Invariants

- Reduce memory/work before increasing capacity. No larger service limits,
  worker pools, forecast intervals, persistent RAM caches or dependencies.
- Keep model/variable/step coverage, run retention and warm-layer coverage.
  An unavailable producer is explicit; a shortened forecast is not a success.
- Preserve the last usable complete run. Do not restart a running ingest.
- Measure RSS **and** cgroup memory/swap; file cache and GPU memory count too.
  Compare equal workloads and content, not unrelated whole-job peaks.

## 3. Bound ECMWF retries and resume completed downloads

### Evidence and affected paths

The installed `ecmwf.opendata.Client` defaults to 500 retries and 120-second
retry waits. Deployment logs showed HTTP 429 repeatedly consuming the global
ingest slot. Client construction in `wxgrid/fetch.py` (`ecmwf_latest_run`,
`fetch_ecmwf`) and `wxgrid/ingest.py` (`_resolve_run`, `augment_waves`) does not
override these settings. `_ecmwf_get` already downloads to `.part` and renames
on success, but its catch-all hides failure categories. `_ingest_locked`'s
unconditional GRIB cleanup removes reusable downloads on a budget exit, and
`RunWriter` recreates an incomplete store on the next attempt.

### Implementation contract

1. Centralize client creation and policy in `fetch.py`; route latest-run,
   surface, pressure and wave operations through it. Enforce one retry policy
   across index and data requests; do not multiply outer retries by SDK
   retries. Verify the installed SDK/multiurl hooks before choosing an adapter.
2. Proposed initial limits: four total HTTP attempts per operation, five
   minutes elapsed per transfer, 60 seconds for latest-run probing, and a
   cumulative 15-minute retry-wait allowance per model invocation. Defaults
   are explicit, environment-overridable downward/upward by the operator,
   tested with a fake clock, and logged once. Normal decode, write pacing,
   warming and host-pressure pauses do not spend the retry-wait allowance.
3. Use monotonic deadlines. Respect `Retry-After` seconds and HTTP dates; if
   the required wait exceeds the remaining allowance, defer without making
   an early request. Otherwise use bounded exponential backoff with jitter.
   Distinguish 429/transient transport/5xx from missing products, unavailable
   optional parameters, authorization errors and corrupt GRIBs. Do not remove
   parameters as a response to throttling.
4. Pass remaining time into connect/read timeouts and check the deadline while
   reading streamed bodies. The current 120-second read timeout is not a total
   transfer deadline. Document the cooperative DNS/socket boundary: do not
   claim hard cancellation of arbitrary blocked library calls. If the SDK
   cannot expose bounded streaming, reuse the existing paced HTTP transport
   for its resolved URLs; do not add a timeout thread/process pool.
5. Raise a typed `FetchDeferred` on retry-budget exhaustion. The per-model CLI
   boundary records a deferred result and continues other models. It must not
   call `finish()`, prune usable runs, or warm the incomplete run. Latest-run
   probe exhaustion follows the same path rather than guessing a newer cycle.
6. Resume at **completed download** granularity initially. Preserve validated
   final GRIBs only on `FetchDeferred`, discard incomplete `.part` files, and
   reuse them on the next invocation of the same run. Re-decode into a rebuilt
   incomplete store under the existing run lock; no new store checkpoint
   schema or memory cache. Keep this distinction visible in logs: completed
   downloads resume, individual byte ranges and decoded steps do not.
7. A final path must pass a cheap length/GRIB framing check before reuse;
   successful HTTP status or nonzero length alone is insufficient. Track
   required versus legitimately absent optional products. A deferred required
   product never becomes an apparently complete run with silent holes.
8. The existing 24-hour orphan-GRIB sweep bounds deferred-file lifetime. Exclude
   a currently locked run from reclamation. Keep existing final-file deletion
   after successful ingestion; no duplicate archive or expanded run retention.

### Tests and acceptance

Fake HTTP/clock tests: numeric/date/malformed Retry-After, 429 followed by
success, all-attempt exhaustion, 503, 404, optional-parameter fallback, slow
stream, stalled read, invalid/truncated 200 response, and cancellation before
rename. Assert exact upper bounds on requests and waits. Fault-inject budget
exhaustion after two files: next model proceeds, last complete run remains
served, incomplete run stays undiscoverable, and retry fetches only unfinished
files. Verify lock-safe cleanup and coverage after successful resumption.

Canary one scheduled ECMWF cycle under unchanged limits. Report network calls,
retry-wait seconds, deferred reason, reused bytes, completed coverage and peak
memory. Roll back code without deleting reusable GRIBs if coverage or recovery
regresses. Do not induce throttling against the public producer to test this.

## 4. Separate browser CPU and GPU field budgets

### Evidence and affected paths

`front/field.js` caps decoded `ImageData` at 96 MiB but also retains its RGBA
texture. `cacheBytes` counts only the CPU copy. `shown` and `pending` entries
are pinned, so the nominal ceiling is not unconditional. An HRRR image is
1401 × 3001 × 4 = 16,817,604 bytes (~16.04 MiB); four distinct pinned fields
already exceed 64 MiB. Browser decode/canvas scratch is additional memory.

### Implementation contract

1. Track CPU decoded bytes and GPU allocation bytes independently. Charge GPU
   allocations as width × height × 4 (no mipmaps); record driver overhead as
   an unmeasured addition, not zero. Centralize allocation/deletion counters.
2. Proposed launch budgets: 80 MiB decoded CPU, 40 MiB GPU, both below today's
   possible residency. Keep CPU images needed for exact hover sampling. Do not
   introduce a second packed representation, GPU readbacks, or a blob cache.
3. Only the displayed interpolation pair needs GPU textures. Prefetch/pending
   entries remain CPU-only. Once the new pair is decoded, release obsolete
   textures and upload the new pair in one render transition, preserving any
   texture shared with the old pair. Retained GPU residency stays within the
   budget; no old-pair plus new-pair transient allocation. Handle upload
   failure via the existing fallback, not an invisible half-transition.
4. CPU admission reserves space for the shown pair and newest requested pair;
   evict unpinned least-recently-used entries before admitting more decoded
   images. At HRRR sizes, four pinned images fit 80 MiB, leaving less than one
   additional image: prefetch must yield. Count/reserve in-flight decode bytes
   from known grid dimensions and reject stale completions before insertion.
5. Do not increase `FieldRequests` concurrency. Apply cache/decode admission
   to selected and speculative work without starving the newest selection.
   Superseded requests release reservations on abort, rejection and late
   success. Avoid retaining failed-entry metadata indefinitely.
6. If a future model's necessary working pair exceeds a budget, explicitly
   degrade to one frame or the existing raster fallback; do not silently grow
   the budget. Test one-URL pairs and transitions between different grid sizes.
7. `onRemove`, fallback and WebGL context loss release/reset GPU accounting.
   Context restoration rebuilds only the shown pair from bounded CPU data.
   Trim inactive CPU entries on removal; keep sampling/render values identical.

### Tests and acceptance

Extend the Node frontend runtime harness with instrumented WebGL allocation
and fake delayed decodes. Assert budget invariants after every event during
long scrubs, rapid model/layer changes, four-distinct-field transitions,
out-of-order completion, failed uploads, context loss/restore and removal.
Compare sampled values and decoded bytes exactly to the current path.

Then use a real browser: identical HRRR/GFS playback and 100-step scrubbing,
same viewport, repeated warm passes. Record CPU cache bytes, texture bytes,
peak JS/process memory where available, requests, dropped frames and p95
frame-ready delay. Require reduced retained memory with no visual/probe
regression; investigate >10% warm-delay regression before release. GPU
counters are accounting evidence, not a physical VRAM measurement. No browser
was available for the preceding audit, so visual acceptance remains mandatory.

## 5. Pressure-aware warming and bounded phase measurements

### Evidence and affected paths

`warm_layers` in `wxgrid/ingest.py` runs after existing per-step/per-variable
pressure gates but does not gate its own frames. The frame encoder already
releases its expression temporaries before the next loop iteration. Existing
whole-service peaks cannot attribute pressure to decode, point-cube, warm or
download phases, and unrelated overlapping workloads distort comparisons.

### Implementation contract

1. Reuse `wait_for_step_gate()` after each newly encoded and atomically
   published frame, with the encode/write call in a helper whose frame has
   returned first. Gate before the first missing frame too. Existing cache
   hits remain cheap; no extra gate subprocess per hit. If a gate aborts,
   already warmed files and the complete model run remain valid.
2. Keep `WARM_LAYERS`, mapped step sets, cache keys, write pacing and timers
   unchanged. No parallel warmer, shorter forecast or mandatory new monitor.
   With no configured gate command, the boundary is effectively a no-op.
3. Add optional structured phase logs for fetch/decode-write, point-cube and
   warming; emit phase start/end plus at most one progress record per minute.
   Nested decode/write wall and CPU deltas distinguish download waiting from
   computation without double-counting inclusive phase totals.
4. Collect monotonic wall time, process user/system CPU deltas, current RSS,
   lifetime high-water RSS, cgroup current/peak memory and swap when available,
   `/proc/self/io` byte deltas, completed/expected work counts, cache skips and
   gate-wait seconds. These are snapshots at existing boundaries, not a
   sampling thread. Track a boundary-sampled maximum with that exact label;
   never label process-lifetime or cgroup-lifetime peaks as phase-local peaks.
5. Logs carry model/run/phase and success/deferred/error status, no weather
   arrays, full URLs, secrets or per-pixel details. Read proc/cgroup defensively
   (missing files, permissions, cgroup v1/non-Linux); diagnostics must never
   fail a forecast. Use existing journald retention, no new database or
   resident exporter. Do not reset shared cgroup peak counters in production.

### Tests and acceptance

Mock pressure gate and frame writer: check before first missing frame and
after every completed frame, verify arrays are collectible before waiting,
skip cached frames, abort without corrupt final/temp files, and resume only
missing frames. Expected warm counts must remain unchanged. Fake proc/clock
tests cover unavailable metrics, counter resets and bounded logging rate.

Compare identical cached/cold local warming fixtures with diagnostics off/on;
target <2% CPU overhead and no growing retained state. Observe one complete
scheduled global, regional and ensemble cycle; verify coverage, frame counts,
gate-wait attribution and RSS/cgroup trends. Shared-host wall-time changes
alone are not proof of improvement.

## Delivery sequence

Ship 3, 4 and 5 as separate reviewable commits with their tests. Item 3 protects
the scheduler from producer failures; item 4 requires real-browser acceptance;
item 5 makes subsequent whole-run measurements interpretable. Revert each
independently. Keep all current host/service limits and model data intact.
