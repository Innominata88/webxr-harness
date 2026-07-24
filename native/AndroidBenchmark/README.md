# Android Native Benchmark

Status: visual-preview build. The shared experiment core, Vulkan capability
probe, and separate flat/material render paths build successfully. Benchmark
collection remains intentionally disabled until the renderer passes device
visual validation and the frame-timing loop passes schema validation.

## Implemented

- Pinned Gradle 8.1.1 and Android Gradle Plugin 8.1.4.
- Pinned SDK 33, NDK 25.1.8937393, CMake 3.22.1, and JDK 17.
- Release-only `arm64-v8a` APK with no Vulkan validation layers.
- Bundled exact Spider-Man study GLB.
- Bundled Pixel 8a and Samsung FE flat/material smoke and full plans.
- Strict `native-benchmark-manifest/v1` C++ parser.
- JavaScript-compatible Mulberry32 condition shuffle.
- JavaScript-compatible `xrwall` placement and frame-statistics formulas.
- GLB flat/material scene loader with geometry, UV, base-color texture,
  sampler, and normalization parity checks against the study asset.
- Separate `vulkan-flat` and `vulkan-basecolor` shader/pipeline paths.
- Plan-controlled scaled offscreen target, linearly blitted to the full
  swapchain (`0.50` Pixel, `0.75` Samsung).
- Choreographer-driven visual preview with a selectable instance count.
- Android Vulkan instance, surface, graphics/present queue, swapchain, and
  capability probe.
- Device/build capability evidence written to app external storage.

The preview APK does not expose a collection action. A successful capability
probe or visual preview is not benchmark data.

## Build

The Android Studio JDK is used because AGP 8.1 requires JDK 17:

```bash
native/AndroidBenchmark/scripts/build-release.sh
```

The installable APK is:

```text
native/AndroidBenchmark/app/build/outputs/apk/release/app-release.apk
```

The Release build uses Android's local debug signing key so it is installable
without committing a research or production key. It remains a non-debuggable,
optimized Release build.

## Host Tests

Run without a device:

```bash
native/AndroidBenchmark/scripts/run-host-tests.sh
```

The tests validate all four full Android plans and check:

- Pixel render scale is `0.50`
- Samsung render scale is `0.75`
- flat and material suite labels do not mix
- five native runs are present
- condition order matches JavaScript and Swift
- `xrwall` offsets match the browser formula
- percentile and jank calculations match the browser formula
- duplicate JSON keys and trailing content are rejected

## Device Visual Gate

When a phone is available:

```bash
native/AndroidBenchmark/scripts/install-setup.sh [adb-serial]
```

In the app:

1. Select a plan and press `Validate plan`.
2. Press `Probe Vulkan`.
3. Confirm the GPU, Vulkan version, surface formats, and present modes appear.
4. Select the Pixel material smoke plan, set `Preview instances` to `1`, and
   press `Preview selected`.
5. Confirm the Spider-Man model is centered, upright, visibly colored, and
   textured. Repeat at `16` preview instances.
6. Select the Pixel flat smoke plan. Confirm the same geometry is solid white
   with no material textures at `1`, then check the full flat layout at `64`.
7. Confirm the status reports `renderer=vulkan-basecolor` only for material
   and `renderer=vulkan-flat` only for flat.
8. Repeat the material `1` and flat `64` checks on Samsung. The status must
   report a `0.75` render scale rather than Pixel's `0.50`.
9. Stop immediately and retain the exact error text if a preview is blank,
   dark, inverted, clipped unexpectedly, or stops.
10. Do not collect benchmark data from this preview build.

Changing the preview instance count does not change the selected plan and does
not create a result record. It exists only to inspect geometry and layout
before the timed scheduler is enabled.

Pull the capability evidence:

```bash
native/AndroidBenchmark/scripts/pull-capabilities.sh \
  "/path/to/capability-backup" \
  [adb-serial]
```

## Bundled Plans

Pixel:

- material smoke and five-run full, `render_scale=0.50`
- flat smoke and five-run full, `render_scale=0.50`

Samsung:

- material smoke and five-run full, `render_scale=0.75`
- flat smoke and five-run full, `render_scale=0.75`

Material uses `surface_mode=basecolor`; flat uses `surface_mode=flat`. These
plans remain separate throughout collection and analysis.

## Remaining Before Collection

1. Pass the Pixel and Samsung device visual gate above.
2. Add Choreographer-driven warmup, measurement, cooldown, and run scheduling.
3. Add per-frame timing resources without merging flat and material paths.
4. Flush one schema-valid JSONL record after every trial.
5. Pass one Pixel material smoke result through
   `tools/validate-native-results.mjs`.

Only then should the Pixel full cohort begin. Samsung reuses the same APK and
starts after the Pixel pilot passes without device-specific renderer changes.
