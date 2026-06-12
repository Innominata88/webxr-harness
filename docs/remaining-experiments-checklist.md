# Remaining Experiments Checklist

Last updated: 2026-06-12

This file is the canonical run plan for the remaining experimental work.

## Scope Assumptions

- Core deduped web benchmark cohorts are already complete.
- Phone AR material reevaluation is complete.
- Phone AR stress reevaluation is complete.
- Phone AR stress warm traces are complete.
- Remaining work is about closing the headset/browser branch, the required native branch, the AVP cliff, and deciding how much Magic Leap beta-browser work is worth promoting.

## Do Not Rerun

- Existing deduped web benchmark cohorts
- Phone AR material probe cohorts
- Phone AR stress benchmark cohorts
- Phone AR stress warm traces
- Any legacy meeting-review outputs

## Required To Close The Final Study

### 1. HoloLens 2 Split Browser Reevaluation

Status: `required`

Purpose:
- Stop treating HoloLens like a paired `WebGPU XR` platform.
- Mirror the Quest logic instead:
  - paired `Canvas` for `WebGL2` vs `WebGPU`
  - `WebGL-only XR` fallback for `immersive-ar`
- Keep the flat/primary ladders separate from the material ladders.

New pack:
- `manifest-packs/m2026-06-12-a/`
- launcher index:
  - `manifest-packs/m2026-06-12-a/manifests/launcher-links-headset-browser-reeval.html`

Material gate order:
1. `Canvas material` smoke
   - `manifest-packs/m2026-06-12-a/manifests/hololens2_canvas_material_complexity_regular_paired_smoke_1sets.json`
2. `XR material` smoke
   - `manifest-packs/m2026-06-12-a/manifests/hololens2_xr_ar_material_complexity_regular_webgl_only_smoke_1sets.json`
3. `Canvas material` sanity
   - `manifest-packs/m2026-06-12-a/manifests/hololens2_canvas_material_complexity_regular_paired_sanity_2sets.json`
4. `XR material` sanity
   - `manifest-packs/m2026-06-12-a/manifests/hololens2_xr_ar_material_complexity_regular_webgl_only_sanity_2sets.json`
5. `Canvas material` full
   - `manifest-packs/m2026-06-12-a/manifests/hololens2_canvas_material_complexity_regular_paired_5sets.json`
6. `XR material` full
   - `manifest-packs/m2026-06-12-a/manifests/hololens2_xr_ar_material_complexity_regular_webgl_only_5sets.json`

Primary promotion order, only if both material branches are clean:
1. `Canvas primary` smoke
   - `manifest-packs/m2026-06-12-a/manifests/hololens2_canvas_primary_regular_paired_smoke_1sets.json`
2. `XR primary` smoke
   - `manifest-packs/m2026-06-12-a/manifests/hololens2_xr_ar_primary_regular_webgl_only_smoke_1sets.json`
3. `Canvas primary` full
   - `manifest-packs/m2026-06-12-a/manifests/hololens2_canvas_primary_regular_paired_5sets.json`
4. `XR primary` full
   - `manifest-packs/m2026-06-12-a/manifests/hololens2_xr_ar_primary_regular_webgl_only_5sets.json`

Success criteria:
- `Canvas material` smoke shows both `WebGL2` and `WebGPU` rendering on HoloLens.
- `XR material` smoke shows usable `immersive-ar` entry and stable `WebGL` fallback behavior.
- Full material cohorts complete cleanly before promoting to the primary ladders.

Stop rules:
- If `Canvas material` smoke cannot render `WebGPU`, stop HoloLens `Canvas` promotion and record that as a capability limit.
- If `XR material` smoke cannot maintain usable `immersive-ar` with `WebGL`, stop HoloLens `XR` promotion and record that as the result.
- Do not use the older paired HoloLens XR manifests as the main plan. They mix the unsupported `WebGPU XR` question into the XR fallback question.

### 2. Native Metal Canvas Branch

Status: `required`

Purpose:
- Add the required web-vs-native canvas comparison on macOS.
- Keep it separate from the XR interpretation.

Current setup files:
- `native/NativeBenchmark/SETUP.md`
- `native/NativeBenchmark/NativeBenchmark/BenchmarkRenderer.swift`
- `native/NativeBenchmark/NativeBenchmark/BenchmarkRunner.swift`
- `native/NativeBenchmark/NativeBenchmark/ConditionPlan.swift`
- `native/NativeBenchmark/NativeBenchmark/ManifestLoader.swift`

Important setup note:
- The Xcode project itself is not committed. `SETUP.md` expects a local project creation step.

Matched Mac web manifests:
- `manifests/macbookpro_m1_canvas_material_complexity_regular_paired_smoke_1sets.json`
- `manifests/macbookpro_m1_canvas_material_complexity_regular_paired_5sets.json`
- `manifests/macbookpro_m1_canvas_primary_regular_paired_smoke_1sets.json`
- `manifests/macbookpro_m1_canvas_primary_regular_paired_5sets.json`

Minimum native run plan:
1. Create the Xcode project locally
2. Native material smoke
   - `manifests/macbookpro_m1_canvas_material_complexity_regular_paired_smoke_1sets.json`
3. Native material full
   - `manifests/macbookpro_m1_canvas_material_complexity_regular_paired_5sets.json`
4. Verify whether matched Mac web primary data already exists
5. If matched Mac web primary is missing, collect:
   - `manifests/macbookpro_m1_canvas_primary_regular_paired_smoke_1sets.json`
   - `manifests/macbookpro_m1_canvas_primary_regular_paired_5sets.json`
