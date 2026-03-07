// src/app-webgl.js
import { loadGLBMesh } from "./common/glb-loader.js";
import { WebGLMeshRenderer, computeViewProj } from "./webgl/renderer-webgl.js";
import { RunStats } from "./common/metrics.js";

const params = new URLSearchParams(location.search);

const suiteId = params.get("suiteId") || `suite_${Date.now()}`;
const modelUrl = params.get("model") || "./assets/model.glb";
const durationMs = parseInt(params.get("durationMs") || "10000", 10);
const trials = parseInt(params.get("trials") || "1", 10);
const warmupMs = parseInt(params.get("warmupMs") || "500", 10);
const cooldownMs = parseInt(params.get("cooldownMs") || "250", 10);
const betweenInstancesMs = parseInt(params.get("betweenInstancesMs") || "800", 10);
const outFileTemplate = params.get("out") || "";
const SCHEMA_VERSION = "1.1.0";

function readMetaContent(name) {
  const el = document.querySelector(`meta[name="${name}"]`);
  if (!el) return null;
  const v = el.getAttribute("content");
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed ? trimmed : null;
}

function normalizeOptionalString(v) {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed ? trimmed : null;
}

function timestampTokenNowUtc() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  const h = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  const s = String(d.getUTCSeconds()).padStart(2, "0");
  return `${y}${mo}${da}-${h}${mi}${s}`;
}

function resolveOutputFilename(template, fallbackPrefix) {
  const fallback = `${fallbackPrefix}_${Date.now()}.jsonl`;
  let raw = (typeof template === "string" ? template.trim() : "");
  if (!raw) raw = fallback;
  const token = timestampTokenNowUtc();
  raw = raw.replaceAll("YYYYMMDD-HHMMSS", token).replaceAll("{ts}", token);
  return raw;
}

const harnessVersion = normalizeOptionalString(params.get("harnessVersion"))
  || normalizeOptionalString(readMetaContent("webxr-harness-version"))
  || SCHEMA_VERSION;
const harnessCommit = normalizeOptionalString(params.get("harnessCommit"))
  || normalizeOptionalString(params.get("appRev"))
  || normalizeOptionalString(readMetaContent("webxr-harness-commit"));
const assetRevision = normalizeOptionalString(params.get("assetRevision"))
  || normalizeOptionalString(params.get("assetHash"))
  || normalizeOptionalString(readMetaContent("webxr-asset-revision"));
const featureFlagsProfile = normalizeOptionalString(params.get("featureFlagsProfile"))
  || normalizeOptionalString(readMetaContent("webxr-feature-flags-profile"));
const featureFlagsExact = normalizeOptionalString(params.get("featureFlagsExact"))
  || normalizeOptionalString(readMetaContent("webxr-feature-flags-exact"));
const profilerMode = normalizeOptionalString(params.get("profilerMode"))
  || normalizeOptionalString(readMetaContent("webxr-profiler-mode"));
const profilerConfig = normalizeOptionalString(params.get("profilerConfig"))
  || normalizeOptionalString(readMetaContent("webxr-profiler-config"));
const xrIdlePresentMode = (() => {
  const raw = String(params.get("xrIdlePresentMode") || "none").toLowerCase();
  return raw === "clear_each_frame" ? "clear_each_frame" : "none";
})();
const provenanceInfo = {
  harness_version: harnessVersion,
  harness_commit: harnessCommit,
  asset_revision: assetRevision,
  feature_flags_profile: featureFlagsProfile,
  feature_flags_exact: featureFlagsExact,
  profiler_mode: profilerMode,
  profiler_config: profilerConfig,
  xr_idle_present_mode: xrIdlePresentMode,
  asset_url: modelUrl
};

const layout = (params.get("layout") || "line").toLowerCase(); // line|grid|spiral|random|xrwall
const seed = parseInt(params.get("seed") || "12345", 10) >>> 0;
const shuffle = (params.get("shuffle") || "0") === "1";
const storeFrames = (params.get("storeFrames") || "0") === "1";


// Instance spacing (scene density). Keep identical between WebGL/WebGPU for fair comparisons.
const spacing = (() => {
  const v = parseFloat(params.get("spacing") || "0.35");
  return (Number.isFinite(v) && v > 0) ? v : 0.35;
})();
const debugColor = (() => {
  const v = String(params.get("debugColor") || "flat").toLowerCase();
  return (v === "flat" || v === "abspos" || v === "instance") ? v : "flat";
})();

// XR placement so the user can look straight ahead (especially on Vision Pro)
const xrFrontMinZ = (() => {
  const v = parseFloat(params.get("xrFrontMinZ") || "-2.0");
  return Number.isFinite(v) ? v : -2.0;
})();
const xrYOffset = (() => {
  const v = parseFloat(params.get("xrYOffset") || "1.4");
  return Number.isFinite(v) ? v : 1.4;
})();

// Render probe: run a single unmeasured frame and sample a few pixels to detect "nothing rendered" cases.
// Runs before timed trials so it should not affect your metrics.
const renderProbe = (params.get("renderProbe") || "1") === "1";

