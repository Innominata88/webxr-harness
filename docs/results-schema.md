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

Post-validation quality/fairness checker:

```bash
node tools/check-run-quality.mjs --pair-by suiteId --out-base reports/run_quality path/to/results_webgl*.jsonl path/to/results_webgpu*.jsonl
```

- Produces `reports/run_quality.json` and `reports/run_quality.csv`.
- In strict mode (default), exits with code `2` if any pair is excluded for primary analysis.
- Use `--pair-by suiteId` for formal data collection so trials only pair within the same run suite.
- For primary WebGPU XR inclusion, require `env.xr_webgpu_binding_available === true` (the checker excludes otherwise).

Failure-rate curve generator (stability analysis):

```bash
node tools/failure-curve.mjs --out-base reports/failure_curve path/to/results_webgl*.jsonl path/to/results_webgpu*.jsonl
```

- Produces `reports/failure_curve.json` and `reports/failure_curve.csv`.
- Aggregates by `api x mode x instances`.
- Reports `n_total`, `n_fail`, `fail_rate`, Wilson 95% CI, and failure reason/abort-code counts.

Failure-curve plotter (SVG):

```bash
node tools/plot-failure-curve.mjs --in reports/failure_curve.json --mode xr --out reports/failure_curve_xr.svg
```

- Reads `tools/failure-curve.mjs` JSON output.
- Generates a publication-ready SVG line chart with one curve per API.
- Includes optional Wilson 95% CI bars (`--ci 1`, default on).

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
| `minFrames` | number | xr | XR-only floor on collected frame deltas before a trial can finish |
| `warmupMs` | number | all | Warmup delay before measured window |
| `cooldownMs` | number | all | Delay after each trial |
| `preIdleMs` | number | canvas, abort | Optional pre-idle window used by canvas and carried into abort metadata |
| `postIdleMs` | number | canvas, abort | Optional post-idle window used by canvas and carried into abort metadata |
| `canvasAutoDelayMs` | number | all | Canvas auto-start delay parameter (informational when `manualStart=true`) |
| `manualStart` | boolean | all | When `true`, canvas suite required explicit operator start click |
| `xrSessionMode` | string | all | Requested XR session type parameter (`"immersive-vr"` or `"immersive-ar"`) |
| `betweenInstancesMs` | number | all | Delay when switching instance blocks |
| `layout` | string | all | `"line"`, `"grid"`, `"spiral"`, `"random"`, `"xrwall"` |
| `seed` | number | all | Seed used for deterministic layout/shuffle |
| `shuffle` | boolean | all | Whether condition order was shuffled |
| `spacing` | number | all | Inter-instance spacing parameter |
| `canvasScaleFactor` | number | all | Requested canvas scale-factor parameter captured at record level for reproducibility |
| `debugColor` | string | all | Debug fragment coloring mode: `"flat"`, `"abspos"`, or `"instance"` |
| `xrScaleFactor` | number | all | Requested XR scale-factor parameter captured at record level for reproducibility |
| `xrStartOnFirstPose` | boolean | all | Requested XR timing mode; when `true`, measured XR window starts on first valid pose |
| `xrAnchorToFirstPose` | boolean | all | Requested XR placement mode; when `true`, XR layout is anchored to the first viewer pose |
| `xrAnchorMode` | string | all | XR anchor reuse mode (`"session"` or `"trial"`) captured for reproducibility |
| `xrPoseStabilityGateMs` | number | all | Requested XR pose-stability gate duration captured for reproducibility; when nonzero the run waits for a stable viewer pose window before timing starts |
| `xrIdlePresentMode` | string | all | XR idle presentation mode parameter (`"none"` or `"clear_each_frame"`) captured for reproducibility |
| `xrFrontMinZ` | number | all | Requested XR forward placement anchor captured at record level |
| `xrYOffset` | number | all | Requested XR vertical placement offset captured at record level |
| `collectPerf` | boolean | all | Whether perf block was collected |
| `perfDetail` | boolean | all | Whether detailed longtask entries were retained |
| `batteryTelemetry` | boolean | all | Whether battery metadata capture was requested (`batteryTelemetry`) |
| `connectionTelemetry` | boolean | all | Whether network metadata capture was requested (`connectionTelemetry`) |
| `condition_index` | number or null | all | 1-based index in condition plan |
| `condition_count` | number or null | all | Total conditions in plan |
| `runId` | string optional | all | Trace/session identifier used for external profiler alignment (`runId` URL param or auto-generated UUID) |
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
| `xr_no_pose_frames` | number | xr | Count of XR callbacks where `getViewerPose()` returned null during trial |
| `xr_no_pose_ms_total` | number | xr | Approx total wall time (ms) spent in no-pose callbacks during trial |
| `render_probe_xr` | object | xr | XR render-probe diagnostics (`performed`, `rendered_anything`, `first_frame_px`, optional sampled pixel diff) |
| `xr_viewports` | object[] | xr | Per-view viewport samples (`x`,`y`,`w`,`h`) collected each frame |
| `aborted` | boolean | abort | Always `true` for abort records |
| `abort_code` | string | abort | Typical values: `"xr_view_count_exceeded"`, `"xr_pose_unavailable_timeout"`, `"webgl_context_lost"`, `"webgpu_device_lost"`, `"xr_session_ended_early"` |
| `abort_reason` | string | abort | Human-readable reason |
| `observed_view_count` | number | xr abort | View count observed at XR abort |
| `expected_max_views` | number | xr abort | Comparability guard, currently `2` |
| `partial_trial` | object | abort | Partial progress; see `partial_trial` section |

