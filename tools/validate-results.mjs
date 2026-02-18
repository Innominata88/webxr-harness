#!/usr/bin/env node

import fs from "node:fs/promises";
import process from "node:process";

const SUPPORTED_SCHEMA_VERSIONS = new Set(["1.0.0", "1.1.0"]);
const VALID_APIS = new Set(["webgl2", "webgpu"]);
const VALID_MODES = new Set(["canvas", "xr"]);
const MAX_PRINTED_ERRORS = 200;

const COMMON_REQUIRED_FIELDS = [
  "schema_version",
  "api",
  "mode",
  "modelUrl",
  "instances",
  "trial",
  "trials",
  "durationMs",
  "warmupMs",
  "cooldownMs",
  "betweenInstancesMs",
  "layout",
  "seed",
  "shuffle",
  "spacing",
  "collectPerf",
  "perfDetail",
  "condition_index",
  "condition_count",
  "suiteId",
  "startedAt",
  "asset_timing",
  "asset_meta",
  "env",
];

function usage() {
  console.log([
    "Usage:",
    "  node tools/validate-results.mjs <results.jsonl> [more.jsonl ...]",
    "",
    "Behavior:",
    "  - validates one JSON object per non-empty line",
    "  - checks required fields for trial and abort records",
    "  - exits 0 on success, 1 if any validation error is found",
  ].join("\n"));
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function typeName(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function pushTypeError(errors, loc, key, expected, actual) {
  errors.push(`${loc}: \`${key}\` expected ${expected}, got ${actual}`);
}

function pushMissingError(errors, loc, key) {
  errors.push(`${loc}: missing required field \`${key}\``);
}

function checkObject(obj, key, loc, errors) {
  if (!checkFieldPresence(obj, key, loc, errors)) return;
  const value = obj[key];
  if (!isObject(value)) {
    pushTypeError(errors, loc, key, "object", typeName(value));
  }
}

function checkIfPresent(obj, key, checker, loc, errors) {
  if (!hasOwn(obj, key)) return;
  checker(obj, key, loc, errors);
}

function checkFieldPresence(obj, key, loc, errors) {
  if (!hasOwn(obj, key)) {
    errors.push(`${loc}: missing required field \`${key}\``);
    return false;
  }
  return true;
}

function checkType(value, expected) {
  if (expected === "array") return Array.isArray(value);
  if (expected === "object") return isObject(value);
  if (expected === "null") return value === null;
  return typeof value === expected;
}

function checkOneOfTypes(obj, key, types, loc, errors) {
  if (!checkFieldPresence(obj, key, loc, errors)) return;
  const value = obj[key];
  const ok = types.some((t) => checkType(value, t));
  if (!ok) {
    pushTypeError(errors, loc, key, types.join(" or "), typeName(value));
  }
}

function checkEnum(obj, key, allowed, loc, errors) {
  if (!checkFieldPresence(obj, key, loc, errors)) return;
  const value = obj[key];
  if (typeof value !== "string" || !allowed.has(value)) {
    errors.push(
      `${loc}: \`${key}\` expected one of [${Array.from(allowed).join(", ")}], got ${JSON.stringify(value)}`
    );
  }
}


function checkStringOrNull(obj, key, loc, errors) {
  if (!(key in obj)) { pushMissingError(errors, loc, key); return; }
  const v = obj[key];
  if (v === null) return;
  if (typeof v !== "string") pushTypeError(errors, loc, key, "string|null", typeName(v));
}
function checkNumberOrNull(obj, key, loc, errors) {
  if (!(key in obj)) { pushMissingError(errors, loc, key); return; }
  const v = obj[key];
  if (v === null) return;
  if (typeof v !== "number" || !Number.isFinite(v)) pushTypeError(errors, loc, key, "number|null", typeName(v));
}
function checkBooleanOrNull(obj, key, loc, errors) {
  if (!(key in obj)) { pushMissingError(errors, loc, key); return; }
  const v = obj[key];
  if (v === null) return;
  if (typeof v !== "boolean") pushTypeError(errors, loc, key, "boolean|null", typeName(v));
}
function checkObjectOrNull(obj, key, loc, errors) {
  if (!(key in obj)) { pushMissingError(errors, loc, key); return; }
  const v = obj[key];
  if (v === null) return;
  if (!isObject(v)) pushTypeError(errors, loc, key, "object|null", typeName(v));
}
function checkArrayOrNull(obj, key, loc, errors) {
  if (!(key in obj)) { pushMissingError(errors, loc, key); return; }
  const v = obj[key];
  if (v === null) return;
  if (!Array.isArray(v)) pushTypeError(errors, loc, key, "array|null", typeName(v));
}

function checkNumber(obj, key, loc, errors, allowNull = false) {
  if (!checkFieldPresence(obj, key, loc, errors)) return;
  const value = obj[key];
  if (value === null && allowNull) return;
  if (typeof value !== "number" || Number.isNaN(value)) {
    pushTypeError(errors, loc, key, allowNull ? "number or null" : "number", typeName(value));
  }
}

function checkBoolean(obj, key, loc, errors) {
  if (!checkFieldPresence(obj, key, loc, errors)) return;
  if (typeof obj[key] !== "boolean") {
    pushTypeError(errors, loc, key, "boolean", typeName(obj[key]));
  }
}

function checkString(obj, key, loc, errors) {
  if (!checkFieldPresence(obj, key, loc, errors)) return;
  if (typeof obj[key] !== "string") {
    pushTypeError(errors, loc, key, "string", typeName(obj[key]));
  }
}

function validateAssetTiming(record, loc, errors) {
  const key = "asset_timing";
  if (!checkFieldPresence(record, key, loc, errors)) return;
  const value = record[key];
  if (!isObject(value)) {
    pushTypeError(errors, loc, key, "object", typeName(value));
    return;
  }
  checkNumber(value, "fetch_ms", `${loc}.${key}`, errors);
  checkNumber(value, "parse_ms", `${loc}.${key}`, errors);
  checkNumber(value, "total_ms", `${loc}.${key}`, errors);
}

function validateAssetMeta(record, loc, errors) {
  const key = "asset_meta";
  if (!checkFieldPresence(record, key, loc, errors)) return;
  const value = record[key];
  if (!isObject(value)) {
    pushTypeError(errors, loc, key, "object", typeName(value));
    return;
  }
  checkNumber(value, "vertex_count", `${loc}.${key}`, errors);
  checkNumber(value, "index_count", `${loc}.${key}`, errors);
  checkNumber(value, "triangle_count", `${loc}.${key}`, errors);
  checkBoolean(value, "has_indices", `${loc}.${key}`, errors);
}

function validateEnv(record, loc, errors) {
  const key = "env";
  if (!checkFieldPresence(record, key, loc, errors)) return;
  const value = record[key];
  if (!isObject(value)) {
    pushTypeError(errors, loc, key, "object", typeName(value));
    return;
  }
  const strictV11 = record.schema_version === "1.1.0";

  // Core fields common to all supported schema versions.
  checkString(value, "api", `${loc}.${key}`, errors);
  checkString(value, "powerPreferenceRequested", `${loc}.${key}`, errors);
  checkBoolean(value, "hudEnabled", `${loc}.${key}`, errors);
  checkNumber(value, "hudHz", `${loc}.${key}`, errors);
  checkNumber(value, "xr_expected_max_views", `${loc}.${key}`, errors);
  checkString(value, "ua", `${loc}.${key}`, errors);

  // Expanded env fields are required in 1.1.0 and optional in 1.0.0.
  if (strictV11) {
    checkNumber(value, "xr_scale_factor_requested", `${loc}.${key}`, errors);
    checkNumberOrNull(value, "xr_scale_factor_applied", `${loc}.${key}`, errors);
    checkString(value, "runMode", `${loc}.${key}`, errors);
    checkObjectOrNull(value, "order_control", `${loc}.${key}`, errors);
    checkObjectOrNull(value, "uaData", `${loc}.${key}`, errors);
    checkStringOrNull(value, "platform", `${loc}.${key}`, errors);
    checkStringOrNull(value, "language", `${loc}.${key}`, errors);
    checkArrayOrNull(value, "languages", `${loc}.${key}`, errors);
    checkNumberOrNull(value, "hardwareConcurrency", `${loc}.${key}`, errors);
    checkNumberOrNull(value, "deviceMemory", `${loc}.${key}`, errors);
    checkNumberOrNull(value, "maxTouchPoints", `${loc}.${key}`, errors);
    checkBoolean(value, "isSecureContext", `${loc}.${key}`, errors);
    checkBoolean(value, "crossOriginIsolated", `${loc}.${key}`, errors);
    checkString(value, "visibilityState", `${loc}.${key}`, errors);
    checkNumber(value, "dpr", `${loc}.${key}`, errors);
    checkObject(value, "canvas_css", `${loc}.${key}`, errors);
    checkObject(value, "canvas_px", `${loc}.${key}`, errors);
    checkString(value, "url", `${loc}.${key}`, errors);
  } else {
    checkIfPresent(value, "xr_scale_factor_requested", checkNumber, `${loc}.${key}`, errors);
    checkIfPresent(value, "xr_scale_factor_applied", checkNumberOrNull, `${loc}.${key}`, errors);
    checkIfPresent(value, "runMode", checkString, `${loc}.${key}`, errors);
    checkIfPresent(value, "order_control", checkObjectOrNull, `${loc}.${key}`, errors);
    checkIfPresent(value, "uaData", checkObjectOrNull, `${loc}.${key}`, errors);
    checkIfPresent(value, "platform", checkStringOrNull, `${loc}.${key}`, errors);
    checkIfPresent(value, "language", checkStringOrNull, `${loc}.${key}`, errors);
    checkIfPresent(value, "languages", checkArrayOrNull, `${loc}.${key}`, errors);
    checkIfPresent(value, "hardwareConcurrency", checkNumberOrNull, `${loc}.${key}`, errors);
    checkIfPresent(value, "deviceMemory", checkNumberOrNull, `${loc}.${key}`, errors);
    checkIfPresent(value, "maxTouchPoints", checkNumberOrNull, `${loc}.${key}`, errors);
    checkIfPresent(value, "isSecureContext", checkBoolean, `${loc}.${key}`, errors);
    checkIfPresent(value, "crossOriginIsolated", checkBoolean, `${loc}.${key}`, errors);
    checkIfPresent(value, "visibilityState", checkString, `${loc}.${key}`, errors);
    checkIfPresent(value, "dpr", checkNumber, `${loc}.${key}`, errors);
    checkIfPresent(value, "canvas_css", checkObject, `${loc}.${key}`, errors);
    checkIfPresent(value, "canvas_px", checkObject, `${loc}.${key}`, errors);
    checkIfPresent(value, "url", checkString, `${loc}.${key}`, errors);
  }

  // Optional XR/session context fields.
  checkIfPresent(value, "xr_enter_to_first_frame_ms", checkNumber, `${loc}.${key}`, errors);
  checkIfPresent(value, "xr_dom_overlay_requested", checkBoolean, `${loc}.${key}`, errors);
  checkIfPresent(value, "xr_abort_reason", checkString, `${loc}.${key}`, errors);
  checkIfPresent(value, "xr_skipped_reason", checkString, `${loc}.${key}`, errors);
  checkIfPresent(value, "xr_observed_view_count", checkNumber, `${loc}.${key}`, errors);

  // Optional rest metadata: newer runs include it; legacy 1.0.0 files may omit it.
  if ("rest" in value) {
    const rest = value.rest;
    if (rest === null) {
      // transitional/legacy writers may set null
    } else if (!isObject(rest)) {
      pushTypeError(errors, `${loc}.${key}`, "rest", "object or null", typeName(rest));
    } else {
      checkNumberOrNull(rest, "restStartTs", `${loc}.${key}.rest`, errors);
      checkNumberOrNull(rest, "restEndTs", `${loc}.${key}.rest`, errors);
      checkNumberOrNull(rest, "restElapsedMs", `${loc}.${key}.rest`, errors);
      checkNumberOrNull(rest, "recommendedRestMs", `${loc}.${key}.rest`, errors);
      checkStringOrNull(rest, "previousSuiteId", `${loc}.${key}.rest`, errors);
      checkStringOrNull(rest, "previousApi", `${loc}.${key}.rest`, errors);
      checkStringOrNull(rest, "previousRunMode", `${loc}.${key}.rest`, errors);
      checkStringOrNull(rest, "previousFinalPhase", `${loc}.${key}.rest`, errors);
      checkStringOrNull(rest, "previousOutFile", `${loc}.${key}.rest`, errors);
      checkStringOrNull(rest, "previousUrl", `${loc}.${key}.rest`, errors);
    }
  }

  // API-specific extras
  if (value.api === "webgl2") {
    if (strictV11) {
      checkObjectOrNull(value, "contextAttributes", `${loc}.${key}`, errors);
      checkObjectOrNull(value, "gpu", `${loc}.${key}`, errors);
    } else {
      checkIfPresent(value, "contextAttributes", checkObjectOrNull, `${loc}.${key}`, errors);
      checkIfPresent(value, "gpu", checkObjectOrNull, `${loc}.${key}`, errors);
    }
  }
  if (value.api === "webgpu") {
    if (strictV11) {
      checkObjectOrNull(value, "adapterRequest", `${loc}.${key}`, errors);
      checkBooleanOrNull(value, "xrCompatibleRequested", `${loc}.${key}`, errors);
      checkObjectOrNull(value, "adapter", `${loc}.${key}`, errors);
      checkArrayOrNull(value, "adapter_features", `${loc}.${key}`, errors);
      checkObjectOrNull(value, "adapter_limits", `${loc}.${key}`, errors);
      checkArrayOrNull(value, "device_features", `${loc}.${key}`, errors);
      checkObjectOrNull(value, "device_limits", `${loc}.${key}`, errors);
      checkStringOrNull(value, "colorFormat", `${loc}.${key}`, errors);
    } else {
      checkIfPresent(value, "adapterRequest", checkObjectOrNull, `${loc}.${key}`, errors);
      checkIfPresent(value, "xrCompatibleRequested", checkBooleanOrNull, `${loc}.${key}`, errors);
      checkIfPresent(value, "adapter", checkObjectOrNull, `${loc}.${key}`, errors);
      checkIfPresent(value, "adapter_features", checkArrayOrNull, `${loc}.${key}`, errors);
      checkIfPresent(value, "adapter_limits", checkObjectOrNull, `${loc}.${key}`, errors);
      checkIfPresent(value, "device_features", checkArrayOrNull, `${loc}.${key}`, errors);
      checkIfPresent(value, "device_limits", checkObjectOrNull, `${loc}.${key}`, errors);
      checkIfPresent(value, "colorFormat", checkStringOrNull, `${loc}.${key}`, errors);
    }
  }
}


function validateSummary(record, loc, errors) {
  if (!checkFieldPresence(record, "summary", loc, errors)) return;
  const summary = record.summary;
  if (!isObject(summary)) {
    pushTypeError(errors, loc, "summary", "object", typeName(summary));
    return;
  }
  checkNumber(summary, "frames", `${loc}.summary`, errors);
  checkNumber(summary, "duration_ms", `${loc}.summary`, errors);
  checkNumber(summary, "mean_ms", `${loc}.summary`, errors);
  checkNumber(summary, "p50_ms", `${loc}.summary`, errors);
  checkNumber(summary, "p95_ms", `${loc}.summary`, errors);
  checkNumber(summary, "p99_ms", `${loc}.summary`, errors);
}

function validateExtras(record, loc, errors) {
  if (!checkFieldPresence(record, "extras", loc, errors)) return;
  const extras = record.extras;
  if (!isObject(extras)) {
    pushTypeError(errors, loc, "extras", "object", typeName(extras));
    return;
  }
  checkNumber(extras, "fps_effective", `${loc}.extras`, errors);
  checkNumber(extras, "fps_from_mean", `${loc}.extras`, errors);
  checkNumber(extras, "target_ms", `${loc}.extras`, errors);
  checkNumber(extras, "missed_1p5x", `${loc}.extras`, errors);
  checkNumber(extras, "missed_2x", `${loc}.extras`, errors);
  checkNumber(extras, "missed_1p5x_pct", `${loc}.extras`, errors);
  checkNumber(extras, "max_frame_ms", `${loc}.extras`, errors);
  checkNumber(extras, "jank_p99_over_p50", `${loc}.extras`, errors);
}

function validatePerf(record, loc, errors) {
  if (!checkFieldPresence(record, "perf", loc, errors)) return;
  const perf = record.perf;
  if (perf === null) return;
  if (!isObject(perf)) {
    pushTypeError(errors, loc, "perf", "object or null", typeName(perf));
    return;
  }

  checkOneOfTypes(perf, "trial_measure_ms", ["number", "null"], `${loc}.perf`, errors);
  checkOneOfTypes(perf, "memory_start", ["object", "null"], `${loc}.perf`, errors);
  checkOneOfTypes(perf, "memory_end", ["object", "null"], `${loc}.perf`, errors);
  checkOneOfTypes(perf, "model_resource", ["object", "null"], `${loc}.perf`, errors);
  checkNumber(perf, "timeOrigin", `${loc}.perf`, errors);

  if (checkFieldPresence(perf, "longtask", `${loc}.perf`, errors)) {
    const longtask = perf.longtask;
    if (!isObject(longtask)) {
      pushTypeError(errors, `${loc}.perf`, "longtask", "object", typeName(longtask));
    } else {
      checkNumber(longtask, "count", `${loc}.perf.longtask`, errors);
      checkNumber(longtask, "total_ms", `${loc}.perf.longtask`, errors);
      checkNumber(longtask, "max_ms", `${loc}.perf.longtask`, errors);
      if (hasOwn(longtask, "entries")) {
        checkOneOfTypes(longtask, "entries", ["array", "undefined"], `${loc}.perf.longtask`, errors);
      }
    }
  }
}

function validateXRViewports(record, loc, errors) {
  if (!checkFieldPresence(record, "xr_viewports", loc, errors)) return;
  const viewports = record.xr_viewports;
  if (!Array.isArray(viewports)) {
    pushTypeError(errors, loc, "xr_viewports", "array", typeName(viewports));
    return;
  }

  for (let i = 0; i < viewports.length; i++) {
    const vp = viewports[i];
    if (!isObject(vp)) {
      errors.push(`${loc}.xr_viewports[${i}]: expected object, got ${typeName(vp)}`);
      continue;
    }
    checkNumber(vp, "x", `${loc}.xr_viewports[${i}]`, errors);
    checkNumber(vp, "y", `${loc}.xr_viewports[${i}]`, errors);
    checkNumber(vp, "w", `${loc}.xr_viewports[${i}]`, errors);
    checkNumber(vp, "h", `${loc}.xr_viewports[${i}]`, errors);
  }
}

function validatePartialTrial(record, loc, errors) {
  if (!checkFieldPresence(record, "partial_trial", loc, errors)) return;
  const partial = record.partial_trial;
  if (!isObject(partial)) {
    pushTypeError(errors, loc, "partial_trial", "object", typeName(partial));
    return;
  }
  checkOneOfTypes(partial, "elapsed_ms", ["number", "null"], `${loc}.partial_trial`, errors);
  if (hasOwn(partial, "frames_collected")) {
    checkNumber(partial, "frames_collected", `${loc}.partial_trial`, errors);
    return;
  }
  checkNumber(partial, "frames_collected_t", `${loc}.partial_trial`, errors);
  checkNumber(partial, "frames_collected_now", `${loc}.partial_trial`, errors);
}

function validateBase(record, loc, errors) {
  for (const field of COMMON_REQUIRED_FIELDS) {
    checkFieldPresence(record, field, loc, errors);
  }

  checkString(record, "schema_version", loc, errors);
  if (typeof record.schema_version === "string" && !SUPPORTED_SCHEMA_VERSIONS.has(record.schema_version)) {
    errors.push(
      `${loc}: unsupported schema_version ${JSON.stringify(record.schema_version)} (supported: ${Array.from(SUPPORTED_SCHEMA_VERSIONS).join(", ")})`
    );
  }

  checkEnum(record, "api", VALID_APIS, loc, errors);
  checkEnum(record, "mode", VALID_MODES, loc, errors);
  checkString(record, "modelUrl", loc, errors);
  checkOneOfTypes(record, "instances", ["number", "null"], loc, errors);
  checkOneOfTypes(record, "trial", ["number", "null"], loc, errors);
  checkNumber(record, "trials", loc, errors);
  checkNumber(record, "durationMs", loc, errors);
  checkNumber(record, "warmupMs", loc, errors);
  checkNumber(record, "cooldownMs", loc, errors);
  checkNumber(record, "betweenInstancesMs", loc, errors);
  checkString(record, "layout", loc, errors);
  checkNumber(record, "seed", loc, errors);
  checkBoolean(record, "shuffle", loc, errors);
  checkNumber(record, "spacing", loc, errors);
  checkBoolean(record, "collectPerf", loc, errors);
  checkBoolean(record, "perfDetail", loc, errors);
  checkOneOfTypes(record, "condition_index", ["number", "null"], loc, errors);
  checkOneOfTypes(record, "condition_count", ["number", "null"], loc, errors);
  checkString(record, "suiteId", loc, errors);
  checkString(record, "startedAt", loc, errors);
  if (typeof record.startedAt === "string" && Number.isNaN(Date.parse(record.startedAt))) {
    errors.push(`${loc}: \`startedAt\` is not a parseable ISO date`);
  }

  validateAssetTiming(record, loc, errors);
  validateAssetMeta(record, loc, errors);
  validateEnv(record, loc, errors);
}

function validateAbortRecord(record, loc, errors) {
  checkBoolean(record, "aborted", loc, errors);
  if (record.mode !== "xr") {
    errors.push(`${loc}: abort record must have mode="xr"`);
  }
  checkString(record, "abort_code", loc, errors);
  checkString(record, "abort_reason", loc, errors);
  checkNumber(record, "observed_view_count", loc, errors);
  checkNumber(record, "expected_max_views", loc, errors);
  checkNumber(record, "preIdleMs", loc, errors);
  checkNumber(record, "postIdleMs", loc, errors);
  validatePartialTrial(record, loc, errors);
  validateXRViewports(record, loc, errors);
}

function validateTrialRecord(record, loc, errors) {
  if (record.mode === "canvas") {
    checkNumber(record, "preIdleMs", loc, errors);
    checkNumber(record, "postIdleMs", loc, errors);
  }
  validateSummary(record, loc, errors);
  validateExtras(record, loc, errors);
  validatePerf(record, loc, errors);

  if (record.mode === "xr") {
    validateXRViewports(record, loc, errors);
  }

  if (hasOwn(record, "frames_ms")) {
    if (!Array.isArray(record.frames_ms)) {
      pushTypeError(errors, loc, "frames_ms", "array", typeName(record.frames_ms));
    } else {
      for (let i = 0; i < record.frames_ms.length; i++) {
        if (typeof record.frames_ms[i] !== "number" || Number.isNaN(record.frames_ms[i])) {
          errors.push(`${loc}.frames_ms[${i}]: expected number`);
        }
      }
    }
  }
  if (hasOwn(record, "frames_ms_now")) {
    if (!Array.isArray(record.frames_ms_now)) {
      pushTypeError(errors, loc, "frames_ms_now", "array", typeName(record.frames_ms_now));
    } else {
      for (let i = 0; i < record.frames_ms_now.length; i++) {
        if (typeof record.frames_ms_now[i] !== "number" || Number.isNaN(record.frames_ms_now[i])) {
          errors.push(`${loc}.frames_ms_now[${i}]: expected number`);
        }
      }
    }
  }
}

function validateRecord(record, filePath, lineNo) {
  const errors = [];
  const loc = `${filePath}:${lineNo}`;

  if (!isObject(record)) {
    return [`${loc}: expected JSON object, got ${typeName(record)}`];
  }

  validateBase(record, loc, errors);

  if (record.aborted === true) validateAbortRecord(record, loc, errors);
  else validateTrialRecord(record, loc, errors);

  return errors;
}

async function validateFile(filePath) {
  const fileErrors = [];
  const content = await fs.readFile(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  let records = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    const lineNo = i + 1;
    records++;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      fileErrors.push(`${filePath}:${lineNo}: invalid JSON (${err.message})`);
      continue;
    }
    fileErrors.push(...validateRecord(parsed, filePath, lineNo));
  }

  return { filePath, records, errors: fileErrors };
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes("-h") || args.includes("--help")) {
    usage();
    process.exit(args.length ? 0 : 1);
  }

  const files = args;
  let totalRecords = 0;
  let totalErrors = 0;
  const printedErrors = [];

  for (const filePath of files) {
    let result;
    try {
      result = await validateFile(filePath);
    } catch (err) {
      totalErrors++;
      printedErrors.push(`${filePath}: failed to read file (${err.message})`);
      continue;
    }

    totalRecords += result.records;
    totalErrors += result.errors.length;

    if (!result.errors.length) {
      console.log(`[OK] ${filePath}: ${result.records} record(s) validated`);
    } else {
      console.log(`[FAIL] ${filePath}: ${result.errors.length} issue(s) across ${result.records} record(s)`);
      printedErrors.push(...result.errors);
    }
  }

  if (printedErrors.length) {
    console.log("");
    const toPrint = printedErrors.slice(0, MAX_PRINTED_ERRORS);
    for (const err of toPrint) console.log(err);
    if (printedErrors.length > MAX_PRINTED_ERRORS) {
      console.log(`... ${printedErrors.length - MAX_PRINTED_ERRORS} more error(s) omitted`);
    }
  }

  console.log("");
  console.log(`Validated ${totalRecords} record(s) across ${files.length} file(s).`);
  if (totalErrors) {
    console.log(`Found ${totalErrors} validation error(s).`);
    process.exit(1);
  }
  console.log("No validation errors found.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
