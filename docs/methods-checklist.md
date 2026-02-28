# WebXR Performance Study Methods Checklist

Use this checklist before collecting data intended for analysis or publication.

## 1) Study Design Lock

- [ ] Primary question is explicitly stated: WebXR performance comparison of `webgpu` vs `webgl2`.
- [ ] Primary endpoint(s) are fixed before runs (for example `fps_effective`, `p95_ms`, `missed_1p5x_pct`).
- [ ] Inclusion/exclusion rules are fixed before runs (for example XR abort handling policy).
- [ ] Instance plan is fixed and identical across APIs (`instances`, `trials`, `durationMs`).
- [ ] Scene/model is fixed (`model`) and unchanged for all compared runs.
- [ ] Query presets are frozen in a versioned run sheet.

## 2) Fairness Controls (Cross-API)

- [ ] Match these params across APIs for every paired run:
  - `instances`
  - `trials`
  - `durationMs`
  - `runMode` (canonical URL param; avoid mixing `mode=both` and `runMode=xr` in primary comparisons)
  - `minFrames` (XR)
  - `xrNoPoseGraceMs` (XR)
  - `xrStartOnFirstPose` (XR timing policy)
  - `xrAnchorToFirstPose` (XR placement policy)
  - `warmupMs`
  - `cooldownMs`
  - `betweenInstancesMs`
  - `layout`
  - `seed`
  - `shuffle`
  - `spacing`
  - `debugColor`
  - `xrFrontMinZ`
  - `xrYOffset`
  - `preIdleMs`
  - `postIdleMs`
  - `manualStart` (trace/profiling runs)
  - `canvasAutoDelayMs` (trace/profiling runs when `manualStart=0`)
  - `collectPerf`
  - `perfDetail`
  - `hud`
  - `hudHz`
  - `renderProbe`
  - `xrProbeReadback`
  - `manualDownload`
  - `runId` (trace/session identifier)
  - `traceMarkers`
  - `traceOverlay` (if used for operator workflow)
- [ ] If using both phases in one page run, `runMode=both` is intentional and documented (`mode=` kept only as legacy alias).
- [ ] XR comparability guard is active (`xr_expected_max_views = 2` in outputs).
- [ ] XR scale policy is fixed and reported (`xrScaleFactor` requested/applied).
- [ ] Order/bias controls are fixed and reported (`orderMode`, `orderIndex`, `assignedApi`, `orderSeed`).
- [ ] GPU pinning policy is fixed and reported (`pinGpu`, `sessionGroup`).

## 3) Runtime Environment Controls

- [ ] Browser/channel and exact version are recorded.
- [ ] OS version is recorded.
- [ ] Device model and headset model are recorded.
- [ ] Power state policy is fixed (battery/plugged, thermal state, power saver off/on).
- [ ] Background processes policy is fixed (notifications, updates, other tabs/apps).
- [ ] Network condition policy is fixed (offline/local asset cache or controlled network).
- [ ] Cache policy is fixed and logged (`cacheMode`: `warm`, `cold_disable_cache`, or `cold_clear_cache`).
- [ ] Profiler policy is fixed and logged (`profilerMode`: `baseline_untraced` or `traced_recording`), and profiler settings are recorded when traced.
- [ ] Security context requirements are met (`https` where needed for XR).

## 4) Harness Configuration Sanity

- [ ] Schema target is confirmed (`schema_version` currently `1.1.0`).
- [ ] Output filenames are unique and traceable (`out`, `outxr`, `suiteId`).
- [ ] Between-suite cooldown procedure is intentional and documented (typically external orchestration + `idle.html`).
- [ ] Rest-handoff behavior is intentional and recorded (`env.rest` usage).
- [ ] Storage permissions/download prompts are verified on each platform/browser.

## 5) Dry Run (Per Device)

- [ ] One short WebGL run completed successfully.
- [ ] One short WebGPU run completed successfully.
- [ ] One XR entry/exit cycle verified for each API path supported by the device.
- [ ] No unexpected abort records in dry run unless intentionally triggered.
- [ ] Logs show no repeated session-request failures or stuck pending sessions.

## 6) Data Collection Procedure

- [ ] API execution order follows pre-registered policy (counterbalanced/randomized).
- [ ] Rest interval between paired runs follows protocol (`betweenSuitesMs` or manual timer).
- [ ] Repetitions per condition are fixed and completed.
- [ ] Any failed/aborted run is labeled and handled per predefined rules.
- [ ] Operator actions are minimized and standardized (especially XR entry timing).

## 7) Output Validation (Required)

- [ ] Validate every generated JSONL file:

```bash
node tools/validate-results.mjs path/to/results_webgl*.jsonl path/to/results_webgpu*.jsonl
node tools/check-run-quality.mjs --pair-by suiteId --out-base reports/run_quality path/to/results_webgl*.jsonl path/to/results_webgpu*.jsonl
```

- [ ] No schema/type errors are present.
- [ ] Abort records (`aborted: true`) are audited and tagged per exclusion policy.
- [ ] Paired-run completeness is checked (matching planned conditions across APIs).
- [ ] Quality report reviewed (`pairs_excluded = 0` or exclusions documented per protocol).

## 8) Analysis Readiness

- [ ] Analysis script version is locked and archived.
- [ ] Unit of analysis is explicit (trial-level vs condition aggregate).
- [ ] Aggregation/statistical plan is fixed before full analysis.
- [ ] Missing data/abort handling strategy is documented and reproducible.
- [ ] Sensitivity checks are preplanned (for example excluding early warm runs).

## 9) Reporting & Reproducibility Package

- [ ] Final parameter manifest is exported (exact query strings used).
- [ ] Provenance IDs are captured and frozen (`harnessCommit`, `assetRevision`, and model URL).
- [ ] Raw JSONL outputs are archived read-only.
- [ ] Validation logs are archived.
- [ ] Device/browser inventory table is archived.
- [ ] Methods section includes fairness controls and abort policy.
- [ ] Limitations are documented (browser support, thermal drift, device variance).

## 10) Sign-Off

- [ ] Pilot complete and reviewed.
- [ ] Full collection approved.
- [ ] Any protocol deviations are recorded with timestamp and reason.