## `summary` object (trial records)

From `RunStats.summarize()` in `src/common/metrics.js`.

| Field | Type | Meaning |
|---|---|---|
| `frames` | number | Number of measured frames |
| `duration_ms` | number | Measured wall duration in ms |
| `mean_ms` | number | Mean frame time in ms |
| `p50_ms` | number or null | Median frame time in ms (`null` when no frames were collected) |
| `p95_ms` | number or null | 95th percentile frame time in ms (`null` when no frames were collected) |
| `p99_ms` | number or null | 99th percentile frame time in ms (`null` when no frames were collected) |

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
| `xr_session_mode_requested` | string optional | Requested WebXR session mode (`immersive-vr` or `immersive-ar`) |
| `xr_session_mode_active` | string or null optional | Active session mode returned by WebXR session once started |
| `xr_session_mode_supported` | boolean or null optional | Result of `isSessionSupported(xrSessionMode)` check when XR path is initialized |
| `browser` | string or null optional | Human-readable browser label derived from `navigator.userAgentData.brands` (fallback UA parsing) |
| `userAgent` | string or null optional | Alias of the user-agent string for downstream tools expecting `userAgent` |
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
| `dpr_canvas` | number optional |
| `canvas_css` | object (`w`,`h`) |
| `canvas_px` | object (`w`,`h`) |
| `xr_enter_to_first_frame_ms` | number optional |
| `xr_dom_overlay_requested` | boolean optional |
| `xr_abort_reason` | string optional |
| `xr_skipped_reason` | string optional | For example `"entry_timeout"` when `mode=both` timed out before XR start |
| `xr_observed_view_count` | number optional |
| `xr_min_frames` | number optional | XR `minFrames` value captured in environment metadata |
| `xr_no_pose_grace_ms` | number optional | Extra XR grace window before aborting if `getViewerPose()` stays unavailable |
| `xr_start_on_first_pose_requested` | boolean optional | Whether query `xrStartOnFirstPose=1` was requested for this run |
| `xr_start_on_first_pose_applied` | boolean optional | `true` when the measured window actually began on first valid pose |
| `xr_anchor_to_first_pose_requested` | boolean optional | Whether query `xrAnchorToFirstPose=1` was requested for this run |
| `xr_anchor_to_first_pose_applied` | boolean optional | `true` when XR instances were re-anchored from the first viewer pose |
| `xr_anchor_mode_requested` | string optional | XR anchor reuse mode requested by the run (`session` for one anchor per XR session, `trial` for re-anchoring at each trial start) |
| `xr_pose_stability_gate_ms_requested` | number optional | XR pose-stability gate duration requested by the run; `0` disables gating |
| `xr_pose_stability_pos_tol_m_requested` | number optional | Position-span tolerance used by the XR pose-stability gate |
| `xr_pose_stability_yaw_tol_deg_requested` | number optional | Yaw-span tolerance used by the XR pose-stability gate |
| `xr_pose_stability_wait_ms` | number or null optional | Observed wait time accumulated toward XR pose-stability gating for the current trial/session |
| `xr_pose_stability_position_span_m` | number or null optional | Observed viewer-position span measured during the XR pose-stability gate |
| `xr_pose_stability_yaw_span_deg` | number or null optional | Observed viewer-yaw span measured during the XR pose-stability gate |
| `xr_pose_stability_achieved` | boolean optional | `true` when the XR pose-stability gate was either disabled or successfully satisfied before measurement started |
| `xr_anchor_pose_yaw_rad` | number optional | Yaw (radians) used for first-pose anchoring |
| `xr_anchor_pose_x` | number optional | Viewer X used for first-pose anchoring |
| `xr_anchor_pose_z` | number optional | Viewer Z used for first-pose anchoring |
| `xr_measurement_waiting_for_first_pose` | boolean optional | `true` while trial is waiting for the first valid pose before timing starts |
| `xr_no_pose_frames` | number optional | Running/session-level no-pose callback count for XR diagnostics |
| `xr_no_pose_ms_total` | number optional | Running/session-level no-pose wall-time total (ms) for XR diagnostics |
| `xr_probe_readback_requested` | boolean optional | Whether XR pixel readback probe was requested (`xrProbeReadback`) |
| `xr_idle_present_mode` | string optional | XR idle presentation mode in effect (`none` for primary true-idle semantics; `clear_each_frame` for diagnostic idle presentation) |
| `debugColor` | string optional | Debug fragment coloring mode used by renderer (`flat`, `abspos`, `instance`) |
| `xrScaleFactor` | number optional | Requested XR scale-factor parameter (camelCase mirror for parser compatibility) |
| `xr_scale_factor_requested` | number |
| `xr_scale_factor_applied` | number or null |
| `canvasScaleFactor` | number optional | Requested canvas scale-factor parameter (camelCase mirror for parser compatibility) |
| `canvas_scale_factor_requested` | number optional |
| `canvas_scale_factor_applied` | number or null optional |
| `xr_scale_factor_fallback_used` | boolean optional | `true` when XR layer creation had to fall back to a lower/default scale factor |
| `xr_projection_layer_fallback` | string optional | XR layer fallback mode used at startup |
| `xr_first_frame_seen` | boolean optional | `false` when XR session ended before first frame was rendered |
| `harness_version` | string optional | Harness build/version identifier (query `harnessVersion`, meta tag fallback, or schema version) |
| `harness_commit` | string or null optional | Harness commit/cache-buster identifier for reproducibility (query `harnessCommit` or `appRev`, then meta tag fallback) |
| `asset_revision` | string or null optional | Asset revision/hash identifier (query `assetRevision`/`assetHash` or meta tag fallback) |
| `feature_flags_profile` | string or null optional | Feature-flag profile ID recorded for this run (query `featureFlagsProfile` or meta tag fallback; operator-provided) |
| `feature_flags_exact` | string or null optional | Exact feature-flag state string recorded for this run (query `featureFlagsExact` or meta tag fallback; operator-provided because browser flag toggles are not readable from page JS) |
| `profiler_mode` | string or null optional | Profiler/trace collection mode recorded for this run (query `profilerMode`; for example `baseline_untraced` or `traced_recording`) |
| `profiler_config` | string or null optional | Free-form profiler configuration string recorded for this run (query `profilerConfig`) |
| `provenance` | object or null optional | Grouped provenance block (see `env.provenance` section) |
| `js_errors` | object[] or null optional | Ring buffer of global JS runtime `error` events captured by `window.onerror` listener |
| `js_unhandled_rejections` | object[] or null optional | Ring buffer of global Promise rejection events captured by `window.unhandledrejection` listener |
| `error_ring_capacity` | object or null optional | Declared ring-buffer capacities used for error diagnostics (for reproducibility/reporting) |
| `xrFrontMinZ` | number | Requested XR forward placement anchor used by XR placement transform |
| `xrYOffset` | number | Requested XR vertical placement offset used by XR placement transform |
| `run_id` | string optional | Trace/session identifier mirrored in env metadata |
| `trace_markers_enabled` | boolean optional | Whether trace marker emission is enabled (`traceMarkers`) |
| `trace_overlay_enabled` | boolean optional | Whether on-page trace overlay is enabled (`traceOverlay`) |
| `runMode` | string |
| `battery_telemetry_requested` | boolean optional | Whether battery telemetry capture was requested |
| `connection_telemetry_requested` | boolean optional | Whether network telemetry capture was requested |
| `battery_api_available` | boolean optional | Whether Battery Status API was available |
| `connection_api_available` | boolean optional | Whether Network Information API was available |
| `online` | boolean optional | Value of `navigator.onLine` at latest env snapshot |
| `connection` | object or null optional | Latest network snapshot (`effective_type`, `rtt_ms`, `downlink_mbps`, `save_data`, `type`) |
| `connection_change_count` | number optional | Count of observed connection change events |
| `battery` | object or null optional | Battery snapshots (`start`, `latest`, `error`) |
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
| `webgl` | object or null optional |

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
| `xr_webgpu_binding_available` | boolean |
| `device_lost` | object or null optional |
| `device_lost_info` | object or null optional | Alias of `device_lost` for parser compatibility |
| `device_lost_count` | number optional | Number of observed `device.lost` events since page load |
| `webgpu_init_timeout_ms` | number optional | Timeout applied to adapter/device initialization (URL param `webgpuInitTimeoutMs`) |
| `webgpu_uncaptured_errors` | object[] or null optional |

