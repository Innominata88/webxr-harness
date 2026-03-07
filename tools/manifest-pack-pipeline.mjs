#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseUrl = "https://innominata88.github.io/webxr-harness/";

const opts = parseArgs(process.argv.slice(2));
if (!opts.manifestTag) fail(usage("Missing required --manifest-tag."));
if (!opts.harnessTag) fail(usage("Missing required --harness-tag."));
if (!/^[a-zA-Z0-9._-]+$/.test(opts.manifestTag)) fail(usage(`Invalid --manifest-tag=${opts.manifestTag}`));
if (!/^[a-zA-Z0-9._-]+$/.test(opts.harnessTag)) fail(usage(`Invalid --harness-tag=${opts.harnessTag}`));

const releaseInfoPath = path.join(repoRoot, "releases", opts.harnessTag, "RELEASE_INFO.json");
if (!fs.existsSync(releaseInfoPath)) {
  fail(`Harness release not found: releases/${opts.harnessTag}/RELEASE_INFO.json`);
}

const packDirRel = path.posix.join("manifest-packs", opts.manifestTag);
const packDir = path.join(repoRoot, packDirRel);
const manifestDirRel = path.posix.join(packDirRel, "manifests");
const manifestDir = path.join(repoRoot, manifestDirRel);
if (fs.existsSync(packDir)) {
  fail(`Manifest pack directory already exists: ${packDirRel}\nPick a new manifest tag to keep manifest packs immutable.`);
}
fs.mkdirSync(manifestDir, { recursive: true });

const releaseInfo = JSON.parse(fs.readFileSync(releaseInfoPath, "utf8"));
const harnessCommit = String(releaseInfo?.commitShort || "").trim();
const manifestPublicBaseUrl = `${baseUrl}${packDirRel}/`;
const launcherBaseUrl = `${baseUrl}releases/${opts.harnessTag}/`;
const packGeneratedAt = new Date().toISOString();

const generateEnv = {
  HARNESS_BASE_URL: baseUrl,
  HARNESS_RELEASE_TAG: opts.harnessTag,
  HARNESS_VERSION: opts.harnessTag,
  MANIFEST_VERSION: opts.manifestTag,
  MANIFEST_OUT_DIR: manifestDirRel,
  GENERATED_AT: packGeneratedAt
};
if (harnessCommit) generateEnv.HARNESS_COMMIT = harnessCommit;

generateManifestProfile("baseline", generateEnv);
generateManifestProfile("sanity", generateEnv);
generateManifestProfile("smoke", generateEnv);

generateLauncherLinks({
  manifestDirRel,
  manifestPublicBaseUrl,
  launcherBaseUrl,
  versionToken: opts.manifestTag
});
generateLauncherLinks({
  manifestDirRel,
  manifestPublicBaseUrl,
  launcherBaseUrl,
  versionToken: opts.manifestTag,
  manifestFilter: "sanity",
  outName: "launcher-links-sanity.csv"
});
generateLauncherLinks({
  manifestDirRel,
  manifestPublicBaseUrl,
  launcherBaseUrl,
  versionToken: opts.manifestTag,
  manifestFilter: "smoke",
  outName: "launcher-links-smoke.csv"
});

verifyManifestPack();
writeManifestPackInfo();
printSummary();

function parseArgs(argv) {
  const out = { manifestTag: "", harnessTag: "" };
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i] || "").trim();
    if (arg === "--manifest-tag") {
      out.manifestTag = String(argv[++i] || "").trim();
      continue;
    }
    if (arg === "--harness-tag") {
      out.harnessTag = String(argv[++i] || "").trim();
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(`${usage("")}\n`);
      process.exit(0);
    }
    fail(usage(`Unknown argument: ${arg}`));
  }
  return out;
}

function usage(prefix) {
  const lines = [];
  if (prefix) lines.push(prefix);
  lines.push("Usage: node tools/manifest-pack-pipeline.mjs --manifest-tag <manifest-tag> --harness-tag <release-tag>");
  lines.push("Example:");
  lines.push("  node tools/manifest-pack-pipeline.mjs --manifest-tag m2026-03-07-a --harness-tag r2026-03-06-a");
  return lines.join("\n");
}

