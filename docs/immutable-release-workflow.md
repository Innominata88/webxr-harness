# Immutable Release Workflow (GitHub Pages)

Use this workflow so experiment URLs are immutable while still hosted on `github.io`.

Recommended model:

1. Freeze the harness runtime once under `releases/<harness-tag>/`
2. Publish separately versioned manifest packs under `manifest-packs/<manifest-tag>/`

That lets you revise protocol/manifests without making it look like the harness code changed.

## 1) Freeze code and choose release tag

From repo root:

```bash
git add builder.html run-launcher.html src tools docs
git commit -m "Freeze harness for release"
REL_TAG="r2026-03-01-a"
```

## 2) Build candidate artifacts (no immutable snapshot yet)

```bash
node tools/release-pipeline.mjs --tag "$REL_TAG" --mode candidate
```

This regenerates baseline/sanity/smoke manifests and launcher links pinned to:

- `https://innominata88.github.io/webxr-harness/...` (root pages, no immutable snapshot yet)

Run your smoke/sanity checks using `v=<tag>` links.
If any issue appears, fix code and re-run candidate mode with the same tag before promotion.

## 3) Promote candidate to immutable snapshot

```bash
node tools/release-pipeline.mjs --tag "$REL_TAG" --mode promote
git add manifests releases/"$REL_TAG"
git commit -m "Publish immutable release $REL_TAG"
git push origin main
```

This creates:

- `releases/<tag>/webgl.html`
- `releases/<tag>/webgpu.html`
- `releases/<tag>/run-launcher.html`
- `releases/<tag>/builder.html`
- `releases/<tag>/manifests/*.json`
- `releases/<tag>/RELEASE_INFO.json`

And verifies release-local launcher links are pinned to the same tag.
After promote, root manifests are also rewritten to point at `releases/<tag>/...`.

## 4) Publish Decoupled Manifest Pack

After the harness release is frozen, generate separately versioned manifests that point to it:

```bash
MANIFEST_TAG="m2026-03-07-a"
HARNESS_TAG="$REL_TAG"
node tools/manifest-pack-pipeline.mjs --manifest-tag "$MANIFEST_TAG" --harness-tag "$HARNESS_TAG"
git add manifest-packs/"$MANIFEST_TAG"
git commit -m "Publish manifest pack $MANIFEST_TAG for $HARNESS_TAG"
git push origin main
```

This creates:

- `manifest-packs/<manifest-tag>/manifests/*.json`
- `manifest-packs/<manifest-tag>/manifests/launcher-links.html`

The launcher links in that pack use the frozen runtime from:

- `releases/<harness-tag>/run-launcher.html`

## 5) Run via launcher

Open launcher with committed manifest URL:

```text
https://innominata88.github.io/webxr-harness/releases/<tag>/run-launcher.html?manifest=manifests/<file>.json
```

For decoupled collection, prefer the manifest-pack links page:

```text
https://innominata88.github.io/webxr-harness/manifest-packs/<manifest-tag>/manifests/launcher-links.html?v=<manifest-tag>
```

Builder can also do this automatically:

- Set `releaseTag` to `<tag>`
- Keep auto-fill `harnessVersion` enabled
- Set `launcherManifestUrl` and click **Open Run Launcher**

## 6) Immutability rule

Never edit an existing `releases/<tag>/` directory after data collection starts.

If you need changes, create a new tag (for example `r2026-03-05-b`) and a new manifest set.

Never edit an existing `manifest-packs/<manifest-tag>/` directory after data collection starts either.

If you need protocol/order/workload changes without runtime code changes, create a new manifest tag, not a new harness release tag.

## 7) GitHub Releases page (optional but recommended)

The harness "release tag" used in URLs (for example `releases/r2026-03-01-a/...`) is a repo path/version convention.
By itself, it does **not** create a GitHub Release entry.

If you want this version to appear under GitHub **Releases**, create and push a git tag, then publish a release:

```bash
git tag -a r2026-03-01-a -m "Immutable harness release r2026-03-01-a"
git push origin r2026-03-01-a
```

Then create a release in GitHub UI (or via `gh release create ...`) for that tag.