## `env.provenance` object (shared env, optional)

Explicit run provenance for reproducibility and paper reporting.

| Field | Type | Meaning |
|---|---|---|
| `harness_version` | string | Harness version identifier |
| `harness_commit` | string or null | Commit identifier when available |
| `asset_revision` | string or null | Asset revision/hash identifier when available |
| `feature_flags_profile` | string or null | Feature-flag profile ID when available |
| `feature_flags_exact` | string or null | Exact feature-flag state string when available |
| `profiler_mode` | string or null | Profiler/trace collection mode when available |
| `profiler_config` | string or null | Free-form profiler configuration string when available |
| `xr_idle_present_mode` | string or null | XR idle presentation mode when available |
| `xr_anchor_mode` | string or null | XR anchor reuse mode when available |
| `xr_pose_stability_gate_ms` | number or null | XR pose-stability gate duration when available |
| `xr_pose_stability_pos_tol_m` | number or null | XR pose-stability position tolerance when available |
| `xr_pose_stability_yaw_tol_deg` | number or null | XR pose-stability yaw tolerance when available |
| `asset_url` | string | Model URL used by the run |

Note: `feature_flags_profile` / `feature_flags_exact` are provenance fields supplied by the operator or deployment metadata. They are not a browser-reported dump of active flag toggles.
Note: `xr_anchor_mode=session` is appropriate for immersive-vr. `xr_anchor_mode=trial` is recommended for fixed-mount immersive-ar phone runs so AR world drift does not accumulate across the entire suite.
Note: `xr_pose_stability_gate_ms` is primarily intended for fixed-mount `immersive-ar` campaigns. Use the logged provenance fields to confirm the exact per-device gate/tolerance values in a given campaign.
Note: `xr_idle_present_mode=none` preserves true-idle semantics for primary runs. `clear_each_frame` is intended for diagnostics when you need the XR compositor to keep presenting between trials.

