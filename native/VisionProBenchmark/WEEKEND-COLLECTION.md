# AVP Native Comparison Weekend Protocol

## Scope

The final comparison is intentionally narrow: Apple Vision Pro, immersive VR,
the material workload, and the regular plus stress ladders. Do not add flat,
Canvas, AR passthrough, a second model, or another headset to this native
campaign.

The full analysis has three paths:

- WebGL2 + WebXR in Safari
- WebGPU + WebXR in Safari
- Metal + Compositor Services in the native app

Native Metal is a reference path, not a native implementation of WebGPU or
WebGL2. Differences are associations among complete runtime paths; they are not
isolated estimates of browser overhead.

## Before The Weekend

- Accept the Xcode license and build the app in Release configuration.
- Set the signing team and install on the physical AVP.
- Freeze updates until all browser and native collection is finished.
- Record AVP model, visionOS version, Safari version, native Git commit, date,
  room, and whether the headset was charging.
- Use the same room and starting position for every immersive cohort.
- Reboot once before the campaign, then allow at least 10 minutes for the
  device to settle. Do not reboot between valid run sets unless a failure
  requires it; document any reboot.

## Saturday: Qualification And Stress

1. Run **Regular smoke (1 run)**. Confirm colored geometry, stable placement,
   two-eye rendering, one exported record, and validator success.
2. Run **Stress smoke (1 run)**. Confirm 8 instances and validator success.
3. Run **Regular sanity (2 runs)** and **Stress sanity (2 runs)**. Each file
   must have 25 records, no aborted record, `view_count=2`, positive drawable
   dimensions, and `surface_mode=basecolor`.
4. If any gate fails, stop. Fix the harness or protocol and repeat smoke/sanity;
   do not start the full cohort with a known defect.
5. Run **Stress full (10 runs)**. Expected wall time is about 76 minutes.
6. Export and validate all 10 stress files before ending the session.

## Sunday: Regular And Browser Match

1. Run **Regular full (10 runs)**. Expected wall time is about 76 minutes.
2. Export and validate all 10 regular files.
3. On the same frozen AVP software stack, rerun the browser material cohorts if
   the paper will directly compare the new native data with browser data:
   - [AVP regular WebGL2/WebGPU launcher](https://innominata88.github.io/webxr-harness/releases/r2026-03-24-b/run-launcher.html?v=r2026-03-24-b&manifest=https%3A%2F%2Finnominata88.github.io%2Fwebxr-harness%2Freleases%2Fr2026-03-24-b%2Fmanifests%2Favp_xr_material_complexity_regular_paired_10sets.json%3Fv%3Dr2026-03-24-b)
   - [AVP stress WebGL2/WebGPU launcher](https://innominata88.github.io/webxr-harness/releases/r2026-03-24-b/run-launcher.html?v=r2026-03-24-b&manifest=https%3A%2F%2Finnominata88.github.io%2Fwebxr-harness%2Freleases%2Fr2026-03-24-b%2Fmanifests%2Favp_xr_material_stress_a_paired_10sets.json%3Fv%3Dr2026-03-24-b)

The two browser cohorts take roughly 2.5 to 3 hours each because each contains
20 counterbalanced API runs and five-minute cooldowns. If time permits only one
browser refresh, prioritize stress because it is more likely to separate
cadence under load. In that case, describe the native-versus-regular comparison
as cross-campaign and retain the exact historical browser OS/version metadata.

## Validity Gates

A full native cohort is analysis-ready only when all of the following hold:

- 10 distinct run IDs and 10 JSONL files
- 25 records per file (5 instance counts times 5 trials)
- no `aborted=true` records
- `surface_mode=basecolor` and a MATERIAL suite ID
- `mode=xr`, `api=metal`, `view_count=2`
- actual drawable width and height are positive and stable within the cohort
- model visibly rendered in color and remained anchored
- no trace tooling active during baseline runs
- one consistent visionOS/app build for the cohort
- every file passes `tools/validate-native-results.mjs`

Store validated full regular data under `Material Baseline/AVP Native XR` and
validated full stress data under `Material Baseline/Stress A/AVP Native XR` in
the existing backup tree. Keep smoke, sanity, and failures in a separate
`AVP Native XR Qualification` folder so analysis discovery cannot pool them.

Keep failures as separate reliability evidence; do not convert them to zero
FPS and do not silently replace them. Repeat a failed run under the documented
repeat policy and retain both files/notes.

## Analysis Contract

- Analyze regular and stress separately.
- Compare WebGPU and WebGL2 only within paired browser run sets.
- Compare each browser path with Metal at matched instance counts as an
  exploratory cross-runtime comparison.
- Use run set as the replication unit (`n=10`), not the five within-run trials.
- Report mean interval and tail metrics (p95/p99 or jank ratio) together.
- Report actual eye-texture dimensions and the browser `xrScaleFactor=0.25`
  mismatch as a limitation; also report that native foveation was disabled
  while Safari's internal behavior was not controlled by this harness.
- Do not call the native cadence direct GPU time, displayed FPS, or proof of
  browser overhead.
