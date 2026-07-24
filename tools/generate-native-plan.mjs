#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SOURCE_SCHEMA = "webxr-harness-manifest/v1";
const NATIVE_SCHEMA = "native-benchmark-manifest/v1";

const QUERY_FIELDS = Object.freeze({
  instances: "instances",
  trialsPerInstance: "trials",
  durationMs: "durationMs",
  warmupMs: "warmupMs",
  cooldownMs: "cooldownMs",
  betweenInstancesMs: "betweenInstancesMs",
  minFrames: "minFrames",
  layout: "layout",
  spacing: "spacing",
  seed: "seed",
  shuffle: "shuffle",
  surfaceMode: "surfaceMode",
  renderScale: "canvasScaleFactor",
  harnessCommit: "harnessCommit",
  harnessVersion: "harnessVersion",
  assetRevision: "assetRevision",
});

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const args = {
    manifest: "",
    out: "",
    api: "",
    runtimeFamily: "",
    runCount: null,
    force: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--force") {
      args.force = true;
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) fail(`Missing value for ${arg}`);
    switch (arg) {
      case "--manifest": args.manifest = next; break;
      case "--out": args.out = next; break;
      case "--api": args.api = next.toLowerCase(); break;
      case "--runtime-family": args.runtimeFamily = next; break;
      case "--run-count": args.runCount = Number(next); break;
      default: fail(`Unknown argument: ${arg}`);
    }
    i++;
  }

  if (!args.manifest) fail("--manifest is required");
  if (!args.api) fail("--api is required");
  if (args.runCount != null && (!Number.isInteger(args.runCount) || args.runCount < 1)) {
    fail("--run-count must be a positive integer");
  }
  return args;
}

function runtimeFamilyForApi(api) {
  switch (api) {
    case "metal": return "native-apple";
    case "vulkan":
    case "opengles": return "native-android";
    case "d3d11":
    case "d3d12": return "native-windows";
    default: fail(`Unsupported native API: ${api}`);
  }
}

function parseQueryRow(row, rowIndex) {
  if ((row.run_mode ?? "canvas") !== "canvas") return null;
  if (!row.url) fail(`Row ${rowIndex + 1} has no URL`);

  let url;
  try {
    url = new URL(row.url);
  } catch {
    fail(`Row ${rowIndex + 1} has an invalid URL`);
  }

  const value = (name, fallback = "") => url.searchParams.get(name) ?? fallback;
  const instances = value("instances", row.instances ?? "64")
    .split(",")
    .map((entry) => Number(entry.trim()))
    .filter(Number.isFinite);
  if (!instances.length || instances.some((entry) => !Number.isInteger(entry) || entry < 1)) {
    fail(`Row ${rowIndex + 1} has an invalid instance ladder`);
  }

  const surfaceMode = value("surfaceMode", row.surface_mode ?? "flat").toLowerCase();
  if (!["flat", "basecolor"].includes(surfaceMode)) {
    fail(`Row ${rowIndex + 1} has unsupported surfaceMode=${surfaceMode}`);
  }

  return {
    api: String(row.api ?? ""),
    suiteId: value("suiteId", row.suite_id ?? ""),
    instances,
    trialsPerInstance: Number(value("trials", row.trials ?? "5")),
    durationMs: Number(value("durationMs", row.duration_ms ?? "6000")),
    warmupMs: Number(value("warmupMs", "500")),
    cooldownMs: Number(value("cooldownMs", "250")),
    betweenInstancesMs: Number(value("betweenInstancesMs", "800")),
    minFrames: Number(value("minFrames", "30")),
    layout: value("layout", row.layout ?? "xrwall"),
    spacing: Number(value("spacing", "0.35")),
    seed: Number(value("seed", row.order_seed ?? "12345")),
    shuffle: value("shuffle", row.shuffle ?? "0") === "1",
    surfaceMode,
    renderScale: Number(value("canvasScaleFactor", "1")),
    harnessCommit: value("harnessCommit", row.harness_commit ?? ""),
    harnessVersion: value("harnessVersion", row.harness_version ?? ""),
    assetRevision: value("assetRevision", row.asset_revision ?? ""),
    cooldownAfterMs: Number(row.cooldown_after_ms ?? 0),
  };
}

function stableWorkload(row) {
  return JSON.stringify({
    instances: row.instances,
    trialsPerInstance: row.trialsPerInstance,
    durationMs: row.durationMs,
    warmupMs: row.warmupMs,
    cooldownMs: row.cooldownMs,
    betweenInstancesMs: row.betweenInstancesMs,
    minFrames: row.minFrames,
    layout: row.layout,
    spacing: row.spacing,
    seed: row.seed,
    shuffle: row.shuffle,
    surfaceMode: row.surfaceMode,
    renderScale: row.renderScale,
    harnessCommit: row.harnessCommit,
    harnessVersion: row.harnessVersion,
    assetRevision: row.assetRevision,
    cooldownAfterMs: row.cooldownAfterMs,
  });
}

function inferRunCount(rows) {
  const counts = new Map();
  for (const row of rows) {
    const api = row.api || "unspecified";
    counts.set(api, (counts.get(api) ?? 0) + 1);
  }
  const values = [...counts.values()];
  if (!values.length) fail("No canvas rows found");
  if (new Set(values).size !== 1) {
    fail(`Source APIs have unequal repetition counts: ${JSON.stringify(Object.fromEntries(counts))}`);
  }
  return values[0];
}

