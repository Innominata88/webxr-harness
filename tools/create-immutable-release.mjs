#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tag = String(process.argv[2] || "").trim();

if (!tag) {
  process.stderr.write("Usage: node tools/create-immutable-release.mjs <release-tag>\n");
  process.stderr.write("Example: node tools/create-immutable-release.mjs r2026-03-01-a\n");
  process.exit(1);
}

if (!/^[a-zA-Z0-9._-]+$/.test(tag)) {
  process.stderr.write("Release tag may contain only letters, numbers, dot, underscore, dash.\n");
  process.exit(1);
}

const releaseDir = path.join(repoRoot, "releases", tag);
if (fs.existsSync(releaseDir)) {
  process.stderr.write(`Refusing to overwrite existing release directory: releases/${tag}\n`);
  process.stderr.write("Create a new tag instead to keep releases immutable.\n");
  process.exit(1);
}

const includes = [
  "assets",
  "src",
  "manifests",
  "builder.html",
  "run-launcher.html",
  "webgl.html",
  "webgpu.html",
  "vr-webgl.html",
  "vr-webgpu.html",
  "idle.html",
  "index.html",
  "LICENSE"
];

const commit = safeGit("git rev-parse --short HEAD");
const commitLong = safeGit("git rev-parse HEAD");
const branch = safeGit("git rev-parse --abbrev-ref HEAD");
const createdAt = new Date().toISOString();

fs.mkdirSync(releaseDir, { recursive: true });
for (const entry of includes) {
  const src = path.join(repoRoot, entry);
  const dst = path.join(releaseDir, entry);
  if (!fs.existsSync(src)) {
    process.stderr.write(`Missing required path: ${entry}\n`);
    process.exit(1);
  }
  fs.cpSync(src, dst, { recursive: true });
}

const releaseInfo = {
  schema: "webxr-harness-release-info/v1",
  releaseTag: tag,
  createdAt,
  commitShort: commit || null,
  commitFull: commitLong || null,
  branch: branch || null,
  includedPaths: includes
};

fs.writeFileSync(
  path.join(releaseDir, "RELEASE_INFO.json"),
  `${JSON.stringify(releaseInfo, null, 2)}\n`,
  "utf8"
);

process.stdout.write(`Created immutable release snapshot at releases/${tag}\n`);
if (commit) process.stdout.write(`Source commit: ${commit}\n`);
process.stdout.write("Next steps:\n");
process.stdout.write("1) git add releases/<tag>\n");
process.stdout.write("2) git commit -m \"Add immutable release <tag>\"\n");
process.stdout.write("3) git push\n");
process.stdout.write(`4) Use base URL: https://innominata88.github.io/webxr-harness/releases/${tag}/\n`);
process.stdout.write(`5) Launcher URL example: https://innominata88.github.io/webxr-harness/releases/${tag}/run-launcher.html?manifest=manifests/<manifest>.json\n`);

function safeGit(cmd) {
  try {
    return String(execSync(cmd, { cwd: repoRoot, stdio: ["ignore", "pipe", "ignore"] })).trim();
  } catch (_) {
    return "";
  }
}
