#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const VALID_APIS = new Set(["metal", "vulkan", "d3d11", "d3d12", "opengles"]);
const VALID_MODES = new Set(["canvas", "ar", "xr"]);
const VALID_SURFACE_MODES = new Set(["flat", "basecolor"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function has(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function requireType(object, key, type, location, errors) {
  if (!has(object, key)) {
    errors.push(`${location}: missing required field \`${key}\``);
    return;
  }
  const value = object[key];
  const valid = type === "object" ? isObject(value)
    : type === "array" ? Array.isArray(value)
      : typeof value === type;
  if (!valid) {
    errors.push(`${location}: \`${key}\` must be ${type}`);
  }
}

function requireFiniteNumber(object, key, location, errors, { min = -Infinity } = {}) {
  requireType(object, key, "number", location, errors);
  const value = object[key];
  if (typeof value === "number" && (!Number.isFinite(value) || value < min)) {
    errors.push(`${location}: \`${key}\` must be finite and >= ${min}`);
  }
}

function requireNonemptyString(object, key, location, errors) {
  requireType(object, key, "string", location, errors);
  if (typeof object[key] === "string" && !object[key].trim()) {
    errors.push(`${location}: \`${key}\` must not be empty`);
  }
}

function surfaceModeOf(record) {
  return String(record.surface_mode ?? record.surfaceMode ?? record.env?.surface_mode ?? "").toLowerCase();
}

function validateSummary(record, location, errors) {
  requireType(record, "summary", "object", location, errors);
  if (!isObject(record.summary)) return;
  for (const key of ["frames", "duration_ms", "mean_ms", "p50_ms", "p95_ms", "p99_ms"]) {
    requireFiniteNumber(record.summary, key, `${location}.summary`, errors, { min: 0 });
  }
  if (record.summary.frames <= 0) {
    errors.push(`${location}.summary: \`frames\` must be > 0`);
  }
  if (record.summary.duration_ms <= 0 || record.summary.mean_ms <= 0) {
    errors.push(`${location}.summary: duration and mean frame time must be > 0`);
  }
}

function validateExtras(record, location, errors) {
  requireType(record, "extras", "object", location, errors);
  if (!isObject(record.extras)) return;
  for (const key of [
    "fps_effective", "fps_from_mean", "max_frame_ms", "jank_p99_over_p50",
    "missed_1p5x", "missed_1p5x_pct", "missed_2x", "target_ms",
  ]) {
    requireFiniteNumber(record.extras, key, `${location}.extras`, errors, { min: 0 });
  }
}

function validateEnvironment(record, location, errors) {
  requireType(record, "env", "object", location, errors);
  if (!isObject(record.env)) return;
  const env = record.env;
  for (const key of [
    "runtime_family", "runtime_mode", "xr_runtime", "renderer_path",
    "timing_source_primary", "asset_revision", "plan_id", "device_model",
    "os_version", "gpu_renderer",
  ]) {
    requireNonemptyString(env, key, `${location}.env`, errors);
  }
  requireNonemptyString(env, "surface_mode", `${location}.env`, errors);

  const mode = surfaceModeOf(record);
  if (env.surface_mode !== mode) {
    errors.push(`${location}.env: surface mode disagrees with root record`);
  }
  const expectedRendererSuffix = mode === "basecolor" ? "basecolor" : "flat";
  if (typeof env.renderer_path === "string" && !env.renderer_path.endsWith(expectedRendererSuffix)) {
    errors.push(`${location}.env: renderer_path does not match ${mode}`);
  }
}

function validateScene(record, location, errors) {
  requireType(record, "scene", "object", location, errors);
  if (!isObject(record.scene)) return;
  const scene = record.scene;
  for (const key of [
    "vertex_count", "index_count", "triangle_count", "primitives_loaded",
    "textured_primitives_loaded", "materials_total", "images_total",
    "textures_total", "material_scene_primitives", "material_scene_textures",
    "norm_scale", "norm_max_dim",
  ]) {
    requireFiniteNumber(scene, key, `${location}.scene`, errors, { min: 0 });
  }
  requireType(scene, "norm_center", "array", `${location}.scene`, errors);
  if (Array.isArray(scene.norm_center)
      && (scene.norm_center.length !== 3
        || scene.norm_center.some((value) => typeof value !== "number" || !Number.isFinite(value)))) {
    errors.push(`${location}.scene: \`norm_center\` must contain three finite numbers`);
  }
  if (surfaceModeOf(record) === "basecolor" && scene.material_scene_primitives <= 0) {
    errors.push(`${location}.scene: basecolor requires material primitives`);
  }
}

export function validateNativeRecord(record, location = "record") {
  const errors = [];
  if (!isObject(record)) return [`${location}: expected JSON object`];

  for (const key of ["schema_version", "api", "mode", "suiteId", "runId", "startedAt", "layout"]) {
    requireNonemptyString(record, key, location, errors);
  }
  for (const key of [
    "trial", "trials", "instances", "condition_index", "condition_count",
    "durationMs", "warmupMs", "cooldownMs", "betweenInstancesMs",
    "minFrames", "spacing", "seed",
  ]) {
    requireFiniteNumber(record, key, location, errors, { min: 0 });
  }
  requireType(record, "shuffle", "boolean", location, errors);
  requireType(record, "aborted", "boolean", location, errors);

  if (record.schema_version !== "1.1.0") {
    errors.push(`${location}: unsupported schema_version ${JSON.stringify(record.schema_version)}`);
  }
  if (!VALID_APIS.has(record.api)) {
    errors.push(`${location}: unsupported native api ${JSON.stringify(record.api)}`);
  }
  if (!VALID_MODES.has(record.mode)) {
    errors.push(`${location}: unsupported native mode ${JSON.stringify(record.mode)}`);
  }
  const surfaceMode = surfaceModeOf(record);
  if (!VALID_SURFACE_MODES.has(surfaceMode)) {
    errors.push(`${location}: unsupported surface mode ${JSON.stringify(surfaceMode)}`);
  }
  if (String(record.suiteId).toUpperCase().includes("MATERIAL") && surfaceMode !== "basecolor") {
    errors.push(`${location}: MATERIAL suite must use basecolor`);
  }
  if (surfaceMode === "basecolor" && !String(record.suiteId).toUpperCase().includes("MATERIAL")) {
    errors.push(`${location}: basecolor record must use a MATERIAL suite ID`);
  }
  if (Number.isNaN(Date.parse(record.startedAt))) {
    errors.push(`${location}: \`startedAt\` is not a parseable date`);
  }

  validateEnvironment(record, location, errors);
  validateScene(record, location, errors);
  if (record.aborted) {
    requireNonemptyString(record, "abort_code", location, errors);
    requireNonemptyString(record, "abort_reason", location, errors);
  } else {
    validateSummary(record, location, errors);
    validateExtras(record, location, errors);
  }
  return errors;
}

export function validateNativeRun(records, location = "run") {
  const errors = [];
  if (!records.length) return [`${location}: no JSON records found`];
  const first = records[0];
  const consistentFields = ["runId", "suiteId", "api", "mode"];
  const firstSurface = surfaceModeOf(first);
  const conditionIndices = new Set();

  records.forEach((record, index) => {
    const recordLocation = `${location}:${index + 1}`;
    errors.push(...validateNativeRecord(record, recordLocation));
    for (const field of consistentFields) {
      if (record[field] !== first[field]) {
        errors.push(`${recordLocation}: \`${field}\` differs within the run`);
      }
    }
    if (surfaceModeOf(record) !== firstSurface) {
      errors.push(`${recordLocation}: surface mode differs within the run`);
    }
    if (conditionIndices.has(record.condition_index)) {
      errors.push(`${recordLocation}: duplicate condition_index ${record.condition_index}`);
    }
    conditionIndices.add(record.condition_index);
  });

  if (Number.isInteger(first.condition_count) && records.length !== first.condition_count) {
    errors.push(
      `${location}: expected ${first.condition_count} condition records, found ${records.length}`
    );
  }
  if (Number.isInteger(first.condition_count)) {
    for (let index = 0; index < first.condition_count; index++) {
      if (!conditionIndices.has(index)) {
        errors.push(`${location}: missing condition_index ${index}`);
      }
    }
  }
  return errors;
}

async function validateFile(filePath) {
  const content = await fs.readFile(filePath, "utf8");
  const records = [];
  const parseErrors = [];
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch (error) {
      parseErrors.push(`${filePath}:${index + 1}: invalid JSON (${error.message})`);
    }
  }
  return {
    records: records.length,
    errors: [...parseErrors, ...validateNativeRun(records, filePath)],
  };
}

async function main(args) {
  if (!args.length || args.includes("-h") || args.includes("--help")) {
    console.log("Usage: node tools/validate-native-results.mjs <results.jsonl> [more.jsonl ...]");
    process.exitCode = args.length ? 0 : 1;
    return;
  }

  let totalRecords = 0;
  const errors = [];
  for (const filePath of args) {
    const result = await validateFile(filePath);
    totalRecords += result.records;
    errors.push(...result.errors);
  }

  if (errors.length) {
    for (const error of errors.slice(0, 200)) console.error(error);
    console.error(`Native validation failed: ${errors.length} errors across ${totalRecords} records.`);
    process.exitCode = 1;
    return;
  }
  console.log(`Native validation passed: ${totalRecords} records across ${args.length} files.`);
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
