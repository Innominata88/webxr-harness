#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const VALID_APIS = new Set(["webgl2", "webgpu"]);
const VALID_MODES = new Set(["canvas", "xr"]);
const WILSON_Z_95 = 1.959963984540054;

function usage() {
  console.log(
    [
      "Usage:",
      "  node tools/failure-curve.mjs [options] <results.jsonl> [more.jsonl ...]",
      "",
      "Options:",
      "  --out-base <path>   Output prefix (default: ./failure_curve_<timestamp>)",
      "  --strict <0|1>      Exit non-zero when any failures are present (default: 0)",
      "  --no-write          Print summary only; do not write JSON/CSV report files",
      "  -h, --help          Show this help",
      "",
      "Outputs (unless --no-write):",
      "  <out-base>.json     Full failure-curve report",
      "  <out-base>.csv      Flat per-(api,mode,instances) table",
      "",
      "Exit codes:",
      "  0 = Success",
      "  1 = Input/parse errors",
      "  2 = Strict mode and at least one failed run",
    ].join("\n")
  );
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function asFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeOptionalString(value) {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t ? t : null;
}

function parseDateMs(value) {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sanitizeTimestampForFilename(date = new Date()) {
  const iso = date.toISOString();
  return iso.replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "_");
}

function addCount(mapObj, key) {
  mapObj[key] = (mapObj[key] || 0) + 1;
}

function toSortedObject(obj) {
  const out = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k];
  return out;
}

function topCounts(countMap, maxItems = 12) {
  return Object.entries(countMap)
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    })
    .slice(0, maxItems);
}

function wilsonInterval95(k, n) {
  if (!Number.isFinite(k) || !Number.isFinite(n) || n <= 0) {
    return { lower: null, upper: null };
  }
  const z = WILSON_Z_95;
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
  return {
    lower: Math.max(0, center - half),
    upper: Math.min(1, center + half),
  };
}

function classifyRecord(record) {
  const reasons = [];
  const env = isObject(record.env) ? record.env : {};
  const isAbort = record.aborted === true;
  const abortCode = normalizeOptionalString(record.abort_code) || "unknown_abort_code";
  const api = typeof record.api === "string" ? record.api : null;
  const mode = typeof record.mode === "string" ? record.mode : null;
  const summary = isObject(record.summary) ? record.summary : null;
  const frames = asFiniteNumber(summary?.frames);

  if (isAbort) reasons.push(`aborted:${abortCode}`);

  let isDeviceLost = false;
  if (api === "webgpu") {
    const lostInfo = isObject(env.device_lost) || isObject(env.device_lost_info);
    const lostCount = asFiniteNumber(env.device_lost_count);
    if (lostInfo || (lostCount !== null && lostCount > 0)) {
      reasons.push("webgpu_device_lost");
      isDeviceLost = true;
    }
  }

  let isContextLost = false;
  if (api === "webgl2") {
    const webglMeta = isObject(env.webgl) ? env.webgl : null;
    const lostCount = asFiniteNumber(webglMeta?.context_lost_count);
    const contextLost = isObject(env.context_lost)
      || (lostCount !== null && lostCount > 0)
      || webglMeta?.context_is_lost === true;
    if (contextLost) {
      reasons.push("webgl_context_lost");
      isContextLost = true;
    }
  }

  const invalidSummary = !isAbort && (!summary || frames === null || frames < 1);
  if (invalidSummary) reasons.push("invalid_summary_or_no_frames");

  let minFramesNotMet = false;
  let renderProbeRenderedNothing = false;
  if (mode === "xr" && !isAbort) {
    const minFrames = asFiniteNumber(record.minFrames) ?? asFiniteNumber(env.xr_min_frames);
    if (minFrames !== null && frames !== null && frames < minFrames) {
      reasons.push("xr_min_frames_not_met");
      minFramesNotMet = true;
    }
    const probe = isObject(record.render_probe_xr) ? record.render_probe_xr : null;
    if (probe && probe.performed === true && probe.rendered_anything === false) {
      reasons.push("xr_render_probe_rendered_nothing");
      renderProbeRenderedNothing = true;
    }
  }

  const uniqueReasons = Array.from(new Set(reasons));
  const isFailed = uniqueReasons.length > 0;
  return {
    isFailed,
    reasons: uniqueReasons,
    isAbort,
    abortCode: isAbort ? abortCode : null,
    isDeviceLost,
    isContextLost,
    minFramesNotMet,
    renderProbeRenderedNothing,
    invalidSummary,
  };
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (!/[",\n]/.test(s)) return s;
  return `"${s.replace(/"/g, "\"\"")}"`;
}

function countsToPipe(mapObj) {
  const items = Object.entries(mapObj).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });
  return items.map(([k, v]) => `${k}:${v}`).join("|");
}

