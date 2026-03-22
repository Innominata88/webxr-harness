#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const opts = parseArgs(process.argv.slice(2));
if (!opts.dataRoot) fail("Missing required --data-root <dir>.");

const dataRoot = path.resolve(opts.dataRoot);
if (!fs.existsSync(dataRoot)) fail(`Data root not found: ${dataRoot}`);

const progressFiles = findFiles(dataRoot, (name) => /^run-launcher-progress-.*\.json$/i.test(name));
if (!progressFiles.length) fail(`No run-launcher-progress JSON files found under ${dataRoot}`);

const manifestIndex = buildManifestIndex();
const plans = [];
for (const progressPath of progressFiles) {
  const plan = buildCopyPlan(progressPath, manifestIndex);
  plans.push(plan);
}

printSummary(plans);

if (opts.copy) {
  let copied = 0;
  for (const plan of plans) {
    if (!plan.match) continue;
    copied += executeCopyPlan(plan, opts.destDirName);
  }
  process.stdout.write(`\nCopied ${copied} file(s).\n`);
} else {
  process.stdout.write("\nDry run only. Re-run with --copy to copy manifests beside the results.\n");
}

function parseArgs(argv) {
  const out = {
    dataRoot: "",
    copy: false,
    destDirName: "manifests-used"
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i] || "").trim();
    if (arg === "--data-root") {
      out.dataRoot = String(argv[++i] || "").trim();
      continue;
    }
    if (arg === "--copy") {
      out.copy = true;
      continue;
    }
    if (arg === "--dest-dir-name") {
      out.destDirName = String(argv[++i] || "").trim() || out.destDirName;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(
        "Usage: node tools/collect-used-manifests.mjs --data-root <dir> [--copy] [--dest-dir-name <name>]\n"
      );
      process.exit(0);
    }
    fail(`Unknown argument: ${arg}`);
  }
  return out;
}

function findFiles(root, predicate) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    const entries = fs.readdirSync(cur, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.isFile() && predicate(entry.name, full)) out.push(full);
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function buildManifestIndex() {
  const roots = [
    path.join(repoRoot, "manifests"),
    path.join(repoRoot, "manifest-packs"),
    path.join(repoRoot, "releases")
  ];
  const manifests = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const files = findFiles(root, (name) => name.endsWith(".json"));
    for (const file of files) {
      if (path.basename(file) === "MANIFEST_PACK_INFO.json") continue;
      if (path.basename(file) === "RELEASE_INFO.json") continue;
      let obj;
      try {
        obj = readJson(file);
      } catch (_) {
        continue;
      }
      if (obj?.schema !== "webxr-harness-manifest/v1" || !Array.isArray(obj?.rows)) continue;
      const runIds = new Set(obj.rows.map((row) => String(row?.run_id || "").trim()).filter(Boolean));
      const suiteIds = new Set(obj.rows.map((row) => String(row?.suite_id || "").trim()).filter(Boolean));
      manifests.push({
        path: file,
        relPath: path.relative(repoRoot, file),
        generatedAt: String(obj?.generatedAt || "").trim(),
        manifestVersion: String(obj?.manifest_version || "").trim(),
        harnessReleaseTag: String(obj?.harness_release_tag || "").trim(),
        rowCount: obj.rows.length,
        runIds,
        suiteIds
      });
    }
  }
  return manifests;
}