function inferGroups(sourceName) {
  const stem = path.basename(sourceName, path.extname(sourceName));
  for (const marker of ["_canvas_", "_xr_ar_", "_xr_"]) {
    const index = stem.indexOf(marker);
    if (index < 0) continue;
    const deviceGroup = stem.slice(0, index);
    let cohortGroup = `${marker.slice(1)}${stem.slice(index + marker.length)}`;
    cohortGroup = cohortGroup.replace(
      /_(paired|webgl_only|smoke|sanity)(?:_[^_]*)?_(?:\d+sets?)$/,
      ""
    );
    cohortGroup = cohortGroup.replace(/_paired_\d+sets?$/, "");
    return { deviceGroup, cohortGroup };
  }
  return { deviceGroup: stem, cohortGroup: "unknown" };
}

function nativeSuiteId(sourceSuiteId, deviceGroup, cohortGroup) {
  if (sourceSuiteId) {
    const devicePrefix = deviceGroup.toUpperCase();
    if (sourceSuiteId.startsWith(`${devicePrefix}_`)) {
      return `${devicePrefix}_NATIVE_${sourceSuiteId.slice(devicePrefix.length + 1)}`;
    }
    return `NATIVE_${sourceSuiteId}`;
  }
  return `${deviceGroup}_native_${cohortGroup}`.toUpperCase();
}

function nativeRunStem(deviceGroup, cohortGroup) {
  return `${deviceGroup}_native_${cohortGroup}`
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase();
}

export function generateNativePlan(source, options = {}) {
  if (!source || source.schema !== SOURCE_SCHEMA) {
    fail(`Unsupported source schema: ${source?.schema ?? ""}`);
  }

  const sourceName = options.sourceName ?? "manifest.json";
  const api = String(options.api ?? "").toLowerCase();
  if (!api) fail("Native API is required");
  const runtimeFamily = options.runtimeFamily || runtimeFamilyForApi(api);
  const parsedRows = (source.rows ?? [])
    .map(parseQueryRow)
    .filter(Boolean);
  if (!parsedRows.length) fail("Source manifest has no canvas rows");

  const expectedWorkload = stableWorkload(parsedRows[0]);
  for (let i = 1; i < parsedRows.length; i++) {
    if (stableWorkload(parsedRows[i]) !== expectedWorkload) {
      fail(`Source manifest mixes workload parameters at canvas row ${i + 1}`);
    }
  }

  const inferredCount = inferRunCount(parsedRows);
  const runCount = options.runCount ?? inferredCount;
  if (!Number.isInteger(runCount) || runCount < 1) fail("runCount must be a positive integer");

  const template = parsedRows[0];
  const { deviceGroup, cohortGroup } = inferGroups(sourceName);
  const suiteId = nativeSuiteId(template.suiteId, deviceGroup, cohortGroup);
  const runStem = nativeRunStem(deviceGroup, cohortGroup);

  const numericFields = [
    "trialsPerInstance", "durationMs", "warmupMs", "cooldownMs",
    "betweenInstancesMs", "minFrames", "spacing", "seed", "cooldownAfterMs",
    "renderScale",
  ];
  for (const field of numericFields) {
    if (!Number.isFinite(template[field])) fail(`Invalid numeric field: ${field}`);
  }
  if (template.renderScale <= 0 || template.renderScale > 1) {
    fail("renderScale must be greater than 0 and at most 1");
  }

  return {
    schema: NATIVE_SCHEMA,
    generated_at: options.generatedAt ?? new Date().toISOString(),
    plan_id: `${runStem}_v1`,
    source_manifest: path.basename(sourceName),
    source_manifest_schema: SOURCE_SCHEMA,
    source_harness_commit: template.harnessCommit,
    source_harness_version: template.harnessVersion,
    asset_revision: template.assetRevision,
    device_group: deviceGroup,
    cohort_group: cohortGroup,
    runtime_family: runtimeFamily,
    api,
    mode: "canvas",
    surface_mode: template.surfaceMode,
    render_scale: template.renderScale,
    layout: template.layout,
    spacing: template.spacing,
    instances: template.instances,
    trials_per_instance: template.trialsPerInstance,
    duration_ms: template.durationMs,
    warmup_ms: template.warmupMs,
    cooldown_ms: template.cooldownMs,
    between_instances_ms: template.betweenInstancesMs,
    between_runs_ms: template.cooldownAfterMs,
    min_frames: template.minFrames,
    seed: template.seed,
    shuffle: template.shuffle,
    run_count: runCount,
    runs: Array.from({ length: runCount }, (_, index) => ({
      run_number: index + 1,
      run_id: `${runStem}_r${String(index + 1).padStart(2, "0")}`,
      suite_id: suiteId,
    })),
  };
}

function usage() {
  return [
    "Usage:",
    "  node tools/generate-native-plan.mjs --manifest <web-manifest.json> --api <metal|vulkan|d3d11>",
    "    [--runtime-family <name>] [--run-count <n>] [--out <native-plan.json>] [--force]",
  ].join("\n");
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(`${error.message}\n\n${usage()}`);
    process.exitCode = 2;
    return;
  }

  const manifestPath = path.resolve(args.manifest);
  const source = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const plan = generateNativePlan(source, {
    sourceName: manifestPath,
    api: args.api,
    runtimeFamily: args.runtimeFamily,
    runCount: args.runCount,
  });

  const output = `${JSON.stringify(plan, null, 2)}\n`;
  if (!args.out) {
    process.stdout.write(output);
    return;
  }

  const outputPath = path.resolve(args.out);
  if (fs.existsSync(outputPath) && !args.force) {
    console.error(`Refusing to overwrite ${outputPath}; pass --force to replace it.`);
    process.exitCode = 2;
    return;
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, output);
  console.log(`Wrote ${outputPath}`);
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) main(process.argv.slice(2));

export { NATIVE_SCHEMA, SOURCE_SCHEMA, QUERY_FIELDS };
