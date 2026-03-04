# Baseline Manifest Set

These manifests were generated for baseline collection using:

- Harness commit: `ea58bb8`
- Generator: `tools/generate-baseline-manifests.mjs`
- Base URL in run links: `https://innominata88.github.io/webxr-harness/`
- Model: `./assets/spiderman_2002_movie_version_sam_raimi_0.glb`
- `debugColor=flat`, `manualDownload=1`, `traceMarkers=1`, `traceOverlay=0`
- Required flags profile metadata is embedded in each manifest (`required_flags_profile_id`, `required_flags_exact`)

All manifests include per-row `out/outxr` output naming so downloaded JSONL names match `results_name`.

For immutable releases, generate with `HARNESS_RELEASE_TAG` so URLs point to:

- `https://innominata88.github.io/webxr-harness/releases/<tag>/...`
- Full workflow: `docs/immutable-release-workflow.md`
- Important: `releases/<tag>/` is a hosted immutable snapshot path. It does not create a GitHub Releases entry unless you also create/push a git tag and publish a release (see `docs/immutable-release-workflow.md` section "GitHub Releases page").

## Use With Run Launcher

Direct launcher pattern:

- `https://innominata88.github.io/webxr-harness/run-launcher.html?manifest=manifests/<manifest-file>.json`

Example:

- `https://innominata88.github.io/webxr-harness/run-launcher.html?manifest=manifests/avp_xr_primary_regular_paired_5sets.json`

Generate fully encoded launcher links for all manifests:

```bash
LAUNCHER_VERSION="r2026-03-01-a" node tools/generate-launcher-links.mjs
```

Output:

- `manifests/launcher-links.csv`
  - Includes `manifest_url` and fully encoded `launcher_url` for each manifest.
  - `LAUNCHER_VERSION` is added as `?v=...` to both launcher and manifest URLs for cache-busting.

## Required Baseline Manifests

1. `manifests/avp_canvas_primary_regular_paired_5sets.json`
2. `manifests/avp_xr_primary_regular_paired_5sets.json`
3. `manifests/avp_xr_primary_cliff_paired_5sets.json`
4. `manifests/quest2_canvas_primary_regular_paired_5sets.json`
5. `manifests/quest2_xr_primary_regular_webgl_only_5sets.json`
6. `manifests/pixel8a_canvas_primary_regular_paired_5sets.json`
7. `manifests/samsung_fe5g_canvas_primary_regular_paired_5sets.json`
8. `manifests/pixel8a_xr_ar_primary_regular_paired_5sets.json`
9. `manifests/samsung_fe5g_xr_ar_primary_regular_paired_5sets.json`
10. `manifests/ipadairm3_canvas_primary_regular_paired_5sets.json`
11. `manifests/macbookpro_m1_canvas_primary_regular_paired_5sets.json`
12. `manifests/windows_hp_canvas_primary_regular_paired_5sets.json`

## Legacy Manifests (Not Primary)

1. `manifests/quest2_canvas_primary_regular_webgl_only_5sets.json`
2. `manifests/pixel8a_xr_ar_primary_regular_webgl_only_5sets.json`
3. `manifests/samsung_fe5g_xr_ar_primary_regular_webgl_only_5sets.json`

## Notes

- Paired manifests use `manifestOrderMode=abba_baab` with `manifestRuns=10` (5 runs per API).
- Single-API manifests use `manifestOrderMode=none` with `manifestRuns=5`.
- Regular manifests use cooldown `300000` ms (5 min) between runs.
- AVP cliff manifest uses cooldown `600000` ms (10 min) between runs.
- AVP cliff instance band is `340,345,348,350`.
- AVP canvas baseline manifest locks `canvasScaleFactor=0.75` (applied to both WebGL/WebGPU).
- Phone canvas baseline manifests lock `canvasScaleFactor=0.75`.
- Phone XR AR baseline manifests are paired WebGL/WebGPU primary manifests (`immersive-ar` cohort).
- Phone XR AR placement defaults are locked to `spacing=0.12`, `xrFrontMinZ=-1.6`, `xrYOffset=0.0`.

## Regenerate

Run from repo root:

```bash
node tools/generate-baseline-manifests.mjs
```

Recommended release-safe flow (candidate first, immutable only after checks pass):

```bash
REL_TAG="r2026-03-05-rc1"
node tools/release-pipeline.mjs --tag "$REL_TAG" --mode candidate
# run smoke/sanity checks
node tools/release-pipeline.mjs --tag "$REL_TAG" --mode promote
```

Generate sanity preflight manifests (default: two sets per API for paired cohorts, two runs for single-API cohorts):

```bash
MANIFEST_PROFILE="sanity" HARNESS_BASE_URL="https://innominata88.github.io/webxr-harness/" HARNESS_RELEASE_TAG="r2026-03-02-rc1" HARNESS_VERSION="r2026-03-02-rc1" node tools/generate-baseline-manifests.mjs
```

Sanity manifests are written as `*_sanity_<N>sets.json` (`N = SANITY_RUNS_PER_API`) and keep the same core workload params as baseline manifests, while reducing run count for preflight.

Generate fast smoke manifests (single run/API, single trial, short duration) for quick device readiness checks:

```bash
MANIFEST_PROFILE="smoke" HARNESS_BASE_URL="https://innominata88.github.io/webxr-harness/" HARNESS_RELEASE_TAG="r2026-03-03-rc2" HARNESS_VERSION="r2026-03-03-rc2" node tools/generate-baseline-manifests.mjs
```

Smoke defaults (override via env vars if needed):

- `SMOKE_RUNS_PER_API=1`
- `SMOKE_TRIALS=1`
- `SMOKE_DURATION_MS=2000`
- `SMOKE_WARMUP_MS=250`
- `SMOKE_PER_TRIAL_COOLDOWN_MS=100`
- `SMOKE_BETWEEN_INSTANCES_MS=200`
- `SMOKE_PRE_IDLE_MS=0`
- `SMOKE_POST_IDLE_MS=0`
- `SMOKE_COOLDOWN_MS=30000`
- `SMOKE_INSTANCES` optional override for all smoke manifests

Optional overrides:

```bash
HARNESS_BASE_URL="https://innominata88.github.io/webxr-harness/" HARNESS_RELEASE_TAG="r2026-03-01-a" HARNESS_VERSION="r2026-03-01-a" ASSET_REVISION="spiderman_2002_movie_version_sam_raimi_0" FEATURE_FLAGS_PROFILE_ID="webxr-webgpu-flags-v1" FEATURE_FLAGS_EXACT="webxr_projection_layers=1;webxr_webgpu_binding=1;webgpu=1" node tools/generate-baseline-manifests.mjs
```

Generate sanity-only launcher links:

```bash
LAUNCHER_VERSION="r2026-03-03-rc5" MANIFEST_FILTER="sanity" LAUNCHER_LINKS_OUT="launcher-links-sanity.csv" node tools/generate-launcher-links.mjs
```

Generate smoke-only launcher links:

```bash
LAUNCHER_VERSION="r2026-03-03-rc5" MANIFEST_FILTER="smoke" LAUNCHER_LINKS_OUT="launcher-links-smoke.csv" node tools/generate-launcher-links.mjs
```

Validate downloaded sanity runs (PASS/FAIL per suite):

```bash
node tools/check-sanity-batch.mjs --strict 0 ~/Downloads/Performance\ Study
```

When `HARNESS_RELEASE_TAG` is set, `tools/generate-baseline-manifests.mjs` auto-reads `releases/<tag>/RELEASE_INFO.json` and stamps `harnessCommit` from `commitShort`.
