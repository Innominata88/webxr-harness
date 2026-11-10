# Apple Vision Pro Native Immersive Benchmark

This target runs the material Spider-Man workload through native Metal and
Compositor Services in a fully immersive visionOS space. It is the native
companion to the AVP WebGL2/WebXR and WebGPU/WebXR cohorts.

It does **not** implement "native WebGL" or "native WebGPU." The comparison has
three runtime paths:

1. Safari WebGL2 + WebXR
2. Safari WebGPU + WebXR
3. Native Metal + Compositor Services

The study can compare observed application/compositor cadence among those
paths. It cannot assign a difference specifically to browser overhead or claim
direct GPU execution time.

## What Is Matched

- device: Apple Vision Pro
- presentation mode: fully immersive VR
- asset: `spiderman_2002_movie_version_sam_raimi_0.glb`
- workload: unlit base-color material rendering, never flat shading
- layout: `xrwall`, spacing `0.35`
- placement: session-level first-pose anchor, front Z `-2.5`, Y `1.4`
- trials: 5 per instance count
- measured duration: 6 seconds after a 500 ms warmup
- condition shuffle: seed `12345`
- full replication: 10 run sets
- within-run idle presentation: models are cleared between trials and instance
  counts using the browser's opaque-black idle clear (`clear_each_frame`)
- between-run recovery: the immersive session closes for each five-minute
  cooldown and a fresh session opens for the next run, matching the browser
  launcher's return to its non-immersive window

The browser used `xrScaleFactor=0.25`. Compositor Services does not expose the
same WebXR scale control. On visionOS 26, the native layer requests the maximum
render quality and uses the compositor-provided variable-rasterization maps so
fine material details are not limited by the platform's lower default drawable
resolution. The native plan reports `render_scale=1`, records the actual
per-eye drawable dimensions and rasterization-rate-map count, and preserves
`source_webxr_scale_factor=0.25` as source metadata. This prevents the results
from falsely claiming identical pixel workloads.

Safari and WebXR may choose their own projection-layer and foveation behavior.
Interpret the native results as a comparison of complete runtime paths rather
than an isolated API-overhead experiment.

The asset's indexed-PNG material uses a Core Graphics fallback decoder. Its
bitmap rows are uploaded in top-left orientation to match MetalKit and the web
renderers; an additional vertical flip moves the gray chest logo outside the
UV region used by the logo primitive.

## Timing Meaning

The primary intervals are differences between consecutive Compositor Services
predicted presentation times for frames the app submits. Monotonic wall-clock
loop intervals are retained as a secondary diagnostic. Neither series is a
Metal GPU-duration measurement or direct proof that every frame was displayed.

Apple's Compositor Services documentation describes the custom render loop,
predicted frame timing, per-eye drawables, device anchors, and Metal
presentation used here:

- [Drawing fully immersive content using Metal](https://developer.apple.com/documentation/CompositorServices/drawing-fully-immersive-content-using-metal)
- [LayerRenderer](https://developer.apple.com/documentation/compositorservices/layerrenderer)
- [LayerRenderer.Frame](https://developer.apple.com/documentation/compositorservices/layerrenderer/frame)
- [LayerRenderer.Drawable](https://developer.apple.com/documentation/compositorservices/layerrenderer/drawable)

## Build And Install

1. Accept the installed Xcode license once:

   ```sh
   sudo xcodebuild -license
   sudo xcodebuild -runFirstLaunch
   xcodebuild -downloadComponent MetalToolchain
   ```

2. Open `native/VisionProBenchmark/VisionProBenchmark.xcodeproj` in Xcode.
3. Select the `VisionProBenchmark` target and choose your development team
   under Signing & Capabilities.
4. Pair the Apple Vision Pro with Xcode, enable Developer Mode if Xcode asks,
   and select the physical headset as the run destination.
5. Use the shared `VisionProBenchmark` scheme in **Release** configuration.
6. Build and run on the physical headset. Simulator output is a functional
   check only and is invalid experimental data because it may expose one view.

The app bundles the model and all plans. No network connection is required for
native collection.

## Operator Flow

1. Select a plan in the control window.
2. Choose **Enter Immersive (Debug)**.
3. Confirm the status becomes `Immersive Metal renderer ready`.
4. Enter the native Git commit shown by `git rev-parse --short HEAD`. Append
   `-dirty` if the installed build contains uncommitted changes.
5. Visually confirm the colored models are visible, fixed in the room, and
   present in both eyes when using the physical headset.
6. If system screenshots are unavailable, choose **Export First-Eye Render
   Target** before collection and export the PNG. This is not a screenshot of
   the headset view: it captures the app's first-eye color attachment without
   compositor effects. Treat it only as a render-target diagnostic.
7. Exit debug immersion and choose **Start Selected Campaign** from the control
   window. Campaign collection cannot begin while debug immersion is open.
8. Keep the headset worn during each measured run. The control panel hides
   while a run is active and the app exits immersion after each run.
9. Wait for the five-minute cooldown to finish in the control window, then
   choose **Continue Next Run**. This opens a fresh immersive session and hides
   the controls before the next measurement begins.
10. Do not capture a preview, record an Instruments trace, or run another app
    during baseline collection.
11. Export the latest JSONL after each run. The app also stores files under
   `Documents/AVP Native XR/<cohort>`.

During short trial and instance cooldowns, the app clears all benchmark models
and leaves only the uniform immersive background. During the five-minute
between-run cooldown, immersion is closed and the control window is visible.
Models remaining on screen during a short cooldown, or immersion remaining open
during a between-run cooldown, indicates a protocol failure; cancel that
collection rather than treating the following run as valid.

Validate exported files on the Mac:

```sh
node tools/validate-native-results.mjs "/path/to/results.jsonl"
```

A full plan must produce 10 files with 25 condition records in each file. A
smoke file has one record. Do not combine smoke or sanity records with the full
experimental cohort.

After validation, place full-cohort files in the existing backup tree:

- regular: `Material Baseline/AVP Native XR`
- stress: `Material Baseline/Stress A/AVP Native XR`
- smoke, sanity, and failed attempts: a separate `AVP Native XR Qualification`
  folder, never inside either analysis cohort

## Plans

| Plan | Instances | Runs | Purpose |
| --- | --- | ---: | --- |
| Regular smoke | 1 | 1 | rendering and export gate |
| Stress smoke | 8 | 1 | stress-path rendering gate |
| Regular sanity | 1, 2, 4, 8, 16 | 2 | complete-plan rehearsal |
| Stress sanity | 8, 16, 32, 48, 64 | 2 | high-load rehearsal |
| Regular full | 1, 2, 4, 8, 16 | 10 | final regular cohort |
| Stress full | 8, 16, 32, 48, 64 | 10 | final stress cohort |

Each full native cohort takes about 76 minutes, including the prescribed
five-minute cooldowns between its 10 runs.