function rowsToCsv(rows) {
  const columns = [
    "api",
    "mode",
    "instances",
    "n_total",
    "n_fail",
    "n_success",
    "fail_rate",
    "ci95_lower",
    "ci95_upper",
    "n_aborted",
    "n_webgpu_device_lost",
    "n_webgl_context_lost",
    "n_xr_min_frames_not_met",
    "n_xr_render_probe_rendered_nothing",
    "n_invalid_summary_or_no_frames",
    "abort_code_counts",
    "failure_reason_counts",
    "model_urls",
    "layouts",
    "harness_versions",
    "asset_revisions",
    "started_at_min",
    "started_at_max",
  ];
  const lines = [columns.join(",")];
  for (const row of rows) {
    const values = [
      row.api,
      row.mode,
      row.instances,
      row.n_total,
      row.n_fail,
      row.n_success,
      row.fail_rate,
      row.fail_rate_ci95.lower,
      row.fail_rate_ci95.upper,
      row.n_aborted,
      row.n_webgpu_device_lost,
      row.n_webgl_context_lost,
      row.n_xr_min_frames_not_met,
      row.n_xr_render_probe_rendered_nothing,
      row.n_invalid_summary_or_no_frames,
      countsToPipe(row.abort_code_counts),
      countsToPipe(row.failure_reason_counts),
      row.model_urls.join("|"),
      row.layouts.join("|"),
      row.harness_versions.join("|"),
      row.asset_revisions.join("|"),
      row.started_at_min,
      row.started_at_max,
    ];
    lines.push(values.map(csvEscape).join(","));
  }
  return lines.join("\n") + "\n";
}

function makeGroupBucket(api, mode, instances) {
  return {
    api,
    mode,
    instances,
    n_total: 0,
    n_fail: 0,
    n_success: 0,
    n_aborted: 0,
    n_webgpu_device_lost: 0,
    n_webgl_context_lost: 0,
    n_xr_min_frames_not_met: 0,
    n_xr_render_probe_rendered_nothing: 0,
    n_invalid_summary_or_no_frames: 0,
    abort_code_counts: {},
    failure_reason_counts: {},
    model_urls: new Set(),
    layouts: new Set(),
    harness_versions: new Set(),
    asset_revisions: new Set(),
    started_at_min_ms: null,
    started_at_max_ms: null,
  };
}