// On iOS/iPadOS/visionOS, automatic downloads triggered by script are unreliable.
// Default: force manual download on Apple devices.
function detectApplePlatform() {
  const ua = navigator.userAgent || "";
  const isIOS = /iPhone|iPad|iPod/i.test(ua);
  const isIPadDesktopMode = (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isVision = /visionOS/i.test(ua) || /Vision Pro/i.test(ua) || /Apple Vision/i.test(ua);
  return isIOS || isIPadDesktopMode || isVision;
}
function detectBrowserLabel() {
  const ua = navigator.userAgent || "";
  const brands = Array.isArray(navigator.userAgentData?.brands)
    ? navigator.userAgentData.brands.map((b) => (b && typeof b.brand === "string" ? b.brand : "")).filter(Boolean)
    : [];
  if (brands.length) return brands.join(" | ");
  if (/SamsungBrowser\//i.test(ua)) return "Samsung Internet";
  if (/Edg\//i.test(ua)) return "Edge";
  if (/OPR\//i.test(ua)) return "Opera";
  if (/CriOS\//i.test(ua)) return "Chrome iOS";
  if (/Chrome\//i.test(ua) || /Chromium\//i.test(ua)) return "Chrome";
  if (/FxiOS\//i.test(ua)) return "Firefox iOS";
  if (/Firefox\//i.test(ua)) return "Firefox";
  if (/Safari\//i.test(ua) && /Version\//i.test(ua)) return "Safari";
  return null;
}
const isApplePlatform = detectApplePlatform();
const browserLabel = detectBrowserLabel();
const manualDownload = (() => {
  // Default: manual download ON for all platforms unless explicitly disabled.
  // Rationale: Safari/visionOS often blocks programmatic downloads; keeping behavior uniform across devices is safest.
  return (params.get("manualDownload") || "1") !== "0";
})();

// Lightweight Chrome/PerformancePanel-friendly instrumentation

// Optional idle windows between XR trials. Default behavior preserves true idle semantics;
// xrIdlePresentMode=clear_each_frame is available for diagnostics when you need visible idle presentation.
const preIdleMs = parseInt(params.get("preIdleMs") || "0", 10);
const postIdleMs = parseInt(params.get("postIdleMs") || "0", 10);

// Minimal HUD (DOM overlay in XR when supported) to show remaining time while wearing a headset.
// hud=1 by default. Set hud=0 to disable.
const hudEnabled = (params.get("hud") || "1") === "1";
const hudHz = (() => {
  const v = parseFloat(params.get("hudHz") || "2");
  return (Number.isFinite(v) && v > 0) ? Math.min(10, Math.max(0.5, v)) : 2;
})();


// collectPerf=1 adds performance marks/measures, Long Task summaries (Chrome), and JS heap snapshots (Chrome)
const collectPerf = (params.get("collectPerf") || "1") === "1";
const perfDetail = (params.get("perfDetail") || "0") === "1";

const _longTasks = [];
if (collectPerf && "PerformanceObserver" in window) {
  try {
    const obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        // startTime is relative to performance.timeOrigin
        _longTasks.push({ startTime: e.startTime, duration: e.duration });
      }
    });
    obs.observe({ entryTypes: ["longtask"] });
  } catch (_) {}
}

function snapshotMemory() {
  // Chrome-only (undefined elsewhere)
  const m = performance.memory;
  if (!m) return null;
  return {
    usedJSHeapSize: m.usedJSHeapSize,
    totalJSHeapSize: m.totalJSHeapSize,
    jsHeapSizeLimit: m.jsHeapSizeLimit
  };
}

function summarizeLongTasks(t0, t1) {
  let count = 0, total = 0, max = 0;
  const hits = [];
  for (const lt of _longTasks) {
    const s = lt.startTime;
    const e = s + lt.duration;
    if (e < t0 || s > t1) continue;
    count++;
    total += lt.duration;
    if (lt.duration > max) max = lt.duration;
    if (perfDetail) hits.push(lt);
  }
  return { count, total_ms: total, max_ms: max, entries: perfDetail ? hits : undefined };
}

function findResourceEntry(url) {
  try {
    const abs = new URL(url, location.href).href;
    const entries = performance.getEntriesByType("resource");
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.name === abs) {
        return {
          name: e.name,
          initiatorType: e.initiatorType,
          startTime: e.startTime,
          duration: e.duration,
          transferSize: e.transferSize,
          encodedBodySize: e.encodedBodySize,
          decodedBodySize: e.decodedBodySize
        };
      }
    }
  } catch (_) {}
  return null;
}

function parseIntList(value, fallback=[4]) {
  if (!value) return fallback;
  const parts = value.split(",").map(s=>s.trim()).filter(Boolean);
  const nums = parts.map(p=>parseInt(p,10)).filter(n=>Number.isFinite(n) && n>0);
  return nums.length ? nums : fallback;
}
const instancesList = parseIntList(params.get("instances"), [4]);
const MAX_COMPARABLE_XR_VIEWS = 2;
const apiLabel = "webgl2";
const runId = normalizeOptionalString(params.get("runId"))
  || ((typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
    ? crypto.randomUUID()
    : `${apiLabel}_${suiteId}_${Date.now()}`);
const traceMarkers = (params.get("traceMarkers") || "1") !== "0";
const traceOverlay = (params.get("traceOverlay") || "0") === "1";

const runMode = (() => {
  // Canonical parameter is ?runMode=. Keep ?mode= as backward-compatible alias.
  // If both are present, runMode takes precedence.
  const raw = (params.get("runMode") || params.get("mode") || "both");
  const v = String(raw).toLowerCase();
  return (v === "canvas" || v === "xr" || v === "both") ? v : "both";
})();
const xrSessionMode = (() => {
  // Canonical XR session mode parameter for immersive session type.
  // Accept legacy alias ?sessionMode= for compatibility.
  const raw = (params.get("xrSessionMode") || params.get("sessionMode") || "immersive-vr");
  const v = String(raw).toLowerCase();
  return v === "immersive-ar" ? "immersive-ar" : "immersive-vr";
})();
const xrSessionModeLabel = xrSessionMode === "immersive-ar" ? "AR" : "VR";
const xrSessionModeShort = xrSessionMode === "immersive-ar" ? "ar" : "vr";
const canvasAutoDelayMs = parseInt(params.get("canvasAutoDelayMs") || "1000", 10);
const manualStart = (params.get("manualStart") || "0") === "1";
const batteryTelemetry = (params.get("batteryTelemetry") || "1") !== "0";
const connectionTelemetry = (params.get("connectionTelemetry") || "1") !== "0";
const xrScaleFactor = (() => {
  const v = parseFloat(params.get("xrScaleFactor") || "1");
  return (Number.isFinite(v) && v > 0) ? Math.min(2.0, Math.max(0.25, v)) : 1.0;
})();
const canvasScaleFactor = (() => {
  const v = parseFloat(params.get("canvasScaleFactor") || "1");
  return (Number.isFinite(v) && v > 0) ? Math.min(1.0, Math.max(0.25, v)) : 1.0;
})();
const xrProbeReadback = (params.get("xrProbeReadback") || "0") === "1";
const minFrames = (() => {
  const v = parseInt(params.get("minFrames") || "30", 10);
  return (Number.isFinite(v) && v >= 0) ? v : 30;
})();
const xrNoPoseGraceMs = (() => {
  const v = parseInt(params.get("xrNoPoseGraceMs") || "3000", 10);
  return (Number.isFinite(v) && v >= 0) ? v : 3000;
})();
const xrStartOnFirstPose = (params.get("xrStartOnFirstPose") || "0") === "1";
const xrAnchorToFirstPose = (() => {
  const raw = params.get("xrAnchorToFirstPose");
  if (raw == null) return layout === "xrwall";
  return raw === "1";
})();
const xrAnchorMode = (() => {
  const raw = params.get("xrAnchorMode");
  if (raw != null) return String(raw).toLowerCase() === "trial" ? "trial" : "session";
  return xrSessionMode === "immersive-ar" ? "trial" : "session";
})();
const xrPoseStabilityGateMs = (() => {
  const raw = params.get("xrPoseStabilityGateMs");
  if (raw != null) {
    const v = parseInt(raw, 10);
    return (Number.isFinite(v) && v >= 0) ? v : 0;
  }
  return xrSessionMode === "immersive-ar" ? 750 : 0;
})();
const xrPoseStabilityPosTolM = (() => {
  const raw = params.get("xrPoseStabilityPosTolM");
  if (raw != null) {
    const v = parseFloat(raw);
    return (Number.isFinite(v) && v >= 0) ? v : 0.08;
  }
  return 0.08;
})();
const xrPoseStabilityYawTolDeg = (() => {
  const raw = params.get("xrPoseStabilityYawTolDeg");
  if (raw != null) {
    const v = parseFloat(raw);
    return (Number.isFinite(v) && v >= 0) ? v : 4.0;
  }
  return 4.0;
})();
provenanceInfo.xr_anchor_mode = xrAnchorMode;
provenanceInfo.xr_pose_stability_gate_ms = xrPoseStabilityGateMs;
provenanceInfo.xr_pose_stability_pos_tol_m = xrPoseStabilityPosTolM;
provenanceInfo.xr_pose_stability_yaw_tol_deg = xrPoseStabilityYawTolDeg;

// Session-order control for ABBA/BAAB/randomized protocols
const enforceOrder = (params.get("enforceOrder") || "0") === "1";
const orderMode = (params.get("orderMode") || "none").toLowerCase(); // none|abba|baab|abba_baab|baab_abba|randomized
const orderIndex = parseInt(params.get("orderIndex") || "0", 10);
const assignedApi = (params.get("assignedApi") || "").toLowerCase();
const orderSeed = params.get("orderSeed") || null;
const pinGpu = (params.get("pinGpu") || "0") === "1";
const sessionGroup = params.get("sessionGroup") || "default";

function orderPatternForMode(mode) {
  if (mode === "abba") return ["webgl2", "webgpu", "webgpu", "webgl2"];
  if (mode === "baab") return ["webgpu", "webgl2", "webgl2", "webgpu"];
  if (mode === "abba_baab") {
    return ["webgl2", "webgpu", "webgpu", "webgl2", "webgpu", "webgl2", "webgl2", "webgpu"];
  }
  if (mode === "baab_abba") {
    return ["webgpu", "webgl2", "webgl2", "webgpu", "webgl2", "webgpu", "webgpu", "webgl2"];
  }
  return null;
}

function expectedApiForOrder(mode, index) {
  if (!Number.isFinite(index) || index < 1) return null;
  const pattern = orderPatternForMode(mode);
  if (!pattern || !pattern.length) return null;
  return pattern[(index - 1) % pattern.length] || null;
}

function enforceOrderControls(apiName) {
  if (!enforceOrder) return;
  if (orderMode === "abba" || orderMode === "baab" || orderMode === "abba_baab" || orderMode === "baab_abba") {
    const expected = expectedApiForOrder(orderMode, orderIndex);
    if (!expected) {
      throw new Error(`Invalid order controls: orderMode=${orderMode}, orderIndex=${orderIndex}`);
    }
    if (expected !== apiName) {
      throw new Error(`Order control violation: expected ${expected} at index ${orderIndex}, got ${apiName}`);
    }
    return;
  }
  if (orderMode === "randomized") {
    if (!assignedApi) throw new Error("Order control violation: randomized mode requires assignedApi");
    if (assignedApi !== apiName) {
      throw new Error(`Order control violation: assignedApi=${assignedApi}, got ${apiName}`);
    }
    return;
  }
  throw new Error(`Order control violation: unsupported orderMode=${orderMode}`);
}

function enforcePinnedGpuIdentity(identity) {
  if (!pinGpu) return;
  const key = `webxr_harness_gpu_pin_${sessionGroup}`;
  let previous = null;
  try {
    previous = localStorage.getItem(key);
    if (!previous) {
      localStorage.setItem(key, identity);
      return;
    }
  } catch (e) {
    throw new Error(`pinGpu enabled but localStorage unavailable: ${e?.message || e}`);
  }
  if (previous !== identity) {
    throw new Error(`Pinned GPU mismatch for sessionGroup=${sessionGroup}: expected "${previous}", got "${identity}"`);
  }
}

function mulberry32(seed_) {
  let a = seed_ >>> 0;
  return function() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace(arr, seed_) {
  const rng = mulberry32(seed_);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

const canvas = document.querySelector("canvas");
const btn = document.getElementById("xr-button");
const status = document.getElementById("status");

let gl=null;
let renderer=null;
let xrSession=null;
let xrRefSpace=null;
let xrRequesting=false;
let xrResultFlushedForSession=false;

let sceneInfo=null;
let envInfo=null;
let resultsCanvas=[];
let resultsXR=[];
let canvasRunInProgress=false;
let canvasRunScheduled=false;
let webglContextLostInfo = null;
let webglContextLostCount = 0;
let webglContextRestoredCount = 0;
let webglContextLostFirstAtMs = null;
let webglContextLostLastAtMs = null;
let webglContextLostEvents = [];
const WEBGL_CONTEXT_LOST_RING = 5;
let webglContextIsLost = false;
let canvasAbortReason = null;
let activeCanvasTrialReject = null;
let xrSuiteTraceClosed = false;
let xrTraceStartMark = null;
let manualCanvasStartButton = null;
const globalJsErrors = [];
const globalJsUnhandledRejections = [];
const GLOBAL_JS_ERROR_RING = 20;
const ERROR_RING_CAPACITY = {
  js_errors: GLOBAL_JS_ERROR_RING,
  js_unhandled_rejections: GLOBAL_JS_ERROR_RING,
  webgl_context_lost_events: WEBGL_CONTEXT_LOST_RING
};
let globalErrorListenersInstalled = false;
let batteryManager = null;
let batteryListenerInstalled = false;
let batteryStartSnapshot = null;
let batteryLatestSnapshot = null;
let batteryError = null;
let connectionInfo = null;
let connectionListenerInstalled = false;
let connectionChangeCount = 0;
const canvasCheckpointEnabled = (params.get("canvasCheckpoint") || "1") !== "0";
const canvasCrashDiagnosticsEnabled = (params.get("canvasCrashDiagnostics") || "1") !== "0";
const CANVAS_CRASH_EVENT_RING = 12;
let _resolvedCanvasOutFilename = null;
let canvasCrashDiagnosticsState = null;
let canvasCrashLifecycleInstalled = false;

function log(msg){ status.textContent = msg; console.log(msg); }

function withSuffixBeforeJsonl(name, suffix) {
  const raw = String(name || "");
  if (raw.toLowerCase().endsWith(".jsonl")) return `${raw.slice(0, -6)}${suffix}.jsonl`;
  return `${raw}${suffix}`;
}

function canvasOutFilename() {
  if (_resolvedCanvasOutFilename) return _resolvedCanvasOutFilename;
  _resolvedCanvasOutFilename = resolveOutputFilename(outFileTemplate, "results_webgl");
  return _resolvedCanvasOutFilename;
}

function canvasCheckpointKey() {
  return `webxr_harness_canvas_partial::webgl2::${suiteId}::${runId}`;
}

function canvasCrashDiagnosticsKey() {
  return `webxr_harness_canvas_diag::webgl2::${suiteId}::${runId}`;
}

function canvasCrashDiagnosticsFilename() {
  const raw = String(canvasOutFilename() || "");
  if (raw.toLowerCase().endsWith(".jsonl")) return `${raw.slice(0, -6)}__crash_diagnostics.json`;
  return `${raw}__crash_diagnostics.json`;
}

function clearCanvasCheckpoint() {
  if (!canvasCheckpointEnabled) return;
  try {
    localStorage.removeItem(canvasCheckpointKey());
  } catch (_) {}
}

function clearCanvasCrashDiagnostics() {
  if (!canvasCrashDiagnosticsEnabled) return;
  canvasCrashDiagnosticsState = null;
  try {
    localStorage.removeItem(canvasCrashDiagnosticsKey());
  } catch (_) {}
}

function summarizeCrashEnv() {
  return {
    visibilityState: document.visibilityState,
    online: navigator.onLine,
    dpr: Number.isFinite(window.devicePixelRatio) ? window.devicePixelRatio : null,
    canvas_css: { w: canvas?.clientWidth ?? null, h: canvas?.clientHeight ?? null },
    canvas_px: { w: canvas?.width ?? null, h: canvas?.height ?? null },
    gpu: envInfo?.gpu || null,
    gpu_identity: envInfo?.gpu_identity || null,
    browser: envInfo?.browser || browserLabel || null,
    harness_version: envInfo?.harness_version || provenanceInfo.harness_version || null,
    harness_commit: envInfo?.harness_commit || provenanceInfo.harness_commit || null,
    canvasScaleFactor,
    xrScaleFactor
  };
}

function writeCanvasCrashDiagnostics() {
  if (!canvasCrashDiagnosticsEnabled || !canvasCrashDiagnosticsState) return;
  try {
    localStorage.setItem(canvasCrashDiagnosticsKey(), JSON.stringify(canvasCrashDiagnosticsState));
  } catch (_) {}
}

function updateCanvasCrashDiagnostics(patch = {}) {
  if (!canvasCrashDiagnosticsEnabled || !canvasCrashDiagnosticsState) return;
  canvasCrashDiagnosticsState = {
    ...canvasCrashDiagnosticsState,
    ...patch,
    saved_at_iso: new Date().toISOString(),
    saved_at_perf_ms: performance.now(),
    env_snapshot: summarizeCrashEnv()
  };
  writeCanvasCrashDiagnostics();
}

function pushCanvasCrashLifecycleEvent(type, extra = {}) {
  if (!canvasCrashDiagnosticsEnabled || !canvasCrashDiagnosticsState) return;
  const events = Array.isArray(canvasCrashDiagnosticsState.lifecycle_events)
    ? canvasCrashDiagnosticsState.lifecycle_events.slice(-CANVAS_CRASH_EVENT_RING + 1)
    : [];
  events.push({
    type,
    at_iso: new Date().toISOString(),
    at_perf_ms: performance.now(),
    visibilityState: document.visibilityState,
    ...extra
  });
  canvasCrashDiagnosticsState.lifecycle_events = events;
  updateCanvasCrashDiagnostics({});
}

function startCanvasCrashDiagnostics(expectedCount = null) {
  if (!canvasCrashDiagnosticsEnabled) return;
  canvasCrashDiagnosticsState = {
    schema_version: SCHEMA_VERSION,
    api: "webgl2",
    mode: "canvas_crash_diagnostics",
    run_id: runId,
    suite_id: suiteId,
    filename: canvasCrashDiagnosticsFilename(),
    results_filename: canvasOutFilename(),
    expected_count: Number.isFinite(expectedCount) ? expectedCount : null,
    completed_count: Array.isArray(resultsCanvas) ? resultsCanvas.length : 0,
    status: "running",
    phase: "suite_start",
    current_condition: null,
    last_completed_condition: null,
    abort_reason: null,
    lifecycle_events: []
  };
  pushCanvasCrashLifecycleEvent("suite_start");
}

function persistCanvasCheckpoint(expectedCount = null) {
  if (!canvasCheckpointEnabled) return;
  try {
    const payload = {
      schema_version: SCHEMA_VERSION,
      api: "webgl2",
      mode: "canvas",
      run_id: runId,
      suite_id: suiteId,
      filename: canvasOutFilename(),
      expected_count: Number.isFinite(expectedCount) ? expectedCount : null,
      completed_count: Array.isArray(resultsCanvas) ? resultsCanvas.length : 0,
      saved_at_iso: new Date().toISOString(),
      records: Array.isArray(resultsCanvas) ? resultsCanvas : []
    };
    localStorage.setItem(canvasCheckpointKey(), JSON.stringify(payload));
  } catch (_) {}
}

function offerRecoveredCanvasCheckpoint() {
  if (!canvasCheckpointEnabled) return;
  let raw = null;
  try {
    raw = localStorage.getItem(canvasCheckpointKey());
  } catch (_) {}
  if (!raw) return;

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {}
  if (!parsed || !Array.isArray(parsed.records) || parsed.records.length < 1) {
    clearCanvasCheckpoint();
    return;
  }

  const recoveredJsonl = parsed.records.map((o) => JSON.stringify(o)).join("\n") + "\n";
  const expectedCount = Number(parsed.expected_count);
  const completedCount = Number(parsed.completed_count);
  const label = Number.isFinite(expectedCount) && expectedCount > 0
    ? `Recovered partial canvas results (${completedCount}/${expectedCount})`
    : `Recovered partial canvas results (${parsed.records.length})`;
  const recoveredFilename = withSuffixBeforeJsonl(
    (typeof parsed.filename === "string" && parsed.filename) ? parsed.filename : canvasOutFilename(),
    "__partial_recovered"
  );
  queueDownload(recoveredJsonl, recoveredFilename, label);
  log(`Recovered partial canvas checkpoint from previous interrupted run (records=${parsed.records.length}).`);
  clearCanvasCheckpoint();
}

function offerRecoveredCanvasCrashDiagnostics() {
  if (!canvasCrashDiagnosticsEnabled) return;
  let raw = null;
  try {
    raw = localStorage.getItem(canvasCrashDiagnosticsKey());
  } catch (_) {}
  if (!raw) return;

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {}
  if (!parsed || typeof parsed !== "object") {
    clearCanvasCrashDiagnostics();
    return;
  }
  if (parsed.status === "completed") {
    clearCanvasCrashDiagnostics();
    return;
  }

  const filename = (typeof parsed.filename === "string" && parsed.filename)
    ? parsed.filename
    : canvasCrashDiagnosticsFilename();
  queueDownload(JSON.stringify(parsed, null, 2) + "\n", filename, "Recovered canvas crash diagnostics", "application/json");
  log(`Recovered canvas crash diagnostics (phase=${parsed.phase || "unknown"}, completed=${parsed.completed_count ?? 0}/${parsed.expected_count ?? "?"}).`);
  clearCanvasCrashDiagnostics();
}

function installCanvasCrashLifecycleListeners() {
  if (canvasCrashLifecycleInstalled || !canvasCrashDiagnosticsEnabled) return;
  canvasCrashLifecycleInstalled = true;

  document.addEventListener("visibilitychange", () => {
    pushCanvasCrashLifecycleEvent("visibilitychange");
  });
  window.addEventListener("pagehide", (event) => {
    pushCanvasCrashLifecycleEvent("pagehide", { persisted: !!event.persisted });
  });
  window.addEventListener("pageshow", (event) => {
    pushCanvasCrashLifecycleEvent("pageshow", { persisted: !!event.persisted });
  });
  window.addEventListener("beforeunload", () => {
    pushCanvasCrashLifecycleEvent("beforeunload");
  });
}

function getNativeDevicePixelRatio() {
  const dpr = Number(window.devicePixelRatio || 1);
  return (Number.isFinite(dpr) && dpr > 0) ? dpr : 1;
}

function getAppliedCanvasDpr() {
  return getNativeDevicePixelRatio() * canvasScaleFactor;
}

function applyCanvasResolutionScale() {
  const appliedDpr = getAppliedCanvasDpr();
  canvas.width = Math.max(1, Math.floor(canvas.clientWidth * appliedDpr));
  canvas.height = Math.max(1, Math.floor(canvas.clientHeight * appliedDpr));
  return appliedDpr;
}

function updateCanvasScaleEnvDiagnostics(appliedDpr = getAppliedCanvasDpr()) {
  if (!envInfo) return;
  const nativeDpr = getNativeDevicePixelRatio();
  const safeNative = nativeDpr > 0 ? nativeDpr : 1;
  envInfo.dpr = nativeDpr;
  envInfo.dpr_canvas = appliedDpr;
  envInfo.canvas_css = { w: canvas.clientWidth, h: canvas.clientHeight };
  envInfo.canvas_px = { w: canvas.width, h: canvas.height };
  envInfo.canvasScaleFactor = canvasScaleFactor;
  envInfo.canvas_scale_factor_requested = canvasScaleFactor;
  envInfo.canvas_scale_factor_applied = appliedDpr / safeNative;
}

function resyncCanvasSurfaceForRun() {
  const appliedDpr = applyCanvasResolutionScale();
  if (gl) gl.viewport(0, 0, canvas.width, canvas.height);
  // WebGL consumes view/projection per-draw via drawForView(...).
  // Keep resize sync focused on surface state to avoid renderer API coupling.
  updateCanvasScaleEnvDiagnostics(appliedDpr);
  return appliedDpr;
}

function ensureManualCanvasStartButton() {
  if (manualCanvasStartButton) return manualCanvasStartButton;
  const header = document.querySelector("header");
  if (!header) return null;
  const b = document.createElement("button");
  b.id = "start-suite-button";
  b.textContent = "Start Canvas Suite";
  b.disabled = true;
  b.addEventListener("click", () => startCanvasSuiteNow("manual_button"));
  if (status && status.parentElement === header) {
    header.insertBefore(b, status);
  } else {
    header.appendChild(b);
  }
  manualCanvasStartButton = b;
  return b;
}

function setManualCanvasStartButtonState({ visible, enabled, text } = {}) {
  const b = ensureManualCanvasStartButton();
  if (!b) return;
  if (typeof text === "string" && text) b.textContent = text;
  if (typeof enabled === "boolean") b.disabled = !enabled;
  if (typeof visible === "boolean") b.style.display = visible ? "" : "none";
}

function traceField(v) {
  if (v == null) return "-";
  return String(v).replace(/[|\s]/g, "_");
}

function traceName(kind, meta={}) {
  const mode = meta.mode || runMode;
  const test = meta.testId || "-";
  const trial = meta.trial ?? "-";
  const idx = meta.index ?? "-";
  const total = meta.total ?? "-";
  return `TRACE|${traceField(kind)}|run=${traceField(runId)}|suite=${traceField(suiteId)}|api=${apiLabel}|mode=${traceField(mode)}|test=${traceField(test)}|trial=${traceField(trial)}|idx=${traceField(idx)}|n=${traceField(total)}`;
}

function traceMark(kind, meta={}) {
  if (!traceMarkers) return null;
  const name = traceName(kind, meta);
  try {
    performance.mark(name);
    console.timeStamp?.(name);
  } catch (_) {}
  return name;
}

function traceMeasure(kind, startMark, endMark, meta={}) {
  if (!traceMarkers || !startMark || !endMark) return null;
  const name = traceName(kind, meta);
  try {
    performance.measure(name, startMark, endMark);
  } catch (_) {}
  return name;
}

function closeXRSuiteTrace(kind, meta={}) {
  if (xrSuiteTraceClosed) return;
  xrSuiteTraceClosed = true;
  traceMark(kind, { mode: "xr", ...meta });
}

const traceOverlayEl = (() => {
  if (!traceOverlay) return null;
  const el = document.createElement("div");
  el.id = "trace-overlay";
  el.style.cssText = [
    "position:fixed",
    "left:12px",
    "top:12px",
    "z-index:999999",
    "max-width:78vw",
    "padding:8px 10px",
    "border-radius:10px",
    "background:rgba(0,0,0,0.65)",
    "color:#fff",
    "font:11px/1.35 system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
    "pointer-events:none",
    "white-space:pre"
  ].join(";");
  document.body.appendChild(el);
  return el;
})();

function updateTraceOverlay(extra="") {
  if (!traceOverlayEl) return;
  const lines = [
    `runId: ${runId}`,
    `suiteId: ${suiteId}`,
    `api: ${apiLabel}`
  ];
  if (extra) lines.push(extra);
  traceOverlayEl.textContent = lines.join("\n");
}

updateTraceOverlay();

function getConnectionObject() {
  return navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
}

function snapshotBatteryState(manager) {
  if (!manager) return null;
  return {
    level_pct: Number.isFinite(manager.level) ? Number((manager.level * 100).toFixed(2)) : null,
    charging: (typeof manager.charging === "boolean") ? manager.charging : null,
    charging_time_s: Number.isFinite(manager.chargingTime) ? manager.chargingTime : null,
    discharging_time_s: Number.isFinite(manager.dischargingTime) ? manager.dischargingTime : null,
    at_iso: new Date().toISOString(),
    at_perf_ms: performance.now()
  };
}

function refreshConnectionInfo() {
  if (!connectionTelemetry) {
    connectionInfo = null;
    return;
  }
  const c = getConnectionObject();
  if (!c) {
    connectionInfo = null;
    return;
  }
  connectionInfo = {
    effective_type: (typeof c.effectiveType === "string") ? c.effectiveType : null,
    rtt_ms: Number.isFinite(c.rtt) ? c.rtt : null,
    downlink_mbps: Number.isFinite(c.downlink) ? c.downlink : null,
    save_data: (typeof c.saveData === "boolean") ? c.saveData : null,
    type: (typeof c.type === "string") ? c.type : null,
    at_iso: new Date().toISOString(),
    at_perf_ms: performance.now()
  };
}

function refreshBatteryInfo() {
  if (!batteryManager) return;
  batteryLatestSnapshot = snapshotBatteryState(batteryManager);
  if (!batteryStartSnapshot) batteryStartSnapshot = batteryLatestSnapshot;
}

function updateRuntimeTelemetryEnvDiagnostics() {
  if (!envInfo) return;
  envInfo.battery_telemetry_requested = batteryTelemetry;
  envInfo.connection_telemetry_requested = connectionTelemetry;
  envInfo.battery_api_available = !!batteryManager;
  envInfo.connection_api_available = !!getConnectionObject();
  envInfo.online = navigator.onLine;
  envInfo.connection = connectionInfo;
  envInfo.connection_change_count = connectionChangeCount;
  envInfo.battery = {
    start: batteryStartSnapshot,
    latest: batteryLatestSnapshot,
    error: batteryError
  };
}

async function initRuntimeTelemetry() {
  refreshConnectionInfo();
  if (connectionTelemetry && !connectionListenerInstalled) {
    const c = getConnectionObject();
    if (c && typeof c.addEventListener === "function") {
      c.addEventListener("change", () => {
        connectionChangeCount++;
        refreshConnectionInfo();
        updateRuntimeTelemetryEnvDiagnostics();
      });
      connectionListenerInstalled = true;
    }
  }

  if (!batteryTelemetry) {
    updateRuntimeTelemetryEnvDiagnostics();
    return;
  }
  if (!navigator.getBattery || typeof navigator.getBattery !== "function") {
    batteryError = "battery_api_unavailable";
    updateRuntimeTelemetryEnvDiagnostics();
    return;
  }
  try {
    batteryManager = await navigator.getBattery();
    refreshBatteryInfo();
    if (!batteryListenerInstalled && batteryManager && typeof batteryManager.addEventListener === "function") {
      const onBatteryChange = () => {
        refreshBatteryInfo();
        updateRuntimeTelemetryEnvDiagnostics();
      };
      batteryManager.addEventListener("chargingchange", onBatteryChange);
      batteryManager.addEventListener("levelchange", onBatteryChange);
      batteryManager.addEventListener("chargingtimechange", onBatteryChange);
      batteryManager.addEventListener("dischargingtimechange", onBatteryChange);
      batteryListenerInstalled = true;
    }
  } catch (e) {
    batteryError = String(e?.message || e);
  }
  updateRuntimeTelemetryEnvDiagnostics();
}

function snapshotEnvInfo() {
  if (!envInfo) return null;
  try {
    refreshConnectionInfo();
    refreshBatteryInfo();
    updateRuntimeTelemetryEnvDiagnostics();
  } catch (_) {}
  try {
    if (typeof structuredClone === "function") return structuredClone(envInfo);
  } catch (_) {}
  try { return JSON.parse(JSON.stringify(envInfo)); } catch (_) {}
  return envInfo;
}

function currentBenchPhase() {
  if (xrSession || xrActive) return "xr";
  if (canvasRunInProgress) return "canvas";
  return "idle";
}

function webglContextLostReasonString() {
  if (webglContextLostCount > 0) return `WebGL context lost (count=${webglContextLostCount})`;
  if (!webglContextLostInfo) return null;
  return "WebGL context lost";
}

function rejectActiveCanvasTrial(err) {
  const rejectFn = activeCanvasTrialReject;
  if (!rejectFn) return;
  activeCanvasTrialReject = null;
  try { rejectFn(err instanceof Error ? err : new Error(String(err))); } catch (_) {}
}

function pushRingSample(arr, sample, maxSize) {
  arr.push(sample);
  if (arr.length > maxSize) arr.shift();
}

function updateGlobalErrorEnvDiagnostics() {
  if (!envInfo) return;
  envInfo.js_errors = globalJsErrors;
  envInfo.js_unhandled_rejections = globalJsUnhandledRejections;
}

function installGlobalErrorListeners() {
  if (globalErrorListenersInstalled) return;
  window.addEventListener("error", (e) => {
    const err = e?.error;
    const sample = {
      t_ms: performance.now(),
      at_iso: new Date().toISOString(),
      name: (typeof err?.name === "string") ? err.name : null,
      message: (typeof err?.message === "string")
        ? err.message
        : (typeof e?.message === "string" ? e.message : String(err ?? "unknown")),
      source: (typeof e?.filename === "string") ? e.filename : null,
      lineno: (typeof e?.lineno === "number" && Number.isFinite(e.lineno)) ? e.lineno : null,
      colno: (typeof e?.colno === "number" && Number.isFinite(e.colno)) ? e.colno : null
    };
    pushRingSample(globalJsErrors, sample, GLOBAL_JS_ERROR_RING);
    updateGlobalErrorEnvDiagnostics();
    try { console.warn("Global JS error:", err || e); } catch (_) {}
  });
  window.addEventListener("unhandledrejection", (e) => {
    const reason = e?.reason;
    const sample = {
      t_ms: performance.now(),
      at_iso: new Date().toISOString(),
      name: (typeof reason?.name === "string") ? reason.name : null,
      message: (typeof reason?.message === "string") ? reason.message : String(reason ?? "unknown")
    };
    pushRingSample(globalJsUnhandledRejections, sample, GLOBAL_JS_ERROR_RING);
    updateGlobalErrorEnvDiagnostics();
    try { console.warn("Unhandled promise rejection:", reason); } catch (_) {}
  });
  globalErrorListenersInstalled = true;
}

function updateWebGLEnvDiagnostics() {
  if (!envInfo) return;
  envInfo.webgl = envInfo.webgl || {};
  envInfo.webgl.context_lost_count = webglContextLostCount;
  envInfo.webgl.context_restored_count = webglContextRestoredCount;
  envInfo.webgl.context_lost_first_at_ms = webglContextLostFirstAtMs;
  envInfo.webgl.context_lost_last_at_ms = webglContextLostLastAtMs;
  envInfo.webgl.context_lost_events = webglContextLostEvents;
  envInfo.webgl.context_is_lost = webglContextIsLost;
  // Backward-compatible top-level field retained for older tooling.
  envInfo.context_lost = webglContextLostInfo;
  updateGlobalErrorEnvDiagnostics();
}

function updateXRPoseStabilityEnvDiagnostics() {
  if (!envInfo) return;
  envInfo.xr_pose_stability_gate_ms_requested = xrPoseStabilityGateMs;
  envInfo.xr_pose_stability_pos_tol_m_requested = xrPoseStabilityPosTolM;
  envInfo.xr_pose_stability_yaw_tol_deg_requested = xrPoseStabilityYawTolDeg;
  envInfo.xr_pose_stability_wait_ms = xrPoseStabilityWaitMs;
  envInfo.xr_pose_stability_position_span_m = xrPoseStabilityPositionSpanM;
  envInfo.xr_pose_stability_yaw_span_deg = xrPoseStabilityYawSpanDeg;
  envInfo.xr_pose_stability_achieved = xrPoseStabilityGateMs <= 0
    ? true
    : !!(xrPoseStabilityWaitMs != null && xrPoseStabilityPositionSpanM != null && xrPoseStabilityYawSpanDeg != null);
}


// HUD overlay element (used for both canvas and XR; XR requires dom-overlay support to be visible in-headset)
const hudEl = document.createElement("div");
hudEl.id = "bench-hud";
hudEl.style.cssText = [
  "position:fixed",
  "left:12px",
  "top:52px",
  "z-index:999999",
  "max-width:70vw",
  "padding:8px 10px",
  "border-radius:10px",
  "background:rgba(0,0,0,0.55)",
  "color:#fff",
  "font:12px/1.35 system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
  "pointer-events:none",
  "white-space:pre",
  "display:none"
].join(";");
document.body.appendChild(hudEl);

let _hudTimer = null;
function hudShow() { if (hudEnabled) hudEl.style.display = "block"; }
function hudHide() { hudEl.style.display = "none"; }
function hudSet(text) { if (hudEnabled) hudEl.textContent = text; }
function hudStartAuto(getTextFn) {
  if (!hudEnabled) return;
  hudShow();
  const period = Math.round(1000 / hudHz);
  if (_hudTimer) clearInterval(_hudTimer);
  _hudTimer = setInterval(() => {
    try { hudSet(getTextFn()); } catch (_) {}
  }, period);
  try { hudSet(getTextFn()); } catch (_) {}
}
function hudStopAuto() {
  if (_hudTimer) clearInterval(_hudTimer);
  _hudTimer = null;
  hudHide();
}


function downloadTextAuto(text, filename, mime="application/jsonl") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 2500);
}

const _pendingDownloads = []; // {label, filename, text, mime, summary}
let _resultsPanelEl = null;

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    // Fallback: select in a hidden textarea
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return !!ok;
    } catch (_) {}
  }
  return false;
}

function ensureResultsPanel() {
  if (_resultsPanelEl) return _resultsPanelEl;

  const panel = document.createElement("div");
  panel.id = "resultsPanel";
  panel.style.position = "fixed";
  panel.style.left = "12px";
  panel.style.right = "12px";
  panel.style.bottom = "12px";
  panel.style.zIndex = "9999";
  panel.style.padding = "12px";
  panel.style.border = "1px solid rgba(255,255,255,0.18)";
  panel.style.borderRadius = "12px";
  panel.style.background = "rgba(0,0,0,0.75)";
  panel.style.backdropFilter = "blur(10px)";
  panel.style.color = "#fff";
  panel.style.fontSize = "13px";
  panel.style.maxHeight = "calc(100vh - 24px)";
  panel.style.overflow = "hidden";
  panel.style.display = "none";

  panel.innerHTML = `
    <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:8px;">
      <div style="font-weight:600;">Results ready</div>
      <button id="rpClose" style="padding:6px 8px; border-radius:10px;">Close</button>
    </div>
    <div id="rpSummary" style="margin-bottom:8px; font-size:12px; opacity:0.92;">Session: no files queued.</div>
    <div id="rpBody" style="display:flex; flex-direction:column; gap:10px; overflow:auto; max-height:55vh;"></div>
    <div id="rpFooter" style="margin-top:10px; opacity:0.85;"></div>
  `;
  document.body.appendChild(panel);

  panel.querySelector("#rpClose").addEventListener("click", () => {
    panel.style.display = "none";
  });

  _resultsPanelEl = panel;
  return panel;
}

function summarizeQueuedJsonl(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  let parsed = 0;
  let parseErrors = 0;
  let completed = 0;
  let aborted = 0;
  let expected = 0;
  let maxConditionIndex = 0;
  let firstAbortReason = "";
  const abortCodes = new Set();

  for (const line of lines) {
    let rec = null;
    try {
      rec = JSON.parse(line);
      parsed++;
    } catch (_) {
      parseErrors++;
      continue;
    }
    if (!rec || typeof rec !== "object") continue;

    const cc = Number(rec.condition_count);
    if (Number.isFinite(cc) && cc > expected) expected = cc;
    const ci = Number(rec.condition_index);
    if (Number.isFinite(ci) && ci > maxConditionIndex) maxConditionIndex = ci;

    const abortCode = (typeof rec.abort_code === "string") ? rec.abort_code.trim() : "";
    const isAborted = rec.aborted === true || !!abortCode;
    if (isAborted) {
      aborted++;
      if (abortCode) abortCodes.add(abortCode);
      if (!firstAbortReason && typeof rec.abort_reason === "string" && rec.abort_reason.trim()) {
        firstAbortReason = rec.abort_reason.trim();
      }
    } else {
      completed++;
    }
  }

  if (expected < 1 && maxConditionIndex > 0) expected = maxConditionIndex;
  const codeList = Array.from(abortCodes);

  let status = "UNKNOWN";
  let details = "";
  if (parseErrors > 0) {
    status = "FAIL";
    details = `JSON parse errors=${parseErrors}, parsed=${parsed}`;
  } else if (aborted > 0) {
    status = "FAIL";
    const codeText = codeList.length ? ` codes=${codeList.join("|")}` : "";
    details = `aborts=${aborted}${codeText}, completed=${completed}${expected > 0 ? `/${expected}` : ""}`;
    if (firstAbortReason) details += ` (${firstAbortReason})`;
  } else if (parsed === 0) {
    status = "INCOMPLETE";
    details = "No JSON records found.";
  } else if (expected > 0 && completed < expected) {
    status = "INCOMPLETE";
    details = `completed=${completed}/${expected}, no explicit abort record`;
  } else {
    status = "PASS";
    details = `completed=${completed}${expected > 0 ? `/${expected}` : ""}, aborts=0`;
  }

  return {
    status,
    details,
    parsed,
    parseErrors,
    completed,
    expected: expected > 0 ? expected : null,
    aborted,
    abortCodes: codeList
  };
}

function renderResultsPanel() {
  const panel = ensureResultsPanel();
  const body = panel.querySelector("#rpBody");
  const footer = panel.querySelector("#rpFooter");
  const summaryEl = panel.querySelector("#rpSummary");
  body.innerHTML = "";

  const counts = { PASS: 0, FAIL: 0, INCOMPLETE: 0, UNKNOWN: 0 };

  for (const item of _pendingDownloads) {
    const status = item.summary?.status || "UNKNOWN";
    if (status === "PASS" || status === "FAIL" || status === "INCOMPLETE") counts[status]++;
    else counts.UNKNOWN++;

    const row = document.createElement("div");
    row.style.display = "grid";
    row.style.gridTemplateColumns = "minmax(0,1fr) auto";
    row.style.gap = "8px";
    row.style.alignItems = "start";
    if ((panel.clientWidth || window.innerWidth || 0) < 560) {
      row.style.gridTemplateColumns = "1fr";
    }

    const label = document.createElement("div");
    label.style.display = "flex";
    label.style.flexDirection = "column";
    label.style.gap = "4px";
    label.style.opacity = "0.95";
    label.style.minWidth = "0";

    const top = document.createElement("div");
    top.style.display = "flex";
    top.style.alignItems = "center";
    top.style.justifyContent = "flex-start";
    top.style.flexWrap = "wrap";
    top.style.gap = "8px";

    const name = document.createElement("div");
    name.textContent = `${item.label} — ${item.filename}`;
    name.style.minWidth = "0";
    name.style.overflowWrap = "anywhere";
    name.style.wordBreak = "break-word";
    name.style.lineHeight = "1.25";
    name.style.flex = "1 1 260px";

    const badge = document.createElement("span");
    badge.textContent = status;
    badge.style.fontSize = "11px";
    badge.style.fontWeight = "700";
    badge.style.padding = "2px 8px";
    badge.style.borderRadius = "999px";
    badge.style.border = "1px solid rgba(255,255,255,0.25)";
    if (status === "PASS") {
      badge.style.background = "rgba(72, 188, 120, 0.30)";
      badge.style.color = "#d7ffe5";
    } else if (status === "FAIL") {
      badge.style.background = "rgba(214, 80, 80, 0.30)";
      badge.style.color = "#ffdede";
    } else if (status === "INCOMPLETE") {
      badge.style.background = "rgba(232, 177, 52, 0.30)";
      badge.style.color = "#fff0cc";
    } else {
      badge.style.background = "rgba(180, 180, 180, 0.25)";
      badge.style.color = "#e6e6e6";
    }

    const details = document.createElement("div");
    details.style.opacity = "0.82";
    details.style.fontSize = "12px";
    details.textContent = item.summary?.details || "No run summary.";

    top.appendChild(name);
    top.appendChild(badge);
    label.appendChild(top);
    label.appendChild(details);

    const actions = document.createElement("div");
    actions.style.display = "flex";
    actions.style.flexDirection = "column";
    actions.style.gap = "6px";
    actions.style.alignSelf = "start";

    const btnDl = document.createElement("button");
    btnDl.textContent = "Download";
    btnDl.style.padding = "6px 10px";
    btnDl.style.borderRadius = "10px";
    btnDl.style.whiteSpace = "nowrap";
    btnDl.addEventListener("click", () => {
      // User gesture => Safari will actually save it
      downloadTextAuto(item.text, item.filename, item.mime);
    });

    const btnCopy = document.createElement("button");
    btnCopy.textContent = "Copy";
    btnCopy.style.padding = "6px 10px";
    btnCopy.style.borderRadius = "10px";
    btnCopy.style.whiteSpace = "nowrap";
    btnCopy.addEventListener("click", async () => {
      const ok = await copyToClipboard(item.text);
      btnCopy.textContent = ok ? "Copied" : "Copy failed";
      setTimeout(()=>btnCopy.textContent="Copy", 1200);
    });

    actions.appendChild(btnDl);
    actions.appendChild(btnCopy);
    row.appendChild(label);
    row.appendChild(actions);
    body.appendChild(row);
  }

  const total = _pendingDownloads.length;
  if (summaryEl) {
    summaryEl.textContent =
      `Session: ${total} file(s)  PASS ${counts.PASS}  FAIL ${counts.FAIL}  INCOMPLETE ${counts.INCOMPLETE}` +
      (counts.UNKNOWN ? `  UNKNOWN ${counts.UNKNOWN}` : "");
    if (counts.FAIL > 0) {
      summaryEl.style.color = "#ffdede";
    } else if (counts.INCOMPLETE > 0) {
      summaryEl.style.color = "#fff0cc";
    } else if (counts.PASS > 0) {
      summaryEl.style.color = "#d7ffe5";
    } else {
      summaryEl.style.color = "#ffffff";
    }
  }

  footer.textContent = manualDownload
    ? "Manual download is enabled. Use the buttons above to Download or Copy results."
    : "Automatic downloads are enabled. If you don’t see the file, re-run with manualDownload=1 to force manual downloads.";

  panel.style.display = "block";
}

function queueDownload(text, filename, label="Results", mime="application/jsonl") {
  _pendingDownloads.push({
    label,
    filename,
    text,
    mime,
    summary: summarizeQueuedJsonl(text)
  });
  renderResultsPanel();
}

function downloadText(text, filename, label="Results") {
  if (manualDownload) {
    queueDownload(text, filename, label);
  } else {
    downloadTextAuto(text, filename);
  }
}

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

function computeXRInterTrialPause(prevItem, nextItem) {
  const postIdlePauseMs = Math.max(0, postIdleMs | 0);
  const cooldownPauseMs = Math.max(0, cooldownMs | 0);
  const warmupPauseMs = nextItem ? Math.max(0, warmupMs | 0) : 0;
  const betweenPauseMs = (nextItem && prevItem && nextItem.instances !== prevItem.instances)
    ? Math.max(0, betweenInstancesMs | 0)
    : 0;
  return {
    postIdlePauseMs,
    cooldownPauseMs,
    warmupPauseMs,
    betweenPauseMs,
    totalPauseMs: postIdlePauseMs + cooldownPauseMs + warmupPauseMs + betweenPauseMs
  };
}

function xrOutFilename() {
  return resolveOutputFilename(params.get("outxr") || "", "results_webgl_xr");
}

function flushXRResults(filename=xrOutFilename(), label="Done (XR)") {
  const jsonl = resultsXR.map(o=>JSON.stringify(o)).join("\n") + "\n";
  xrResultFlushedForSession = true;
  resultsXR = [];
  downloadText(jsonl, filename, "XR results");
  if (!manualDownload) {
    // Backup path in case automatic download is blocked by the browser.
    queueDownload(jsonl, filename, "XR results");
  }
  log(`${label}. ${manualDownload ? "Queued" : "Downloaded"} ${filename}`);
}


function clearCanvasBlankOnce() {
  if (!gl) return;
  try {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.flush?.();
  } catch (_) {}
}

let _renderProbeDoneCanvas = false;

function rgba8FromClear(c) {
  return [
    Math.round(Math.max(0, Math.min(1, c[0])) * 255),
    Math.round(Math.max(0, Math.min(1, c[1])) * 255),
    Math.round(Math.max(0, Math.min(1, c[2])) * 255),
    Math.round(Math.max(0, Math.min(1, c[3])) * 255),
  ];
}

// Sample a 3x3 block around center; if any pixel differs from clear, assume something rendered.
// This is intentionally outside measured trials (called before the suite starts).
function ensureCanvasRenderProbe(vp) {
  if (!renderProbe || _renderProbeDoneCanvas || !gl || !renderer) return;
  _renderProbeDoneCanvas = true;

  try {
    // Use a small-ish instance count to ensure something hits the center in most layouts.
    const n = Math.max(1, Math.min(4, instancesList[0] || 1));
    renderer.setInstances(n, spacing, { layout, seed });

    const clear = [1.0, 0.0, 1.0, 1.0]; // magenta
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(clear[0], clear[1], clear[2], clear[3]);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    renderer.drawForView(vp);

    const x = Math.max(0, Math.min(canvas.width - 3, Math.floor(canvas.width / 2) - 1));
    const y = Math.max(0, Math.min(canvas.height - 3, Math.floor(canvas.height / 2) - 1));
    const buf = new Uint8Array(3 * 3 * 4);
    gl.readPixels(x, y, 3, 3, gl.RGBA, gl.UNSIGNED_BYTE, buf);

    const clear8 = rgba8FromClear(clear);
    let diff = 0;
    for (let i=0;i<buf.length;i+=4) {
      const dr = Math.abs(buf[i+0] - clear8[0]);
      const dg = Math.abs(buf[i+1] - clear8[1]);
      const db = Math.abs(buf[i+2] - clear8[2]);
      if (dr + dg + db > 6) { diff++; }
    }
    const rendered_anything = diff > 0;

    envInfo.render_probe_canvas = {
      performed: true,
      rendered_anything,
      sample_px: { x: x+1, y: y+1, w: 3, h: 3 },
      diff_pixels: diff,
      clear_rgba8: clear8,
      first_rgba8: [buf[0], buf[1], buf[2], buf[3]],
    };
    log(`Render probe (canvas): rendered_anything=${rendered_anything} (diff_pixels=${diff})`);
  } catch (e) {
    envInfo.render_probe_canvas = { performed: true, error: String(e) };
    log(`Render probe (canvas) failed: ${e?.message || e}`);
  } finally {
    clearCanvasBlankOnce();
  }
}


function nearestTargetMs(p50) {
  const candidates = [1000/120, 1000/90, 1000/72, 1000/60];
  let best=candidates[0], bestD=Math.abs(p50-best);
  for (const c of candidates) {
    const d=Math.abs(p50-c);
    if (d < bestD) { bestD=d; best=c; }
  }
  return best;
}

function deriveExtras(summary, dts) {
  const fps_effective = summary.frames / (summary.duration_ms / 1000);
  const fps_from_mean = 1000 / summary.mean_ms;
  const target_ms = nearestTargetMs(summary.p50_ms);

  let max_ms = 0;
  let miss_1p5 = 0;
  let miss_2x = 0;
  for (let i=0;i<dts.length;i++) {
    const dt = dts[i];
    if (dt > max_ms) max_ms = dt;
    if (dt > 1.5 * target_ms) miss_1p5++;
    if (dt > 2.0 * target_ms) miss_2x++;
  }

  return {
    fps_effective,
    fps_from_mean,
    target_ms,
    missed_1p5x: miss_1p5,
    missed_2x: miss_2x,
    missed_1p5x_pct: (dts.length ? (miss_1p5 / dts.length) : 0),
    max_frame_ms: max_ms,
    jank_p99_over_p50: summary.p99_ms / summary.p50_ms
  };
}

function summarizeSeries(samples) {
  if (!samples || !samples.length) return null;
  const a = [...samples].sort((x, y) => x - y);
  const n = a.length;
  const q = (p) => a[Math.min(n - 1, Math.floor(p * (n - 1)))];
  const mean = samples.reduce((s, v) => s + v, 0) / n;
  return {
    frames: n,
    mean_ms: mean,
    p50_ms: q(0.50),
    p95_ms: q(0.95),
    p99_ms: q(0.99),
  };
}

function createXRRenderProbeState() {
  return {
    performed: !!renderProbe,
    rendered_anything: null,
    first_frame_px: null,
    readback_allowed: null,
    sampled_pixel_diff: null,
  };
}

async function initGL() {
  const xrCompatibleRequested = (runMode === "xr");
  gl = canvas.getContext("webgl2", {
    antialias: false,
    depth: true,
    powerPreference: "high-performance",
  });
  if (!gl) {
    throw new Error("WebGL2 not available");
  }
  gl.enable(gl.DEPTH_TEST);

  canvas.addEventListener("webglcontextlost", (event) => {
    // Prevent default so the browser can attempt restore.
    event.preventDefault();

    webglContextIsLost = true;
    webglContextLostCount++;
    const t = performance.now();
    if (webglContextLostFirstAtMs == null) webglContextLostFirstAtMs = t;
    webglContextLostLastAtMs = t;

    const phase = currentBenchPhase();
    const eventInfo = {
      t_ms: t,
      at_iso: new Date().toISOString(),
      statusMessage: null,
      phase
    };
    webglContextLostEvents.push(eventInfo);
    if (webglContextLostEvents.length > WEBGL_CONTEXT_LOST_RING) {
      webglContextLostEvents.shift();
    }

    webglContextLostInfo = {
      message: "webglcontextlost",
      phase,
      at_iso: eventInfo.at_iso,
      at_perf_ms: t,
      count: webglContextLostCount
    };
    updateWebGLEnvDiagnostics();

    try { console.warn("WebGL CONTEXT LOST", { webglContextLostCount }); } catch (_) {}

    const reason = webglContextLostReasonString() || "WebGL context lost.";
    if (!canvasAbortReason) canvasAbortReason = reason;
    if (envInfo) envInfo.canvas_abort_reason = canvasAbortReason;

    if (xrSession && !xrAbortReason) {
      xrAbortReason = reason;
      if (envInfo) {
        envInfo.xr_abort_reason = reason;
        if (!Number.isFinite(envInfo.xr_observed_view_count)) envInfo.xr_observed_view_count = 0;
        envInfo.xr_expected_max_views = MAX_COMPARABLE_XR_VIEWS;
        updateWebGLEnvDiagnostics();
      }
      const last = resultsXR[resultsXR.length - 1];
      if (!last || last.aborted !== true) {
        resultsXR.push(buildXRAbortRecord({
          abortCode: "webgl_context_lost",
          abortReason: reason,
          observedViewCount: Number.isFinite(envInfo?.xr_observed_view_count) ? envInfo.xr_observed_view_count : 0
        }));
      }
      if (!xrResultFlushedForSession) {
        flushXRResults(xrOutFilename(), "XR aborted (WebGL context lost)");
      }
      xrActive = false;
      Promise.resolve(xrSession.end()).catch(()=>{});
    }

    log(`${reason}.`);
    const err = new Error(canvasAbortReason);
    err.abortCode = "webgl_context_lost";
    err.partial_trial = { elapsed_ms: null, frames_collected: 0 };
    rejectActiveCanvasTrial(err);
  }, false);
  canvas.addEventListener("webglcontextrestored", () => {
    webglContextIsLost = false;
    webglContextRestoredCount++;
    updateWebGLEnvDiagnostics();
    try { console.warn("WebGL CONTEXT RESTORED", { webglContextRestoredCount }); } catch (_) {}
    try { log("WebGL context restored."); } catch (_) {}
  }, false);

  renderer = new WebGLMeshRenderer(gl);
  renderer.setDebugColor(debugColor);

  const scene = await loadGLBMesh(modelUrl);
  renderer.setMesh(scene);

  const ext = gl.getExtension("WEBGL_debug_renderer_info");
  const gpu = {};
  if (ext) {
    gpu.vendor = gl.getParameter(ext.UNMASKED_VENDOR_WEBGL);
    gpu.renderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
  }
  const nativeDpr = getNativeDevicePixelRatio();
  const canvasAppliedDpr = canvas.width / Math.max(1, canvas.clientWidth);
  const canvasAppliedScaleFactor = canvasAppliedDpr / nativeDpr;

  sceneInfo = { asset_timing: scene.timing, asset_meta: scene.meta };
  envInfo = {
    api: "webgl2",
    powerPreferenceRequested: "high-performance",
    webgl_context_xr_compatible_requested: xrCompatibleRequested,
    hudEnabled,
    hudHz,
    xr_expected_max_views: MAX_COMPARABLE_XR_VIEWS,
    xrScaleFactor,
    xr_scale_factor_requested: xrScaleFactor,
    xr_scale_factor_applied: null,
    xr_scale_factor_fallback_used: false,
    xr_projection_layer_fallback: null,
    xr_probe_readback_requested: xrProbeReadback,
    xr_idle_present_mode: xrIdlePresentMode,
    canvasScaleFactor,
    canvas_scale_factor_requested: canvasScaleFactor,
    canvas_scale_factor_applied: canvasAppliedScaleFactor,
    xr_min_frames: minFrames,
    xr_no_pose_grace_ms: xrNoPoseGraceMs,
    xr_start_on_first_pose_requested: xrStartOnFirstPose,
    xr_start_on_first_pose_applied: false,
    xr_anchor_to_first_pose_requested: xrAnchorToFirstPose,
    xr_anchor_to_first_pose_applied: false,
    xr_anchor_mode_requested: xrAnchorMode,
    xr_pose_stability_gate_ms_requested: xrPoseStabilityGateMs,
    xr_pose_stability_pos_tol_m_requested: xrPoseStabilityPosTolM,
    xr_pose_stability_yaw_tol_deg_requested: xrPoseStabilityYawTolDeg,
    xr_pose_stability_wait_ms: xrPoseStabilityGateMs > 0 ? null : 0,
    xr_pose_stability_position_span_m: xrPoseStabilityGateMs > 0 ? null : 0,
    xr_pose_stability_yaw_span_deg: xrPoseStabilityGateMs > 0 ? null : 0,
    xr_pose_stability_achieved: xrPoseStabilityGateMs <= 0,
    xr_measurement_waiting_for_first_pose: false,
    xr_no_pose_frames: 0,
    xr_no_pose_ms_total: 0,
    context_lost: webglContextLostInfo,
    webgl: {
      context_lost_count: webglContextLostCount,
      context_restored_count: webglContextRestoredCount,
      context_lost_first_at_ms: webglContextLostFirstAtMs,
      context_lost_last_at_ms: webglContextLostLastAtMs,
      context_lost_events: webglContextLostEvents,
      context_is_lost: webglContextIsLost
    },
    error_ring_capacity: { ...ERROR_RING_CAPACITY },
    js_errors: globalJsErrors,
    js_unhandled_rejections: globalJsUnhandledRejections,
    xrFrontMinZ,
    xrYOffset,
    debugColor,
    xrIdlePresentMode,
    xrAnchorMode,
    harness_version: harnessVersion,
    harness_commit: harnessCommit,
    asset_revision: assetRevision,
    feature_flags_profile: featureFlagsProfile,
    feature_flags_exact: featureFlagsExact,
    profiler_mode: profilerMode,
    profiler_config: profilerConfig,
    provenance: provenanceInfo,
    run_id: runId,
    trace_markers_enabled: traceMarkers,
    trace_overlay_enabled: traceOverlay,
    runMode,
    xr_session_mode_requested: xrSessionMode,
    xr_session_mode_active: null,
    xr_session_mode_supported: null,
    battery_telemetry_requested: batteryTelemetry,
    connection_telemetry_requested: connectionTelemetry,
    battery_api_available: false,
    connection_api_available: false,
    online: navigator.onLine,
    connection: null,
    connection_change_count: 0,
    battery: {
      start: null,
      latest: null,
      error: null
    },
    manualDownload,
    manualStart,
    canvasAutoDelayMs,
    isApplePlatform,
    renderProbeRequested: renderProbe,
    order_control: {
      enforceOrder,
      orderMode,
      orderIndex,
      assignedApi: assignedApi || null,
      orderSeed,
      pinGpu,
      sessionGroup
    },
    browser: browserLabel,
    userAgent: navigator.userAgent || null,
    ua: navigator.userAgent,
    uaData: (navigator.userAgentData ? {
      brands: navigator.userAgentData.brands,
      mobile: navigator.userAgentData.mobile,
      platform: navigator.userAgentData.platform
    } : null),
    platform: navigator.platform || null,
    language: navigator.language || null,
    languages: Array.isArray(navigator.languages) ? navigator.languages : null,
    hardwareConcurrency: Number.isFinite(navigator.hardwareConcurrency) ? navigator.hardwareConcurrency : null,
    deviceMemory: Number.isFinite(navigator.deviceMemory) ? navigator.deviceMemory : null,
    maxTouchPoints: Number.isFinite(navigator.maxTouchPoints) ? navigator.maxTouchPoints : null,
    isSecureContext,
    crossOriginIsolated,
    visibilityState: document.visibilityState,
    dpr: nativeDpr,
    dpr_canvas: canvasAppliedDpr,
    canvas_css: { w: canvas.clientWidth, h: canvas.clientHeight },
    canvas_px: { w: canvas.width, h: canvas.height },
    contextAttributes: gl.getContextAttributes ? gl.getContextAttributes() : null,
    gpu,
    url: location.href
  };
  updateCanvasScaleEnvDiagnostics(canvasAppliedDpr);

  const gpuIdentity = `webgl2:${gpu.vendor || "unknown"}|${gpu.renderer || "unknown"}`;
  envInfo.gpu_identity = gpuIdentity;
  updateWebGLEnvDiagnostics();
  enforcePinnedGpuIdentity(gpuIdentity);
  await initRuntimeTelemetry();

  renderer.setInstances(instancesList[0], spacing, { layout, seed });
}

function getDefaultViewProj() {
  const aspect = canvas.clientWidth / canvas.clientHeight;
  const fov = 60 * Math.PI / 180;
  const near = 0.1, far = 100.0;
  const f = 1.0 / Math.tan(fov / 2);

  const proj = new Float32Array(16);
  proj.set([
    f/aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far+near)/(near-far), -1,
    0, 0, (2*far*near)/(near-far), 0
  ]);

  const view = new Float32Array(16);
  view.set([
    1,0,0,0,
    0,1,0,0,
    0,0,1,0,
    0,0,-2.0,1
  ]);

  const vp = new Float32Array(16);
  computeViewProj(vp, proj, view);
  return vp;
}

function buildPlan() {
  const plan=[];
  for (const inst of instancesList) {
    for (let t=1; t<=trials; t++) plan.push({ instances: inst, trial: t });
  }
  if (shuffle) shuffleInPlace(plan, seed);
  return plan;
}

function buildCanvasAbortRecord({ abortCode, abortReason, item=null, planIdx=null, planLen=null, partialTrial=null } = {}) {
  return {
    schema_version: SCHEMA_VERSION,
    api: "webgl2",
    mode: "canvas",
    aborted: true,
    abort_code: abortCode || "canvas_trial_failed",
    abort_reason: abortReason || "Canvas trial failed before completion.",
    runId,
    suiteId,
    modelUrl,
    instances: item ? item.instances : null,
    trial: item ? item.trial : null,
    trials,
    durationMs,
    warmupMs,
    cooldownMs,
    preIdleMs,
    postIdleMs,
    betweenInstancesMs,
    canvasAutoDelayMs,
    manualStart,
    xrSessionMode,
    layout,
    seed,
    shuffle,
    spacing,
    debugColor,
    canvasScaleFactor,
    xrScaleFactor,
    xrStartOnFirstPose,
    xrAnchorToFirstPose,
    xrAnchorMode,
    xrIdlePresentMode,
    xrPoseStabilityGateMs,
    xrFrontMinZ,
    xrYOffset,
    collectPerf,
    perfDetail,
    batteryTelemetry,
    connectionTelemetry,
    condition_index: Number.isFinite(planIdx) ? (planIdx + 1) : null,
    condition_count: Number.isFinite(planLen) ? planLen : null,
    startedAt: new Date().toISOString(),
    partial_trial: (partialTrial && typeof partialTrial === "object") ? partialTrial : {
      elapsed_ms: null,
      frames_collected: 0
    },
    ...sceneInfo,
    env: snapshotEnvInfo()
  };
}

function runCanvasTrial(item, planIdx, planLen, vp) {
  renderer.setInstances(item.instances, spacing, { layout, seed });

  const dts = [];
  const traceMeta = {
    mode: "canvas",
    testId: `instances_${item.instances}`,
    trial: item.trial,
    index: planIdx + 1,
    total: planLen
  };
  let traceStartMark = null;
  return new Promise((resolve, reject) => {
    let settled = false;
    function finishResolve(value) {
      if (settled) return;
      settled = true;
      const traceEndMark = traceMark("TEST_END", traceMeta);
      traceMeasure("TEST_MEASURE", traceStartMark, traceEndMark, traceMeta);
      activeCanvasTrialReject = null;
      resolve(value);
    }
    function finishReject(err) {
      if (settled) return;
      settled = true;
      traceMark("TEST_ABORT", { ...traceMeta, reason: err?.abortCode || "canvas_trial_failed" });
      activeCanvasTrialReject = null;
      reject(err instanceof Error ? err : new Error(String(err)));
    }
    activeCanvasTrialReject = (err) => {
      finishReject(err);
    };

    const stats = new RunStats();
    stats.meta = {
      schema_version: SCHEMA_VERSION,
      api: "webgl2",
      mode: "canvas",
      modelUrl,
      instances: item.instances,
      trial: item.trial,
      trials,
      durationMs,
      warmupMs,
      cooldownMs,
      preIdleMs,
      postIdleMs,
      betweenInstancesMs,
      canvasAutoDelayMs,
      manualStart,
      xrSessionMode,
      layout,
      seed,
      shuffle,
      spacing,
      debugColor,
      canvasScaleFactor,
      xrScaleFactor,
      xrStartOnFirstPose,
      xrAnchorToFirstPose,
      xrAnchorMode,
      xrIdlePresentMode,
      xrFrontMinZ,
      xrYOffset,
      collectPerf,
      perfDetail,
      batteryTelemetry,
      connectionTelemetry,
      condition_index: planIdx + 1,
      condition_count: planLen,
      runId,
      suiteId,
      startedAt: new Date().toISOString(),
      ...sceneInfo,
      env: snapshotEnvInfo()
    };

    function makeCanvasTrialError(message, abortCode="canvas_trial_failed") {
      const err = new Error(message);
      err.abortCode = abortCode;
      const elapsedMs = stats.startWall ? Math.max(0, performance.now() - stats.startWall) : null;
      err.partial_trial = {
        elapsed_ms: elapsedMs,
        frames_collected: dts.length
      };
      return err;
    }


    const trialId = `trial_webgl2_canvas_inst${item.instances}_t${item.trial}_idx${planIdx+1}`;
    const memStart = collectPerf ? snapshotMemory() : null;
    if (collectPerf) {
      try {
        performance.mark(`${trialId}_start`);
        console.timeStamp?.(`${trialId}_start`);
      } catch (_) {}
    }
    
    function beginMeasured() {
      traceStartMark = traceMark("TEST_START", traceMeta);
      updateTraceOverlay(`mode=canvas\ntrial ${planIdx + 1}/${planLen}\ninst=${item.instances} t=${item.trial}`);
      updateCanvasCrashDiagnostics({
        phase: "trial_measured",
        current_condition: {
          index: planIdx + 1,
          total: planLen,
          instances: item.instances,
          trial: item.trial
        },
        completed_count: resultsCanvas.length
      });
      stats.markStart();
      let lastT = NaN;

      function frame(t) {
      if (canvasAbortReason) {
        stats.markEnd();
        const abortCode = (webglContextIsLost || webglContextLostCount > 0 || gl.isContextLost?.())
          ? "webgl_context_lost"
          : "canvas_trial_failed";
        finishReject(makeCanvasTrialError(canvasAbortReason, abortCode));
        return;
      }
      if (gl.isContextLost?.()) {
        const reason = webglContextLostReasonString() || "WebGL context lost.";
        if (!canvasAbortReason) canvasAbortReason = reason;
        stats.markEnd();
        finishReject(makeCanvasTrialError(canvasAbortReason, "webgl_context_lost"));
        return;
      }
      if (Number.isFinite(lastT)) {
        const dt = t - lastT;
        dts.push(dt);
        stats.addFrame(dt);
      }
      lastT = t;

      try {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0,0,canvas.width,canvas.height);
        gl.clearColor(0.08,0.08,0.1,1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        renderer.drawForView(vp);
      } catch (e) {
        stats.markEnd();
        finishReject(makeCanvasTrialError(`Canvas render failed: ${e?.message || e}`, "canvas_trial_failed"));
        return;
      }

      if (t - stats.startWall < durationMs) requestAnimationFrame(frame);
      else {
        stats.markEnd();
        const summary = stats.summarize();
        const extras = deriveExtras(summary, dts);

        let perf = null;
        if (collectPerf) {
          try {
            performance.mark(`${trialId}_end`);
            performance.measure(trialId, `${trialId}_start`, `${trialId}_end`);
          } catch (_) {}
        
          let trial_measure_ms = null;
          try {
            const ms = performance.getEntriesByName(trialId, "measure");
            trial_measure_ms = ms.length ? ms[ms.length - 1].duration : null;
          } catch (_) {}
        
          const longtask = summarizeLongTasks(stats.startWall, stats.endWall);
          const memEnd = snapshotMemory();
          const model_resource = findResourceEntry(modelUrl);
        
          perf = {
            trial_measure_ms,
            memory_start: memStart,
            memory_end: memEnd,
            longtask,
            model_resource,
            timeOrigin: performance.timeOrigin
          };
        
          // Keep the perf buffer from growing without bound unless perfDetail is requested
          if (!perfDetail) {
            try {
              performance.clearMarks(`${trialId}_start`);
              performance.clearMarks(`${trialId}_end`);
              performance.clearMeasures(trialId);
            } catch (_) {}
          }
        }
        
        const out = { ...stats.meta, env: snapshotEnvInfo(), summary, extras, perf };
        if (storeFrames) out.frames_ms = dts;
        if (postIdleMs > 0) {
  clearCanvasBlankOnce();
  setTimeout(() => finishResolve(out), postIdleMs);
} else {
  finishResolve(out);
}
}
    }
      requestAnimationFrame(frame);
}

// Start measured section after optional pre-idle
if (preIdleMs > 0) {
  clearCanvasBlankOnce();
  setTimeout(beginMeasured, preIdleMs);
} else {
  beginMeasured();
}
  });
}

async function runCanvasSuite() {
  if (runMode === "xr") {
    log("Skipping canvas suite (mode=xr).");
    return;
  }
  if (canvasRunInProgress) return;

  canvasRunScheduled = false;
  canvasRunInProgress = true;
  let plan = [];
  try {
    _resolvedCanvasOutFilename = null;
    const syncedCanvasDpr = resyncCanvasSurfaceForRun();
    log(`Canvas surface synced before suite: css=${canvas.clientWidth}x${canvas.clientHeight}, px=${canvas.width}x${canvas.height}, canvasDpr=${syncedCanvasDpr.toFixed(3)}, canvasScaleFactor=${canvasScaleFactor}.`);
    const vp = getDefaultViewProj();
    ensureCanvasRenderProbe(vp);
    resultsCanvas = [];

    plan = buildPlan();
    persistCanvasCheckpoint(plan.length);
    startCanvasCrashDiagnostics(plan.length);
    traceMark("SUITE_START", { mode: "canvas", testId: "suite", trial: "-", index: 1, total: plan.length });
    updateTraceOverlay(`mode=canvas\nsuite=${suiteId}\nrunId=${runId}`);
    for (let i=0;i<plan.length;i++) {
      const item = plan[i];
      updateCanvasCrashDiagnostics({
        phase: "trial_warmup",
        current_condition: {
          index: i + 1,
          total: plan.length,
          instances: item.instances,
          trial: item.trial
        },
        completed_count: resultsCanvas.length
      });

      // Extra pause when instances changes (if not shuffled, this is between blocks)
      if (i>0 && plan[i-1].instances !== item.instances) {
        log(`Between-instances cooldown (${betweenInstancesMs}ms)`);
        await sleep(betweenInstancesMs);
      }

      log(`Canvas run ${i+1}/${plan.length}: instances=${item.instances}, trial=${item.trial}/${trials} (warmup ${warmupMs}ms)`);
      await sleep(warmupMs);

      let out = null;
      try {
        out = await runCanvasTrial(item, i, plan.length, vp);
      } catch (e) {
        const reason = `Canvas trial failed at ${i+1}/${plan.length}: ${e?.message || e}`;
        if (!canvasAbortReason) canvasAbortReason = reason;
        if (envInfo) envInfo.canvas_abort_reason = canvasAbortReason;
        resultsCanvas.push(buildCanvasAbortRecord({
          abortCode: (typeof e?.abortCode === "string" && e.abortCode) ? e.abortCode : "canvas_trial_failed",
          abortReason: canvasAbortReason,
          item,
          planIdx: i,
          planLen: plan.length,
          partialTrial: (e?.partial_trial && typeof e.partial_trial === "object") ? e.partial_trial : {
            elapsed_ms: null,
            frames_collected: 0
          }
        }));
        persistCanvasCheckpoint(plan.length);
        updateCanvasCrashDiagnostics({
          status: "aborted",
          phase: "trial_abort",
          abort_reason: canvasAbortReason,
          completed_count: resultsCanvas.length,
          current_condition: {
            index: i + 1,
            total: plan.length,
            instances: item.instances,
            trial: item.trial
          }
        });
        log(canvasAbortReason);
        break;
      }
      resultsCanvas.push(out);
      persistCanvasCheckpoint(plan.length);
      updateCanvasCrashDiagnostics({
        phase: "trial_complete",
        completed_count: resultsCanvas.length,
        last_completed_condition: {
          index: i + 1,
          total: plan.length,
          instances: item.instances,
          trial: item.trial
        },
        current_condition: null
      });

      if (canvasAbortReason) {
        resultsCanvas.push(buildCanvasAbortRecord({
          abortCode: (webglContextIsLost || webglContextLostCount > 0) ? "webgl_context_lost" : "canvas_trial_failed",
          abortReason: canvasAbortReason,
          item,
          planIdx: i,
          planLen: plan.length,
          partialTrial: { elapsed_ms: null, frames_collected: 0 }
        }));
        persistCanvasCheckpoint(plan.length);
        updateCanvasCrashDiagnostics({
          status: "aborted",
          phase: "suite_abort",
          abort_reason: canvasAbortReason,
          completed_count: resultsCanvas.length
        });
        break;
      }
      await sleep(cooldownMs);
    }

    const jsonl = resultsCanvas.map(o=>JSON.stringify(o)).join("\n") + "\n";
    const canvasOutFile = canvasOutFilename();
    downloadText(jsonl, canvasOutFile, "Canvas results");
    clearCanvasCheckpoint();
    updateCanvasCrashDiagnostics({
      status: "completed",
      phase: "suite_complete",
      completed_count: resultsCanvas.length,
      current_condition: null
    });
    clearCanvasCrashDiagnostics();
    log(`Done (canvas). ${manualDownload ? "Queued" : "Downloaded"} ${canvasOutFile}`);
    traceMark("SUITE_END", { mode: "canvas", testId: "suite", trial: "-", index: plan.length, total: plan.length });
    clearCanvasBlankOnce();
  } finally {
    canvasRunInProgress = false;
    if (manualStart && manualCanvasStartButton) {
      setManualCanvasStartButtonState({
        visible: true,
        enabled: false,
        text: "Canvas Complete"
      });
    }
  }
}

function startCanvasSuiteNow(trigger = "manual") {
  if (runMode === "xr") {
    log("Canvas start ignored (mode=xr).");
    return;
  }
  if (canvasRunInProgress) {
    log("Canvas suite already running.");
    return;
  }
  if (!canvasRunScheduled) {
    log("Canvas suite is not armed.");
    return;
  }
  if (manualStart && manualCanvasStartButton) {
    setManualCanvasStartButtonState({
      visible: true,
      enabled: false,
      text: "Starting Canvas..."
    });
  }
  log(`Starting canvas suite (${trigger}).`);
  runCanvasSuite().catch((e) => {
    console.error(e);
    log(String(e));
  });
}

async function initXR() {
  if (!navigator.xr) {
    if (envInfo) envInfo.xr_skipped_reason = "webxr_unsupported";
    btn.disabled = true;
    btn.textContent = "XR unavailable";
    log("WebXR not supported (canvas-only)");
    return;
  }
  const supported = await navigator.xr.isSessionSupported(xrSessionMode).catch(()=>false);
  if (envInfo) {
    envInfo.xr_session_mode_supported = supported;
    if (!supported) envInfo.xr_skipped_reason = `${xrSessionModeShort}_unsupported`;
  }
  if (!supported) {
    btn.disabled = true;
    btn.textContent = `${xrSessionMode} unavailable`;
    log(`${xrSessionMode} not supported here (canvas-only)`);
    return;
  }
  btn.disabled = false;
  btn.textContent = `Enter ${xrSessionModeLabel}`;
  btn.addEventListener("click", async ()=> {
    if (xrRequesting) {
      log("XR session request already in progress.");
      return;
    }
    if (!xrSession) {
      if (canvasRunInProgress || canvasRunScheduled) {
        log("Canvas suite is scheduled/running. Use mode=xr for XR-only benchmarking.");
        return;
      }
      try {
        const opts = hudEnabled ? { optionalFeatures:["dom-overlay"], domOverlay:{ root: document.body } } : {};
        xrResultFlushedForSession = false;
        xrAbortReason = null;
        xrEnterClickedAt = performance.now();
        xrRequesting = true;
        const session = await navigator.xr.requestSession(xrSessionMode, opts);
        xrRequesting = false;
        xrSession = session;
        if (envInfo) envInfo.xr_session_mode_active = session.mode || xrSessionMode;
        await onSessionStarted(session);
      } catch (e) {
        xrRequesting = false;
        const failedSession = xrSession;
        xrSession = null;
        xrEnterClickedAt = null;
        if (failedSession) {
          try { await failedSession.end(); } catch (_) {}
        }
        const reason = `${xrSessionMode} session failed before suite completion: ${e?.message || e}`;
        if (envInfo) {
          envInfo.xr_abort_reason = reason;
          envInfo.xr_observed_view_count = 0;
          envInfo.xr_expected_max_views = MAX_COMPARABLE_XR_VIEWS;
        }
        if (!xrResultFlushedForSession) {
          const last = resultsXR[resultsXR.length - 1];
          if (!last || last.aborted !== true) {
            resultsXR.push(buildXRAbortRecord({
              abortCode: "xr_session_start_failed",
              abortReason: reason,
              observedViewCount: 0,
              planItem: null
            }));
          }
          flushXRResults(xrOutFilename(), "XR session failed");
        }
        console.error(e);
        log(`XR session failed: ${e?.message || e}`);
      }
    } else {
      await xrSession.end();
    }
  });
}

// XR multi-run state
// XR startup / idle helpers
let xrBlankClearOnce = false;      // when true, onXRFrame will render a single blank frame then stop work
let xrEnterClickedAt = null;       // performance.now() when user clicked Enter XR
let xrPlan=null;
let xrIndex=0;
let xrActive=false;
let xrStats=null;
let xrLastT=NaN;
let xrLastNow=NaN;
let xrDts=null;
let xrDtsNow=null;
let xrViewports=null;
let xrTrialId=null;
let xrMemStart=null;
let xrAbortReason=null;
let xrFirstFramePixels=null;
let xrFirstFrameViewPixels=null;
let xrRenderProbe = createXRRenderProbeState();
let xrFinalizing = false;
let xrMinFramesWaitLogged = false;
let xrNoPoseFrames = 0;
let xrNoPoseMsTotal = 0;
let xrFrameLoopLastNow = NaN;
let xrTrialWallStartNow = NaN;
let xrAwaitingFirstPoseStart = false;
let xrStartedOnFirstPose = false;
let xrAnchoredToFirstPose = false;
let xrSessionAnchorPose = null; // { yaw, x, z } reused per session or refreshed per trial, depending on xrAnchorMode
let xrPoseGateState = null;
let xrPoseStabilityWaitMs = null;
let xrPoseStabilityPositionSpanM = null;
let xrPoseStabilityYawSpanDeg = null;


function fmtMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return "n/a";
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms/1000).toFixed(1)}s`;
}

function resetXRNoPoseDiagnostics() {
  xrNoPoseFrames = 0;
  xrNoPoseMsTotal = 0;
  xrFrameLoopLastNow = NaN;
  xrTrialWallStartNow = NaN;
  xrAwaitingFirstPoseStart = false;
  xrStartedOnFirstPose = false;
}

function isXRMeasurementStarted() {
  return !!(xrStats && Number.isFinite(xrStats.startWall) && xrStats.startWall > 0);
}

function syncXRNoPoseDiagnosticsToEnv() {
  if (!envInfo) return;
  envInfo.xr_no_pose_frames = xrNoPoseFrames;
  envInfo.xr_no_pose_ms_total = xrNoPoseMsTotal;
  envInfo.xr_start_on_first_pose_applied = xrStartedOnFirstPose;
  envInfo.xr_measurement_waiting_for_first_pose = xrAwaitingFirstPoseStart;
  updateXRPoseStabilityEnvDiagnostics();
}

function xrPoseTimeoutElapsedMs(now) {
  if (isXRMeasurementStarted()) return Math.max(0, now - xrStats.startWall);
  if (Number.isFinite(xrTrialWallStartNow)) return Math.max(0, now - xrTrialWallStartNow);
  return null;
}

function beginXRMeasuredWindow(startMode = "immediate") {
  if (!xrSession || !xrStats) return;
  if (isXRMeasurementStarted()) return;
  const item = currentXRPlanItem();
  if (!item) return;

  xrStats.markStart();
  xrTrialId = `trial_webgl2_xr_inst${item.instances}_t${item.trial}_idx${xrIndex+1}`;
  xrMemStart = collectPerf ? snapshotMemory() : null;
  if (collectPerf) {
    try {
      performance.mark(`${xrTrialId}_start`);
      console.timeStamp?.(`${xrTrialId}_start`);
    } catch (_) {}
  }
  xrLastT = NaN;
  xrLastNow = NaN;
  xrAwaitingFirstPoseStart = false;
  xrStartedOnFirstPose = (startMode === "first_pose" || startMode === "stable_pose");
  syncXRNoPoseDiagnosticsToEnv();

  const startNote = startMode === "stable_pose"
    ? ", start=stable_pose"
    : (xrStartedOnFirstPose ? ", start=first_pose" : ", start=immediate");
  log(`XR run ${xrIndex+1}/${xrPlan.length}: instances=${item.instances}, trial=${item.trial}/${trials} (preIdle ${preIdleMs}ms${startNote})`);
  xrTraceStartMark = traceMark("TEST_START", {
    mode: "xr",
    testId: `instances_${item.instances}`,
    trial: item.trial,
    index: xrIndex + 1,
    total: xrPlan.length
  });
  updateTraceOverlay(`mode=xr\ntrial ${xrIndex + 1}/${xrPlan.length}\ninst=${item.instances} t=${item.trial}`);
}

function currentXRPlanItem() {
  return (xrPlan && xrIndex >= 0 && xrIndex < xrPlan.length) ? xrPlan[xrIndex] : null;
}

function yawFromQuaternion(q) {
  if (!q) return null;
  const x = Number.isFinite(q.x) ? q.x : 0;
  const y = Number.isFinite(q.y) ? q.y : 0;
  const z = Number.isFinite(q.z) ? q.z : 0;
  const w = Number.isFinite(q.w) ? q.w : 1;
  const siny = 2 * (w * y + x * z);
  const cosy = 1 - 2 * (y * y + z * z);
  const yaw = Math.atan2(siny, cosy);
  return Number.isFinite(yaw) ? yaw : null;
}

function normalizeYawRadians(yaw) {
  if (!Number.isFinite(yaw)) return null;
  let out = yaw;
  while (out > Math.PI) out -= Math.PI * 2;
  while (out < -Math.PI) out += Math.PI * 2;
  return out;
}

function resetXRPoseStabilityState() {
  xrPoseGateState = null;
  xrPoseStabilityWaitMs = xrPoseStabilityGateMs > 0 ? null : 0;
  xrPoseStabilityPositionSpanM = xrPoseStabilityGateMs > 0 ? null : 0;
  xrPoseStabilityYawSpanDeg = xrPoseStabilityGateMs > 0 ? null : 0;
  updateXRPoseStabilityEnvDiagnostics();
}

function extractViewerPoseSample(pose) {
  const t = pose?.transform;
  if (!t) return null;
  const x = Number.isFinite(t.position?.x) ? t.position.x : null;
  const y = Number.isFinite(t.position?.y) ? t.position.y : null;
  const z = Number.isFinite(t.position?.z) ? t.position.z : null;
  const yaw = yawFromQuaternion(t.orientation);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) || !Number.isFinite(yaw)) return null;
  return { x, y, z, yaw };
}

function createXRPoseGateState(sample, now) {
  return {
    startNow: now,
    minX: sample.x,
    maxX: sample.x,
    minY: sample.y,
    maxY: sample.y,
    minZ: sample.z,
    maxZ: sample.z,
    minYaw: sample.yaw,
    maxYaw: sample.yaw,
    lastYaw: sample.yaw,
    lastUnwrappedYaw: sample.yaw
  };
}

function updateXRPoseStabilityGate(pose, now) {
  if (!(xrPoseStabilityGateMs > 0)) {
    xrPoseStabilityWaitMs = 0;
    xrPoseStabilityPositionSpanM = 0;
    xrPoseStabilityYawSpanDeg = 0;
    updateXRPoseStabilityEnvDiagnostics();
    return { stable: true };
  }
  const sample = extractViewerPoseSample(pose);
  if (!sample) return { stable: false, missingSample: true };

  if (!xrPoseGateState) {
    xrPoseGateState = createXRPoseGateState(sample, now);
    xrPoseStabilityWaitMs = 0;
    xrPoseStabilityPositionSpanM = 0;
    xrPoseStabilityYawSpanDeg = 0;
    updateXRPoseStabilityEnvDiagnostics();
    return { stable: false };
  }

  const state = xrPoseGateState;
  state.minX = Math.min(state.minX, sample.x);
  state.maxX = Math.max(state.maxX, sample.x);
  state.minY = Math.min(state.minY, sample.y);
  state.maxY = Math.max(state.maxY, sample.y);
  state.minZ = Math.min(state.minZ, sample.z);
  state.maxZ = Math.max(state.maxZ, sample.z);
  const yawDelta = normalizeYawRadians(sample.yaw - state.lastYaw);
  state.lastUnwrappedYaw += yawDelta == null ? 0 : yawDelta;
  state.lastYaw = sample.yaw;
  state.minYaw = Math.min(state.minYaw, state.lastUnwrappedYaw);
  state.maxYaw = Math.max(state.maxYaw, state.lastUnwrappedYaw);

  const elapsedMs = Math.max(0, now - state.startNow);
  const posSpan = Math.hypot(state.maxX - state.minX, state.maxY - state.minY, state.maxZ - state.minZ);
  const yawSpanDeg = (state.maxYaw - state.minYaw) * 180 / Math.PI;
  xrPoseStabilityWaitMs = elapsedMs;
  xrPoseStabilityPositionSpanM = posSpan;
  xrPoseStabilityYawSpanDeg = yawSpanDeg;
  updateXRPoseStabilityEnvDiagnostics();

  if (elapsedMs < xrPoseStabilityGateMs) return { stable: false };
  if (posSpan <= xrPoseStabilityPosTolM && yawSpanDeg <= xrPoseStabilityYawTolDeg) {
    return { stable: true };
  }

  xrPoseGateState = createXRPoseGateState(sample, now);
  xrPoseStabilityWaitMs = 0;
  xrPoseStabilityPositionSpanM = 0;
  xrPoseStabilityYawSpanDeg = 0;
  updateXRPoseStabilityEnvDiagnostics();
  return { stable: false, reset: true };
}

function maybeAnchorXRInstancesToPose(pose) {
  if (!xrAnchorToFirstPose || xrAnchoredToFirstPose) return false;
  const item = currentXRPlanItem();
  const t = pose?.transform;
  if (!item || !renderer || !t) return false;

  const yaw = yawFromQuaternion(t.orientation);
  const px = Number.isFinite(t.position?.x) ? t.position.x : null;
  const pz = Number.isFinite(t.position?.z) ? t.position.z : null;
  if (!Number.isFinite(yaw) || !Number.isFinite(px) || !Number.isFinite(pz)) return false;

  if (!xrSessionAnchorPose || xrAnchorMode === "trial") {
    xrSessionAnchorPose = { yaw, x: px, z: pz };
  }
  const anchor = xrSessionAnchorPose;

  renderer.setInstances(item.instances, spacing, {
    layout,
    seed,
    isXR: true,
    xrFrontMinZ,
    xrYOffset,
    xrAnchorYaw: anchor.yaw,
    xrAnchorX: anchor.x,
    xrAnchorZ: anchor.z
  });
  xrAnchoredToFirstPose = true;
  if (envInfo) {
    envInfo.xr_anchor_to_first_pose_applied = true;
    envInfo.xr_anchor_mode_requested = xrAnchorMode;
    envInfo.xr_anchor_pose_yaw_rad = anchor.yaw;
    envInfo.xr_anchor_pose_x = anchor.x;
    envInfo.xr_anchor_pose_z = anchor.z;
  }
  const anchorSource = xrAnchorMode === "trial" ? "trial pose" : "first pose";
  log(`XR anchor applied from ${anchorSource} (yaw=${anchor.yaw.toFixed(3)}, x=${anchor.x.toFixed(3)}, z=${anchor.z.toFixed(3)}).`);
  return true;
}

function ensureXRRenderProbeState() {
  if (!xrRenderProbe) xrRenderProbe = createXRRenderProbeState();
  return xrRenderProbe;
}

function markXRRenderProbeFirstFrame(framePixelTotal) {
  const probe = ensureXRRenderProbeState();
  if (!probe.performed) return;
  if (probe.first_frame_px == null) {
    probe.first_frame_px = Number.isFinite(framePixelTotal) ? framePixelTotal : null;
    if (probe.rendered_anything == null) probe.rendered_anything = framePixelTotal > 0;
  }
}

function sampleXRPixelDiffWebGL(viewports, clearRGBA8) {
  const probe = ensureXRRenderProbeState();
  if (!probe.performed || probe.readback_allowed !== null) return;
  if (!xrProbeReadback) {
    probe.readback_allowed = false;
    probe.readback_error = "xr_probe_readback_disabled_default";
    return;
  }
  try {
    // XRWebGLLayer framebuffers are often multisampled; readPixels on those is invalid.
    const samples = Number(gl.getParameter(gl.SAMPLES) || 0);
    if (samples > 0) {
      probe.readback_allowed = false;
      probe.readback_error = `multisampled_framebuffer_samples_${samples}`;
      return;
    }

    const px = new Uint8Array(4);
    let diff = 0;
    let sampleCount = 0;
    let firstSample = null;
    for (const vp of viewports) {
      const points = [
        [Math.floor(vp.x + vp.w * 0.25), Math.floor(vp.y + vp.h * 0.5)],
        [Math.floor(vp.x + vp.w * 0.50), Math.floor(vp.y + vp.h * 0.5)],
        [Math.floor(vp.x + vp.w * 0.75), Math.floor(vp.y + vp.h * 0.5)],
      ];
      for (const [sxRaw, syRaw] of points) {
        const sx = Math.max(0, sxRaw);
        const sy = Math.max(0, syRaw);
        gl.readPixels(sx, sy, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        const d = Math.abs(px[0] - clearRGBA8[0]) + Math.abs(px[1] - clearRGBA8[1]) + Math.abs(px[2] - clearRGBA8[2]);
        if (d > 6) diff++;
        sampleCount++;
        if (!firstSample) firstSample = [px[0], px[1], px[2], px[3]];
      }
    }
    probe.readback_allowed = true;
    probe.sampled_pixel_diff = diff;
    probe.sample_count = sampleCount;
    probe.clear_rgba8 = clearRGBA8;
    probe.sample_rgba8 = firstSample;
    if (probe.rendered_anything == null) probe.rendered_anything = diff > 0;
    else probe.rendered_anything = probe.rendered_anything || diff > 0;
  } catch (e) {
    probe.readback_allowed = false;
    probe.readback_error = String(e?.message || e);
  }
}

function finalizeXRTrial(session) {
  if (!xrSession || session !== xrSession) {
    xrFinalizing = false;
    return;
  }
  syncXRNoPoseDiagnosticsToEnv();
  xrStats.markEnd();
  const summary = xrStats.summarize();
  const extras = deriveExtras(summary, xrDts);

  let perf = null;
  if (collectPerf) {
    try {
      performance.mark(`${xrTrialId}_end`);
      performance.measure(xrTrialId, `${xrTrialId}_start`, `${xrTrialId}_end`);
    } catch (_) {}

    let trial_measure_ms = null;
    try {
      const ms = performance.getEntriesByName(xrTrialId, "measure");
      trial_measure_ms = ms.length ? ms[ms.length - 1].duration : null;
    } catch (_) {}

    const longtask = summarizeLongTasks(xrStats.startWall, xrStats.endWall);
    const memEnd = snapshotMemory();
    const model_resource = findResourceEntry(modelUrl);

    perf = {
      trial_measure_ms,
      memory_start: xrMemStart,
      memory_end: memEnd,
      longtask,
      model_resource,
      timeOrigin: performance.timeOrigin
    };

    if (!perfDetail) {
      try {
        performance.clearMarks(`${xrTrialId}_start`);
        performance.clearMarks(`${xrTrialId}_end`);
        performance.clearMeasures(xrTrialId);
      } catch (_) {}
    }
  }

  const out = {
    ...xrStats.meta,
    env: snapshotEnvInfo(),
    summary,
    extras,
    perf,
    timing_primary_source: "xr_callback_t",
    timing_secondary_source: "performance.now",
    xr_cadence_secondary: summarizeSeries(xrDtsNow),
    xr_effective_pixels: {
      requested_scale_factor: xrScaleFactor,
      applied_scale_factor: envInfo?.xr_scale_factor_applied ?? null,
      first_frame_total_px: xrFirstFramePixels,
      first_frame_per_view_px: xrFirstFrameViewPixels || []
    },
    xr_no_pose_frames: xrNoPoseFrames,
    xr_no_pose_ms_total: xrNoPoseMsTotal,
    xr_viewports: xrViewports,
    render_probe_xr: xrRenderProbe || createXRRenderProbeState()
  };
  if (storeFrames) {
    out.frames_ms = xrDts;
    out.frames_ms_now = xrDtsNow;
  }
  if (!xrSession || session !== xrSession) {
    xrFinalizing = false;
    return;
  }

  const cur = currentXRPlanItem();
  const traceMeta = {
    mode: "xr",
    testId: cur ? `instances_${cur.instances}` : "instances_-",
    trial: cur ? cur.trial : "-",
    index: cur ? (xrIndex + 1) : "-",
    total: xrPlan ? xrPlan.length : "-"
  };
  const xrTraceEnd = traceMark("TEST_END", traceMeta);
  traceMeasure("TEST_MEASURE", xrTraceStartMark, xrTraceEnd, traceMeta);
  xrTraceStartMark = null;

  resultsXR.push(out);
  xrIndex++;
  xrActive = false;
  xrFinalizing = false;
  xrMinFramesWaitLogged = false;

  const next = xrPlan[xrIndex];
  const prev = xrPlan[xrIndex-1];
  xrBlankClearOnce = xrIdlePresentMode === "none";
  setTimeout(() => startNextXRTrial(session), computeXRInterTrialPause(prev, next).totalPauseMs);
}

function buildXRAbortRecord({ abortCode, abortReason, observedViewCount=0, planItem=undefined } = {}) {
  syncXRNoPoseDiagnosticsToEnv();
  const cur = (planItem === undefined) ? currentXRPlanItem() : planItem;
  const elapsedMs = xrPoseTimeoutElapsedMs(performance.now());
  return {
    schema_version: SCHEMA_VERSION,
    api: "webgl2",
    mode: "xr",
    aborted: true,
    abort_code: abortCode || "xr_session_ended_early",
    abort_reason: abortReason || "XR session ended before suite completion.",
    observed_view_count: Number.isFinite(observedViewCount) ? observedViewCount : 0,
    expected_max_views: MAX_COMPARABLE_XR_VIEWS,
    runId,
    suiteId,
    modelUrl,
    instances: cur ? cur.instances : null,
    trial: cur ? cur.trial : null,
    trials,
    durationMs,
    minFrames,
    warmupMs,
    cooldownMs,
    preIdleMs,
    postIdleMs,
    betweenInstancesMs,
    canvasAutoDelayMs,
    manualStart,
    xrSessionMode,
    layout,
    seed,
    shuffle,
    spacing,
    debugColor,
    canvasScaleFactor,
    xrScaleFactor,
    xrStartOnFirstPose,
    xrAnchorToFirstPose,
    xrAnchorMode,
    xrIdlePresentMode,
    xrPoseStabilityGateMs,
    xrFrontMinZ,
    xrYOffset,
    collectPerf,
    perfDetail,
    batteryTelemetry,
    connectionTelemetry,
    condition_index: cur ? (xrIndex + 1) : null,
    condition_count: xrPlan ? xrPlan.length : null,
    startedAt: new Date().toISOString(),
    partial_trial: {
      elapsed_ms: elapsedMs,
      frames_collected_t: xrDts ? xrDts.length : 0,
      frames_collected_now: xrDtsNow ? xrDtsNow.length : 0
    },
    xr_no_pose_frames: xrNoPoseFrames,
    xr_no_pose_ms_total: xrNoPoseMsTotal,
    ...sceneInfo,
    env: snapshotEnvInfo(),
    xr_effective_pixels: {
      requested_scale_factor: xrScaleFactor,
      applied_scale_factor: envInfo?.xr_scale_factor_applied ?? null,
      first_frame_total_px: xrFirstFramePixels,
      first_frame_per_view_px: xrFirstFrameViewPixels || []
    },
    render_probe_xr: xrRenderProbe || createXRRenderProbeState(),
    xr_cadence_secondary: summarizeSeries(xrDtsNow),
    xr_viewports: xrViewports || []
  };
}

function abortXRForPoseTimeout(session, elapsedMs, waitingForFirstPose=false) {
  if (xrAbortReason) return;
  const reason = waitingForFirstPose
    ? `XR aborted: first viewer pose unavailable after ${Math.round(elapsedMs)}ms (durationMs=${durationMs}, minFrames=${minFrames}, xrStartOnFirstPose=1).`
    : `XR aborted: viewer pose unavailable after ${Math.round(elapsedMs)}ms (durationMs=${durationMs}, minFrames=${minFrames}).`;
  xrAbortReason = reason;
  if (envInfo) {
    envInfo.xr_abort_reason = reason;
    if (!Number.isFinite(envInfo.xr_observed_view_count)) envInfo.xr_observed_view_count = 0;
    envInfo.xr_expected_max_views = MAX_COMPARABLE_XR_VIEWS;
  }
  syncXRNoPoseDiagnosticsToEnv();
  const cur = currentXRPlanItem();
  traceMark("TEST_ABORT", {
    mode: "xr",
    testId: cur ? `instances_${cur.instances}` : "instances_-",
    trial: cur ? cur.trial : "-",
    index: cur ? (xrIndex + 1) : "-",
    total: xrPlan ? xrPlan.length : "-",
    reason: "xr_pose_unavailable_timeout"
  });
  xrTraceStartMark = null;
  closeXRSuiteTrace("SUITE_ABORT", {
    testId: "suite",
    trial: "-",
    index: xrIndex + 1,
    total: xrPlan ? xrPlan.length : "-"
  });
  resultsXR.push(buildXRAbortRecord({
    abortCode: "xr_pose_unavailable_timeout",
    abortReason: reason,
    observedViewCount: Number.isFinite(envInfo?.xr_observed_view_count) ? envInfo.xr_observed_view_count : 0
  }));
  flushXRResults(xrOutFilename(), "Aborted (XR)");
  xrActive = false;
  log(reason);
  Promise.resolve(session.end()).catch(()=>{});
}

function abortXRForPoseStabilityTimeout(session, elapsedMs) {
  if (xrAbortReason) return;
  const posSpan = Number.isFinite(xrPoseStabilityPositionSpanM) ? xrPoseStabilityPositionSpanM.toFixed(3) : "n/a";
  const yawSpan = Number.isFinite(xrPoseStabilityYawSpanDeg) ? xrPoseStabilityYawSpanDeg.toFixed(2) : "n/a";
  const reason = `XR aborted: stable viewer pose not achieved after ${Math.round(elapsedMs)}ms (gate=${xrPoseStabilityGateMs}ms, posSpan=${posSpan}m, yawSpan=${yawSpan}deg).`;
  xrAbortReason = reason;
  if (envInfo) {
    envInfo.xr_abort_reason = reason;
    if (!Number.isFinite(envInfo.xr_observed_view_count)) envInfo.xr_observed_view_count = 0;
    envInfo.xr_expected_max_views = MAX_COMPARABLE_XR_VIEWS;
    updateXRPoseStabilityEnvDiagnostics();
  }
  const cur = currentXRPlanItem();
  traceMark("TEST_ABORT", {
    mode: "xr",
    testId: cur ? `instances_${cur.instances}` : "instances_-",
    trial: cur ? cur.trial : "-",
    index: cur ? (xrIndex + 1) : "-",
    total: xrPlan ? xrPlan.length : "-",
    reason: "xr_pose_unstable_timeout"
  });
  xrTraceStartMark = null;
  closeXRSuiteTrace("SUITE_ABORT", {
    testId: "suite",
    trial: "-",
    index: xrIndex + 1,
    total: xrPlan ? xrPlan.length : "-"
  });
  resultsXR.push(buildXRAbortRecord({
    abortCode: "xr_pose_unstable_timeout",
    abortReason: reason,
    observedViewCount: Number.isFinite(envInfo?.xr_observed_view_count) ? envInfo.xr_observed_view_count : 0
  }));
  flushXRResults(xrOutFilename(), "Aborted (XR)");
  xrActive = false;
  log(reason);
  Promise.resolve(session.end()).catch(()=>{});
}

function abortXRForComparability(session, observedViews) {
  if (xrAbortReason) return;
  xrAbortReason = `XR aborted: observed ${observedViews} views; max allowed is ${MAX_COMPARABLE_XR_VIEWS} for cross-API comparability.`;
  if (envInfo) {
    envInfo.xr_abort_reason = xrAbortReason;
    envInfo.xr_observed_view_count = observedViews;
    envInfo.xr_expected_max_views = MAX_COMPARABLE_XR_VIEWS;
  }
  const cur = currentXRPlanItem();
  traceMark("TEST_ABORT", {
    mode: "xr",
    testId: cur ? `instances_${cur.instances}` : "instances_-",
    trial: cur ? cur.trial : "-",
    index: cur ? (xrIndex + 1) : "-",
    total: xrPlan ? xrPlan.length : "-",
    reason: "xr_view_count_exceeded"
  });
  xrTraceStartMark = null;
  closeXRSuiteTrace("SUITE_ABORT", {
    testId: "suite",
    trial: "-",
    index: xrIndex + 1,
    total: xrPlan ? xrPlan.length : "-"
  });
  resultsXR.push(buildXRAbortRecord({
    abortCode: "xr_view_count_exceeded",
    abortReason: xrAbortReason,
    observedViewCount: observedViews
  }));
  flushXRResults(xrOutFilename(), "Aborted (XR)");
  xrActive = false;
  log(xrAbortReason);
  Promise.resolve(session.end()).catch(()=>{});
}

function ensureComparableXRViews(session, pose) {
  if (xrAbortReason) return false;
  const viewCount = pose?.views?.length || 0;
  if (viewCount > MAX_COMPARABLE_XR_VIEWS) {
    abortXRForComparability(session, viewCount);
    return false;
  }
  return true;
}

function xrHudText() {
  if (!xrPlan) return "XR: not started";
  const total = xrPlan.length;
  const idx = Math.min(xrIndex + (xrActive ? 0 : 0), total);
  const cur = xrPlan[Math.min(xrIndex, total-1)];
  const inst = cur ? cur.instances : "-";
  const tr = cur ? cur.trial : "-";
  if (xrActive && xrStats) {
    if (!isXRMeasurementStarted()) {
      return `XR run ${xrIndex+1}/${total}\ninstances=${inst}  trial=${tr}/${trials}\nwaiting_for_pose=1\nframes=${xrDts ? xrDts.length : 0}/${minFrames}\napi=${(envInfo&&envInfo.api)||"?"}`;
    }
    const elapsed = performance.now() - xrStats.startWall;
    const rem = Math.max(0, durationMs - elapsed);
    const frames = xrDts ? xrDts.length : 0;
    return `XR run ${xrIndex+1}/${total}\ninstances=${inst}  trial=${tr}/${trials}\nremaining=${fmtMs(rem)}\nframes=${frames}/${minFrames}\napi=${(envInfo&&envInfo.api)||"?"}`;
  }
  return `XR idle ${xrIndex+1}/${total}\nnext instances=${inst}  trial=${tr}/${trials}\nminFrames=${minFrames}`;
}


function startNextXRTrial(session) {
  if (!xrSession || session !== xrSession) return;
  if (xrAbortReason) {
    closeXRSuiteTrace("SUITE_ABORT", {
      testId: "suite",
      trial: "-",
      index: xrIndex + 1,
      total: xrPlan ? xrPlan.length : "-"
    });
    xrActive=false;
    Promise.resolve(session.end()).catch(()=>{});
    return;
  }
  if (!xrPlan || xrIndex >= xrPlan.length) {
    closeXRSuiteTrace("SUITE_END", {
      testId: "suite",
      trial: "-",
      index: xrPlan ? xrPlan.length : 0,
      total: xrPlan ? xrPlan.length : 0
    });
    flushXRResults();
    xrActive=false;
    session.end();
    return;
  }

  const item = xrPlan[xrIndex];
  const reuseAnchor = !!(xrAnchorToFirstPose && xrAnchorMode === "session" && xrSessionAnchorPose);
  if (xrAnchorToFirstPose && xrAnchorMode === "trial") {
    xrSessionAnchorPose = null;
  }
  renderer.setInstances(item.instances, spacing, {
    layout,
    seed,
    isXR: true,
    xrFrontMinZ,
    xrYOffset,
    ...(reuseAnchor ? {
      xrAnchorYaw: xrSessionAnchorPose.yaw,
      xrAnchorX: xrSessionAnchorPose.x,
      xrAnchorZ: xrSessionAnchorPose.z
    } : {})
  });
  xrAnchoredToFirstPose = reuseAnchor;
  if (envInfo) {
    envInfo.xr_anchor_mode_requested = xrAnchorMode;
    envInfo.xr_anchor_to_first_pose_applied = xrAnchoredToFirstPose;
    if (xrAnchoredToFirstPose && xrSessionAnchorPose) {
      envInfo.xr_anchor_pose_yaw_rad = xrSessionAnchorPose.yaw;
      envInfo.xr_anchor_pose_x = xrSessionAnchorPose.x;
      envInfo.xr_anchor_pose_z = xrSessionAnchorPose.z;
    } else {
      delete envInfo.xr_anchor_pose_yaw_rad;
      delete envInfo.xr_anchor_pose_x;
      delete envInfo.xr_anchor_pose_z;
    }
  }

  xrDts = [];
  xrDtsNow = [];
  xrViewports = [];
  xrFirstFramePixels = null;
  xrFirstFrameViewPixels = null;
  xrRenderProbe = createXRRenderProbeState();
  xrFinalizing = false;
  xrMinFramesWaitLogged = false;
  xrTraceStartMark = null;

  xrStats = new RunStats();
  xrStats.meta = {
    schema_version: SCHEMA_VERSION,
    api:"webgl2",
    mode:"xr",
    modelUrl,
    instances: item.instances,
    trial: item.trial,
    trials,
    durationMs,
    minFrames,
    warmupMs,
    cooldownMs,
    preIdleMs,
    postIdleMs,
    betweenInstancesMs,
    canvasAutoDelayMs,
    manualStart,
    xrSessionMode,
    layout,
    seed,
    shuffle,
    spacing,
    debugColor,
    canvasScaleFactor,
    xrScaleFactor,
    xrStartOnFirstPose,
    xrAnchorToFirstPose,
    xrAnchorMode,
    xrIdlePresentMode,
    xrFrontMinZ,
    xrYOffset,
    collectPerf,
    perfDetail,
    batteryTelemetry,
    connectionTelemetry,
    condition_index: xrIndex + 1,
    condition_count: xrPlan.length,
    runId,
    suiteId,
    startedAt: new Date().toISOString(),
    ...sceneInfo,
    env: snapshotEnvInfo()
  };

function beginTrialActiveWindow() {
  if (!xrSession || session !== xrSession) return;
  xrLastT = NaN;
  xrLastNow = NaN;
  xrFrameLoopLastNow = NaN;
  xrTrialWallStartNow = performance.now();
  xrActive = true;
  xrBlankClearOnce = false;
  xrAwaitingFirstPoseStart = !!(xrStartOnFirstPose || xrPoseStabilityGateMs > 0);
  xrStartedOnFirstPose = false;
  resetXRPoseStabilityState();
  syncXRNoPoseDiagnosticsToEnv();
  if (xrAwaitingFirstPoseStart) {
    const gateLabel = xrPoseStabilityGateMs > 0
      ? `stable pose (${xrPoseStabilityGateMs}ms gate)`
      : "first pose";
    log(`XR run ${xrIndex+1}/${xrPlan.length}: instances=${item.instances}, trial=${item.trial}/${trials} (preIdle ${preIdleMs}ms, waiting for ${gateLabel})`);
  } else {
    beginXRMeasuredWindow("immediate");
  }
}

// Default keeps true idle semantics. Diagnostic mode can keep submitting a cheap clear during idle gaps.
resetXRNoPoseDiagnostics();
syncXRNoPoseDiagnosticsToEnv();
xrActive = false;
xrBlankClearOnce = xrIdlePresentMode === "none";
if (preIdleMs > 0) {
  setTimeout(beginTrialActiveWindow, preIdleMs);
} else {
  beginTrialActiveWindow();
}

}

function flushUnexpectedXREnd() {
  if (xrResultFlushedForSession) return;
  const incomplete = !xrPlan || xrIndex < xrPlan.length;
  if (incomplete) {
    closeXRSuiteTrace("SUITE_ABORT", {
      testId: "suite",
      trial: "-",
      index: xrIndex + 1,
      total: xrPlan ? xrPlan.length : "-"
    });
  } else {
    closeXRSuiteTrace("SUITE_END", {
      testId: "suite",
      trial: "-",
      index: xrPlan ? xrPlan.length : 0,
      total: xrPlan ? xrPlan.length : 0
    });
  }
  if (incomplete) {
    const reason = xrAbortReason || "XR session ended before suite completion.";
    if (envInfo) {
      envInfo.xr_abort_reason = envInfo.xr_abort_reason || reason;
      if (!Number.isFinite(envInfo.xr_observed_view_count)) envInfo.xr_observed_view_count = 0;
      envInfo.xr_expected_max_views = MAX_COMPARABLE_XR_VIEWS;
    }
    const last = resultsXR[resultsXR.length - 1];
    if (!last || last.aborted !== true) {
      resultsXR.push(buildXRAbortRecord({
        abortCode: "xr_session_ended_early",
        abortReason: reason,
        observedViewCount: Number.isFinite(envInfo?.xr_observed_view_count) ? envInfo.xr_observed_view_count : 0
      }));
    }
  }
  if (resultsXR.length > 0) {
    const label = incomplete ? "XR session ended (partial)" : "XR session ended";
    flushXRResults(xrOutFilename(), label);
  }
}

async function onSessionStarted(session) {
  xrRequesting = false;
  xrAbortReason = null;
  xrResultFlushedForSession = false;
  // Reset XR-specific envInfo fields so re-entry doesn't inherit stale values.
  if (envInfo) {
    delete envInfo.xr_enter_to_first_frame_ms;
    delete envInfo.xr_dom_overlay_requested;
    delete envInfo.xr_abort_reason;
    delete envInfo.xr_observed_view_count;
    delete envInfo.xr_skipped_reason;
    delete envInfo.xr_scale_factor_fallback_used;
    delete envInfo.xr_projection_layer_fallback;
    envInfo.xr_expected_max_views = MAX_COMPARABLE_XR_VIEWS;
    envInfo.xr_start_on_first_pose_requested = xrStartOnFirstPose;
    envInfo.xr_start_on_first_pose_applied = false;
    envInfo.xr_anchor_to_first_pose_requested = xrAnchorToFirstPose;
    envInfo.xr_anchor_to_first_pose_applied = false;
    envInfo.xr_anchor_mode_requested = xrAnchorMode;
    envInfo.xr_pose_stability_gate_ms_requested = xrPoseStabilityGateMs;
    envInfo.xr_pose_stability_pos_tol_m_requested = xrPoseStabilityPosTolM;
    envInfo.xr_pose_stability_yaw_tol_deg_requested = xrPoseStabilityYawTolDeg;
    envInfo.xr_pose_stability_wait_ms = xrPoseStabilityGateMs > 0 ? null : 0;
    envInfo.xr_pose_stability_position_span_m = xrPoseStabilityGateMs > 0 ? null : 0;
    envInfo.xr_pose_stability_yaw_span_deg = xrPoseStabilityGateMs > 0 ? null : 0;
    envInfo.xr_pose_stability_achieved = xrPoseStabilityGateMs <= 0;
    delete envInfo.xr_anchor_pose_yaw_rad;
    delete envInfo.xr_anchor_pose_x;
    delete envInfo.xr_anchor_pose_z;
    envInfo.xr_measurement_waiting_for_first_pose = false;
    envInfo.xr_no_pose_frames = 0;
    envInfo.xr_no_pose_ms_total = 0;
    envInfo.xr_session_mode_requested = xrSessionMode;
    envInfo.xr_session_mode_active = session.mode || xrSessionMode;
  }
  btn.textContent = `Exit ${xrSessionModeLabel}`;
  hudStartAuto(xrHudText);
  session.addEventListener("end", ()=> {
    hudStopAuto();
    xrRequesting = false;
    xrSession=null;
    xrSessionAnchorPose = null;
    btn.textContent = `Enter ${xrSessionModeLabel}`;
    xrActive=false;
    flushUnexpectedXREnd();
  });

  if (typeof gl.makeXRCompatible === "function") {
    try {
      await gl.makeXRCompatible();
    } catch (e) {
      throw new Error(`WebGL makeXRCompatible failed: ${e?.message || e}`);
    }
  }
  if (!xrSession) return;

  const scaleCandidates = (() => {
    const base = [xrScaleFactor, 0.75, 0.5, 0.35, 0.25];
    const out = [];
    for (const v of base) {
      if (!Number.isFinite(v) || v <= 0) continue;
      if (v > xrScaleFactor) continue;
      if (!out.some((x) => Math.abs(x - v) < 1e-6)) out.push(v);
    }
    return out.length ? out : [xrScaleFactor];
  })();

  const layerAttemptErrors = [];
  let baseLayer = null;
  let appliedScale = null;
  let usedScaleFallback = false;

  for (let i = 0; i < scaleCandidates.length; i++) {
    const s = scaleCandidates[i];
    try {
      baseLayer = new XRWebGLLayer(session, gl, { framebufferScaleFactor: s });
      appliedScale = s;
      usedScaleFallback = i > 0;
      break;
    } catch (e) {
      layerAttemptErrors.push(`scale=${s}: ${e?.message || e}`);
    }
  }

  if (!baseLayer) {
    try {
      baseLayer = new XRWebGLLayer(session, gl);
      appliedScale = null;
      usedScaleFallback = true;
      if (envInfo) envInfo.xr_projection_layer_fallback = "default_without_scale";
    } catch (e) {
      layerAttemptErrors.push(`no-scale: ${e?.message || e}`);
      throw new Error(`Failed to create WebGL XR base layer (${layerAttemptErrors.join("; ")})`);
    }
  }
  session.updateRenderState({ baseLayer });
  if (envInfo) {
    envInfo.xr_scale_factor_requested = xrScaleFactor;
    envInfo.xr_scale_factor_applied = appliedScale;
    envInfo.xr_scale_factor_fallback_used = usedScaleFallback;
    if (usedScaleFallback && !envInfo.xr_projection_layer_fallback) {
      envInfo.xr_projection_layer_fallback = `framebufferScaleFactor=${appliedScale == null ? "default" : appliedScale}`;
    }
  }
  if (usedScaleFallback) {
    log(`XR base layer fallback applied (${envInfo?.xr_projection_layer_fallback || "unknown"}).`);
  }
  xrRefSpace = await session.requestReferenceSpace("local");
  if (!xrSession) return;

  resultsXR = [];
  xrPlan = buildPlan();
  xrIndex = 0;
  xrSessionAnchorPose = null;
  xrSuiteTraceClosed = false;
  traceMark("SUITE_START", { mode: "xr", testId: "suite", trial: "-", index: 1, total: xrPlan.length });
  updateTraceOverlay(`mode=xr\nsuite=${suiteId}\nrunId=${runId}`);
  log(`XR timing policy: preIdle=${preIdleMs}ms, measured=${durationMs}ms, postIdle=${postIdleMs}ms, cooldown=${cooldownMs}ms, betweenInstances=${betweenInstancesMs}ms on instance changes, warmup=${warmupMs}ms before each trial, xrAnchorMode=${xrAnchorMode}, xrPoseStabilityGateMs=${xrPoseStabilityGateMs}.`);

  await sleep(warmupMs);
  if (!xrSession) return;
  startNextXRTrial(session);
  session.requestAnimationFrame(onXRFrame);
}

const _vp = new Float32Array(16);
function onXRFrame(t, frame) {
  const session = frame.session;
  session.requestAnimationFrame(onXRFrame);

if (!xrActive || !xrStats) {
  const keepIdlePresentationAlive = xrIdlePresentMode === "clear_each_frame";
  if (xrBlankClearOnce || keepIdlePresentationAlive) {
    // Diagnostic-only mode can keep a cheap clear visible during idle gaps.
    let attemptedIdleClear = false;
    try {
      const pose = frame.getViewerPose(xrRefSpace);
      if (pose) {
        if (!ensureComparableXRViews(session, pose)) return;
        attemptedIdleClear = true;
        const glLayer = session.renderState.baseLayer;
        gl.bindFramebuffer(gl.FRAMEBUFFER, glLayer.framebuffer);
        gl.clearColor(0,0,0,1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.flush?.();
      }
    } catch (_) {}
    if (attemptedIdleClear && !keepIdlePresentationAlive) xrBlankClearOnce = false;

    if (xrEnterClickedAt != null && envInfo && envInfo.xr_enter_to_first_frame_ms == null) {
      envInfo.xr_enter_to_first_frame_ms = performance.now() - xrEnterClickedAt;
      envInfo.xr_dom_overlay_requested = hudEnabled;
    }
  }
  return;
}


  const now = performance.now();
  const havePrev = Number.isFinite(xrLastT) && Number.isFinite(xrLastNow);
  const dtT = havePrev ? (t - xrLastT) : null;
  const dtNow = havePrev ? (now - xrLastNow) : null;
  const frameLoopHavePrev = Number.isFinite(xrFrameLoopLastNow);
  const frameLoopDtNow = frameLoopHavePrev ? (now - xrFrameLoopLastNow) : null;

  const pose = frame.getViewerPose(xrRefSpace);
  if (!pose) {
    xrNoPoseFrames++;
    if (Number.isFinite(frameLoopDtNow) && frameLoopDtNow >= 0) {
      xrNoPoseMsTotal += frameLoopDtNow;
    }
    syncXRNoPoseDiagnosticsToEnv();
    xrFrameLoopLastNow = now;
    const elapsedMs = xrPoseTimeoutElapsedMs(now);
    if (!xrFinalizing && elapsedMs != null && elapsedMs > (durationMs + xrNoPoseGraceMs) && xrDts.length < minFrames) {
      xrFinalizing = true;
      abortXRForPoseTimeout(session, elapsedMs, xrAwaitingFirstPoseStart);
    }
    return;
  }
  if (!ensureComparableXRViews(session, pose)) return;
  if (xrAwaitingFirstPoseStart && !isXRMeasurementStarted()) {
    if (xrPoseStabilityGateMs > 0) {
      const stable = updateXRPoseStabilityGate(pose, now);
      if (!stable.stable) {
        const elapsedMs = xrPoseTimeoutElapsedMs(now);
        if (!xrFinalizing && elapsedMs != null && elapsedMs > (durationMs + xrNoPoseGraceMs) && xrDts.length < minFrames) {
          xrFinalizing = true;
          abortXRForPoseStabilityTimeout(session, elapsedMs);
        }
        xrFrameLoopLastNow = now;
        return;
      }
      maybeAnchorXRInstancesToPose(pose);
      beginXRMeasuredWindow("stable_pose");
    } else {
      maybeAnchorXRInstancesToPose(pose);
      beginXRMeasuredWindow("first_pose");
    }
  }
  maybeAnchorXRInstancesToPose(pose);

  const glLayer = session.renderState.baseLayer;
  gl.bindFramebuffer(gl.FRAMEBUFFER, glLayer.framebuffer);
  gl.clearColor(0.05,0.05,0.08,1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  let framePixelTotal = 0;
  const frameViewPixels = [];
  const frameViewports = [];
  for (const view of pose.views) {
    const vp = glLayer.getViewport(view);
    const vpObj = { x: vp.x, y: vp.y, w: vp.width, h: vp.height };
    xrViewports.push(vpObj);
    frameViewports.push(vpObj);
    const px = vp.width * vp.height;
    framePixelTotal += px;
    frameViewPixels.push(px);
    gl.viewport(vp.x, vp.y, vp.width, vp.height);
    computeViewProj(_vp, view.projectionMatrix, view.transform.inverse.matrix);
    renderer.drawForView(_vp);
  }
  if (xrFirstFramePixels == null) {
    xrFirstFramePixels = framePixelTotal;
    xrFirstFrameViewPixels = frameViewPixels;
    markXRRenderProbeFirstFrame(framePixelTotal);
    sampleXRPixelDiffWebGL(frameViewports, [13, 13, 20, 255]);
    if (xrRenderProbe?.performed && xrRenderProbe.readback_allowed === null) {
      xrRenderProbe.readback_allowed = false;
    }
  }

  if (xrEnterClickedAt != null && envInfo && envInfo.xr_enter_to_first_frame_ms == null) {
    envInfo.xr_enter_to_first_frame_ms = performance.now() - xrEnterClickedAt;
    envInfo.xr_dom_overlay_requested = hudEnabled;
  }

  if (havePrev) {
    xrDts.push(dtT);
    xrDtsNow.push(dtNow);
    xrStats.addFrame(dtT);
  }
  xrLastT = t;
  xrLastNow = now;
  xrFrameLoopLastNow = now;

  if (!isXRMeasurementStarted()) return;
  const elapsedMs = now - xrStats.startWall;
  const minFramesMet = xrDts.length >= minFrames;
  const durationMet = elapsedMs > durationMs;
  if (durationMet && !minFramesMet && !xrMinFramesWaitLogged) {
    xrMinFramesWaitLogged = true;
    log(`XR minFrames gate: collected ${xrDts.length}/${minFrames} frames after durationMs; extending run.`);
  }

  if (durationMet && minFramesMet && !xrFinalizing) {
    xrFinalizing = true;
    xrActive = false;
    try {
      finalizeXRTrial(session);
    } catch (e) {
      xrFinalizing = false;
      const reason = `XR finalize failed: ${e?.message || e}`;
      xrAbortReason = reason;
      if (envInfo) envInfo.xr_abort_reason = reason;
      resultsXR.push(buildXRAbortRecord({
        abortCode: "xr_finalize_failed",
        abortReason: reason,
        observedViewCount: Number.isFinite(envInfo?.xr_observed_view_count) ? envInfo.xr_observed_view_count : 0
      }));
      flushXRResults(xrOutFilename(), "XR finalize failed");
      Promise.resolve(session.end()).catch(()=>{});
    }
  }
}

async function main() {
  installGlobalErrorListeners();
  installCanvasCrashLifecycleListeners();

  const appliedCanvasDpr = applyCanvasResolutionScale();

  enforceOrderControls(apiLabel);

  log("Loading model...");
  await initGL();
  if (runMode !== "canvas") {
    await initXR();
  } else {
    btn.disabled = true;
    btn.textContent = "XR disabled (mode=canvas)";
  }
  offerRecoveredCanvasCheckpoint();
  offerRecoveredCanvasCrashDiagnostics();

  if (runMode === "xr") {
    log(`Ready (XR-only). Canvas auto-run disabled. Enter ${xrSessionModeLabel} to start XR suite. runId=${runId}, mode=${runMode}, xrSessionMode=${xrSessionMode}, manualStart=${manualStart ? "ON" : "OFF"}, canvasScaleFactor=${canvasScaleFactor}, canvasDpr=${appliedCanvasDpr.toFixed(3)}, xrScaleFactor=${xrScaleFactor}, minFrames=${minFrames}, xrStartOnFirstPose=${xrStartOnFirstPose ? "ON" : "OFF"}, xrAnchorToFirstPose=${xrAnchorToFirstPose ? "ON" : "OFF"}, xrAnchorMode=${xrAnchorMode}, xrIdlePresentMode=${xrIdlePresentMode}, xrPoseStabilityGateMs=${xrPoseStabilityGateMs}, xrProbeReadback=${xrProbeReadback ? "ON" : "OFF"}, manualDownload=${manualDownload ? "ON" : "OFF"}.`);
    return;
  }

  if (manualStart) {
    canvasRunScheduled = true; // also blocks XR entry in mode=both until canvas completes
    setManualCanvasStartButtonState({
      visible: true,
      enabled: true,
      text: "Start Canvas Suite"
    });
    log(`Ready. Manual canvas start is ON (manualStart=1). Start trace tooling, then click "Start Canvas Suite". runId=${runId}, instances=[${instancesList.join(",")}], trials=${trials}, durationMs=${durationMs}, minFrames=${minFrames}, layout=${layout}, seed=${seed}, mode=${runMode}, xrSessionMode=${xrSessionMode}, canvasScaleFactor=${canvasScaleFactor}, canvasDpr=${appliedCanvasDpr.toFixed(3)}, canvasAutoDelayMs=${canvasAutoDelayMs}, xrStartOnFirstPose=${xrStartOnFirstPose ? "ON" : "OFF"}, xrAnchorToFirstPose=${xrAnchorToFirstPose ? "ON" : "OFF"}, xrAnchorMode=${xrAnchorMode}, xrIdlePresentMode=${xrIdlePresentMode}, xrPoseStabilityGateMs=${xrPoseStabilityGateMs}, xrProbeReadback=${xrProbeReadback ? "ON" : "OFF"}, manualDownload=${manualDownload ? "ON" : "OFF"}.`);
    return;
  }

  log(`Ready. Auto-running canvas suite in ${canvasAutoDelayMs}ms: runId=${runId}, instances=[${instancesList.join(",")}], trials=${trials}, durationMs=${durationMs}, minFrames=${minFrames}, layout=${layout}, seed=${seed}, mode=${runMode}, xrSessionMode=${xrSessionMode}, canvasScaleFactor=${canvasScaleFactor}, canvasDpr=${appliedCanvasDpr.toFixed(3)}, manualStart=${manualStart ? "ON" : "OFF"}, xrStartOnFirstPose=${xrStartOnFirstPose ? "ON" : "OFF"}, xrAnchorToFirstPose=${xrAnchorToFirstPose ? "ON" : "OFF"}, xrAnchorMode=${xrAnchorMode}, xrIdlePresentMode=${xrIdlePresentMode}, xrPoseStabilityGateMs=${xrPoseStabilityGateMs}, xrProbeReadback=${xrProbeReadback ? "ON" : "OFF"}, manualDownload=${manualDownload ? "ON" : "OFF"}.`);
  canvasRunScheduled = true;
  setTimeout(() => startCanvasSuiteNow("auto_delay"), canvasAutoDelayMs);
}

main().catch(e=>{ console.error(e); log(String(e)); });
