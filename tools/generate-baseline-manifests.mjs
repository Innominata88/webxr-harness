#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(repoRoot, "manifests");
const rootBaseUrl = process.env.HARNESS_BASE_URL || "https://innominata88.github.io/webxr-harness/";
const releaseTag = process.env.HARNESS_RELEASE_TAG || "";
const baseUrl = deriveEffectiveBaseUrl(rootBaseUrl, releaseTag);
const manifestProfile = String(process.env.MANIFEST_PROFILE || "baseline").trim().toLowerCase();
const modelUrl = "./assets/spiderman_2002_movie_version_sam_raimi_0.glb";
const releaseCommitShort = readReleaseCommitShort(releaseTag);
const explicitHarnessCommit = String(process.env.HARNESS_COMMIT || "").trim();
if (explicitHarnessCommit && releaseCommitShort && explicitHarnessCommit !== releaseCommitShort) {
  throw new Error(
    `HARNESS_COMMIT (${explicitHarnessCommit}) does not match releases/${releaseTag}/RELEASE_INFO.json commitShort (${releaseCommitShort}).`
  );
}
const harnessCommit = explicitHarnessCommit || releaseCommitShort || safeGitShortHash() || "";
const harnessVersion = process.env.HARNESS_VERSION || releaseTag || "";
const assetRevision = process.env.ASSET_REVISION || "spiderman_2002_movie_version_sam_raimi_0";
const requiredFlagsProfileId = process.env.FEATURE_FLAGS_PROFILE_ID || "webxr-webgpu-flags-v1";
const requiredFlagsExact = process.env.FEATURE_FLAGS_EXACT || "webxr_projection_layers=1;webxr_webgpu_binding=1;webgpu=1";
const generatedAt = new Date().toISOString();
const sanityRunsPerApi = parsePositiveInt(process.env.SANITY_RUNS_PER_API, 2);
const sanityCooldownMs = parseNonNegativeInt(process.env.SANITY_COOLDOWN_MS, 120000);

if (manifestProfile !== "baseline" && manifestProfile !== "sanity") {
  throw new Error(`Unsupported MANIFEST_PROFILE=${manifestProfile}. Use baseline or sanity.`);
}

function safeGitShortHash() {
  try {
    return String(execSync("git rev-parse --short HEAD", { cwd: repoRoot, stdio: ["ignore", "pipe", "ignore"] })).trim();
  } catch (_) {
    return "";
  }
}

function parsePositiveInt(raw, fallback) {
  const v = Number.parseInt(String(raw || "").trim(), 10);
  if (!Number.isFinite(v) || v < 1) return fallback;
  return v;
}

function parseNonNegativeInt(raw, fallback) {
  const v = Number.parseInt(String(raw || "").trim(), 10);
  if (!Number.isFinite(v) || v < 0) return fallback;
  return v;
}

function readReleaseCommitShort(tag) {
  const trimmed = String(tag || "").trim();
  if (!trimmed) return "";
  const infoPath = path.join(repoRoot, "releases", trimmed, "RELEASE_INFO.json");
  try {
    const raw = fs.readFileSync(infoPath, "utf8");
    const obj = JSON.parse(raw);
    const short = String(obj?.commitShort || "").trim();
    return short || "";
  } catch (_) {
    return "";
  }
}

function normalizeBaseDirPath(pathname) {
  let dir = String(pathname || "/");
  if (!dir.endsWith("/")) {
    const idx = dir.lastIndexOf("/");
    dir = idx >= 0 ? dir.slice(0, idx + 1) : "/";
  }
  dir = dir.replace(/\/releases\/[^/]+\/?$/, "/");
  if (!dir.endsWith("/")) dir += "/";
  return dir;
}

function deriveEffectiveBaseUrl(rawBase, tag) {
  let base;
  try {
    base = new URL(String(rawBase || "").trim() || "https://innominata88.github.io/webxr-harness/");
  } catch (_) {
    base = new URL("https://innominata88.github.io/webxr-harness/");
  }
  if (!String(tag || "").trim()) return base.toString();
  const dir = normalizeBaseDirPath(base.pathname);
  base.pathname = `${dir}releases/${encodeURIComponent(String(tag).trim())}/`.replace(/\/+/g, "/");
  base.search = "";
  base.hash = "";
  return base.toString();
}

