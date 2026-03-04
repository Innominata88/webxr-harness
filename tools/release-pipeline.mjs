#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseUrl = "https://innominata88.github.io/webxr-harness/";

const opts = parseArgs(process.argv.slice(2));
if (!opts.tag) fail(usage("Missing required --tag."));
if (!/^[a-zA-Z0-9._-]+$/.test(opts.tag)) fail(usage("Tag may contain only letters, numbers, dot, underscore, dash."));
if (!["candidate", "promote"].includes(opts.mode)) fail(usage(`Unsupported --mode=${opts.mode}.`));

const releaseDir = path.join(repoRoot, "releases", opts.tag);
if (opts.mode === "promote" && fs.existsSync(releaseDir)) {
  fail(`Release directory already exists: releases/${opts.tag}\nPick a new tag or remove the existing directory first.`);
}

const commitShort = safeGit("git rev-parse --short HEAD") || "";

const generateEnv = buildGenerateEnv(opts.mode, opts.tag, commitShort);
generateRootArtifacts(opts.tag, generateEnv);
verifyRootLinksTag(opts.tag);
verifyRootManifestBase(opts.mode, opts.tag);

if (opts.mode === "promote") {
  runNodeScript(path.join(repoRoot, "tools", "create-immutable-release.mjs"), [opts.tag], {}, repoRoot);

  const releaseBaseUrl = `${baseUrl}releases/${opts.tag}/`;
  runNodeScript(
    path.join(repoRoot, "tools", "generate-launcher-links.mjs"),
    [],
    { LAUNCHER_VERSION: opts.tag, HARNESS_BASE_URL: releaseBaseUrl },
    releaseDir
  );
  runNodeScript(
    path.join(repoRoot, "tools", "generate-launcher-links.mjs"),
    [],
    {
      LAUNCHER_VERSION: opts.tag,
      HARNESS_BASE_URL: releaseBaseUrl,
      MANIFEST_FILTER: "sanity",
      LAUNCHER_LINKS_OUT: "launcher-links-sanity.csv"
    },
    releaseDir
  );
  runNodeScript(
    path.join(repoRoot, "tools", "generate-launcher-links.mjs"),
    [],
    {
      LAUNCHER_VERSION: opts.tag,
      HARNESS_BASE_URL: releaseBaseUrl,
      MANIFEST_FILTER: "smoke",
      LAUNCHER_LINKS_OUT: "launcher-links-smoke.csv"
    },
    releaseDir
  );
  verifyReleaseLinksTag(opts.tag, releaseDir);
}

printSummary(opts.tag, opts.mode, commitShort);

function parseArgs(argv) {
  const out = { tag: "", mode: "candidate" };
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i] || "").trim();
    if (arg === "--tag") {
      out.tag = String(argv[++i] || "").trim();
      continue;
    }
    if (arg === "--mode") {
      out.mode = String(argv[++i] || "").trim().toLowerCase();
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
  lines.push("Usage: node tools/release-pipeline.mjs --tag <release-tag> [--mode candidate|promote]");
  lines.push("Modes:");
  lines.push("  candidate: regenerate manifests/launcher links against root URLs (smoke before lock).");
  lines.push("  promote:   regenerate manifests pinned to releases/<tag>, create immutable snapshot, refresh release-local links.");
  lines.push("Examples:");
  lines.push("  node tools/release-pipeline.mjs --tag r2026-03-05-rc1 --mode candidate");
  lines.push("  node tools/release-pipeline.mjs --tag r2026-03-05-a --mode promote");
  return lines.join("\n");
}

function runNodeScript(scriptPath, args, envVars, cwd) {
  const proc = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    env: { ...process.env, ...envVars },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (proc.stdout) process.stdout.write(proc.stdout);
  if (proc.stderr) process.stderr.write(proc.stderr);
  if (proc.status !== 0) {
    fail(`Command failed: node ${path.relative(repoRoot, scriptPath)} ${args.join(" ")}`.trim());
  }
}

function verifyRootLinksTag(tag) {
  const mdPath = path.join(repoRoot, "manifests", "launcher-links.md");
  const text = fs.readFileSync(mdPath, "utf8");
  if (!text.includes(`launcher_version: ${tag}`)) {
    fail(`Root launcher links are not pinned to ${tag}: manifests/launcher-links.md`);
  }
}

