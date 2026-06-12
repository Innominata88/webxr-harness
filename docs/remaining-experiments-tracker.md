# Remaining Experiments Tracker

Last updated: 2026-06-12

Use this as the working tracker during collection. The planning details live in `docs/remaining-experiments-checklist.md`.

## Completed

- [x] Core deduped web benchmark cohorts
- [x] Phone AR material reevaluation
- [x] Phone AR stress reevaluation
- [x] Phone AR stress warm traces

## Required

### HoloLens 2 Split Browser Matrix

- [ ] `Canvas material` smoke
  - manifest: `manifest-packs/m2026-06-12-a/manifests/hololens2_canvas_material_complexity_regular_paired_smoke_1sets.json`
- [ ] If HoloLens reports `no WebGPU adapter`, switch to `Canvas material` WebGL-only smoke
  - manifest: `manifest-packs/m2026-06-12-a/manifests/hololens2_canvas_material_complexity_regular_webgl_only_smoke_1sets.json`
- [ ] Confirm HoloLens Canvas mode is either paired-capable or explicitly `WebGL-only`
- [ ] `XR material` smoke
  - manifest: `manifest-packs/m2026-06-12-a/manifests/hololens2_xr_ar_material_complexity_regular_webgl_only_smoke_1sets.json`
- [ ] Confirm `immersive-ar` WebGL fallback works in HoloLens XR material smoke
- [ ] `Canvas material` sanity
  - paired manifest: `manifest-packs/m2026-06-12-a/manifests/hololens2_canvas_material_complexity_regular_paired_sanity_2sets.json`
  - WebGL-only fallback: `manifest-packs/m2026-06-12-a/manifests/hololens2_canvas_material_complexity_regular_webgl_only_sanity_2sets.json`
- [ ] `XR material` sanity
  - manifest: `manifest-packs/m2026-06-12-a/manifests/hololens2_xr_ar_material_complexity_regular_webgl_only_sanity_2sets.json`
- [ ] `Canvas material` full
  - paired manifest: `manifest-packs/m2026-06-12-a/manifests/hololens2_canvas_material_complexity_regular_paired_5sets.json`
  - WebGL-only fallback: `manifest-packs/m2026-06-12-a/manifests/hololens2_canvas_material_complexity_regular_webgl_only_5sets.json`
- [ ] `XR material` full
  - manifest: `manifest-packs/m2026-06-12-a/manifests/hololens2_xr_ar_material_complexity_regular_webgl_only_5sets.json`
- [ ] If both material branches are clean: `Canvas primary` smoke
  - paired manifest: `manifest-packs/m2026-06-12-a/manifests/hololens2_canvas_primary_regular_paired_smoke_1sets.json`
  - WebGL-only fallback: `manifest-packs/m2026-06-12-a/manifests/hololens2_canvas_primary_regular_webgl_only_smoke_1sets.json`
- [ ] If both material branches are clean: `XR primary` smoke
  - manifest: `manifest-packs/m2026-06-12-a/manifests/hololens2_xr_ar_primary_regular_webgl_only_smoke_1sets.json`
- [ ] If primary smoke passes: `Canvas primary` full
  - paired manifest: `manifest-packs/m2026-06-12-a/manifests/hololens2_canvas_primary_regular_paired_5sets.json`
  - WebGL-only fallback: `manifest-packs/m2026-06-12-a/manifests/hololens2_canvas_primary_regular_webgl_only_5sets.json`
- [ ] If primary smoke passes: `XR primary` full
  - manifest: `manifest-packs/m2026-06-12-a/manifests/hololens2_xr_ar_primary_regular_webgl_only_5sets.json`

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

## Conditional

### Magic Leap 2 Beta Browser Capability Gate

- [ ] `Canvas material` smoke
  - manifest: `manifest-packs/m2026-06-12-a/manifests/magicleap2_canvas_material_complexity_regular_paired_smoke_1sets.json`
- [ ] If Magic Leap reports `no WebGPU adapter`, switch to `Canvas material` WebGL-only smoke
  - manifest: `manifest-packs/m2026-06-12-a/manifests/magicleap2_canvas_material_complexity_regular_webgl_only_smoke_1sets.json`
- [ ] Confirm Magic Leap Canvas mode is either paired-capable or explicitly `WebGL-only`
- [ ] `XR material` smoke
  - manifest: `manifest-packs/m2026-06-12-a/manifests/magicleap2_xr_ar_material_complexity_regular_webgl_only_smoke_1sets.json`
- [ ] Confirm `immersive-ar` WebGL fallback works in Magic Leap XR material smoke
- [ ] If both smoke gates pass: `Canvas material` full
  - paired manifest: `manifest-packs/m2026-06-12-a/manifests/magicleap2_canvas_material_complexity_regular_paired_5sets.json`
  - WebGL-only fallback: `manifest-packs/m2026-06-12-a/manifests/magicleap2_canvas_material_complexity_regular_webgl_only_5sets.json`
- [ ] If both smoke gates pass: `XR material` full
  - manifest: `manifest-packs/m2026-06-12-a/manifests/magicleap2_xr_ar_material_complexity_regular_webgl_only_5sets.json`
- [ ] If material full passes: `Canvas primary` smoke/full
  - manifests:
    - paired:
      - `manifest-packs/m2026-06-12-a/manifests/magicleap2_canvas_primary_regular_paired_smoke_1sets.json`
      - `manifest-packs/m2026-06-12-a/manifests/magicleap2_canvas_primary_regular_paired_5sets.json`
    - WebGL-only fallback:
      - `manifest-packs/m2026-06-12-a/manifests/magicleap2_canvas_primary_regular_webgl_only_smoke_1sets.json`
      - `manifest-packs/m2026-06-12-a/manifests/magicleap2_canvas_primary_regular_webgl_only_5sets.json`
- [ ] If material full passes: `XR primary` smoke/full
  - manifests:
    - `manifest-packs/m2026-06-12-a/manifests/magicleap2_xr_ar_primary_regular_webgl_only_smoke_1sets.json`
    - `manifest-packs/m2026-06-12-a/manifests/magicleap2_xr_ar_primary_regular_webgl_only_5sets.json`
- [ ] Optional only if the beta browser clearly exposes `navigator.gpu` plus `XRGPUBinding`: paired XR diagnostic smoke
  - manifest: `manifests/magicleap2_xr_ar_material_complexity_regular_paired_5sets.json`

### Optional Phone AR Failure Curves

- [ ] `Pixel 8a` AR failure curve `64`
- [ ] `Pixel 8a` AR failure curve `128`
- [ ] `Pixel 8a` AR failure curve `192`
- [ ] `Samsung Galaxy FE` AR failure curve `64`
- [ ] `Samsung Galaxy FE` AR failure curve `128`
- [ ] `Samsung Galaxy FE` AR failure curve `192`

## Meeting Notes

- [ ] Explain that phone AR benchmark collection and traces are complete
- [ ] Explain that the headset plan is now split by capability, not by the older paired-XR assumption
- [ ] Explain that HoloLens should be treated like Quest: paired Canvas plus WebGL-only XR fallback
- [ ] Explain that Magic Leap stays capability-gated because the browser is beta
- [ ] Explain that native is still required and separate from XR conclusions