## `partial_trial` object (abort records)

| Field | Type | Meaning |
|---|---|---|
| `elapsed_ms` | number or null | Time elapsed in current trial before abort |
| `frames_collected` | number | Canvas abort: number of collected frame deltas before abort |
| `frames_collected_t` | number | Number of primary cadence deltas (`t`) before abort |
| `frames_collected_now` | number | Number of secondary cadence deltas (`performance.now`) before abort |

## `xr_cadence_secondary` object (XR records)

| Field | Type | Meaning |
|---|---|---|
| `frames` | number | Sample count |
| `mean_ms` | number | Mean frame delta |
| `p50_ms` | number or null | Median frame delta (`null` when no frames were collected) |
| `p95_ms` | number or null | 95th percentile frame delta (`null` when no frames were collected) |
| `p99_ms` | number or null | 99th percentile frame delta (`null` when no frames were collected) |

## `xr_effective_pixels` object (XR records)

| Field | Type | Meaning |
|---|---|---|
| `requested_scale_factor` | number | `xrScaleFactor` request |
| `applied_scale_factor` | number or null | Applied layer scale factor (`null` if runtime fallback/unknown) |
| `first_frame_total_px` | number or null | Sum of per-view pixels on first measured XR frame |
| `first_frame_per_view_px` | number[] | Per-view pixel counts on first measured XR frame |