function verifyRootManifestBase(mode, tag) {
  const manifestPath = path.join(repoRoot, "manifests", "macbookpro_m1_canvas_primary_regular_paired_smoke_1sets.json");
  const text = fs.readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(text);
  const effective = String(manifest?.source?.effectiveBaseUrl || "");
  const expected = mode === "promote" ? `${baseUrl}releases/${tag}/` : baseUrl;
  if (effective !== expected) {
    fail(
      `Root manifest base mismatch in ${path.relative(repoRoot, manifestPath)}.\nExpected: ${expected}\nActual:   ${effective}`
    );
  }
}

function verifyReleaseLinksTag(tag, dir) {
  const mdPath = path.join(dir, "manifests", "launcher-links.md");
  const text = fs.readFileSync(mdPath, "utf8");
  if (!text.includes(`launcher_version: ${tag}`)) {
    fail(`Release launcher links are not pinned to ${tag}: releases/${tag}/manifests/launcher-links.md`);
  }
}

function printSummary(tag, mode, commitShortValue) {
  process.stdout.write("\nRelease pipeline complete.\n");
  process.stdout.write(`- mode: ${mode}\n`);
  process.stdout.write(`- tag: ${tag}\n`);
  if (commitShortValue) process.stdout.write(`- source commit: ${commitShortValue}\n`);
  process.stdout.write(`\nNext steps:\n`);
  if (mode === "candidate") {
    process.stdout.write(`1) Run smoke/sanity checks using root launcher links (v=${tag}).\n`);
    process.stdout.write(`   Example: ${baseUrl}run-launcher.html?v=${tag}&manifest=<encoded-manifest-url>\n`);
    process.stdout.write(`2) If checks pass, run:\n`);
    process.stdout.write(`   node tools/release-pipeline.mjs --tag ${tag} --mode promote\n`);
    process.stdout.write(`3) Commit and push manifests + links + releases/${tag}.\n`);
    return;
  }
  process.stdout.write(`1) git add manifests releases/${tag}\n`);
  process.stdout.write(`2) git commit -m \"Publish immutable release ${tag}\"\n`);
  process.stdout.write(`3) git push origin main\n`);
  process.stdout.write(`4) Use launcher URL:\n`);
  process.stdout.write(`   ${baseUrl}releases/${tag}/run-launcher.html?manifest=manifests/<manifest>.json\n`);
}

function safeGit(cmd) {
  try {
    return String(execSync(cmd, { cwd: repoRoot, stdio: ["ignore", "pipe", "ignore"] })).trim();
  } catch (_) {
    return "";
  }
}

function buildGenerateEnv(mode, tag, commit) {
  const env = {
    HARNESS_BASE_URL: baseUrl,
    HARNESS_VERSION: tag
  };
  if (commit) env.HARNESS_COMMIT = commit;
  if (mode === "promote") env.HARNESS_RELEASE_TAG = tag;
  return env;
}

function generateRootArtifacts(tag, env) {
  runNodeScript(path.join(repoRoot, "tools", "generate-baseline-manifests.mjs"), [], env, repoRoot);
  runNodeScript(
    path.join(repoRoot, "tools", "generate-baseline-manifests.mjs"),
    [],
    { ...env, MANIFEST_PROFILE: "sanity" },
    repoRoot
  );
  runNodeScript(
    path.join(repoRoot, "tools", "generate-baseline-manifests.mjs"),
    [],
    { ...env, MANIFEST_PROFILE: "smoke" },
    repoRoot
  );

  runNodeScript(
    path.join(repoRoot, "tools", "generate-launcher-links.mjs"),
    [],
    { LAUNCHER_VERSION: tag },
    repoRoot
  );
  runNodeScript(
    path.join(repoRoot, "tools", "generate-launcher-links.mjs"),
    [],
    { LAUNCHER_VERSION: tag, MANIFEST_FILTER: "sanity", LAUNCHER_LINKS_OUT: "launcher-links-sanity.csv" },
    repoRoot
  );
  runNodeScript(
    path.join(repoRoot, "tools", "generate-launcher-links.mjs"),
    [],
    { LAUNCHER_VERSION: tag, MANIFEST_FILTER: "smoke", LAUNCHER_LINKS_OUT: "launcher-links-smoke.csv" },
    repoRoot
  );
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