function buildCopyPlan(progressPath, manifestIndex) {
  const progress = readJson(progressPath);
  const cohortDir = path.dirname(progressPath);
  const statuses = Array.isArray(progress?.statuses) ? progress.statuses : [];
  const runIds = new Set(statuses.map((s) => String(s?.run_id || "").trim()).filter(Boolean));
  const suiteIds = new Set(statuses.map((s) => String(s?.suite_id || "").trim()).filter(Boolean));
  const manifestMeta = progress?.manifestMeta || {};
  const generatedAt = String(manifestMeta?.generatedAt || "").trim();
  const rowCount = Number.isFinite(manifestMeta?.rowCount) ? manifestMeta.rowCount : statuses.length;

  const candidates = manifestIndex
    .map((m) => ({ manifest: m, score: scoreManifest(m, runIds, suiteIds, generatedAt, rowCount) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.manifest.relPath.localeCompare(b.manifest.relPath));

  const match = candidates.length ? candidates[0].manifest : null;
  return {
    cohortDir,
    progressPath,
    generatedAt,
    rowCount,
    runIds: [...runIds].sort(),
    suiteIds: [...suiteIds].sort(),
    match,
    candidates: candidates.slice(0, 5)
  };
}

function scoreManifest(manifest, runIds, suiteIds, generatedAt, rowCount) {
  let score = 0;
  if (manifest.rowCount === rowCount) score += 50;
  if (generatedAt && manifest.generatedAt === generatedAt) score += 100;

  let matchedRunIds = 0;
  for (const runId of runIds) {
    if (manifest.runIds.has(runId)) matchedRunIds++;
  }
  if (runIds.size && matchedRunIds === runIds.size) score += 500;
  else score += matchedRunIds * 10;

  let matchedSuiteIds = 0;
  for (const suiteId of suiteIds) {
    if (manifest.suiteIds.has(suiteId)) matchedSuiteIds++;
  }
  if (suiteIds.size && matchedSuiteIds === suiteIds.size) score += 25;

  return score;
}

function printSummary(plans) {
  process.stdout.write(`Matched ${plans.length} cohort folder(s):\n`);
  for (const plan of plans) {
    process.stdout.write(`\n- ${path.relative(dataRoot, plan.cohortDir) || "."}\n`);
    process.stdout.write(`  progress: ${path.basename(plan.progressPath)}\n`);
    process.stdout.write(`  run_count: ${plan.rowCount}\n`);
    if (plan.match) {
      process.stdout.write(`  manifest: ${plan.match.relPath}\n`);
      process.stdout.write(`  generated_at: ${plan.match.generatedAt || "(none)"}\n`);
      process.stdout.write(`  manifest_version: ${plan.match.manifestVersion || "(none)"}\n`);
      process.stdout.write(`  harness_release_tag: ${plan.match.harnessReleaseTag || "(none)"}\n`);
    } else {
      process.stdout.write("  manifest: NO MATCH\n");
      for (const cand of plan.candidates) {
        process.stdout.write(`    candidate: ${cand.manifest.relPath} score=${cand.score}\n`);
      }
    }
  }
}

function executeCopyPlan(plan, destDirName) {
  const files = filesToCopyForMatch(plan.match);
  if (!files.length) return 0;
  const destDir = path.join(plan.cohortDir, destDirName);
  fs.mkdirSync(destDir, { recursive: true });
  let count = 0;
  for (const src of files) {
    if (!fs.existsSync(src)) continue;
    const dest = path.join(destDir, path.basename(src));
    fs.copyFileSync(src, dest);
    count++;
  }
  const progressBase = path.basename(plan.progressPath).replace(/\.json$/i, "");
  const summaryPath = path.join(destDir, `manifest-selection-${progressBase}.json`);
  fs.writeFileSync(
    summaryPath,
    `${JSON.stringify({
      copiedAt: new Date().toISOString(),
      sourceManifest: plan.match.relPath,
      generatedAt: plan.match.generatedAt,
      manifestVersion: plan.match.manifestVersion,
      harnessReleaseTag: plan.match.harnessReleaseTag,
      progressFile: path.basename(plan.progressPath),
      suiteIds: plan.suiteIds,
      runIds: plan.runIds
    }, null, 2)}\n`,
    "utf8"
  );
  return count + 1;
}

function filesToCopyForMatch(match) {
  if (!match) return [];
  const files = [match.path];
  const rel = match.relPath.split(path.sep).join("/");
  const manifestDir = path.dirname(match.path);
  const launcherBases = launcherLinkBaseNamesForManifest(path.basename(match.path));

  if (rel.startsWith("manifest-packs/")) {
    const packDir = path.resolve(manifestDir, "..");
    const packInfo = path.join(packDir, "MANIFEST_PACK_INFO.json");
    if (fs.existsSync(packInfo)) files.push(packInfo);
    addLauncherFiles(files, manifestDir, launcherBases);
    return files;
  }

  if (rel.startsWith("releases/")) {
    const releaseDir = path.resolve(manifestDir, "..");
    const releaseInfo = path.join(releaseDir, "RELEASE_INFO.json");
    if (fs.existsSync(releaseInfo)) files.push(releaseInfo);
    addLauncherFiles(files, manifestDir, launcherBases);
    return files;
  }

  addLauncherFiles(files, manifestDir, launcherBases);
  return files;
}

function launcherLinkBaseNamesForManifest(fileName) {
  const name = String(fileName || "").toLowerCase();
  if (name.includes("_material_stress_")) return ["launcher-links-material-stress", "launcher-links"];
  if (name.includes("_material_complexity_")) return ["launcher-links-material", "launcher-links"];
  if (name.includes("_trace_")) return ["launcher-links-trace", "launcher-links"];
  if (name.includes("_failurecurve_")) return ["launcher-links-failure", "launcher-links"];
  if (name.includes("_sanity_")) return ["launcher-links-sanity", "launcher-links"];
  if (name.includes("_smoke_")) return ["launcher-links-smoke", "launcher-links"];
  if (name.includes("_cliff_i") || name.includes("_cliff_")) return ["launcher-links-cliff", "launcher-links"];
  return ["launcher-links"];
}

function addLauncherFiles(out, manifestDir, bases) {
  const seen = new Set(out.map((p) => path.resolve(p)));
  for (const base of bases) {
    for (const ext of [".html", ".md", ".csv"]) {
      const file = path.join(manifestDir, `${base}${ext}`);
      const resolved = path.resolve(file);
      if (!fs.existsSync(file) || seen.has(resolved)) continue;
      out.push(file);
      seen.add(resolved);
    }
  }
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
