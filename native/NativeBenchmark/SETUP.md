# NativeBenchmark Setup and Collection

Status: the Release app builds and is ready for the Mac smoke gate. Visual
validation is still required before full collection.

## Prerequisites

- Xcode with the macOS SDK
- Xcode Metal Toolchain component
- macOS 13 or later deployment target

If Xcode reports that the Metal compiler is missing, install the Metal
Toolchain from Xcode's Components settings. The command-line equivalent shown
by Xcode is:

```bash
xcodebuild -downloadComponent MetalToolchain
```

## Open the Xcode Project

Open:

```text
native/NativeBenchmark/NativeBenchmark.xcodeproj
```

The shared `NativeBenchmark` scheme launches with the Release configuration.

Use these target settings:

| Setting | Value |
| --- | --- |
| Deployment target | macOS 13.0 or later |
| Metal API Validation | Enabled for Debug, disabled for Release |
| Swift optimization | Release |
| App Sandbox | Disabled for the local research build so results can be written to Downloads |

Always collect benchmark data with a Release build.

## Native Plans

The app only accepts `native-benchmark-manifest/v1` plans. It deliberately
rejects browser manifests so a paired ten-row WebGL2/WebGPU manifest cannot
accidentally produce ten Metal runs.

Generate a plan with:

```bash
node tools/generate-native-plan.mjs \
  --manifest manifests/macbookpro_m1_canvas_material_complexity_regular_paired_5sets.json \
  --api metal \
  --out native/plans/macbookpro_m1_native_canvas_material_complexity_regular_5sets.json
```

The checked-in Mac plans are:

- `native/plans/macbookpro_m1_native_canvas_material_complexity_regular_smoke_1sets.json`
- `native/plans/macbookpro_m1_native_canvas_material_complexity_regular_5sets.json`
- `native/plans/macbookpro_m1_native_canvas_primary_regular_smoke_1sets.json`
- `native/plans/macbookpro_m1_native_canvas_primary_regular_5sets.json`

The material plans use `surface_mode=basecolor`. The primary plans use
`surface_mode=flat`. The app rejects a `MATERIAL` suite assigned to the flat
renderer.

## Renderer Paths

The Metal app has two separate renderer paths:

- `metal-flat`
  - merged position/index mesh
  - solid-white fragment output
  - one instanced draw per frame
- `metal-basecolor`
  - preserved source primitives and UVs
  - embedded base-color textures and factors
  - glTF sampler mapping
  - alpha discard and source-alpha blending
  - one instanced draw per source primitive per frame

For the study Spider-Man asset, the loader smoke test expects:

- 167,495 vertices
- 15 material primitives
- 11 textured primitives
- 9 unique base-color textures used by the material path

## Run the Smoke Gate

1. Build and run the app in Release mode.
2. Click `Load Model` and select:
   - `assets/spiderman_2002_movie_version_sam_raimi_0.glb`
3. Click `Load Native Plan` and select:
   - `native/plans/macbookpro_m1_native_canvas_material_complexity_regular_smoke_1sets.json`
4. Confirm the model is visibly textured and colored.
5. Run the one-condition material smoke.
6. Confirm one JSONL record is written.
7. Validate the result:

```bash
node tools/validate-native-results.mjs "/path/to/results.jsonl"
```

Do not run the full material plan unless the smoke is visibly correct and the
validator passes.

## Full Collection Order

1. Material smoke
2. Material full, five runs at `1,2,4,8,16,32` instances
3. Flat smoke
4. Flat full, five runs at `64,128,192,256,320` instances

The full plans retain the browser protocol's five-minute between-run cooldown.
The smoke plans retain the 30-second cooldown.

## Output

Results are written under:

```text
~/Downloads/Data Collection/<device_group>/<cohort_group>/
```

Each trial is appended and flushed immediately. A later failure therefore does
not discard completed trial records.

The native records include:

- `api=metal`
- `surfaceMode=flat|basecolor`
- `env.runtime_family=native-apple`
- `env.renderer_path=metal-flat|metal-basecolor`
- `env.timing_source_primary=mtkview_draw_callback`
- plan, source manifest, asset, OS, and GPU provenance
- flat/material scene counts

## Validation

Run the source and plan checks:

```bash
node --test \
  tools/generate-native-plan.test.mjs \
  tools/validate-native-results.test.mjs
```

Run the Swift loader smoke tests:

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
xcrun swiftc \
  native/NativeBenchmark/NativeBenchmark/GLBLoader.swift \
  native/NativeBenchmark/Tests/GLBLoaderSmoke.swift \
  -o /tmp/GLBLoaderSmoke

/tmp/GLBLoaderSmoke assets/spiderman_2002_movie_version_sam_raimi_0.glb
```

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
xcrun swiftc \
  native/NativeBenchmark/NativeBenchmark/ManifestLoader.swift \
  native/NativeBenchmark/Tests/ManifestLoaderSmoke.swift \
  -o /tmp/ManifestLoaderSmoke

/tmp/ManifestLoaderSmoke \
  native/plans/macbookpro_m1_native_canvas_material_complexity_regular_5sets.json \
  native/plans/macbookpro_m1_native_canvas_primary_regular_5sets.json
```

Verify that the Swift condition order still matches the JavaScript harness:

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
xcrun swiftc \
  native/NativeBenchmark/NativeBenchmark/ConditionPlan.swift \
  native/NativeBenchmark/Tests/ConditionPlanSmoke.swift \
  -o /tmp/ConditionPlanSmoke

/tmp/ConditionPlanSmoke
```

After collection, validate each native JSONL file and ingest the directory:

```bash
node tools/validate-native-results.mjs "/path/to/native/results.jsonl"
node analysis/prepare-data.mjs --in "$HOME/Downloads/Data Collection"
```

`prepare-data.mjs` groups the `metal` records as a separate API. Browser-only
pairing scripts must not be used to interpret Metal as WebGL2 or WebGPU.

## Timing Interpretation

Primary frame cadence is measured from `CACurrentMediaTime()` at
`MTKView.draw(in:)` entry. This is a CPU-side callback interval analogous to
browser animation-frame cadence. It is not GPU completion time.

The percentile formula remains:

```text
sorted[floor(p * (n - 1))]
```

The existing browser data and new native data are non-contemporaneous. Treat
the main native result as a matched-protocol companion comparison. If stronger
same-session order control is required, run the separate Mac/Pixel sensitivity
experiment described in `docs/native-implementation-checklist.md`.