6. Native primary smoke and full
   - `manifests/macbookpro_m1_canvas_primary_regular_paired_smoke_1sets.json`
   - `manifests/macbookpro_m1_canvas_primary_regular_paired_5sets.json`

Method note:
- Write up native as a Mac canvas extension, not as part of the main headset XR story.

### 3. AVP XR Cliff Matrix

Status: `required`

Purpose:
- Close the high-load threshold story on AVP XR.

Use these manifests:
- `manifests/avp_xr_primary_cliff_paired_smoke_1sets.json`
- `manifests/avp_xr_primary_cliff_paired_sanity_2sets.json`
- `manifests/avp_xr_primary_cliff_i340_paired_5sets.json`
- `manifests/avp_xr_primary_cliff_i345_paired_5sets.json`
- `manifests/avp_xr_primary_cliff_i348_paired_5sets.json`
- `manifests/avp_xr_primary_cliff_i350_paired_5sets.json`

Recommended order:
1. smoke
2. sanity
3. `340`
4. `345`
5. `348`
6. `350`

Success criteria:
- Clean paired completion at each point
- No unresolved ambiguity about the cliff onset

## Conditional Runs

### 4. Magic Leap 2 Beta Browser Capability Gate

Status: `conditional`

Purpose:
- Probe the Magic Leap beta browser without assuming it supports the full paired XR/WebGPU path.
- Use the same split-browser logic as HoloLens first:
  - paired `Canvas`
  - `WebGL-only XR`
- Only after that decide whether any paired XR/WebGPU diagnostic is worth attempting.

New pack:
- `manifest-packs/m2026-06-12-a/`

Smoke gate order:
1. `Canvas material` smoke
   - `manifest-packs/m2026-06-12-a/manifests/magicleap2_canvas_material_complexity_regular_paired_smoke_1sets.json`
2. `XR material` smoke
   - `manifest-packs/m2026-06-12-a/manifests/magicleap2_xr_ar_material_complexity_regular_webgl_only_smoke_1sets.json`

Promote only if both smoke gates pass:
- `Canvas material` sanity/full
  - `manifest-packs/m2026-06-12-a/manifests/magicleap2_canvas_material_complexity_regular_paired_sanity_2sets.json`
  - `manifest-packs/m2026-06-12-a/manifests/magicleap2_canvas_material_complexity_regular_paired_5sets.json`
- `XR material` sanity/full
  - `manifest-packs/m2026-06-12-a/manifests/magicleap2_xr_ar_material_complexity_regular_webgl_only_sanity_2sets.json`
  - `manifest-packs/m2026-06-12-a/manifests/magicleap2_xr_ar_material_complexity_regular_webgl_only_5sets.json`

Primary promotion, only if both material full cohorts are clean:
- `Canvas primary` smoke/full
  - `manifest-packs/m2026-06-12-a/manifests/magicleap2_canvas_primary_regular_paired_smoke_1sets.json`
  - `manifest-packs/m2026-06-12-a/manifests/magicleap2_canvas_primary_regular_paired_5sets.json`
- `XR primary` smoke/full
  - `manifest-packs/m2026-06-12-a/manifests/magicleap2_xr_ar_primary_regular_webgl_only_smoke_1sets.json`
  - `manifest-packs/m2026-06-12-a/manifests/magicleap2_xr_ar_primary_regular_webgl_only_5sets.json`

Optional paired XR diagnostic, only if the beta browser clearly exposes `navigator.gpu` plus `XRGPUBinding`:
- existing diagnostic candidate:
  - `manifests/magicleap2_xr_ar_material_complexity_regular_paired_5sets.json`

Recommendation:
- Do not start Magic Leap with the older paired XR manifests.
- Start with capability smoke only.

### 5. Phone AR Failure Curves

Status: `optional`

Purpose:
- Only needed if the study still wants a reliability-boundary result for phone `immersive-ar`.

Pixel manifests:
- `manifests/pixel8a_xr_ar_failurecurve_i64_paired_10sets.json`
- `manifests/pixel8a_xr_ar_failurecurve_i128_paired_10sets.json`
- `manifests/pixel8a_xr_ar_failurecurve_i192_paired_10sets.json`

Samsung manifests:
- `manifests/samsung_fe5g_xr_ar_failurecurve_i64_paired_10sets.json`
- `manifests/samsung_fe5g_xr_ar_failurecurve_i128_paired_10sets.json`
- `manifests/samsung_fe5g_xr_ar_failurecurve_i192_paired_10sets.json`

Recommendation:
- Do these only after the required items above are done.

## Recommended Sequence

1. `HoloLens 2 Canvas material smoke`
2. `HoloLens 2 XR material smoke`
3. `HoloLens 2 material sanity/full promotion`
4. `Native Metal material branch`
5. `AVP XR cliff`
6. `HoloLens primary promotion`, if both material branches are clean
7. `Magic Leap` capability smokes
8. `Magic Leap` promotion, only if the beta browser passes the smoke gates
9. `Phone AR failure curves`, only if reliability boundaries are still needed

## Current Completion Snapshot

Completed:
- Deduped core web benchmark dataset
- Main current figure set
- Phone AR material reevaluation
- Phone AR stress reevaluation
- Phone AR stress warm traces

Remaining:
- HoloLens 2 split browser reevaluation
- Native Metal branch
- AVP XR cliff
- Conditional Magic Leap beta-browser reevaluation
- Optional phone AR failure curves
