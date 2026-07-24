# Android Native Benchmark Harness Specification

Status: implementation specification

Last updated: 2026-07-24

## 1. Purpose

Build one Android-native benchmark family that can compare the existing browser
workloads with:

- native Vulkan windowed rendering on Pixel 8a and Samsung Galaxy FE
- native ARCore plus Vulkan on Pixel 8a and Samsung Galaxy FE
- native OpenXR plus Vulkan on Quest 2 and Magic Leap 2

The Android harness must preserve workload structure and output semantics. It
does not need to reproduce browser internals.

## 2. Non-Negotiable Study Rules

1. Flat and material are separate workloads.
2. A material suite must use the base-color material renderer.
3. A flat suite must use the flat solid-color renderer.
4. A paired browser manifest is a parameter source, not a native run schedule.
5. A five-repetition native cohort produces five native runs, not ten.
6. Phone AR requires live ARCore camera passthrough.
7. Headset native testing uses immersive OpenXR, not a simulated Canvas surface.
8. Primary cadence metrics use runtime/frame callback timing. GPU timestamps
   are optional secondary diagnostics.

## 3. Supported Modes

| `mode` | Devices | Runtime | Renderer | Primary timing |
| --- | --- | --- | --- | --- |
| `canvas` | Pixel, Samsung | Android window + frame callbacks | Vulkan | frame callback timestamp deltas |
| `ar` | Pixel, Samsung | ARCore | Vulkan | frame callback timestamp deltas |
| `xr` | Quest, Magic Leap | OpenXR | Vulkan | `XrFrameState.predictedDisplayTime` deltas |

Secondary timing:

- `canvas`: `CLOCK_MONOTONIC` render-loop deltas
- `ar`: ARCore camera frame timestamps and `CLOCK_MONOTONIC`
- `xr`: `CLOCK_MONOTONIC` around `xrWaitFrame`/`xrEndFrame`
- all modes: Vulkan timestamp queries when available, reported separately

## 4. Workload Definitions

### Flat

The flat path matches the browser flat renderer:

- merge all GLB mesh primitives into one normalized position/index mesh
- no UVs or material textures
- solid white fragment output
- one instanced indexed draw per view
- suite and output metadata contain `surface_mode=flat`

### Material

The material path matches browser `surfaceMode=basecolor`:

- preserve mesh primitives
- preserve normalized per-primitive positions
- preserve `TEXCOORD_0`
- preserve indices
- preserve glTF `baseColorFactor`
- preserve glTF `baseColorTexture`
- preserve wrap and filtering sampler state
- use an unlit base-color shader
- multiply sampled texture by base-color factor
- use a white texture when no usable texture is available
- discard fragments with alpha `<= 0.001`
- enable source-alpha blending
- issue one instanced draw per source primitive per view
- suite and output metadata contain `surface_mode=basecolor`

`debugColor=flat` in the browser manifest describes the debug-color selection
for the flat shader. It must not override `surfaceMode=basecolor`.

## 5. Proposed Repository Layout

```text
native/
  AndroidBenchmark/
    README.md
    settings.gradle.kts
    build.gradle.kts
    gradle.properties
    app/
      build.gradle.kts
      src/
        main/
          AndroidManifest.xml
          assets/
            benchmark/
              model.glb
              plans/
          java/.../BenchmarkActivity.kt
          java/.../BenchmarkFiles.kt
          java/.../BenchmarkStatus.kt
          cpp/
            CMakeLists.txt
            jni_bridge.cpp
            app/
              benchmark_app.cpp
              benchmark_app.h
            core/
              benchmark_plan.cpp
              benchmark_plan.h
              condition_plan.cpp
              condition_plan.h
              result_record.cpp
              result_record.h
              run_controller.cpp
              run_controller.h
              timing.cpp
              timing.h
            asset/
              glb_loader.cpp
              glb_loader.h
              material_scene.h
            render/
              renderer.h
              vulkan_context.cpp
              vulkan_context.h
              vulkan_flat_renderer.cpp
              vulkan_flat_renderer.h
              vulkan_material_renderer.cpp
              vulkan_material_renderer.h
              instance_layout.cpp
              instance_layout.h
              shaders/
            runtime/
              window_runtime.cpp
              window_runtime.h
              arcore_runtime.cpp
              arcore_runtime.h
              openxr_runtime.cpp
              openxr_runtime.h
            telemetry/
              android_device_info.cpp
              android_device_info.h
              thermal_info.cpp
              thermal_info.h
            tests/
              condition_plan_test.cpp
              manifest_test.cpp
              glb_parity_test.cpp
              stats_test.cpp
```

