# Remaining Experiments Tracker

Last updated: 2026-06-05

Use this as the working tracker during collection. The planning details live in `docs/remaining-experiments-checklist.md`.

## Required

### Phone AR Stress Warm Traces

- [ ] `Pixel 8a` full warm trace
  - manifest: `manifest-packs/m2026-06-05-a/manifests/pixel8a_xr_ar_material_stress_probe_a_warm_trace_paired_5sets.json`
- [ ] `Samsung Galaxy FE` full warm trace
  - manifest: `manifest-packs/m2026-06-05-a/manifests/samsung_fe5g_xr_ar_material_stress_probe_a_warm_trace_paired_5sets.json`
- [ ] If `Pixel 8a` full trace fails, run sanity fallback
  - manifest: `manifest-packs/m2026-06-05-a/manifests/pixel8a_xr_ar_material_stress_probe_a_warm_trace_paired_sanity_2sets.json`
- [ ] If `Samsung Galaxy FE` full trace fails, run sanity fallback
  - manifest: `manifest-packs/m2026-06-05-a/manifests/samsung_fe5g_xr_ar_material_stress_probe_a_warm_trace_paired_sanity_2sets.json`
- [ ] If full and sanity both fail on `Pixel 8a`, collect focused traces at `48` and `64`
  - manifests:
    - `manifest-packs/m2026-06-05-a/manifests/pixel8a_xr_ar_material_stress_probe_a_warm_trace_i48_paired_2sets.json`
    - `manifest-packs/m2026-06-05-a/manifests/pixel8a_xr_ar_material_stress_probe_a_warm_trace_i64_paired_2sets.json`
- [ ] If full and sanity both fail on `Samsung Galaxy FE`, collect focused traces at `48` and `64`
  - manifests:
    - `manifest-packs/m2026-06-05-a/manifests/samsung_fe5g_xr_ar_material_stress_probe_a_warm_trace_i48_paired_2sets.json`
    - `manifest-packs/m2026-06-05-a/manifests/samsung_fe5g_xr_ar_material_stress_probe_a_warm_trace_i64_paired_2sets.json`

### HoloLens 2

- [ ] Material onboarding
  - manifest: `manifests/hololens2_xr_ar_material_complexity_regular_paired_5sets.json`
- [ ] Confirm row 1 `WebGL2` works
- [ ] Confirm row 2 `WebGPU` works
- [ ] Confirm passthrough and anchoring are usable
- [ ] Only if material succeeds: run primary flat cohort
  - manifest: `manifests/hololens2_xr_ar_primary_regular_paired_5sets.json`

### AVP XR Cliff

- [ ] Smoke
  - manifest: `manifests/avp_xr_primary_cliff_paired_smoke_1sets.json`
- [ ] Sanity
  - manifest: `manifests/avp_xr_primary_cliff_paired_sanity_2sets.json`
- [ ] `340`
  - manifest: `manifests/avp_xr_primary_cliff_i340_paired_5sets.json`
- [ ] `345`
  - manifest: `manifests/avp_xr_primary_cliff_i345_paired_5sets.json`
- [ ] `348`
  - manifest: `manifests/avp_xr_primary_cliff_i348_paired_5sets.json`
- [ ] `350`
  - manifest: `manifests/avp_xr_primary_cliff_i350_paired_5sets.json`

### Native Metal Canvas Branch

- [ ] Create local Xcode project from `native/NativeBenchmark/SETUP.md`
- [ ] Native material smoke
  - manifest: `manifests/macbookpro_m1_canvas_material_complexity_regular_paired_smoke_1sets.json`
- [ ] Native material full
  - manifest: `manifests/macbookpro_m1_canvas_material_complexity_regular_paired_5sets.json`
- [ ] Verify whether Mac web primary already exists
- [ ] If Mac web primary is missing: collect web smoke
  - manifest: `manifests/macbookpro_m1_canvas_primary_regular_paired_smoke_1sets.json`
- [ ] If Mac web primary is missing: collect web full
  - manifest: `manifests/macbookpro_m1_canvas_primary_regular_paired_5sets.json`
- [ ] Native primary smoke
  - manifest: `manifests/macbookpro_m1_canvas_primary_regular_paired_smoke_1sets.json`
- [ ] Native primary full
  - manifest: `manifests/macbookpro_m1_canvas_primary_regular_paired_5sets.json`

## Conditional

### Optional Reliability Boundary Work

- [ ] `Pixel 8a` AR failure curve `64`
- [ ] `Pixel 8a` AR failure curve `128`
- [ ] `Pixel 8a` AR failure curve `192`
- [ ] `Samsung Galaxy FE` AR failure curve `64`
- [ ] `Samsung Galaxy FE` AR failure curve `128`
- [ ] `Samsung Galaxy FE` AR failure curve `192`

### Optional Enterprise Extension

- [ ] `Magic Leap 2` material onboarding
  - manifest: `manifests/magicleap2_xr_ar_material_complexity_regular_paired_5sets.json`
- [ ] `Magic Leap 2` primary flat
  - manifest: `manifests/magicleap2_xr_ar_primary_regular_paired_5sets.json`

## Meeting Notes

- [ ] Explain that phone AR benchmark reevaluation is already complete
- [ ] Explain that phone AR stress traces are the highest-value remaining mechanism work
- [ ] Explain that native is now a required branch, not future work
- [ ] Explain that HoloLens is the next enterprise AR gate
- [ ] Ask whether Mac web primary must be rerun if the existing web-side heavy cohort is incomplete