function finalizeGroup(bucket) {
  const failRate = bucket.n_total > 0 ? bucket.n_fail / bucket.n_total : null;
  const ci = wilsonInterval95(bucket.n_fail, bucket.n_total);
  return {
    api: bucket.api,
    mode: bucket.mode,
    instances: bucket.instances,
    n_total: bucket.n_total,
    n_fail: bucket.n_fail,
    n_success: bucket.n_success,
    fail_rate: failRate,
    fail_rate_ci95: ci,
    n_aborted: bucket.n_aborted,
    n_webgpu_device_lost: bucket.n_webgpu_device_lost,
    n_webgl_context_lost: bucket.n_webgl_context_lost,
    n_xr_min_frames_not_met: bucket.n_xr_min_frames_not_met,
    n_xr_render_probe_rendered_nothing: bucket.n_xr_render_probe_rendered_nothing,
    n_invalid_summary_or_no_frames: bucket.n_invalid_summary_or_no_frames,
    abort_code_counts: toSortedObject(bucket.abort_code_counts),
    failure_reason_counts: toSortedObject(bucket.failure_reason_counts),
    model_urls: Array.from(bucket.model_urls).sort(),
    layouts: Array.from(bucket.layouts).sort(),
    harness_versions: Array.from(bucket.harness_versions).sort(),
    asset_revisions: Array.from(bucket.asset_revisions).sort(),
    started_at_min: bucket.started_at_min_ms !== null ? new Date(bucket.started_at_min_ms).toISOString() : null,
    started_at_max: bucket.started_at_max_ms !== null ? new Date(bucket.started_at_max_ms).toISOString() : null,
  };
}

async function parseJsonlFiles(files) {
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

      const api = typeof parsed.api === "string" ? parsed.api : null;
      if (!api || !VALID_APIS.has(api)) {
        parseErrors.push(`${filePath}:${lineNo}: invalid api ${JSON.stringify(parsed.api)}`);
        continue;
      }
      const mode = typeof parsed.mode === "string" ? parsed.mode : null;
      if (!mode || !VALID_MODES.has(mode)) {
        parseErrors.push(`${filePath}:${lineNo}: invalid mode ${JSON.stringify(parsed.mode)}`);
        continue;
      }
      const instances = asFiniteNumber(parsed.instances);
      if (instances === null) {
        parseErrors.push(`${filePath}:${lineNo}: missing numeric instances value (required for failure curve)`);
        continue;
      }

      entries.push({
        id: `${filePath}:${lineNo}`,
        file: filePath,
        line: lineNo,
        record: parsed,
        api,
        mode,
        instances,
      });
      parsedRecordsForFile++;
    }

    if (parsedRecordsForFile === 0) {
      parseErrors.push(`${filePath}: no JSON object records found`);
    }
  }

  return { entries, parseErrors };
}