## 6. Application Architecture

### Kotlin shell

Responsibilities:

- Activity and Android lifecycle
- camera permission for ARCore
- ARCore install/update flow
- file picker or bundled-plan selection
- persistent output directory selection
- run status, progress, and abort display
- copying/sharing completed JSONL files
- forwarding surface and lifecycle events through JNI

The Kotlin layer must not calculate benchmark metrics.

### C++ benchmark core

Responsibilities:

- parse native benchmark plans
- load and normalize GLB data
- generate seeded condition order
- manage warmup, measurement, cooldown, and between-instance waits
- choose flat or material renderer
- collect frame cadence
- calculate summaries
- emit one JSONL record per trial
- own runtime-neutral renderer interfaces

Use one shared C++ core for all Android devices. Device-specific branches belong
only in runtime/capability adapters.

### Vulkan renderer

Responsibilities:

- instance buffers and draw submission
- depth buffer and render targets
- flat and material pipeline creation
- texture upload and sampler mapping
- per-view camera data
- optional timestamp query collection
- context/device-loss reporting

The renderer must expose the active path in every result:

- `renderer_path=vulkan-flat`
- `renderer_path=vulkan-basecolor`

## 7. Plan Format

Use a native plan generated from the browser manifest. Do not make the Android
app infer a native schedule from paired browser rows at runtime.

Proposed schema:

```json
{
  "schema": "native-benchmark-manifest/v1",
  "plan_id": "pixel8a_native_canvas_material_regular_v1",
  "source_manifest": "pixel8a_canvas_material_complexity_regular_paired_5sets.json",
  "source_harness_commit": "84bb3bc",
  "asset_revision": "spiderman_2002_movie_version_sam_raimi_0",
  "device_group": "pixel8a",
  "runtime_family": "native-android",
  "api": "vulkan",
  "mode": "canvas",
  "surface_mode": "basecolor",
  "render_scale": 0.5,
  "layout": "xrwall",
  "spacing": 0.35,
  "instances": [1, 2, 4, 8, 16, 32],
  "trials_per_instance": 5,
  "duration_ms": 6000,
  "warmup_ms": 500,
  "cooldown_ms": 1000,
  "between_instances_ms": 800,
  "between_runs_ms": 300000,
  "min_frames": 30,
  "seed": 12345,
  "shuffle": true,
  "run_count": 5
}
```

The generator must:

1. parse one representative browser row
2. verify all rows in the source manifest use the same workload parameters
3. ignore browser `api`, browser output name, and browser run order
4. emit exactly `run_count` native run IDs
5. include source manifest and commit provenance
6. reject mixed `surfaceMode` or mixed instance ladders

Suggested tool:

```text
tools/generate-native-plan.mjs
```

## 8. Runtime Validation

Reject the plan before rendering when:

- `schema` is unsupported
- `api != vulkan`
- `mode` is not supported by the installed build flavor
- `surface_mode` is not `flat` or `basecolor`
- `render_scale` is not greater than zero and at most one
- a material suite ID is paired with `surface_mode=flat`
- a flat suite ID is paired with `surface_mode=basecolor`
- the asset revision does not match the bundled/selected asset
- run count, instances, trials, or duration are invalid
- an AR plan starts without camera permission or ARCore support
- an XR plan starts without a supported OpenXR system/view configuration

For AR, also reject measurement until:

- live passthrough is visible
- tracking state is `TRACKING`
- at least one valid pose has been received
- the model has been placed and is in the expected view volume

## 9. Condition Planning

Port the existing JS/Swift behavior exactly:

- build `(instances, trial)` pairs in instance-major order
- apply Fisher-Yates shuffle when enabled
- use the same 32-bit `mulberry32` implementation
- keep trial numbers one-based
- record shuffled `condition_index`

Required golden test:

- one fixed input plan must produce the same ordered list in JavaScript, Swift,
  and C++

Instance layout must match existing `xrwall` semantics and spacing. AR/XR
placement offsets are applied by the runtime layer after generating the shared
local offsets.

## 10. Trial State Machine

Use this state machine in all modes:

```text
idle
  -> loading
  -> ready
  -> warmup
  -> measuring
  -> trial_cooldown
  -> between_instances
  -> next_condition
  -> between_runs
  -> complete

Any state
  -> aborted
```

Rules:

- clear cadence samples when measurement starts
- the first measured callback establishes the previous timestamp and does not
  emit a delta
- stop only after both `duration_ms` and `min_frames` are satisfied
- write each trial record immediately after it completes
- flush the file after every record
- never rewrite a completed raw result file

## 11. Timing and Metrics

Primary summary fields:

- `frames`
- `duration_ms`
- `mean_ms`
- `p50_ms`
- `p95_ms`
- `p99_ms`
- `fps_effective`
- `fps_from_mean`
- `max_frame_ms`
- `missed_1p5x`
- `missed_2x`
- `jank_p99_over_p50`

Use the same percentile formula as the browser harness:

```text
sorted[floor(p * (n - 1))]
```

Primary cadence is not GPU execution time. Record timing identity explicitly:

```json
{
  "timing_source_primary": "android_choreographer",
  "timing_source_secondary": "clock_monotonic",
  "gpu_timing_available": true
}
```

For OpenXR:

```json
{
  "timing_source_primary": "openxr_predicted_display_time",
  "timing_source_secondary": "clock_monotonic"
}
```

GPU timestamps, if collected, go in a separate `gpu_timing` object and must not
replace the callback-cadence summary.

## 12. Result Contract

Keep the existing top-level shape where possible:

```json
{
  "schema_version": "1.1.0",
  "api": "vulkan",
  "mode": "canvas",
  "trial": 1,
  "trials": 5,
  "instances": 16,
  "condition_index": 3,
  "suiteId": "PIXEL8A_NATIVE_CANVAS_MATERIAL_REGULAR",
  "runId": "pixel8a_native_canvas_material_regular_r01",
  "started_at": "2026-07-24T12:00:00Z",
  "summary": {},
  "extras": {},
  "env": {},
  "scene": {}
}
```

Required `env` fields:

- `runtime_family=native-android`
- `runtime_mode=window|arcore|openxr`
- `xr_runtime=none|arcore|openxr`
- `renderer_path=vulkan-flat|vulkan-basecolor`
- `surface_mode=flat|basecolor`
- `render_scale`
- `device_manufacturer`
- `device_model`
- `device_code_name`
- `os_version`
- `sdk_level`
- `build_fingerprint`
- `gpu_vendor`
- `gpu_renderer`
- `vulkan_api_version`
- `graphics_driver`
- `display_refresh_hz`
- `drawable_width`
- `drawable_height`
- `render_scale`
- `timing_source_primary`
- `timing_source_secondary`
- `thermal_status_start`
- `thermal_status_end`
- `app_version`
- `app_commit`
- `source_harness_commit`
- `asset_revision`
- `plan_id`

Required material scene fields:

- `surface_mode`
- `vertex_count`
- `index_count`
- `triangle_count`
- `primitives_loaded`
- `textured_primitives_loaded`
- `materials_total`
- `images_total`
- `textures_total`
- `material_scene_primitives`
- `material_scene_textures`
- `norm_scale`
- `norm_center`
- `norm_max_dim`

AR/XR additions:

- tracking state counts
- lost-tracking duration
- view count
- per-view viewport dimensions
- session/runtime name and version
- reference space
- passthrough/environment mode
- placement mode

## 13. Output Files

Write to app-specific external storage first, then copy through the Android
Storage Access Framework into the selected collection directory.

