# Collection Matrices

This file defines the next collection phases after baseline:

1. trace collection for mechanism analysis
2. cliff testing for high-load threshold behavior
3. phone XR failure-rate collection
4. XR material stress extension

All of these should be run from a frozen harness release and a versioned manifest pack.

## XR Material Stress Matrix

Use this after the low-instance material XR baseline (`1,2,4,8,16`) is complete.

Stress A manifests:

- `avp_xr_material_stress_a_paired_10sets.json`
- `quest2_xr_material_stress_a_webgl_only_5sets.json`

Protocol:

- `instances=8,16,32,48,64`
- `trials=5`
- `shuffle=1`
- `AVP`: paired, `xrIdlePresentMode=clear_each_frame`
- `Quest 2`: WebGL only

Escalation rule:

- If `64` still remains near frame cap on AVP, add a second follow-up cohort rather than mutating Stress A:
  - `64,96,128`

## Trace Matrix

Trace runs are explanatory, not baseline replacements.

Use:

- `profilerMode=traced_recording`
- Chrome-family browsers: `profilerConfig=chrome_perf:screenshots=0,memory=1`
- Safari / visionOS: `profilerConfig=safari_timelines:manual`
- trace manifests are tagged `cacheMode=cold_start`

Cold-start discipline for the trace phase:

1. Treat each launcher row as a fresh startup/load attempt.
2. Before each row, fully close the browser if feasible on that device.
3. Reopen from the frozen launcher/manifests, not from an already-running benchmark tab.
4. Avoid reusing a hot benchmark page for the next trace row.
5. Keep these runs separate from the steady-state baseline dataset.

Recommended trace cohorts:

| Cohort | Manifest(s) | APIs | Reps | Duration |
|---|---|---|---:|---:|
| Quest 2 Canvas | `quest2_canvas_primary_trace_i64_paired_2sets.json`, `quest2_canvas_primary_trace_i192_paired_2sets.json`, `quest2_canvas_primary_trace_i320_paired_2sets.json` | paired | 2 / API | 6000 ms |
| AVP XR | `avp_xr_primary_trace_i64_paired_2sets.json`, `avp_xr_primary_trace_i128_paired_2sets.json`, `avp_xr_primary_trace_i192_paired_2sets.json` | paired | 2 / API | 6000 ms |
| AVP Canvas | `avp_canvas_primary_trace_i64_paired_2sets.json`, `avp_canvas_primary_trace_i192_paired_2sets.json` | paired | 2 / API | 6000 ms |
| Quest 2 XR | `quest2_xr_primary_trace_i64_webgl_only_2sets.json`, `quest2_xr_primary_trace_i192_webgl_only_2sets.json` | WebGL only | 2 | 6000 ms |

## AVP XR Cliff Matrix

Use short single-instance manifests so the cliff band is interpretable and less exposed to long-session degradation.

Recommended manifests:

- `avp_xr_primary_cliff_i340_paired_5sets.json`
- `avp_xr_primary_cliff_i345_paired_5sets.json`
- `avp_xr_primary_cliff_i348_paired_5sets.json`
- `avp_xr_primary_cliff_i350_paired_5sets.json`

Protocol:

- `trials=3`
- `runCount=10` for paired manifests (`5` runs / API)
- `shuffle=0`
- `xrIdlePresentMode=clear_each_frame`

## Phone XR Failure-Rate Matrix

Phone XR AR should be treated as a reliability/failure-rate study, not a primary baseline cohort.

Use single-trial manifests so each launcher row is one attempt:

Pixel 8a:

- `pixel8a_xr_ar_failurecurve_i64_paired_10sets.json`
- `pixel8a_xr_ar_failurecurve_i128_paired_10sets.json`
- `pixel8a_xr_ar_failurecurve_i192_paired_10sets.json`

Samsung FE 5G:

- `samsung_fe5g_xr_ar_failurecurve_i64_paired_10sets.json`
- `samsung_fe5g_xr_ar_failurecurve_i128_paired_10sets.json`
- `samsung_fe5g_xr_ar_failurecurve_i192_paired_10sets.json`

Protocol:

- paired manifests with interleaved WebGL / WebGPU attempts
- `trials=1`
- `durationMs=3000`
- `shuffle=0`
- preserve existing per-device XR pose stability settings

Interpretation:

- each launcher row is one matched failure-rate attempt
- keep all outcomes, including failures
- do not require complete paired success for inclusion in the failure-rate analysis