function parseArgs(argv) {
  const opts = {
    strict: false,
    writeFiles: true,
    outBase: path.resolve(process.cwd(), `failure_curve_${sanitizeTimestampForFilename()}`),
  };
  const files = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") return { help: true, opts, files };
    if (arg === "--no-write") {
      opts.writeFiles = false;
      continue;
    }
    if (arg === "--strict") {
      const v = argv[++i];
      if (v !== "0" && v !== "1") throw new Error(`Invalid --strict value: ${v}`);
      opts.strict = v === "1";
      continue;
    }
    if (arg.startsWith("--strict=")) {
      const v = arg.slice("--strict=".length);
      if (v !== "0" && v !== "1") throw new Error(`Invalid --strict value: ${v}`);
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
  const csvText = rowsToCsv(report.curve_rows);

  await fs.writeFile(jsonPath, jsonText, "utf8");
  await fs.writeFile(csvPath, csvText, "utf8");
  return { jsonPath, csvPath };
}

function printSummary(report, outPaths) {
  const t = report.totals;
  console.log(`Records: ${t.records_total}`);
  console.log(`Failed records: ${t.records_failed}`);
  console.log(`Successful records: ${t.records_success}`);
  console.log(`Curve rows: ${t.curve_rows}`);

  if (report.parse_errors.length) {
    console.log(`Parse/input errors: ${report.parse_errors.length}`);
  }

  const topFailureReasons = topCounts(report.reason_counts.failure_reasons, 10);
  if (topFailureReasons.length) {
    console.log("Top failure reasons:");
    for (const [k, v] of topFailureReasons) console.log(`  ${k}: ${v}`);
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

  const { entries, parseErrors } = await parseJsonlFiles(files);

  const groups = new Map();
  const globalReasonCounts = {
    failure_reasons: {},
    abort_codes: {},
  };

  let recordsFailed = 0;
  let recordsSuccess = 0;

  for (const entry of entries) {
    const rec = entry.record;
    const key = `api=${entry.api}|mode=${entry.mode}|instances=${entry.instances}`;
    if (!groups.has(key)) {
      groups.set(key, makeGroupBucket(entry.api, entry.mode, entry.instances));
    }
    const bucket = groups.get(key);
    bucket.n_total++;

    const classification = classifyRecord(rec);
    if (classification.isFailed) {
      bucket.n_fail++;
      recordsFailed++;
      for (const reason of classification.reasons) {
        addCount(bucket.failure_reason_counts, reason);
        addCount(globalReasonCounts.failure_reasons, reason);
      }
    } else {
      bucket.n_success++;
      recordsSuccess++;
    }

    if (classification.isAbort) {
      bucket.n_aborted++;
      addCount(bucket.abort_code_counts, classification.abortCode || "unknown_abort_code");
      addCount(globalReasonCounts.abort_codes, classification.abortCode || "unknown_abort_code");
    }
    if (classification.isDeviceLost) bucket.n_webgpu_device_lost++;
    if (classification.isContextLost) bucket.n_webgl_context_lost++;
    if (classification.minFramesNotMet) bucket.n_xr_min_frames_not_met++;
    if (classification.renderProbeRenderedNothing) bucket.n_xr_render_probe_rendered_nothing++;
    if (classification.invalidSummary) bucket.n_invalid_summary_or_no_frames++;

    const modelUrl = normalizeOptionalString(rec.modelUrl);
    if (modelUrl) bucket.model_urls.add(modelUrl);
    const layout = normalizeOptionalString(rec.layout);
    if (layout) bucket.layouts.add(layout);

    const env = isObject(rec.env) ? rec.env : null;
    const harnessVersion = normalizeOptionalString(env?.harness_version) ?? normalizeOptionalString(env?.provenance?.harness_version);
    if (harnessVersion) bucket.harness_versions.add(harnessVersion);
    const assetRevision = normalizeOptionalString(env?.asset_revision) ?? normalizeOptionalString(env?.provenance?.asset_revision);
    if (assetRevision) bucket.asset_revisions.add(assetRevision);

    const startedMs = parseDateMs(rec.startedAt);
    if (startedMs !== null) {
      if (bucket.started_at_min_ms === null || startedMs < bucket.started_at_min_ms) bucket.started_at_min_ms = startedMs;
      if (bucket.started_at_max_ms === null || startedMs > bucket.started_at_max_ms) bucket.started_at_max_ms = startedMs;
    }
  }

  const curveRows = Array.from(groups.values())
    .map(finalizeGroup)
    .sort((a, b) => {
      if (a.api !== b.api) return a.api.localeCompare(b.api);
      if (a.mode !== b.mode) return a.mode.localeCompare(b.mode);
      return a.instances - b.instances;
    });

  const report = {
    generated_at: new Date().toISOString(),
    tool: "failure-curve",
    inputs: files,
    settings: {
      strict: opts.strict,
      writeFiles: opts.writeFiles,
      outBase: opts.outBase,
      ci_method: "wilson_95",
    },
    totals: {
      records_total: entries.length,
      records_failed: recordsFailed,
      records_success: recordsSuccess,
      curve_rows: curveRows.length,
    },
    parse_errors: parseErrors,
    reason_counts: {
      failure_reasons: toSortedObject(globalReasonCounts.failure_reasons),
      abort_codes: toSortedObject(globalReasonCounts.abort_codes),
    },
    curve_rows: curveRows,
  };

  let outPaths = null;
  if (opts.writeFiles) {
    outPaths = await writeOutputs(report, opts.outBase);
  }

  printSummary(report, outPaths);

  if (parseErrors.length > 0) process.exit(1);
  if (opts.strict && recordsFailed > 0) process.exit(2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

