# Immutable Release Workflow (GitHub Pages)

Use this workflow so experiment URLs are immutable while still hosted on `github.io`.

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

- `https://innominata88.github.io/webxr-harness/releases/<tag>/...`

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

## 4) Run via launcher

Open launcher with committed manifest URL:

```text
https://innominata88.github.io/webxr-harness/releases/<tag>/run-launcher.html?manifest=manifests/<file>.json
```

Builder can also do this automatically:

- Set `releaseTag` to `<tag>`
- Keep auto-fill `harnessVersion` enabled
- Set `launcherManifestUrl` and click **Open Run Launcher**

## 5) Immutability rule

Never edit an existing `releases/<tag>/` directory after data collection starts.

If you need changes, create a new tag (for example `r2026-03-05-b`) and a new manifest set.

## 6) GitHub Releases page (optional but recommended)

The harness "release tag" used in URLs (for example `releases/r2026-03-01-a/...`) is a repo path/version convention.
By itself, it does **not** create a GitHub Release entry.

If you want this version to appear under GitHub **Releases**, create and push a git tag, then publish a release:

```bash
git tag -a r2026-03-01-a -m "Immutable harness release r2026-03-01-a"
git push origin r2026-03-01-a
```

Then create a release in GitHub UI (or via `gh release create ...`) for that tag.