function runNodeScript(scriptPath, envVars) {
  const proc = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    env: { ...process.env, ...envVars },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (proc.stdout) process.stdout.write(proc.stdout);
  if (proc.stderr) process.stderr.write(proc.stderr);
  if (proc.status !== 0) {
    fail(`Command failed: node ${path.relative(repoRoot, scriptPath)}`);
  }
}

function generateManifestProfile(profile, env) {
  const profileEnv = profile === "baseline" ? env : { ...env, MANIFEST_PROFILE: profile };
  runNodeScript(path.join(repoRoot, "tools", "generate-baseline-manifests.mjs"), profileEnv);
}

function generateLauncherLinks({ manifestDirRel: relDir, manifestPublicBaseUrl: publicBase, launcherBaseUrl: launcherBase, versionToken, manifestFilter = "", outName = "launcher-links.csv" }) {
  runNodeScript(path.join(repoRoot, "tools", "generate-launcher-links.mjs"), {
    MANIFEST_DIR: relDir,
    MANIFEST_PUBLIC_BASE_URL: publicBase,
    LAUNCHER_BASE_URL: launcherBase,
    LAUNCHER_VERSION: versionToken,
    GENERATED_AT: packGeneratedAt,
    MANIFEST_FILTER: manifestFilter,
    LAUNCHER_LINKS_OUT: outName
  });
}

function verifyManifestPack() {
  const sampleManifestPath = path.join(manifestDir, "macbookpro_m1_canvas_primary_regular_paired_5sets.json");
  const manifest = JSON.parse(fs.readFileSync(sampleManifestPath, "utf8"));
  const expectedBase = `${baseUrl}releases/${opts.harnessTag}/`;
  const actualBase = String(manifest?.source?.effectiveBaseUrl || "");
  if (actualBase !== expectedBase) {
    fail(`Manifest pack effectiveBaseUrl mismatch.\nExpected: ${expectedBase}\nActual:   ${actualBase}`);
  }
  if (String(manifest?.manifest_version || "") !== opts.manifestTag) {
    fail(`Manifest pack manifest_version mismatch in ${path.relative(repoRoot, sampleManifestPath)}.`);
  }
  const mdPath = path.join(manifestDir, "launcher-links.md");
  const text = fs.readFileSync(mdPath, "utf8");
  if (!text.includes(`launcher_base_url: ${launcherBaseUrl}`)) {
    fail(`Launcher links are not pointing at ${launcherBaseUrl}`);
  }
}

function writeManifestPackInfo() {
  const info = {
    schema: "webxr-harness-manifest-pack/v1",
    generatedAt: packGeneratedAt,
    manifestTag: opts.manifestTag,
    harnessReleaseTag: opts.harnessTag,
    harnessCommit,
    manifestPublicBaseUrl,
    launcherBaseUrl
  };
  fs.writeFileSync(path.join(packDir, "MANIFEST_PACK_INFO.json"), `${JSON.stringify(info, null, 2)}\n`, "utf8");
}

function printSummary() {
  process.stdout.write("\nManifest pack pipeline complete.\n");
  process.stdout.write(`- manifest tag: ${opts.manifestTag}\n`);
  process.stdout.write(`- harness release tag: ${opts.harnessTag}\n`);
  if (harnessCommit) process.stdout.write(`- harness commit: ${harnessCommit}\n`);
  process.stdout.write(`- manifest pack dir: ${packDirRel}\n`);
  process.stdout.write(`\nNext steps:\n`);
  process.stdout.write(`1) git add ${packDirRel}\n`);
  process.stdout.write(`2) git commit -m "Publish manifest pack ${opts.manifestTag} for ${opts.harnessTag}"\n`);
  process.stdout.write(`3) git push origin main\n`);
  process.stdout.write(`4) Use links page:\n`);
  process.stdout.write(`   ${manifestPublicBaseUrl}manifests/launcher-links.html?v=${opts.manifestTag}\n`);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
