# Immutable Snapshots

This directory stores published immutable harness snapshots used for data collection:

- `releases/<tag>/...`

Use `tools/release-pipeline.mjs` for safe promotion:

```bash
node tools/release-pipeline.mjs --tag <tag> --mode candidate
node tools/release-pipeline.mjs --tag <tag> --mode promote
```

Do not edit an existing `releases/<tag>/` after collection starts.
