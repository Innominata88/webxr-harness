# Results JSONL Schema

This document describes the JSONL output produced by:

- `src/app-webgl.js`
- `src/app-webgpu.js`

One JSON object is written per line (`.jsonl`).

## Output files

- Canvas output:
  - WebGL default: `results_webgl_<timestamp>.jsonl`
  - WebGPU default: `results_webgpu_<timestamp>.jsonl`
  - Override with query parameter `out=...`
- XR output:
  - WebGL default: `results_webgl_xr_<timestamp>.jsonl`
  - WebGPU default: `results_webgpu_xr_<timestamp>.jsonl`
  - Override with query parameter `outxr=...`

## Validation script

Use the built-in validator before analysis:

```bash
node tools/validate-results.mjs results_webgl_*.jsonl
node tools/validate-results.mjs results_webgpu_*.jsonl
node tools/validate-results.mjs path/to/file1.jsonl path/to/file2.jsonl
```

Exit code behavior:

- `0`: all records passed
- `1`: one or more validation failures (missing fields, wrong types, malformed JSON, or unsupported `schema_version`)

## Record types

- Canvas trial record:
  - `mode: "canvas"`
  - Contains `summary`, `extras`, `perf`
- XR trial record:
  - `mode: "xr"`
  - Contains `summary`, `extras`, `perf`, `xr_viewports`
- XR abort record:
  - `mode: "xr"`, `aborted: true`
  - Written when XR cannot produce a valid complete suite (for example view-count comparability guard, entry timeout, or early session termination)
  - Contains abort metadata and partial progress, not `summary/extras/perf`

## Top-level fields

`Type` uses JSON data types. `Applies to` may be `all`, `trial`, `abort`, `xr`, `canvas`.

| Field | Type | Applies to | Notes |
|---|---|---|---|
| `schema_version` | string | all | Record schema version; current value `"1.1.0"` (validator also accepts legacy `"1.0.0"`) |
| `api` | string | all | `"webgl2"` or `"webgpu"` |
| `mode` | string | all | `"canvas"` or `"xr"` |
| `modelUrl` | string | all | Model URL used by loader |
| `instances` | number or null | all | Instance count for the condition; may be `null` in early abort edge cases |
| `trial` | number or null | all | Trial index within instance condition; may be `null` in early abort edge cases |
| `trials` | number | all | Requested trials per instance count |
| `durationMs` | number | all | Requested measured window per trial (ms) |
| `warmupMs` | number | all | Warmup delay before measured window |
| `cooldownMs` | number | all | Delay after each trial |
| `preIdleMs` | number | canvas, abort | Optional pre-idle window used by canvas and carried into abort metadata |
| `postIdleMs` | number | canvas, abort | Optional post-idle window used by canvas and carried into abort metadata |
| `betweenInstancesMs` | number | all | Delay when switching instance blocks |
| `layout` | string | all | `"line"`, `"grid"`, `"spiral"`, `"random"` |
| `seed` | number | all | Seed used for deterministic layout/shuffle |
| `shuffle` | boolean | all | Whether condition order was shuffled |
| `spacing` | number | all | Inter-instance spacing parameter |
| `collectPerf` | boolean | all | Whether perf block was collected |
| `perfDetail` | boolean | all | Whether detailed longtask entries were retained |
| `condition_index` | number or null | all | 1-based index in condition plan |
| `condition_count` | number or null | all | Total conditions in plan |
| `suiteId` | string | all | Suite/run identifier |
| `startedAt` | string | all | ISO-8601 timestamp at record creation |
| `asset_timing` | object | all | Loader timings; see `asset_timing` section |
| `asset_meta` | object | all | Mesh metadata; see `asset_meta` section |
| `env` | object | all | Environment and device metadata; see `env` section |
| `summary` | object | trial | Frame-time summary stats |
| `extras` | object | trial | Derived performance metrics |
| `perf` | object or null | trial | Perf telemetry block when `collectPerf=1`, else `null` |
| `frames_ms` | number[] | trial, optional | Present only when query `storeFrames=1` |
| `frames_ms_now` | number[] | xr trial, optional | Secondary cadence (`performance.now`) when `storeFrames=1` |
| `timing_primary_source` | string | xr trial | Primary cadence source; currently `"xr_callback_t"` |
| `timing_secondary_source` | string | xr trial | Secondary cadence source; currently `"performance.now"` |
| `xr_cadence_secondary` | object or null | xr | Secondary cadence summary from `performance.now` deltas |
| `xr_effective_pixels` | object | xr | Requested/applied scale factor and first-frame pixel counts |
| `xr_viewports` | object[] | xr | Per-view viewport samples (`x`,`y`,`w`,`h`) collected each frame |
| `aborted` | boolean | abort | Always `true` for abort records |
| `abort_code` | string | abort | Typical values: `"xr_view_count_exceeded"`, `"xr_entry_timeout"`, `"xr_session_ended_early"` |
| `abort_reason` | string | abort | Human-readable reason |
| `observed_view_count` | number | abort | View count observed at abort |
| `expected_max_views` | number | abort | Comparability guard, currently `2` |
| `partial_trial` | object | abort | Partial progress; see `partial_trial` section |

