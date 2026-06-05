# Remaining Experiments Checklist

Last updated: 2026-06-05

This file is the canonical run plan for the remaining experimental work.

## Scope Assumptions

- Core deduped web benchmark cohorts are already complete.
- Phone AR material reevaluation is complete.
- Phone AR stress reevaluation is complete.
- Remaining work is about closing mechanism gaps, enterprise AR onboarding, the AVP cliff, and completing the required native branch.

## Do Not Rerun

- Existing deduped web benchmark cohorts
- Phone AR material probe cohorts
- Samsung phone AR material cleanup reruns
- Any legacy meeting-review outputs

## Required To Close The Final Study

### 1. Phone AR Stress Warm Traces

Status: `pending`

Purpose:
- Add mechanism evidence for the now-interesting phone AR stress result.
- Keep traced runs separate from the headline untraced benchmark dataset.

Required manifests:
- `manifest-packs/m2026-06-05-a/manifests/pixel8a_xr_ar_material_stress_probe_a_warm_trace_paired_5sets.json`
- `manifest-packs/m2026-06-05-a/manifests/samsung_fe5g_xr_ar_material_stress_probe_a_warm_trace_paired_5sets.json`

Fallback manifests if the full traced cohorts are too fragile:
- `manifest-packs/m2026-06-05-a/manifests/pixel8a_xr_ar_material_stress_probe_a_warm_trace_paired_sanity_2sets.json`
- `manifest-packs/m2026-06-05-a/manifests/samsung_fe5g_xr_ar_material_stress_probe_a_warm_trace_paired_sanity_2sets.json`

Highest-value focused diagnostic traces, if you need per-instance recovery:
- `manifest-packs/m2026-06-05-a/manifests/pixel8a_xr_ar_material_stress_probe_a_warm_trace_i48_paired_2sets.json`
- `manifest-packs/m2026-06-05-a/manifests/pixel8a_xr_ar_material_stress_probe_a_warm_trace_i64_paired_2sets.json`
- `manifest-packs/m2026-06-05-a/manifests/samsung_fe5g_xr_ar_material_stress_probe_a_warm_trace_i32_paired_2sets.json`
- `manifest-packs/m2026-06-05-a/manifests/samsung_fe5g_xr_ar_material_stress_probe_a_warm_trace_i48_paired_2sets.json`
- `manifest-packs/m2026-06-05-a/manifests/samsung_fe5g_xr_ar_material_stress_probe_a_warm_trace_i64_paired_2sets.json`

Success criteria:
- Valid passthrough
- Stable enough pose to complete traced runs
- Chrome trace and JSONL provenance both present

Stop rule:
- If a device cannot complete the full traced cohort, drop to the sanity manifest.
- If sanity still fails, collect the focused `i48` and `i64` traces instead.

### 2. HoloLens 2 Onboarding

Status: `pending`

Purpose:
- Close the enterprise AR branch with at least one working headset.
- Verify whether `WebGPU` AR is usable on-device before committing to heavier cohorts.

Run first:
- `manifests/hololens2_xr_ar_material_complexity_regular_paired_5sets.json`

Run second only if the first manifest succeeds cleanly:
- `manifests/hololens2_xr_ar_primary_regular_paired_5sets.json`

Success criteria for the material manifest:
- `immersive-ar` enters
- passthrough is visually correct
- content anchors and stays usable
- both row 1 `WebGL2` and row 2 `WebGPU` render correctly

Stop rule:
- Do not proceed to the primary flat cohort if the material cohort fails on session entry, anchoring, or `WebGPU` rendering.

### 3. AVP XR Cliff Matrix

Status: `pending`

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

### 4. Native Metal Canvas Branch

Status: `required`

Purpose:
- Add a web-vs-native canvas comparison on macOS.
- This is not part of the XR branch. Treat it as a separate comparison axis.

Current setup files:
- `native/NativeBenchmark/SETUP.md`
- `native/NativeBenchmark/NativeBenchmark/BenchmarkRenderer.swift`
- `native/NativeBenchmark/NativeBenchmark/BenchmarkRunner.swift`
- `native/NativeBenchmark/NativeBenchmark/ConditionPlan.swift`
- `native/NativeBenchmark/NativeBenchmark/ManifestLoader.swift`

Important setup note:
- The Xcode project itself is not committed. `SETUP.md` expects you to create the `NativeBenchmark` macOS app locally in Xcode.

Matched Mac web manifests:
- `manifests/macbookpro_m1_canvas_material_complexity_regular_paired_smoke_1sets.json`
- `manifests/macbookpro_m1_canvas_material_complexity_regular_paired_5sets.json`
- `manifests/macbookpro_m1_canvas_primary_regular_paired_smoke_1sets.json`
- `manifests/macbookpro_m1_canvas_primary_regular_paired_5sets.json`

Known current state:
- Mac web material data already appears in the collection audit.
- Mac web primary data should be verified before rerunning; if missing, collect it.

Minimum native run plan:
1. Create the Xcode project locally as described in `native/NativeBenchmark/SETUP.md`
2. Run one native smoke using the material smoke manifest:
   - `manifests/macbookpro_m1_canvas_material_complexity_regular_paired_smoke_1sets.json`
3. Run full native material:
   - `manifests/macbookpro_m1_canvas_material_complexity_regular_paired_5sets.json`
4. Verify whether matched Mac web primary data already exists
5. If matched Mac web primary is missing, collect:
   - `manifests/macbookpro_m1_canvas_primary_regular_paired_smoke_1sets.json`
   - `manifests/macbookpro_m1_canvas_primary_regular_paired_5sets.json`
6. Run native primary:
   - `manifests/macbookpro_m1_canvas_primary_regular_paired_smoke_1sets.json`
   - `manifests/macbookpro_m1_canvas_primary_regular_paired_5sets.json`

Method note:
- Analyze native separately from the core XR conclusions.
- If native is included, write it up as a Mac canvas extension, not as part of the main phone/AVP/Quest XR story.

## Conditional Runs

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
- They are lower priority now because phone AR stress benchmark data already exists and is useful.

### 6. Magic Leap 2 Onboarding

Status: `optional`

Purpose:
- Second enterprise AR headset, only if HoloLens works and there is remaining time/scope.

Manifests:
- `manifests/magicleap2_xr_ar_material_complexity_regular_paired_5sets.json`
- `manifests/magicleap2_xr_ar_primary_regular_paired_5sets.json`

Recommendation:
- Do not start here.
- Use Magic Leap only after HoloLens material succeeds.

## Recommended Sequence

1. `Phone AR stress warm traces`
2. `Native Metal material branch`
3. `HoloLens 2 material onboarding`
4. `Native primary branch`, if matched web primary exists or is collected
5. `HoloLens 2 primary flat`, only if material succeeds
6. `AVP XR cliff`
7. `Phone AR failure curves`, only if reliability boundaries are still needed
8. `Magic Leap 2 onboarding`, only if HoloLens succeeds and there is remaining scope

## Current Completion Snapshot

Completed:
- Deduped core web benchmark dataset
- Main current figure set
- Phone AR material reevaluation
- Phone AR stress reevaluation

Remaining:
- Phone AR stress traces
- Native Metal branch
- HoloLens 2 onboarding
- AVP XR cliff
- Optional phone AR failure curves
- Optional Magic Leap 2 onboarding
