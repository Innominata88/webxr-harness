# Immutable Release Workflow (GitHub Pages)

Use this workflow so experiment URLs are immutable while still hosted on `github.io`.

## 1) Freeze code and create release snapshot

From repo root:

```bash
git add builder.html run-launcher.html src tools docs
git commit -m "Freeze harness for release"
node tools/create-immutable-release.mjs r2026-03-01-a
git add releases/r2026-03-01-a
git commit -m "Add immutable release r2026-03-01-a"
git push
```

This creates:

- `releases/r2026-03-01-a/webgl.html`
- `releases/r2026-03-01-a/webgpu.html`
- `releases/r2026-03-01-a/RELEASE_INFO.json`

## 2) Generate manifests pinned to release path

```bash
HARNESS_BASE_URL="https://innominata88.github.io/webxr-harness/" \
HARNESS_RELEASE_TAG="r2026-03-01-a" \
HARNESS_VERSION="r2026-03-01-a" \
node tools/generate-baseline-manifests.mjs
```

This makes row URLs point to:

- `https://innominata88.github.io/webxr-harness/releases/r2026-03-01-a/...`

The generator auto-reads `releases/<tag>/RELEASE_INFO.json` and stamps
`harnessCommit` from `commitShort` to avoid provenance drift.

## 3) Run via launcher

Open launcher with committed manifest URL:

```text
https://innominata88.github.io/webxr-harness/run-launcher.html?manifest=manifests/<file>.json
```

Builder can also do this automatically:

- Set `releaseTag` to `r2026-03-01-a`
- Keep auto-fill `harnessVersion` enabled
- Set `launcherManifestUrl` and click **Open Run Launcher**

## 4) Immutability rule

Never edit an existing `releases/<tag>/` directory after data collection starts.

If you need changes, create a new tag (for example `r2026-03-05-b`) and a new manifest set.

## 5) GitHub Releases page (optional but recommended)

The harness "release tag" used in URLs (for example `releases/r2026-03-01-a/...`) is a repo path/version convention.
By itself, it does **not** create a GitHub Release entry.

If you want this version to appear under GitHub **Releases**, create and push a git tag, then publish a release:

```bash
git tag -a r2026-03-01-a -m "Immutable harness release r2026-03-01-a"
git push origin r2026-03-01-a
```

Then create a release in GitHub UI (or via `gh release create ...`) for that tag.