## `summary` object (trial records)

From `RunStats.summarize()` in `src/common/metrics.js`.

| Field | Type | Meaning |
|---|---|---|
| `frames` | number | Number of measured frames |
| `duration_ms` | number | Measured wall duration in ms |
| `mean_ms` | number | Mean frame time in ms |
| `p50_ms` | number | Median frame time in ms |
| `p95_ms` | number | 95th percentile frame time in ms |
| `p99_ms` | number | 99th percentile frame time in ms |

## `extras` object (trial records)

Derived from `summary` and raw `dt` samples.

| Field | Type | Meaning |
|---|---|---|
| `fps_effective` | number | `frames / (duration_ms/1000)` |
| `fps_from_mean` | number | `1000 / mean_ms` |
| `target_ms` | number | Nearest target frame period from {120, 90, 72, 60 Hz} |
| `missed_1p5x` | number | Frames slower than `1.5 * target_ms` |
| `missed_2x` | number | Frames slower than `2.0 * target_ms` |
| `missed_1p5x_pct` | number | `missed_1p5x / frame_count` |
| `max_frame_ms` | number | Maximum frame time |
| `jank_p99_over_p50` | number | `p99_ms / p50_ms` |

## `perf` object (trial records)

Present when `collectPerf=1`, otherwise `null`.

| Field | Type | Meaning |
|---|---|---|
| `trial_measure_ms` | number or null | Duration from `performance.measure()` |
| `memory_start` | object or null | Heap snapshot at trial start |
| `memory_end` | object or null | Heap snapshot at trial end |
| `longtask` | object | Long task summary over trial window |
| `model_resource` | object or null | Resource timing entry for model fetch |
| `timeOrigin` | number | `performance.timeOrigin` |

### `memory_start` / `memory_end`

Only available on browsers exposing `performance.memory`.

| Field | Type |
|---|---|
| `usedJSHeapSize` | number |
| `totalJSHeapSize` | number |
| `jsHeapSizeLimit` | number |

### `longtask`

| Field | Type | Notes |
|---|---|---|
| `count` | number | Long task count overlapping trial window |
| `total_ms` | number | Sum of long task durations |
| `max_ms` | number | Max long task duration |
| `entries` | object[] optional | Present only when `perfDetail=1` |

`entries` items:

| Field | Type |
|---|---|
| `startTime` | number |
| `duration` | number |

### `model_resource`

Can be `null` if no matching resource timing entry is found.

| Field | Type |
|---|---|
| `name` | string |
| `initiatorType` | string |
| `startTime` | number |
| `duration` | number |
| `transferSize` | number |
| `encodedBodySize` | number |
| `decodedBodySize` | number |

## `asset_timing` object

| Field | Type | Meaning |
|---|---|---|
| `fetch_ms` | number | Time from load start to fetch response |
| `parse_ms` | number | Parse + merge + normalize time |
| `total_ms` | number | End-to-end model load time |

## `asset_meta` object

| Field | Type |
|---|---|
| `vertex_count` | number |
| `index_count` | number |
| `triangle_count` | number |
| `has_indices` | boolean |
| `bounds_raw` | object (`minX`,`minY`,`minZ`,`maxX`,`maxY`,`maxZ`) |
| `norm_scale` | number |
| `norm_center` | number[] (`[x,y,z]`) |
| `norm_max_dim` | number |
| `meshes_total` | number |
| `meshes_loaded` | number |
| `primitives_loaded` | number |
| `nodes_total` | number |
| `skins_total` | number |
| `materials_total` | number |
| `images_total` | number |
| `textures_total` | number |

## `env` object

`env` captures runtime context. Some fields are API-specific.

### Shared fields (WebGL + WebGPU)

| Field | Type |
|---|---|
| `api` | string |
| `powerPreferenceRequested` | string |
| `hudEnabled` | boolean |
| `hudHz` | number |
| `xr_expected_max_views` | number |
| `ua` | string |
| `uaData` | object or null |
| `platform` | string or null |
| `language` | string or null |
| `languages` | string[] or null |
| `hardwareConcurrency` | number or null |
| `deviceMemory` | number or null |
| `maxTouchPoints` | number or null |
| `isSecureContext` | boolean |
| `crossOriginIsolated` | boolean |
| `visibilityState` | string |
| `dpr` | number |
| `canvas_css` | object (`w`,`h`) |
| `canvas_px` | object (`w`,`h`) |
| `xr_enter_to_first_frame_ms` | number optional |
| `xr_dom_overlay_requested` | boolean optional |
| `xr_abort_reason` | string optional |
| `xr_skipped_reason` | string optional | For example `"entry_timeout"` when `mode=both` timed out before XR start |
| `xr_observed_view_count` | number optional |
| `xr_scale_factor_requested` | number |
| `xr_scale_factor_applied` | number or null |
| `runMode` | string |
| `gpu_identity` | string |
| `order_control` | object |
| `url` | string (1.1.0+) |
| `rest` | object or null (optional) |

