#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const VALID_APIS = new Set(["webgl2", "webgpu"]);
const VALID_MODES = new Set(["canvas", "xr"]);
const VALID_PAIR_BY = new Set(["condition", "suiteId"]);

const ROOT_FAIRNESS_FIELDS = [
  { name: "mode" },
  { name: "modelUrl" },
  { name: "instances" },
  { name: "trial" },
  { name: "durationMs" },
  { name: "minFrames" },
  { name: "warmupMs" },
  { name: "cooldownMs" },
  { name: "betweenInstancesMs" },
  { name: "layout" },
  { name: "seed" },
  { name: "shuffle" },
  { name: "spacing", tol: 1e-9 },
  { name: "debugColor" },
  { name: "preIdleMs" },
  { name: "postIdleMs" },
  { name: "collectPerf" },
  { name: "perfDetail" },
];

const ENV_FAIRNESS_FIELDS = [
  { name: "runMode" },
  { name: "xrFrontMinZ", tol: 1e-9 },
  { name: "xrYOffset", tol: 1e-9 },
  { name: "xr_scale_factor_requested", tol: 1e-9 },
  { name: "xr_scale_factor_applied", tol: 1e-9 },
  { name: "xr_no_pose_grace_ms" },
  { name: "xr_start_on_first_pose_requested" },
  { name: "xr_probe_readback_requested" },
  { name: "manualDownload" },
  { name: "hudEnabled" },
  { name: "hudHz", tol: 1e-9 },
  { name: "renderProbeRequested" },
  { name: "xr_expected_max_views" },
  { name: "harness_version" },
  { name: "harness_commit" },
  { name: "asset_revision" },
];