function slugSegment(value, fallback = "na") {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  const cleaned = raw
    .replace(/https?:\/\//g, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "");
  return cleaned || fallback;
}

function fnv1a32(text) {
  let h = 0x811c9dc5 >>> 0;
  const s = String(text || "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function compactToken(value, fallback = "na", maxLen = 24) {
  const seg = slugSegment(value, fallback);
  if (seg.length <= maxLen) return seg;
  const hash = fnv1a32(seg).toString(16).padStart(8, "0");
  const headLen = Math.max(1, maxLen - 9);
  return `${seg.slice(0, headLen)}-${hash}`;
}

function modelToken(rawModelPath) {
  const raw = String(rawModelPath || "").trim();
  if (!raw) return "model";
  const base = raw.split("/").pop() || raw;
  return slugSegment(base.replace(/\.[^/.]+$/, ""), "model");
}

function instancesToken(instancesRaw) {
  const raw = String(instancesRaw || "").replace(/\s+/g, "");
  if (!raw) return "inst";
  const parts = raw.split(",").filter(Boolean);
  if (parts.length <= 4) return slugSegment(parts.join("-"), "inst");
  return slugSegment(`${parts[0]}-to-${parts[parts.length - 1]}-n${parts.length}`, "inst");
}

function toSeedU32(raw, fallback = 12345) {
  if (raw == null) return fallback >>> 0;
  const text = String(raw).trim();
  if (!text) return fallback >>> 0;
  const n = Number.parseInt(text, 10);
  if (Number.isFinite(n)) return n >>> 0;
  return fallback >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function() {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffledCopy(items, seedU32) {
  const out = items.slice();
  const rng = mulberry32(seedU32 >>> 0);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function repeatPattern(pattern, count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(pattern[i % pattern.length]);
  return out;
}

function buildManifestApiSequence(orderMode, runCount, seedU32, apiScope) {
  if (apiScope === "webgl_only") return repeatPattern(["webgl2"], runCount);
  if (apiScope === "webgpu_only") return repeatPattern(["webgpu"], runCount);
  if (orderMode === "abba") return repeatPattern(["webgl2", "webgpu", "webgpu", "webgl2"], runCount);
  if (orderMode === "baab") return repeatPattern(["webgpu", "webgl2", "webgl2", "webgpu"], runCount);
  if (orderMode === "abba_baab") {
    const block = ["webgl2", "webgpu", "webgpu", "webgl2", "webgpu", "webgl2", "webgl2", "webgpu"];
    return repeatPattern(block, runCount);
  }
  if (orderMode === "baab_abba") {
    const block = ["webgpu", "webgl2", "webgl2", "webgpu", "webgl2", "webgpu", "webgpu", "webgl2"];
    return repeatPattern(block, runCount);
  }
  if (orderMode === "randomized") {
    const half = Math.floor(runCount / 2);
    const seq = [];
    for (let i = 0; i < half; i++) seq.push("webgl2");
    for (let i = 0; i < half; i++) seq.push("webgpu");
    if (runCount % 2 === 1) {
      const rng = mulberry32(seedU32 ^ 0x9e3779b9);
      seq.push(rng() < 0.5 ? "webgl2" : "webgpu");
    }
    return shuffledCopy(seq, seedU32);
  }
  return repeatPattern(["webgl2", "webgpu"], runCount);
}

function makeManifestRunId(baseRunId, runNumber, api) {
  const base = String(baseRunId || "run").trim() || "run";
  const apiTag = api === "webgpu" ? "wgpu" : "wgl2";
  const idx = String(runNumber).padStart(2, "0");
  return `${base}_r${idx}_${apiTag}`;
}

function buildTraceCoreForManifest(values, api, runNumber, deviceTag, browserTag) {
  const run = compactToken(values.runId || "auto", "auto", 30);
  const mode = compactToken(values.runMode || "mode", "mode", 10);
  const inst = compactToken(instancesToken(values.instances), "inst", 20);
  const trials = compactToken(values.trials || "1", "1", 8);
  const device = compactToken(deviceTag || "device", "device", 16);
  const browser = compactToken(browserTag || "browser", "browser", 16);
  const idx = String(runNumber).padStart(2, "0");
  return `run=${run}__r=${idx}__a=${api}__m=${mode}__i=${inst}__t=${trials}__d=${device}__b=${browser}`;
}

function appendSuffixBeforeJsonl(name, suffix) {
  const value = String(name || "");
  if (value.toLowerCase().endsWith(".jsonl")) {
    return `${value.slice(0, -6)}${suffix}.jsonl`;
  }
  return `${value}${suffix}`;
}

function withOutputNames(rowValues, resultFile) {
  const mode = String(rowValues.runMode || "").toLowerCase();
  const out = { ...rowValues };
  if (mode === "xr") {
    out.out = "";
    out.outxr = resultFile;
    return out;
  }
  if (mode === "canvas") {
    out.out = resultFile;
    out.outxr = "";
    return out;
  }
  if (mode === "both") {
    out.out = appendSuffixBeforeJsonl(resultFile, "__canvas");
    out.outxr = appendSuffixBeforeJsonl(resultFile, "__xr");
    return out;
  }
  out.out = resultFile;
  out.outxr = "";
  return out;
}

function buildRowUrl(api, values) {
  const target = new URL(api === "webgpu" ? "webgpu.html" : "webgl.html", baseUrl);
  const fields = [
    "suiteId",
    "model",
    "instances",
    "trials",
    "layout",
    "spacing",
    "canvasScaleFactor",
    "seed",
    "shuffle",
    "debugColor",
    "durationMs",
    "warmupMs",
    "cooldownMs",
    "betweenInstancesMs",
    "preIdleMs",
    "postIdleMs",
    "canvasAutoDelayMs",
    "manualStart",
    "runMode",
    "xrSessionMode",
    "minFrames",
    "xrNoPoseGraceMs",
    "xrScaleFactor",
    "xrFrontMinZ",
    "xrYOffset",
    "xrStartOnFirstPose",
    "xrAnchorToFirstPose",
    "manualDownload",
    "hud",
    "hudHz",
    "collectPerf",
    "perfDetail",
    "renderProbe",
    "xrProbeReadback",
    "traceMarkers",
    "traceOverlay",
    "batteryTelemetry",
    "connectionTelemetry",
    "runId",
    "harnessCommit",
    "harnessVersion",
    "assetRevision",
    "featureFlagsProfile",
    "featureFlagsExact",
    "enforceOrder",
    "orderMode",
    "orderIndex",
    "assignedApi",
    "orderSeed",
    "pinGpu",
    "sessionGroup",
    "storeFrames",
    "webgpuInitTimeoutMs",
    "out",
    "outxr"
  ];

  for (const key of fields) {
    if (key === "webgpuInitTimeoutMs" && api !== "webgpu") continue;
    const value = values[key];
    if (value == null || String(value) === "") continue;
    target.searchParams.set(key, String(value));
  }
  target.searchParams.sort();
  return target.toString();
}

const baseValues = {
  model: modelUrl,
  trials: "10",
  durationMs: "6000",
  spacing: "0.35",
  canvasScaleFactor: "1",
  seed: "12345",
  debugColor: "flat",
  warmupMs: "500",
  cooldownMs: "250",
  betweenInstancesMs: "800",
  canvasAutoDelayMs: "1000",
  manualStart: "0",
  minFrames: "30",
  xrNoPoseGraceMs: "3000",
  xrScaleFactor: "0.25",
  xrFrontMinZ: "-2.5",
  xrYOffset: "1.4",
  xrStartOnFirstPose: "1",
  xrAnchorToFirstPose: "1",
  manualDownload: "1",
  hud: "0",
  hudHz: "2",
  collectPerf: "1",
  perfDetail: "0",
  renderProbe: "1",
  xrProbeReadback: "0",
  traceMarkers: "1",
  traceOverlay: "0",
  batteryTelemetry: "1",
  connectionTelemetry: "1",
  pinGpu: "0",
  sessionGroup: "default",
  storeFrames: "0",
  webgpuInitTimeoutMs: "15000",
  harnessCommit,
  harnessVersion,
  assetRevision,
  featureFlagsProfile: requiredFlagsProfileId,
  featureFlagsExact: requiredFlagsExact
};

const baselineDefs = [
  {
    file: "avp_canvas_primary_regular_paired_5sets.json",
    suiteId: "AVP_CANVAS_PRIMARY_REGULAR",
    runIdBase: "avp_canvas_primary_regular",
    deviceTag: "avp",
    browserTag: "visionos-safari",
    runMode: "canvas",
    xrSessionMode: "immersive-vr",
    instances: "64,128,192,256,320",
    layout: "xrwall",
    shuffle: "1",
    preIdleMs: "0",
    postIdleMs: "0",
    apiScope: "paired",
    orderMode: "abba_baab",
    runCount: 10,
    orderSeed: "12345",
    cooldownBetweenRunsMs: 300000
  },
  {
    file: "avp_xr_primary_regular_paired_5sets.json",
    suiteId: "AVP_XR_PRIMARY_REGULAR",
    runIdBase: "avp_xr_primary_regular",
    deviceTag: "avp",
    browserTag: "visionos-safari",
    runMode: "xr",
    xrSessionMode: "immersive-vr",
    instances: "64,128,192,256,320",
    layout: "xrwall",
    shuffle: "1",
    preIdleMs: "500",
    postIdleMs: "500",
    apiScope: "paired",
    orderMode: "abba_baab",
    runCount: 10,
    orderSeed: "12345",
    cooldownBetweenRunsMs: 300000
  },
  {
    file: "avp_xr_primary_cliff_paired_5sets.json",
    suiteId: "AVP_XR_PRIMARY_CLIFF",
    runIdBase: "avp_xr_primary_cliff",
    deviceTag: "avp",
    browserTag: "visionos-safari",
    runMode: "xr",
    xrSessionMode: "immersive-vr",
    instances: "340,345,348,350",
    layout: "xrwall",
    shuffle: "0",
    preIdleMs: "0",
    postIdleMs: "0",
    apiScope: "paired",
    orderMode: "abba_baab",
    runCount: 10,
    orderSeed: "12345",
    cooldownBetweenRunsMs: 600000
  },
  {
    file: "quest2_canvas_primary_regular_webgl_only_5sets.json",
    suiteId: "QUEST2_CANVAS_PRIMARY_REGULAR",
    runIdBase: "quest2_canvas_primary_regular",
    deviceTag: "quest2",
    browserTag: "oculus-browser",
    runMode: "canvas",
    xrSessionMode: "immersive-vr",
    instances: "64,128,192,256,320",
    layout: "xrwall",
    shuffle: "1",
    preIdleMs: "0",
    postIdleMs: "0",
    apiScope: "webgl_only",
    orderMode: "none",
    runCount: 5,
    orderSeed: "12345",
    cooldownBetweenRunsMs: 300000
  },
  {
    file: "quest2_xr_primary_regular_webgl_only_5sets.json",
    suiteId: "QUEST2_XR_PRIMARY_REGULAR",
    runIdBase: "quest2_xr_primary_regular",
    deviceTag: "quest2",
    browserTag: "oculus-browser",
    runMode: "xr",
    xrSessionMode: "immersive-vr",
    instances: "64,128,192,256,320",
    layout: "xrwall",
    shuffle: "1",
    preIdleMs: "500",
    postIdleMs: "500",
    apiScope: "webgl_only",
    orderMode: "none",
    runCount: 5,
    orderSeed: "12345",
    cooldownBetweenRunsMs: 300000
  },
  {
    file: "pixel8a_canvas_primary_regular_paired_5sets.json",
    suiteId: "PIXEL8A_CANVAS_PRIMARY_REGULAR",
    runIdBase: "pixel8a_canvas_primary_regular",
    deviceTag: "pixel8a",
    browserTag: "chrome-android",
    runMode: "canvas",
    xrSessionMode: "immersive-vr",
    instances: "64,128,192,256,320",
    layout: "xrwall",
    canvasScaleFactor: "0.75",
    shuffle: "1",
    preIdleMs: "0",
    postIdleMs: "0",
    apiScope: "paired",
    orderMode: "abba_baab",
    runCount: 10,
    orderSeed: "12345",
    cooldownBetweenRunsMs: 300000
  },
  {
    file: "samsung_fe5g_canvas_primary_regular_paired_5sets.json",
    suiteId: "SAMSUNG_FE5G_CANVAS_PRIMARY_REGULAR",
    runIdBase: "samsung_fe5g_canvas_primary_regular",
    deviceTag: "samsung-fe5g",
    browserTag: "chrome-android",
    runMode: "canvas",
    xrSessionMode: "immersive-vr",
    instances: "64,128,192,256,320",
    layout: "xrwall",
    canvasScaleFactor: "0.75",
    shuffle: "1",
    preIdleMs: "0",
    postIdleMs: "0",
    apiScope: "paired",
    orderMode: "abba_baab",
    runCount: 10,
    orderSeed: "12345",
    cooldownBetweenRunsMs: 300000
  },
  {
    file: "pixel8a_xr_ar_primary_regular_paired_5sets.json",
    suiteId: "PIXEL8A_XR_AR_PRIMARY_REGULAR",
    runIdBase: "pixel8a_xr_ar_primary_regular",
    deviceTag: "pixel8a",
    browserTag: "chrome-android",
    runMode: "xr",
    xrSessionMode: "immersive-ar",
    instances: "64,128,192,256,320",
    layout: "xrwall",
    shuffle: "1",
    preIdleMs: "500",
    postIdleMs: "500",
    apiScope: "paired",
    orderMode: "abba_baab",
    runCount: 10,
    orderSeed: "12345",
    cooldownBetweenRunsMs: 300000
  },
  {
    file: "samsung_fe5g_xr_ar_primary_regular_paired_5sets.json",
    suiteId: "SAMSUNG_FE5G_XR_AR_PRIMARY_REGULAR",
    runIdBase: "samsung_fe5g_xr_ar_primary_regular",
    deviceTag: "samsung-fe5g",
    browserTag: "chrome-android",
    runMode: "xr",
    xrSessionMode: "immersive-ar",
    instances: "64,128,192,256,320",
    layout: "xrwall",
    shuffle: "1",
    preIdleMs: "500",
    postIdleMs: "500",
    apiScope: "paired",
    orderMode: "abba_baab",
    runCount: 10,
    orderSeed: "12345",
    cooldownBetweenRunsMs: 300000
  },
  {
    file: "ipadairm3_canvas_primary_regular_paired_5sets.json",
    suiteId: "IPADAIRM3_CANVAS_PRIMARY_REGULAR",
    runIdBase: "ipadairm3_canvas_primary_regular",
    deviceTag: "ipadairm3",
    browserTag: "safari-ipados",
    runMode: "canvas",
    xrSessionMode: "immersive-vr",
    instances: "64,128,192,256,320",
    layout: "xrwall",
    shuffle: "1",
    preIdleMs: "0",
    postIdleMs: "0",
    apiScope: "paired",
    orderMode: "abba_baab",
    runCount: 10,
    orderSeed: "12345",
    cooldownBetweenRunsMs: 300000
  },
  {
    file: "macbookpro_m1_canvas_primary_regular_paired_5sets.json",
    suiteId: "MACBOOKPRO_M1_CANVAS_PRIMARY_REGULAR",
    runIdBase: "macbookpro_m1_canvas_primary_regular",
    deviceTag: "macbookpro-m1",
    browserTag: "chrome-macos",
    runMode: "canvas",
    xrSessionMode: "immersive-vr",
    instances: "64,128,192,256,320",
    layout: "xrwall",
    shuffle: "1",
    preIdleMs: "0",
    postIdleMs: "0",
    apiScope: "paired",
    orderMode: "abba_baab",
    runCount: 10,
    orderSeed: "12345",
    cooldownBetweenRunsMs: 300000
  },
  {
    file: "windows_hp_canvas_primary_regular_paired_5sets.json",
    suiteId: "WINDOWS_HP_CANVAS_PRIMARY_REGULAR",
    runIdBase: "windows_hp_canvas_primary_regular",
    deviceTag: "windows-hp",
    browserTag: "chrome-windows",
    runMode: "canvas",
    xrSessionMode: "immersive-vr",
    instances: "64,128,192,256,320",
    layout: "xrwall",
    shuffle: "1",
    preIdleMs: "0",
    postIdleMs: "0",
    apiScope: "paired",
    orderMode: "abba_baab",
    runCount: 10,
    orderSeed: "12345",
    cooldownBetweenRunsMs: 300000
  }
];

function sanityFileName(file) {
  const base = String(file || "").replace(/\.json$/i, "");
  const stripped = base.replace(/_5sets$/i, "");
  return `${stripped}_sanity_2sets.json`;
}

function toSanityDef(def) {
  const runCount = def.apiScope === "paired" ? sanityRunsPerApi * 2 : sanityRunsPerApi;
  return {
    ...def,
    file: sanityFileName(def.file),
    suiteId: `${def.suiteId}_SANITY`,
    runIdBase: `${def.runIdBase}_sanity`,
    runCount,
    cooldownBetweenRunsMs: sanityCooldownMs
  };
}

const defs = manifestProfile === "sanity" ? baselineDefs.map(toSanityDef) : baselineDefs;

function buildManifest(def) {
  const sequence = buildManifestApiSequence(def.orderMode, def.runCount, toSeedU32(def.orderSeed, 12345), def.apiScope);
  const rows = [];
  for (let i = 0; i < sequence.length; i++) {
    const api = sequence[i];
    const runNumber = i + 1;
    let rowValues = {
      ...baseValues,
      suiteId: def.suiteId,
      instances: def.instances,
      runMode: def.runMode,
      xrSessionMode: def.xrSessionMode,
      layout: def.layout,
      canvasScaleFactor: def.canvasScaleFactor || baseValues.canvasScaleFactor,
      shuffle: def.shuffle,
      preIdleMs: def.preIdleMs,
      postIdleMs: def.postIdleMs,
      enforceOrder: def.orderMode === "none" ? "0" : "1",
      orderMode: def.orderMode,
      orderIndex: String(runNumber),
      assignedApi: def.orderMode === "randomized" ? api : "",
      orderSeed: def.orderSeed,
      runId: makeManifestRunId(def.runIdBase, runNumber, api)
    };

    const core = buildTraceCoreForManifest(rowValues, api, runNumber, def.deviceTag, def.browserTag);
    const chromeTrace = `chrome_trace__${core}__ts=YYYYMMDD-HHMMSS.json`;
    const safariTrace = `safari_timeline__${core}__ts=YYYYMMDD-HHMMSS.json`;
    const resultFile = `results__${core}__ts=YYYYMMDD-HHMMSS.jsonl`;

    rowValues = withOutputNames(rowValues, resultFile);
    const url = buildRowUrl(api, rowValues);

    rows.push({
      run_number: runNumber,
      api,
      suite_id: rowValues.suiteId || "",
      run_id: rowValues.runId,
      order_mode: rowValues.orderMode,
      api_scope: def.apiScope,
      order_index: rowValues.orderIndex,
      enforce_order: rowValues.enforceOrder,
      assigned_api: rowValues.assignedApi || "",
      order_seed: rowValues.orderSeed || "",
      session_group: rowValues.sessionGroup || "",
      cache_mode: "warm",
      profiler_mode: "baseline_untraced",
      profiler_config: "",
      cooldown_after_ms: def.cooldownBetweenRunsMs,
      run_mode: rowValues.runMode || "",
      instances: rowValues.instances || "",
      trials: rowValues.trials || "",
      duration_ms: rowValues.durationMs || "",
      layout: rowValues.layout || "",
      seed: rowValues.seed || "",
      shuffle: rowValues.shuffle || "",
      debug_color: rowValues.debugColor || "",
      harness_commit: rowValues.harnessCommit || "",
      harness_version: rowValues.harnessVersion || "",
      asset_revision: rowValues.assetRevision || "",
      url,
      chrome_trace_name: chromeTrace,
      safari_timeline_name: safariTrace,
      results_name: resultFile,
      device_tag: def.deviceTag,
      browser_tag: def.browserTag,
      power_log_file: "",
      external_metrics_file: "",
      notes: ""
    });
  }

  return {
    schema: "webxr-harness-manifest/v1",
    generatedAt: generatedAt,
    source: {
      manifestOrderMode: def.orderMode,
      manifestApiScope: def.apiScope,
      manifestRuns: def.runCount,
      manifestOrderSeed: def.orderSeed,
      effectiveBaseUrl: baseUrl,
      releaseTag: releaseTag || "",
      cacheMode: "warm",
      profilerMode: "baseline_untraced",
      profilerConfig: "",
      injectOutputNames: true,
      cooldownBetweenRunsMs: def.cooldownBetweenRunsMs,
      required_flags_profile_id: requiredFlagsProfileId,
      required_flags_exact: requiredFlagsExact
    },
    required_flags_profile_id: requiredFlagsProfileId,
    required_flags_exact: requiredFlagsExact,
    rows
  };
}

function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const def of defs) {
    const manifest = buildManifest(def);
    const outPath = path.join(outDir, def.file);
    fs.writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    written.push(def.file);
  }
  process.stdout.write(`Generated ${written.length} manifests in ${outDir} (profile=${manifestProfile})\n`);
  process.stdout.write(`Base URL: ${baseUrl}\n`);
  if (manifestProfile === "sanity") {
    process.stdout.write(`sanityRunsPerApi=${sanityRunsPerApi} sanityCooldownMs=${sanityCooldownMs}\n`);
  }
  process.stdout.write(`harnessCommit=${harnessCommit || "(empty)"} harnessVersion=${harnessVersion || "(empty)"} releaseTag=${releaseTag || "(none)"}\n`);
  for (const f of written) process.stdout.write(`- ${f}\n`);
}

main();