Legacy note:
- For legacy `schema_version: "1.0.0"` files, newer env fields (for example `runMode`, `order_control`, `url`, and XR scale-factor metadata) may be absent.

### WebGL-only fields

| Field | Type |
|---|---|
| `contextAttributes` | object or null |
| `gpu` | object with optional `vendor`, `renderer` |

### WebGPU-only fields

| Field | Type |
|---|---|
| `adapterRequest` | object |
| `xrCompatibleRequested` | boolean |
| `adapter` | object or null |
| `adapter_features` | string[] |
| `adapter_limits` | object |
| `device_features` | string[] |
| `device_limits` | object |
| `colorFormat` | string |

## `partial_trial` object (abort records)

| Field | Type | Meaning |
|---|---|---|
| `elapsed_ms` | number or null | Time elapsed in current trial before abort |
| `frames_collected_t` | number | Number of primary cadence deltas (`t`) before abort |
| `frames_collected_now` | number | Number of secondary cadence deltas (`performance.now`) before abort |

## `xr_cadence_secondary` object (XR records)

| Field | Type | Meaning |
|---|---|---|
| `frames` | number | Sample count |
| `mean_ms` | number | Mean frame delta |
| `p50_ms` | number | Median frame delta |
| `p95_ms` | number | 95th percentile frame delta |
| `p99_ms` | number | 99th percentile frame delta |

## `xr_effective_pixels` object (XR records)

| Field | Type | Meaning |
|---|---|---|
| `requested_scale_factor` | number | `xrScaleFactor` request |
| `applied_scale_factor` | number or null | Applied layer scale factor (`null` if runtime fallback/unknown) |
| `first_frame_total_px` | number or null | Sum of per-view pixels on first measured XR frame |
| `first_frame_per_view_px` | number[] | Per-view pixel counts on first measured XR frame |

## Notes for analysis and reporting

- `condition_index` is 1-based.
- For XR aborts, earlier completed XR trials remain in the same file, followed by one abort record.
- `xr_viewports` is appended every frame and can be large; treat as diagnostic metadata.
- `frames_ms` is optional and only emitted with `storeFrames=1`.
- `perf.longtask.entries` is only present when `perfDetail=1`.
- Use `schema_version` to gate parsers when fields evolve.
- For paper reproducibility, also pin analyses to a git commit hash.


### env.rest

`env.rest` records the measured idle/cooldown interval **between the previous suite finishing** and **this suite page loading**.

This uses a small `localStorage` handoff written at the end of the previous suite and consumed on the next suite load.

Fields:

- `restStartTs` (number|null): epoch ms when the previous suite finished (handoff written)
- `restEndTs` (number|null): epoch ms when this suite loaded
- `restElapsedMs` (number|null): `restEndTs - restStartTs`
- `recommendedRestMs` (number|null): from URL param `betweenSuitesMs` (if provided)
- `previousSuiteId` (string|null)
- `previousApi` (string|null)
- `previousRunMode` (string|null): `"canvas" | "xr" | "both"`
- `previousFinalPhase` (string|null): `"canvas" | "xr"`
- `previousOutFile` (string|null)
- `previousUrl` (string|null)

Notes:
- `env.rest` may be absent in legacy `schema_version: "1.0.0"` records generated before rest handoff support.
- `env.rest` may also be explicitly `null` in transitional outputs.
- On the **first** suite in a sequence, the `previous*` fields and timestamps are null.
- `restElapsedMs` intentionally excludes model parsing, GPU initialization, and auto-run delays; it measures “time spent idle between pages”.

### cooldown redirect (optional)

If you set `cooldownPage`, the harness will auto-navigate to that page after the **final** phase completes.

URL params:
- `cooldownPage=./idle.html` (or any same-origin page)
- `betweenSuitesMs=300000` (5 minutes; also passed into `idle.html`)
- `cooldownDelayMs=8000` (optional; redirect delay after download trigger)
- `cooldownAfter=final|canvas|xr` (default `final`)
- `xrEntryTimeoutMs=45000` (only when `mode=both` + `cooldownAfter=final`; if XR is not entered in time, harness emits an XR abort/skip record and finalizes)
