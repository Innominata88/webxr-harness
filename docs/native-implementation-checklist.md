# Native Implementation and Collection Checklist

Last updated: 2026-07-24

## Objective

Complete a defensible browser-versus-native comparison across the study
devices without delaying paper writing until every platform is finished.

The critical path is:

`contract -> Mac material pilot -> Pixel material pilot -> paper results draft`

The completion path then continues:

`Apple family -> Android phones -> Android headsets -> Windows family`

## Scope Freeze

Native v1 includes:

- one native graphics API per platform:
  - Metal on Apple
  - Vulkan on Android
  - D3D11 on Windows
- separate `flat` and `basecolor` suites
- native windowed rendering on conventional displays
- ARCore on Pixel and Samsung
- OpenXR on Quest, Magic Leap, and HoloLens
- the same asset, layout, instance ladders, trial timing, and summary metrics as
  the matching browser suite

Native v1 does not include:

- native OpenGL ES as a second Android API
- engine comparisons such as Unity versus Unreal
- byte-identical cross-platform shaders
- GPU completion time as the primary metric
- native emulation of browser Canvas on immersive-only devices

## Paper-Ready Definition

Paper writing does not need to wait for every native device.

The native method is ready to write when:

- [x] the native manifest/result contract is frozen for the Mac pilot
- [x] flat and material paths have distinct suite IDs and output metadata
- [ ] material visual parity passes on Mac and Pixel
- [ ] Mac Metal material smoke and full collection pass quality checks
- [ ] Pixel Vulkan material smoke and full collection pass quality checks
- [ ] the limitation of non-contemporaneous browser/native collection is
      documented

The full native study is complete when all applicable device/mode cells below
are complete or have a documented capability stop.

## Device Matrix

| Device | Native Canvas/windowed | Native AR/XR | Priority | Status |
| --- | --- | --- | --- | --- |
| MacBook Pro M1 | Metal flat + material | N/A | 1 | Prototype needs correction |
| iPad Air M3 | Metal flat + material | Optional unless required | 2 | Not implemented |
| Apple Vision Pro | Metal windowed | visionOS immersive | 3 | Not implemented |
| Pixel 8a | Vulkan flat + material | ARCore Vulkan AR | 4 | Not implemented |
| Samsung Galaxy FE | Vulkan flat + material | ARCore Vulkan AR | 5 | Not implemented |
| Quest 2 | N/A for main native comparison | OpenXR Vulkan | 6 | Not implemented |
| Magic Leap 2 | N/A for main native comparison | OpenXR Vulkan | 7 | Not implemented |
| HP laptop | D3D11 flat + material | N/A | 8 | Not implemented |
| HoloLens 2 | N/A for main native comparison | OpenXR D3D11 | 9 | Not implemented |

## Stage 0: Contract and Audit

Target: 2-3 focused work sessions.

- [x] Freeze the native result fields required for the Mac pilot.
- [x] Define explicit native values for:
  - [x] `api`
  - [x] `mode`
  - [x] `surface_mode`
  - [x] `runtime_family`
  - [x] `xr_runtime`
  - [x] `timing_source_primary`
  - [x] `device_model`
  - [x] `os_version`
- [x] Add a native-plan generator that reads workload parameters from one web
      manifest row but emits exactly five native repetitions.
- [x] Do not replay all ten rows of a paired WebGL2/WebGPU manifest.
- [x] Add distinct suite naming:
  - [x] native material suite IDs include `_MATERIAL_`
  - [x] native flat/primary plans retain `surface_mode=flat`
- [x] Add a hard runtime check that rejects a material suite if
      `surface_mode != basecolor`.
- [x] Add a hard runtime check that prevents a non-material suite from using
      `surface_mode=basecolor`.
- [x] Confirm the analysis importer accepts native APIs without merging them into
      WebGL2 or WebGPU.
- [x] Add a strict native-result validator and test fixture.
- [ ] Save a one-trial JSONL fixture for each native mode.

Exit gate:

- A malformed or mislabeled material run must fail before measurement.
- A full native plan must contain five native runs, not ten.
- The fixture must pass schema, ingestion, and deduplication checks.

## Week 1: Correct and Validate Mac Metal

Implementation:

- [x] Preserve the existing flat renderer as `surface_mode=flat`.
- [x] Extend the GLB loader to retain:
  - [x] per-primitive positions and indices
  - [x] `TEXCOORD_0`
  - [x] base color factor
  - [x] base color texture
  - [x] glTF sampler settings
- [x] Add an unlit base-color Metal pipeline.
- [x] Match browser material behavior:
  - [x] instanced draw per primitive
  - [x] texture multiplied by base color factor
  - [x] white texture fallback
  - [x] alpha discard at `<= 0.001`
  - [x] alpha blending