Filename pattern:

```text
results__run=<run_id>__a=vulkan__m=<canvas|ar|xr>__s=<flat|basecolor>__d=<device>__ts=<timestamp>.jsonl
```

Create a sidecar once per app build:

```text
build-provenance__app=<version>__commit=<short_commit>.json
```

The sidecar includes:

- app commit
- dirty-worktree flag at build time
- Gradle version
- Android Gradle Plugin version
- NDK version
- CMake version
- shader hashes
- asset hash
- enabled runtime build flavor

## 14. Build Flavors

Use runtime-specific product flavors with one shared C++ core:

- `phoneWindow`
- `phoneArcore`
- `questOpenxr`
- `magicLeapOpenxr`

Reasons:

- phone AR requires ARCore dependencies and camera permissions
- Quest and Magic Leap have runtime/package metadata differences
- separate flavors reduce accidental capability or permission drift
- the benchmark core and Vulkan material implementation remain shared

Pin tool and SDK versions in the repository when implementation starts. Record
those exact versions in build provenance rather than relying on "latest".

## 15. Visual Validation

Before timing collection on each device:

1. render flat at `1i`
2. render flat at `16i`
3. render material at `1i`
4. render material at `16i`
5. save screenshots
6. compare silhouette, texture orientation, alpha handling, object scale, and
   instance placement with browser references

Material passes only when:

- texture/color is visible
- the renderer reports `vulkan-basecolor`
- material primitive/texture counts are nonzero where expected
- the image is not the solid-white flat output

AR passes only when:

- live camera passthrough is visible
- the model is stable enough to remain in the test volume
- tracking diagnostics are recorded

## 16. Automated Tests

Required before the Pixel full cohort:

- manifest parser rejects mixed/mislabeled plans
- native generator emits five runs from a ten-row paired browser manifest
- condition-order golden test matches JavaScript
- `xrwall` offset golden test matches JavaScript
- GLB normalization values match browser loader within tolerance
- flat mesh counts match browser scene metadata
- material primitive and texture counts match browser scene metadata
- stats fixture matches browser `mean`, percentiles, FPS, and jank values
- result fixture passes `analysis/prepare-data.mjs`
- duplicate native run IDs are rejected

## 17. Manual Acceptance Tests

Pixel 8a is the pilot device.

Pilot sequence:

1. install `phoneWindowRelease`
2. validate flat screenshots
3. validate material screenshots
4. run one material smoke plan
5. copy output
6. run schema and quality checks
7. run one five-repetition material cohort
8. review thermal drift
9. only then install and validate `phoneArcoreRelease`

Samsung collection starts only after the Pixel windowed pilot passes without
device-specific code changes.

## 18. Failure and Stop Rules

Abort and preserve a result record for:

- Vulkan device loss
- swapchain recreation failure
- surface loss
- ARCore session failure
- OpenXR session loss
- missing pose beyond the grace interval
- tracking loss beyond the configured threshold
- invalid view count
- asset revision mismatch
- renderer/suite surface-mode mismatch

Do not promote from smoke to full when:

- material appearance is wrong
- passthrough is black or absent
- output metadata identifies the wrong renderer path
- expected record count is wrong
- timing source is missing
- thermal state is severe at cohort start

## 19. Implementation Order

1. Core plan, condition, stats, and JSONL modules
2. Vulkan context and window runtime
3. Flat renderer
4. Material GLB loader and renderer
5. Pixel visual validation
6. Pixel Canvas smoke and full
7. Samsung Canvas smoke and full
8. ARCore runtime
9. Pixel and Samsung AR
10. OpenXR runtime
11. Quest
12. Magic Leap

## 20. Definition of Done

The Android family is complete when:

- Pixel and Samsung have separate valid flat and material windowed cohorts
- Pixel and Samsung have valid material AR cohorts with real passthrough
- Quest and Magic Leap have valid native OpenXR material cohorts or a preserved
  native capability stop
- all raw records pass schema, ingestion, deduplication, and quality checks
- app build provenance, plans, screenshots, and operator notes are archived
- analysis never combines flat and material suites