function usage() {
  console.log(
    [
      "Usage:",
      "  node tools/check-run-quality.mjs [options] <results.jsonl> [more.jsonl ...]",
      "",
      "Options:",
      "  --out-base <path>   Output prefix (default: ./quality_report_<timestamp>)",
      "  --pair-by <mode>    Pairing strategy: condition | suiteId (default: condition)",
      "  --strict <0|1>      Exit non-zero if any pair is excluded (default: 1)",
      "  --no-write          Print summary only; do not write JSON/CSV report files",
      "  -h, --help          Show this help",
      "",
      "Outputs (unless --no-write):",
      "  <out-base>.json     Full quality report with per-pair diagnostics",
      "  <out-base>.csv      Flat pair-level inclusion/exclusion table",
      "",
      "Exit codes:",
      "  0 = Success (or exclusions allowed via --strict 0)",
      "  1 = Input/parse errors",
      "  2 = Strict mode and at least one excluded pair",
    ].join("\n")
  );
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function getPath(obj, pathParts, fallback = undefined) {
  let cur = obj;
  for (const part of pathParts) {
    if (!isObject(cur) || !hasOwn(cur, part)) return fallback;
    cur = cur[part];
  }
  return cur;
}

function asFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeNullish(value) {
  return value === undefined ? null : value;
}

function valuesEquivalent(aRaw, bRaw, tol = 0) {
  const a = normalizeNullish(aRaw);
  const b = normalizeNullish(bRaw);
  if (a === null && b === null) return true;
  if (typeof a === "number" && typeof b === "number") {
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    return Math.abs(a - b) <= tol;
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

function gpuVendorFromIdentity(identity) {
  if (typeof identity !== "string") return null;
  const payload = identity.includes(":") ? identity.split(":").slice(1).join(":") : identity;
  const vendor = String(payload.split("|")[0] || "").trim().toLowerCase();
  if (!vendor || vendor === "unknown") return null;
  return vendor;
}

function sanitizeTimestampForFilename(date = new Date()) {
  const iso = date.toISOString(); // 2026-02-25T20:12:34.123Z
  return iso.replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "_");
}

function parseDateMs(value) {
  if (typeof value !== "string") return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function addCount(mapObj, key) {
  mapObj[key] = (mapObj[key] || 0) + 1;
}

function buildPairKey(record, pairBy) {
  const mode = typeof record.mode === "string" ? record.mode : "unknown";
  const model = typeof record.modelUrl === "string" ? record.modelUrl : "unknown_model";
  const instances = normalizeNullish(record.instances);
  const trial = normalizeNullish(record.trial);
  const conditionIndex = normalizeNullish(record.condition_index);
  // Do not include aborted status in the key; we want aborted/non-aborted counterparts
  // from the same condition to pair together for exclusion diagnostics.
  const base = `mode=${mode}|model=${model}|instances=${instances}|trial=${trial}|cond=${conditionIndex}`;
  if (pairBy === "suiteId") {
    const suiteId = normalizeNullish(record.suiteId);
    return `suite=${suiteId}|${base}`;
  }
  return base;
}

function summarizeRecordForPair(entry, assessment) {
  if (!entry) return null;
  const rec = entry.record;
  return {
    file: entry.file,
    line: entry.line,
    suiteId: rec.suiteId ?? null,
    startedAt: rec.startedAt ?? null,
    include: assessment.include,
    exclude_reasons: assessment.exclude_reasons,
    warning_reasons: assessment.warning_reasons,
    aborted: rec.aborted === true,
    frames: asFiniteNumber(getPath(rec, ["summary", "frames"])),
    p95_ms: asFiniteNumber(getPath(rec, ["summary", "p95_ms"])),
  };
}

function assessRecord(entry) {
  const record = entry.record;
  const env = isObject(record.env) ? record.env : {};
  const exclude = [];
  const warnings = [];

  if (entry.pairBy === "suiteId") {
    const suiteId = (typeof record.suiteId === "string") ? record.suiteId.trim() : "";
    if (!suiteId) exclude.push("missing_suiteId_for_pairing");
  }

  if (!VALID_APIS.has(entry.api)) exclude.push("invalid_api");
  if (!VALID_MODES.has(entry.mode)) exclude.push("invalid_mode");

  const isAbort = record.aborted === true;
  if (isAbort) exclude.push("aborted_record");

  if (!isAbort) {
    if (!isObject(record.summary)) {
      exclude.push("missing_summary");
    } else {
      const frames = asFiniteNumber(record.summary.frames);
      const duration = asFiniteNumber(record.summary.duration_ms);
      if (frames === null || frames < 1) exclude.push("no_frames_collected");
      if (duration === null || duration <= 0) exclude.push("invalid_duration");

      if (entry.mode === "xr") {
        const minFrames = asFiniteNumber(record.minFrames) ?? asFiniteNumber(env.xr_min_frames);
        if (minFrames !== null && frames !== null && frames < minFrames) {
          exclude.push("xr_min_frames_not_met");
        }
      }
    }
  }

  if (entry.mode === "xr") {
    const probe = isObject(record.render_probe_xr) ? record.render_probe_xr : null;
    if (probe && probe.performed === true && probe.rendered_anything === false) {
      exclude.push("xr_render_probe_rendered_nothing");
    }

    if (!isAbort) {
      const enterToFirst = asFiniteNumber(env.xr_enter_to_first_frame_ms);
      if (enterToFirst === null) warnings.push("xr_enter_to_first_frame_missing");
    }

    const observedViews = asFiniteNumber(env.xr_observed_view_count);
    if (observedViews !== null && observedViews !== 2) {
      warnings.push("xr_observed_view_count_not_2");
    }

    const expectedViews = asFiniteNumber(env.xr_expected_max_views);
    if (expectedViews !== null && expectedViews !== 2) {
      warnings.push("xr_expected_max_views_not_2");
    }
  }

  if (Array.isArray(env.js_errors) && env.js_errors.length > 0) {
    warnings.push("js_error_events_present");
  }
  if (Array.isArray(env.js_unhandled_rejections) && env.js_unhandled_rejections.length > 0) {
    warnings.push("js_unhandled_rejection_events_present");
  }

  if (entry.api === "webgpu") {
    if (isObject(env.device_lost)) {
      exclude.push("webgpu_device_lost");
    }
    if (isObject(env.device_lost_info)) {
      exclude.push("webgpu_device_lost");
    }
    const deviceLostCount = asFiniteNumber(env.device_lost_count);
    if (deviceLostCount !== null && deviceLostCount > 0) {
      exclude.push("webgpu_device_lost");
    }
    if (Array.isArray(env.webgpu_uncaptured_errors) && env.webgpu_uncaptured_errors.length > 0) {
      warnings.push("webgpu_uncaptured_errors_present");
    }
    if (env.xr_scale_factor_fallback_used === true) {
      warnings.push("webgpu_xr_scale_factor_fallback_used");
    }
    if (typeof env.xr_projection_layer_fallback === "string" && env.xr_projection_layer_fallback) {
      warnings.push("webgpu_projection_layer_fallback_used");
    }
  }
  if (entry.api === "webgl2") {
    if (isObject(env.context_lost)) {
      exclude.push("webgl_context_lost");
    }
    const webglMeta = isObject(env.webgl) ? env.webgl : null;
    const contextLostCount = asFiniteNumber(webglMeta?.context_lost_count);
    if (contextLostCount !== null && contextLostCount > 0) {
      exclude.push("webgl_context_lost");
    }
    if (webglMeta?.context_is_lost === true) {
      exclude.push("webgl_context_currently_lost");
    }
  }

  const rest = isObject(env.rest) ? env.rest : null;
  if (rest) {
    const recommended = asFiniteNumber(rest.recommendedRestMs);
    const elapsed = asFiniteNumber(rest.restElapsedMs);
    if (recommended !== null && elapsed !== null && elapsed < recommended) {
      warnings.push("rest_shorter_than_recommended");
    }
  }

  return {
    include: exclude.length === 0,
    exclude_reasons: Array.from(new Set(exclude)),
    warning_reasons: Array.from(new Set(warnings)),
  };
}

function compareFairnessFields(webglRecord, webgpuRecord) {
  const mismatches = [];

  for (const field of ROOT_FAIRNESS_FIELDS) {
    const a = webglRecord[field.name];
    const b = webgpuRecord[field.name];
    const tol = field.tol || 0;
    if (!valuesEquivalent(a, b, tol)) {
      mismatches.push({
        scope: "root",
        field: field.name,
        webgl: normalizeNullish(a),
        webgpu: normalizeNullish(b),
      });
    }
  }

  for (const field of ENV_FAIRNESS_FIELDS) {
    const a = getPath(webglRecord, ["env", field.name]);
    const b = getPath(webgpuRecord, ["env", field.name]);
    const tol = field.tol || 0;
    if (!valuesEquivalent(a, b, tol)) {
      mismatches.push({
        scope: "env",
        field: field.name,
        webgl: normalizeNullish(a),
        webgpu: normalizeNullish(b),
      });
    }
  }

  return mismatches;
}

function pairEntries(entries) {
  const grouped = new Map();
  for (const entry of entries) {
    const key = entry.pairKey;
    if (!grouped.has(key)) {
      grouped.set(key, { webgl: [], webgpu: [], meta: entry.keyMeta });
    }
    const bucket = grouped.get(key);
    if (entry.api === "webgl2") bucket.webgl.push(entry);
    else if (entry.api === "webgpu") bucket.webgpu.push(entry);
  }

  const pairs = [];
  for (const [key, bucket] of grouped.entries()) {
    const sortByStarted = (a, b) => {
      if (a.startedMs !== b.startedMs) return a.startedMs - b.startedMs;
      if (a.file !== b.file) return a.file.localeCompare(b.file);
      return a.line - b.line;
    };
    bucket.webgl.sort(sortByStarted);
    bucket.webgpu.sort(sortByStarted);

    const n = Math.max(bucket.webgl.length, bucket.webgpu.length);
    for (let i = 0; i < n; i++) {
      pairs.push({
        pair_key: key,
        pair_index: i + 1,
        key_meta: bucket.meta,
        webgl: bucket.webgl[i] || null,
        webgpu: bucket.webgpu[i] || null,
      });
    }
  }

  pairs.sort((a, b) => {
    const aTime = Math.min(a.webgl?.startedMs ?? Number.POSITIVE_INFINITY, a.webgpu?.startedMs ?? Number.POSITIVE_INFINITY);
    const bTime = Math.min(b.webgl?.startedMs ?? Number.POSITIVE_INFINITY, b.webgpu?.startedMs ?? Number.POSITIVE_INFINITY);
    if (aTime !== bTime) return aTime - bTime;
    if (a.pair_key !== b.pair_key) return a.pair_key.localeCompare(b.pair_key);
    return a.pair_index - b.pair_index;
  });

  return pairs;
}

function evaluatePair(pair, assessmentsById) {
  const pairExcludes = [];
  const pairWarnings = [];
  const mismatches = [];

  const webglAssess = pair.webgl ? assessmentsById.get(pair.webgl.id) : null;
  const webgpuAssess = pair.webgpu ? assessmentsById.get(pair.webgpu.id) : null;

  if (!pair.webgl) pairExcludes.push("missing_webgl_trial");
  if (!pair.webgpu) pairExcludes.push("missing_webgpu_trial");

  if (pair.webgl && webglAssess && !webglAssess.include) pairExcludes.push("webgl_trial_excluded");
  if (pair.webgpu && webgpuAssess && !webgpuAssess.include) pairExcludes.push("webgpu_trial_excluded");

  if (pair.webgl && pair.webgpu) {
    const m = compareFairnessFields(pair.webgl.record, pair.webgpu.record);
    for (const item of m) {
      mismatches.push(item);
      pairExcludes.push(`fairness_mismatch:${item.scope}.${item.field}`);
    }

    const webglGpu = getPath(pair.webgl.record, ["env", "gpu_identity"]);
    const webgpuGpu = getPath(pair.webgpu.record, ["env", "gpu_identity"]);
    const webglVendor = gpuVendorFromIdentity(webglGpu);
    const webgpuVendor = gpuVendorFromIdentity(webgpuGpu);
    if (webglVendor && webgpuVendor && webglVendor !== webgpuVendor) {
      pairWarnings.push("gpu_vendor_mismatch");
    }
  }

  if (webglAssess) pairWarnings.push(...webglAssess.warning_reasons);
  if (webgpuAssess) pairWarnings.push(...webgpuAssess.warning_reasons);

  const excludeReasons = Array.from(new Set(pairExcludes));
  const warningReasons = Array.from(new Set(pairWarnings));

  return {
    include_for_primary: excludeReasons.length === 0,
    pair_exclude_reasons: excludeReasons,
    pair_warning_reasons: warningReasons,
    fairness_mismatches: mismatches,
    webgl_assessment: webglAssess,
    webgpu_assessment: webgpuAssess,
  };
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (!/[",\n]/.test(s)) return s;
  return `"${s.replace(/"/g, "\"\"")}"`;
}

function pairsToCsv(pairRows) {
  const columns = [
    "pair_key",
    "pair_index",
    "pair_by",
    "key_suiteId",
    "mode",
    "modelUrl",
    "instances",
    "trial",
    "condition_index",
    "webgl_present",
    "webgpu_present",
    "webgl_include",
    "webgpu_include",
    "include_for_primary",
    "pair_exclude_reasons",
    "pair_warning_reasons",
    "mismatch_fields",
    "webgl_file",
    "webgpu_file",
    "webgl_line",
    "webgpu_line",
    "webgl_suiteId",
    "webgpu_suiteId",
  ];

  const lines = [columns.join(",")];
  for (const row of pairRows) {
    const webgl = row.webgl;
    const webgpu = row.webgpu;
    const mismatchFields = row.fairness_mismatches.map((m) => `${m.scope}.${m.field}`).join("|");
    const values = [
      row.pair_key,
      row.pair_index,
      row.key_meta.pair_by,
      row.key_meta.suiteId,
      row.key_meta.mode,
      row.key_meta.modelUrl,
      row.key_meta.instances,
      row.key_meta.trial,
      row.key_meta.condition_index,
      !!webgl,
      !!webgpu,
      webgl ? !!webgl.include : null,
      webgpu ? !!webgpu.include : null,
      !!row.include_for_primary,
      row.pair_exclude_reasons.join("|"),
      row.pair_warning_reasons.join("|"),
      mismatchFields,
      webgl?.file ?? null,
      webgpu?.file ?? null,
      webgl?.line ?? null,
      webgpu?.line ?? null,
      webgl?.suiteId ?? null,
      webgpu?.suiteId ?? null,
    ];
    lines.push(values.map(csvEscape).join(","));
  }

  return lines.join("\n") + "\n";
}

function makeEntry(filePath, lineNo, record, pairBy) {
  const api = typeof record.api === "string" ? record.api : "invalid";
  const mode = typeof record.mode === "string" ? record.mode : "invalid";
  const startedMs = parseDateMs(record.startedAt);
  const pairKey = buildPairKey(record, pairBy);

  return {
    id: `${filePath}:${lineNo}`,
    file: filePath,
    line: lineNo,
    record,
    api,
    mode,
    pairBy,
    startedMs,
    pairKey,
    keyMeta: {
      pair_by: pairBy,
      suiteId: record.suiteId ?? null,
      mode: record.mode ?? null,
      modelUrl: record.modelUrl ?? null,
      instances: record.instances ?? null,
      trial: record.trial ?? null,
      condition_index: record.condition_index ?? null,
    },
  };
}

async function parseJsonlFiles(files, pairBy) {
  const entries = [];
  const parseErrors = [];

  for (const filePath of files) {
    let parsedRecordsForFile = 0;
    let content;
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch (err) {
      parseErrors.push(`${filePath}: failed to read file (${err.message})`);
      continue;
    }

    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      if (!raw.trim()) continue;
      const lineNo = i + 1;
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        parseErrors.push(`${filePath}:${lineNo}: invalid JSON (${err.message})`);
        continue;
      }
      if (!isObject(parsed)) {
        parseErrors.push(`${filePath}:${lineNo}: expected object record`);
        continue;
      }
      entries.push(makeEntry(filePath, lineNo, parsed, pairBy));
      parsedRecordsForFile++;
    }

    if (parsedRecordsForFile === 0) {
      parseErrors.push(`${filePath}: no JSON object records found`);
    }
  }

  return { entries, parseErrors };
}

function topCounts(countMap, maxItems = 12) {
  return Object.entries(countMap)
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    })
    .slice(0, maxItems);
}

function parseArgs(argv) {
  const opts = {
    pairBy: "condition",
    strict: true,
    writeFiles: true,
    outBase: path.resolve(process.cwd(), `quality_report_${sanitizeTimestampForFilename()}`),
  };
  const files = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") return { help: true, opts, files };
    if (arg === "--no-write") {
      opts.writeFiles = false;
      continue;
    }
    if (arg === "--pair-by") {
      const v = argv[++i];
      if (!VALID_PAIR_BY.has(v)) {
        throw new Error(`Invalid --pair-by value: ${v}. Expected one of: ${Array.from(VALID_PAIR_BY).join(", ")}`);
      }
      opts.pairBy = v;
      continue;
    }
    if (arg.startsWith("--pair-by=")) {
      const v = arg.slice("--pair-by=".length);
      if (!VALID_PAIR_BY.has(v)) {
        throw new Error(`Invalid --pair-by value: ${v}. Expected one of: ${Array.from(VALID_PAIR_BY).join(", ")}`);
      }
      opts.pairBy = v;
      continue;
    }
    if (arg === "--strict") {
      const v = argv[++i];
      if (v !== "0" && v !== "1") {
        throw new Error(`Invalid --strict value: ${v}`);
      }
      opts.strict = v === "1";
      continue;
    }
    if (arg.startsWith("--strict=")) {
      const v = arg.slice("--strict=".length);
      if (v !== "0" && v !== "1") {
        throw new Error(`Invalid --strict value: ${v}`);
      }
      opts.strict = v === "1";
      continue;
    }
    if (arg === "--out-base") {
      const v = argv[++i];
      if (!v) throw new Error("Missing value for --out-base");
      opts.outBase = path.resolve(process.cwd(), v);
      continue;
    }
    if (arg.startsWith("--out-base=")) {
      const v = arg.slice("--out-base=".length);
      if (!v) throw new Error("Missing value for --out-base");
      opts.outBase = path.resolve(process.cwd(), v);
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    files.push(arg);
  }

  return { help: false, opts, files };
}

async function writeOutputs(report, outBase) {
  const outDir = path.dirname(outBase);
  await fs.mkdir(outDir, { recursive: true });

  const jsonPath = `${outBase}.json`;
  const csvPath = `${outBase}.csv`;
  const jsonText = JSON.stringify(report, null, 2) + "\n";
  const csvText = pairsToCsv(report.pairs);

  await fs.writeFile(jsonPath, jsonText, "utf8");
  await fs.writeFile(csvPath, csvText, "utf8");
  return { jsonPath, csvPath };
}

function printSummary(report, outPaths) {
  const t = report.totals;
  console.log(`Records: ${t.records_total} (webgl2=${t.records_webgl2}, webgpu=${t.records_webgpu}, other=${t.records_other})`);
  console.log(`Pairs: ${t.pairs_total}`);
  console.log(`Included pairs: ${t.pairs_included}`);
  console.log(`Excluded pairs: ${t.pairs_excluded}`);

  if (report.parse_errors.length) {
    console.log(`Parse/input errors: ${report.parse_errors.length}`);
  }

  const topPairExcludes = topCounts(report.reason_counts.pair_exclude, 10);
  if (topPairExcludes.length) {
    console.log("Top pair exclusions:");
    for (const [k, v] of topPairExcludes) console.log(`  ${k}: ${v}`);
  }

  const topRecordExcludes = topCounts(report.reason_counts.record_exclude, 10);
  if (topRecordExcludes.length) {
    console.log("Top record exclusions:");
    for (const [k, v] of topRecordExcludes) console.log(`  ${k}: ${v}`);
  }

  if (outPaths) {
    console.log(`Wrote ${outPaths.jsonPath}`);
    console.log(`Wrote ${outPaths.csvPath}`);
  }
}

async function main() {
  let parsedArgs;
  try {
    parsedArgs = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message || err);
    usage();
    process.exit(1);
  }

  if (parsedArgs.help) {
    usage();
    process.exit(0);
  }

  const { opts, files } = parsedArgs;
  if (!files.length) {
    usage();
    process.exit(1);
  }

  const { entries, parseErrors } = await parseJsonlFiles(files, opts.pairBy);
  const assessmentsById = new Map();

  const reasonCounts = {
    record_exclude: {},
    pair_exclude: {},
    warnings: {},
  };

  for (const entry of entries) {
    const assessment = assessRecord(entry);
    assessmentsById.set(entry.id, assessment);
    for (const reason of assessment.exclude_reasons) addCount(reasonCounts.record_exclude, reason);
    for (const warning of assessment.warning_reasons) addCount(reasonCounts.warnings, warning);
  }

  const pairs = pairEntries(entries);
  const pairRows = [];

  for (const pair of pairs) {
    const evaluation = evaluatePair(pair, assessmentsById);
    for (const reason of evaluation.pair_exclude_reasons) addCount(reasonCounts.pair_exclude, reason);
    for (const warning of evaluation.pair_warning_reasons) addCount(reasonCounts.warnings, warning);

    pairRows.push({
      pair_key: pair.pair_key,
      pair_index: pair.pair_index,
      key_meta: pair.key_meta,
      include_for_primary: evaluation.include_for_primary,
      pair_exclude_reasons: evaluation.pair_exclude_reasons,
      pair_warning_reasons: evaluation.pair_warning_reasons,
      fairness_mismatches: evaluation.fairness_mismatches,
      webgl: summarizeRecordForPair(pair.webgl, evaluation.webgl_assessment),
      webgpu: summarizeRecordForPair(pair.webgpu, evaluation.webgpu_assessment),
    });
  }

  const recordsWebgl = entries.filter((e) => e.api === "webgl2").length;
  const recordsWebgpu = entries.filter((e) => e.api === "webgpu").length;
  const recordsOther = entries.length - recordsWebgl - recordsWebgpu;
  const pairsIncluded = pairRows.filter((p) => p.include_for_primary).length;
  const pairsExcluded = pairRows.length - pairsIncluded;

  const report = {
    generated_at: new Date().toISOString(),
    tool: "check-run-quality",
    inputs: files,
    settings: {
      pairBy: opts.pairBy,
      strict: opts.strict,
      writeFiles: opts.writeFiles,
      outBase: opts.outBase,
    },
    totals: {
      records_total: entries.length,
      records_webgl2: recordsWebgl,
      records_webgpu: recordsWebgpu,
      records_other: recordsOther,
      pairs_total: pairRows.length,
      pairs_included: pairsIncluded,
      pairs_excluded: pairsExcluded,
    },
    parse_errors: parseErrors,
    reason_counts: reasonCounts,
    pairs: pairRows,
  };

  let outPaths = null;
  if (opts.writeFiles) {
    outPaths = await writeOutputs(report, opts.outBase);
  }

  printSummary(report, outPaths);

  if (parseErrors.length > 0) process.exit(1);
  if (opts.strict && pairsExcluded > 0) process.exit(2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