## `render_probe_xr` object (XR records)

XR render probe metadata for “did anything render” diagnostics.

| Field | Type | Meaning |
|---|---|---|
| `performed` | boolean | Whether XR probe was enabled (`renderProbe=1`) |
| `rendered_anything` | boolean or null | Probe verdict; `null` when not determined |
| `first_frame_px` | number or null | First measured XR frame pixel area (sum over views) |
| `readback_allowed` | boolean or null | Whether tiny pixel readback was possible |
| `sampled_pixel_diff` | number or null | Sum/count proxy from sampled pixels against clear color |

Note: XR probe readback is disabled by default for fairness/stability. Enable with `xrProbeReadback=1` when needed.

## `env.device_lost` object (WebGPU env, optional)

Present when the harness receives a `device.lost` signal.

Companion fields:
- `env.device_lost_info` mirrors the same object for parser compatibility.
- `env.device_lost_count` tracks how many loss events were observed.

| Field | Type | Meaning |
|---|---|---|
| `reason` | string or null | Browser/runtime loss reason |
| `message` | string or null | Runtime-provided diagnostic message |
| `phase` | string or null | Harness phase at loss (`canvas`, `xr`, `idle`) |
| `at_iso` | string or null | ISO timestamp when loss was observed |
| `at_perf_ms` | number or null | `performance.now()` when loss was observed |

## `env.webgl` object (WebGL env, optional)

WebGL context-loss diagnostics for run integrity checks.

| Field | Type | Meaning |
|---|---|---|
| `context_lost_count` | number | Count of observed `webglcontextlost` events during the suite page lifetime |
| `context_restored_count` | number | Count of observed `webglcontextrestored` events |
| `context_lost_first_at_ms` | number or null | `performance.now()` timestamp of the first observed loss |
| `context_lost_last_at_ms` | number or null | `performance.now()` timestamp of the most recent observed loss |
| `context_lost_events` | object[] | Ring buffer (last few) of context-loss event samples |
| `context_is_lost` | boolean | Whether context is currently in the lost state |

`context_lost_events[]` fields:

| Field | Type | Meaning |
|---|---|---|
| `t_ms` | number | `performance.now()` when event was observed |
| `at_iso` | string | ISO wall-clock timestamp |
| `statusMessage` | string or null | Browser/runtime message when available (`null` in most browsers) |
| `phase` | string or null | Harness phase at event (`canvas`, `xr`, `idle`) |

