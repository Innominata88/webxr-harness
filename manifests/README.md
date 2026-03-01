# Baseline Manifest Set

These manifests were generated for baseline collection using:

- Harness commit: `ea58bb8`
- Generator: `tools/generate-baseline-manifests.mjs`
- Base URL in run links: `https://innominata88.github.io/webxr-harness/`
- Model: `./assets/spiderman_2002_movie_version_sam_raimi_0.glb`
- `debugColor=flat`, `manualDownload=1`, `traceMarkers=1`, `traceOverlay=0`

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
4. `manifests/quest2_canvas_primary_regular_webgl_only_5sets.json`
5. `manifests/quest2_xr_primary_regular_webgl_only_5sets.json`
6. `manifests/pixel8a_canvas_primary_regular_paired_5sets.json`
7. `manifests/samsung_fe5g_canvas_primary_regular_paired_5sets.json`
8. `manifests/ipadairm3_canvas_primary_regular_paired_5sets.json`
9. `manifests/macbookpro_m1_canvas_primary_regular_paired_5sets.json`
10. `manifests/windows_hp_canvas_primary_regular_paired_5sets.json`

## Optional Phone AR Manifests

1. `manifests/pixel8a_xr_ar_primary_regular_webgl_only_5sets.json`
2. `manifests/samsung_fe5g_xr_ar_primary_regular_webgl_only_5sets.json`

## Notes

- Paired manifests use `manifestOrderMode=abba_baab` with `manifestRuns=10` (5 runs per API).
- Single-API manifests use `manifestOrderMode=none` with `manifestRuns=5`.
- Regular manifests use cooldown `300000` ms (5 min) between runs.
- AVP cliff manifest uses cooldown `600000` ms (10 min) between runs.
- AVP cliff instance band is `340,345,348,350`.

## Regenerate

Run from repo root:

```bash
node tools/generate-baseline-manifests.mjs
```

Optional overrides:

```bash
HARNESS_BASE_URL="https://innominata88.github.io/webxr-harness/" HARNESS_RELEASE_TAG="r2026-03-01-a" HARNESS_COMMIT="ea58bb8" HARNESS_VERSION="r2026-03-01-a" ASSET_REVISION="spiderman_2002_movie_version_sam_raimi_0" node tools/generate-baseline-manifests.mjs
```