- [x] Record primitive and texture counts in output metadata.
- [x] Correct native repetition planning.

Validation:

- [ ] Flat screenshot at `1i`.
- [ ] Flat screenshot at `16i`.
- [ ] Material screenshot at `1i`.
- [ ] Material screenshot at `16i`.
- [ ] Compare native screenshots with browser reference screenshots.
- [ ] Verify the material model is visibly textured and not solid white.
- [ ] Verify no material result is written by the flat pipeline.
- [ ] Run one smoke plan.
- [ ] Validate JSONL.
- [ ] Run Release mode only.

Collection:

- [ ] Mac material smoke.
- [ ] Mac material full, five independent native runs.
- [ ] Mac flat smoke.
- [ ] Mac flat full only after material is complete.

Exit gate:

- Mac material full is visually valid, structurally valid, and accepted by the
  analysis pipeline.

## Week 2: Apple Portability

iPad:

- [ ] Create the iOS/iPadOS target using the shared Metal core.
- [ ] Confirm fixed render scale and drawable size metadata.
- [ ] Run flat and material screenshots.
- [ ] Run material smoke.
- [ ] Run material full.
- [ ] Run flat full.

Apple Vision Pro:

- [ ] Create the visionOS target.
- [ ] Validate a windowed Metal path only if it maps to the browser Canvas
      question.
- [ ] Add the immersive visionOS render loop.
- [ ] Record view count, per-view viewport, and immersive timing source.
- [ ] Validate object scale and placement against the browser XR protocol.
- [ ] Run material smoke before any full suite.
- [ ] Run native immersive material full.
- [ ] Run native immersive flat full separately.

Exit gate:

- Shared Apple rendering code produces the same flat/material definitions on
  Mac, iPad, and AVP.

## Week 3: Android Vulkan Canvas

Shared Android core:

- [ ] Create `native/AndroidBenchmark`.
- [ ] Add Kotlin lifecycle/file-selection shell.
- [ ] Add C++ manifest, GLB, condition-plan, timing, JSONL, and Vulkan modules.
- [ ] Bundle or select the exact study asset revision.
- [ ] Implement flat and base-color Vulkan pipelines.
- [ ] Implement the `xrwall` instance layout and seeded shuffle.
- [ ] Use Android frame callback cadence as the primary windowed timing source.
- [ ] Record device, OS, GPU, driver, display refresh, and thermal metadata.

Pixel pilot:

- [ ] Install Release APK.
- [ ] Material screenshot at `1i`.
- [ ] Material screenshot at `16i`.
- [ ] Material smoke.
- [ ] Validate JSONL and copied files.
- [ ] Material full.
- [ ] Flat smoke and full.

Samsung replication:

- [ ] Repeat the same visual gates.
- [ ] Material smoke and full.
- [ ] Flat smoke and full.
- [ ] Record any device-specific render-scale difference.

Exit gate:

- The same APK and renderer core complete valid Pixel and Samsung material
  cohorts without device-specific workload changes.

## Week 4: Android Phone AR

Implementation:

- [ ] Add ARCore lifecycle and camera permission handling.
- [ ] Render the real camera passthrough supplied by ARCore.
- [ ] Use the same base-color renderer core over the AR background.
- [ ] Anchor the model relative to the first stable pose.
- [ ] Port the browser pose-start and placement semantics where they are
      meaningful natively.
- [ ] Record tracking state and lost-tracking intervals.
- [ ] Use frame callback cadence as primary timing.
- [ ] Record AR camera timestamps as a secondary timing source.

Pixel:

- [ ] Verify passthrough is visible.
- [ ] Verify model visibility and material appearance.
- [ ] Material AR smoke.
- [ ] Material AR full.
- [ ] Stress AR smoke.
- [ ] Stress AR full only if the regular ladder is clean.

Samsung:

- [ ] Repeat passthrough and model checks.
- [ ] Material AR smoke.
- [ ] Material AR full.
- [ ] Stress AR smoke.
- [ ] Stress AR full only if the regular ladder is clean.

Exit gate:

- No black-background run is accepted as native AR.
- Tracking failures are recorded separately from rendering performance.

## Week 5: Android OpenXR Headsets

Quest 2:

- [ ] Add OpenXR loader/runtime target.
- [ ] Reuse the Vulkan mesh/material core.
- [ ] Validate view configuration and swapchain format.
- [ ] Match immersive object scale and placement.
- [ ] Record `predictedDisplayTime` cadence as primary.
- [ ] Record monotonic host timing as secondary.
- [ ] Material smoke.
- [ ] Material full.
- [ ] Flat smoke and full separately.

Magic Leap 2:

- [ ] Package the same OpenXR Vulkan core for Magic Leap.
- [ ] Confirm required Magic Leap OpenXR extensions.
- [ ] Validate passthrough/environment visibility.
- [ ] Material smoke.
- [ ] Material full.
- [ ] Flat smoke and full separately.

Stop rule:

- A missing browser capability is not a reason to stop the native OpenXR test.
- Stop only if the native runtime/API cannot create the required session or
  render the validated workload, and save the capability evidence.

## Week 6: Windows D3D11 and HoloLens

HP laptop:

- [ ] Create shared D3D11 renderer core.
- [ ] Implement flat and base-color material paths.
- [ ] Implement manifest plan and JSONL output.
- [ ] Validate visual parity.
- [ ] Material smoke and full.
- [ ] Flat smoke and full.

HoloLens 2:

- [ ] Add OpenXR session and D3D11 swapchains.
- [ ] Reuse the D3D11 material renderer.
- [ ] Validate passthrough/environment and model appearance.
- [ ] Explicitly compare native material appearance with the darkened browser
      WebGPU Canvas observation.
- [ ] Material smoke and full.
- [ ] Flat smoke and full separately.

Exit gate:

- HoloLens native results are not combined with the caveated browser Canvas or
  failed browser XR results.

## Optional Same-Session Sensitivity Experiment

The existing browser runs and new native runs are not contemporaneous. Report
the main native extension as a matched-protocol comparison, not a randomized
same-session experiment.

For a stronger order and thermal-control sensitivity check:

- [ ] Repeat a small material cohort on MacBook Pro.
- [ ] Repeat a small material cohort on Pixel 8a.
- [ ] Use six blocks covering all three-condition permutations:
  - [ ] WebGL2, WebGPU, native
  - [ ] WebGL2, native, WebGPU
  - [ ] WebGPU, WebGL2, native
  - [ ] WebGPU, native, WebGL2
  - [ ] native, WebGL2, WebGPU
  - [ ] native, WebGPU, WebGL2
- [ ] Apply the same cooldown between conditions.
- [ ] Analyze this as a sensitivity check, not as a replacement for the full
      browser dataset.

## Collection Rules

Before each cohort:

- [ ] Confirm device and OS version.
- [ ] Confirm app build ID and source commit.
- [ ] Confirm asset hash.
- [ ] Confirm exact mode and `surface_mode`.
- [ ] Confirm fixed scale/drawable configuration.
- [ ] Confirm Release build and no validation layers.
- [ ] Start from the documented battery/thermal state.

After each run:

- [ ] Confirm the expected record count.
- [ ] Confirm no abort or device-loss record.
- [ ] Confirm mode and material labels.
- [ ] Confirm nonzero frames and plausible duration.
- [ ] Copy results before changing device or build.
- [ ] Record operator notes without editing raw JSONL.

After each cohort:

- [ ] Run validation.
- [ ] Run quality checks.
- [ ] Deduplicate.
- [ ] Save manifests/plans used.
- [ ] Save app build provenance.
- [ ] Save visual validation screenshots.
- [ ] Update the completion matrix.

## Data Layout

Use this structure in the existing backup tree:

```text
Data Collection/
  Native Comparison/
    Apple/
      MacBook Pro M1/
        Canvas Material/
        Canvas Flat/
      iPad Air M3/
        Canvas Material/
        Canvas Flat/
      Apple Vision Pro/
        Immersive Material/
        Immersive Flat/
    Android/
      Pixel 8a/
        Canvas Material/
        Canvas Flat/
        AR Material/
        AR Stress/
      Samsung Galaxy FE/
        Canvas Material/
        Canvas Flat/
        AR Material/
        AR Stress/
      Quest 2/
        Immersive Material/
        Immersive Flat/
      Magic Leap 2/
        Immersive Material/
        Immersive Flat/
    Windows/
      HP Laptop/
        Canvas Material/
        Canvas Flat/
      HoloLens 2/
        Immersive Material/
        Immersive Flat/
```

Each leaf should contain:

```text
results/
manifests-used/
build-provenance/
visual-validation/
operator-notes/
```

## Writing in Parallel

Start now:

- [ ] Methods: browser workload definitions.
- [ ] Methods: native family design.
- [ ] Methods: timing-source limitations.
- [ ] Methods: flat/material separation.
- [ ] Results: browser core findings.
- [ ] Results: phone AR reevaluation.
- [ ] Limitations: HoloLens and Magic Leap browser capability results.

Start after Mac and Pixel pilots:

- [ ] Results: browser-versus-native material comparison.
- [ ] Discussion: runtime overhead versus platform/runtime differences.
- [ ] Limitations: non-contemporaneous native collection.

Do not wait for:

- every headset native result before drafting Methods
- the Windows family before drafting browser Results
- optional same-session sensitivity runs before drafting the main paper