## `env.webgpu_uncaptured_errors[]` object (WebGPU env, optional)

Present when the harness receives WebGPU uncaptured runtime/validation errors.

| Field | Type | Meaning |
|---|---|---|
| `t_ms` | number | `performance.now()` timestamp when the error was observed |
| `name` | string or null | Error class/name when available |
| `message` | string | Runtime-provided error message |

## `env.js_errors[]` object (shared env, optional)

Global JS runtime error samples (ring buffer).

| Field | Type | Meaning |
|---|---|---|
| `t_ms` | number | `performance.now()` timestamp when the error was observed |
| `at_iso` | string | ISO wall-clock timestamp |
| `name` | string or null | Error class/name when available |
| `message` | string | Error message |
| `source` | string or null | Script URL when available |
| `lineno` | number or null | Source line when available |
| `colno` | number or null | Source column when available |

## `env.js_unhandled_rejections[]` object (shared env, optional)

Global unhandled Promise rejection samples (ring buffer).

| Field | Type | Meaning |
|---|---|---|
| `t_ms` | number | `performance.now()` timestamp when rejection was observed |
| `at_iso` | string | ISO wall-clock timestamp |
| `name` | string or null | Rejection error class/name when available |
| `message` | string | Rejection message/stringified reason |

## `env.error_ring_capacity` object (shared env, optional)

Declared ring sizes for diagnostic arrays. Keys vary by backend/runtime.

| Field | Type | Meaning |
|---|---|---|
| `js_errors` | number optional | Max retained entries in `env.js_errors` |
| `js_unhandled_rejections` | number optional | Max retained entries in `env.js_unhandled_rejections` |
| `webgl_context_lost_events` | number optional | Max retained entries in `env.webgl.context_lost_events` |
| `webgpu_uncaptured_errors` | number optional | Max retained entries in `env.webgpu_uncaptured_errors` |

## Notes for analysis and reporting

- `condition_index` is 1-based.
- For XR aborts, earlier completed XR trials remain in the same file, followed by one abort record.
- `xr_viewports` is appended every frame and can be large; treat as diagnostic metadata.
- `frames_ms` is optional and only emitted with `storeFrames=1`.
- `perf.longtask.entries` is only present when `perfDetail=1`.
- Use `schema_version` to gate parsers when fields evolve.
- `debugColor` is controlled via URL param `debugColor=flat|abspos|instance` (default `flat`).
- `xrStartOnFirstPose=1` starts XR trial timing on first valid pose (recommended when startup no-pose gaps are large).
- `xrAnchorToFirstPose=1` anchors XR placement to the first viewer pose (default ON for `layout=xrwall`).
- `runId=<id>` pins trace identity across JSONL and profiler exports; when omitted, harness auto-generates a UUID.
- `traceMarkers=1` emits User Timing + `console.timeStamp()` markers like `TRACE|TEST_START|...` / `TRACE|TEST_END|...` / `TRACE|SUITE_START|...`.
- `traceOverlay=1` shows `runId/suiteId/api` on-page to reduce manual export mix-ups.
- `webgpuInitTimeoutMs` (default `15000`) can fail fast on devices where `requestAdapter`/`requestDevice` stall.
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

Status note:
- The current `app-webgl.js` / `app-webgpu.js` entrypoints do not parse cooldown redirect params.
- Use `idle.html` and your external run orchestration for between-suite timing.

URL params:
- `cooldownPage=./idle.html` (or any same-origin page)
- `betweenSuitesMs=300000` (5 minutes; also passed into `idle.html`)
- `cooldownDelayMs=8000` (optional; redirect delay after download trigger)
- `cooldownAfter=final|canvas|xr` (default `final`)
- `xrEntryTimeoutMs=45000` (only when `mode=both` + `cooldownAfter=final`; if XR is not entered in time, harness emits an XR abort/skip record and finalizes)
