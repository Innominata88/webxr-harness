// src/app-webgpu.js
import { loadGLBMesh } from "./common/glb-loader.js";
import { RunStats } from "./common/metrics.js";
import { WebGPUMeshRenderer } from "./webgpu/renderer-webgpu.js";

const params = new URLSearchParams(location.search);

const suiteId = params.get("suiteId") || `suite_${Date.now()}`;
const modelUrl = params.get("model") || "./assets/model.glb";
const durationMs = parseInt(params.get("durationMs") || "10000", 10);
const trials = parseInt(params.get("trials") || "1", 10);
const warmupMs = parseInt(params.get("warmupMs") || "500", 10);
const cooldownMs = parseInt(params.get("cooldownMs") || "250", 10);
const betweenInstancesMs = parseInt(params.get("betweenInstancesMs") || "800", 10);
const outFile = params.get("out") || `results_webgpu_${Date.now()}.jsonl`;
const SCHEMA_VERSION = "1.1.0";

const layout = (params.get("layout") || "line").toLowerCase();
const seed = parseInt(params.get("seed") || "12345", 10) >>> 0;
const shuffle = (params.get("shuffle") || "0") === "1";
const storeFrames = (params.get("storeFrames") || "0") === "1";


// Instance spacing (scene density). Keep identical between WebGL/WebGPU for fair comparisons.
const spacing = (() => {
  const v = parseFloat(params.get("spacing") || "0.35");
  return (Number.isFinite(v) && v > 0) ? v : 0.35;
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
const isApplePlatform = detectApplePlatform();
const manualDownload = (() => {
  if (!isApplePlatform) return (params.get("manualDownload") || "0") === "1";
  // Apple default ON unless explicitly disabled
  return (params.get("manualDownload") || "1") !== "0";
})();

// Lightweight Chrome/PerformancePanel-friendly instrumentation

// Optional idle windows that render a blank frame once, then do no drawing.
// Recommended for experiments: preIdleMs=1000&postIdleMs=1000 (defaults are 0 for backward compatibility).
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
const apiLabel = "webgpu";

const runMode = (() => {
  // Accept either ?mode= or ?runMode= (some runs used runMode=canvas).
  const raw = (params.get("runMode") || params.get("mode") || "both");
  const v = String(raw).toLowerCase();
  return (v === "canvas" || v === "xr" || v === "both") ? v : "both";
})();
const canvasAutoDelayMs = parseInt(params.get("canvasAutoDelayMs") || "1000", 10);
const xrScaleFactor = (() => {
  const v = parseFloat(params.get("xrScaleFactor") || "1");
  return (Number.isFinite(v) && v > 0) ? Math.min(2.0, Math.max(0.25, v)) : 1.0;
})();

// Session-order control for ABBA/BAAB/randomized protocols
const enforceOrder = (params.get("enforceOrder") || "0") === "1";
const orderMode = (params.get("orderMode") || "none").toLowerCase(); // none|abba|baab|randomized
const orderIndex = parseInt(params.get("orderIndex") || "0", 10);
const assignedApi = (params.get("assignedApi") || "").toLowerCase();
const orderSeed = params.get("orderSeed") || null;
const pinGpu = (params.get("pinGpu") || "0") === "1";
const sessionGroup = params.get("sessionGroup") || "default";

function expectedApiForOrder(mode, index) {
  if (!Number.isFinite(index) || index < 1) return null;
  if (mode === "abba") {
    const seq = ["webgl2", "webgpu", "webgpu", "webgl2"];
    return seq[index - 1] || null;
  }
  if (mode === "baab") {
    const seq = ["webgpu", "webgl2", "webgl2", "webgpu"];
    return seq[index - 1] || null;
  }
  return null;
}

function enforceOrderControls(apiName) {
  if (!enforceOrder) return;
  if (orderMode === "abba" || orderMode === "baab") {
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

let device=null, context=null, depthTex=null, colorFormat=null, adapterInfo=null;
let xrSession=null, xrRefSpace=null, xrGpuBinding=null, projectionLayer=null;
let renderer=null;
let xrRequesting=false;
let xrResultFlushedForSession=false;

let sceneInfo=null;
let sceneMesh=null;
let envInfo=null;
let resultsCanvas=[];
let resultsXR=[];
let canvasRunInProgress=false;
let canvasRunScheduled=false;

function log(msg){ status.textContent = msg; console.log(msg); }


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

const _pendingDownloads = []; // {label, filename, text, mime}
let _resultsPanelEl = null;

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
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
  panel.style.display = "none";

  panel.innerHTML = `
    <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:8px;">
      <div style="font-weight:600;">Results ready</div>
      <button id="rpClose" style="padding:6px 8px; border-radius:10px;">Close</button>
    </div>
    <div id="rpBody" style="display:flex; flex-direction:column; gap:10px;"></div>
    <div id="rpFooter" style="margin-top:10px; opacity:0.85;"></div>
  `;
  document.body.appendChild(panel);

  panel.querySelector("#rpClose").addEventListener("click", () => {
    panel.style.display = "none";
  });

  _resultsPanelEl = panel;
  return panel;
}

function renderResultsPanel() {
  const panel = ensureResultsPanel();
  const body = panel.querySelector("#rpBody");
  const footer = panel.querySelector("#rpFooter");
  body.innerHTML = "";

  for (const item of _pendingDownloads) {
    const row = document.createElement("div");
    row.style.display = "grid";
    row.style.gridTemplateColumns = "1fr auto auto";
    row.style.gap = "8px";
    row.style.alignItems = "center";

    const label = document.createElement("div");
    label.textContent = `${item.label} — ${item.filename}`;
    label.style.opacity = "0.95";

    const btnDl = document.createElement("button");
    btnDl.textContent = "Download";
    btnDl.style.padding = "6px 10px";
    btnDl.style.borderRadius = "10px";
    btnDl.addEventListener("click", () => {
      downloadTextAuto(item.text, item.filename, item.mime);
    });

    const btnCopy = document.createElement("button");
    btnCopy.textContent = "Copy";
    btnCopy.style.padding = "6px 10px";
    btnCopy.style.borderRadius = "10px";
    btnCopy.addEventListener("click", async () => {
      const ok = await copyToClipboard(item.text);
      btnCopy.textContent = ok ? "Copied" : "Copy failed";
      setTimeout(()=>btnCopy.textContent="Copy", 1200);
    });

    row.appendChild(label);
    row.appendChild(btnDl);
    row.appendChild(btnCopy);
    body.appendChild(row);
  }

  footer.textContent = manualDownload
    ? "On Apple devices, downloads must be initiated by a tap. Use the buttons above."
    : "Downloads were triggered automatically. If you don’t see the file, use Copy or re-run with manualDownload=1.";

  panel.style.display = "block";
}

function queueDownload(text, filename, label="Results", mime="application/jsonl") {
  _pendingDownloads.push({ label, filename, text, mime });
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

function xrOutFilename() {
  return params.get("outxr") || `results_webgpu_xr_${Date.now()}.jsonl`;
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
  if (!device || !context) return;
  try {
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: context.getCurrentTexture().createView(),
        loadOp: "clear",
        storeOp: "store",
        clearValue: [0, 0, 0, 1]
      }],
      depthStencilAttachment: {
        view: depthTex.createView(),
        depthLoadOp: "clear",
        depthStoreOp: "store",
        depthClearValue: 1.0
      }
    });
    pass.end();
    device.queue.submit([encoder.finish()]);
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

async function ensureCanvasRenderProbe() {
  if (!renderProbe || _renderProbeDoneCanvas || !device || !context || !renderer) return;
  _renderProbeDoneCanvas = true;

  try {
    const n = Math.max(1, Math.min(4, instancesList[0] || 1));
    renderer.setInstances(n, spacing, { layout, seed });

    const clear = [1.0, 0.0, 1.0, 1.0]; // magenta
    const w = 4, h = 4;

    // Offscreen render target for a safe readback (doesn't require swapchain COPY_SRC).
    const offColor = device.createTexture({
      size: [w, h, 1],
      format: colorFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
    });
    const offDepth = device.createTexture({
      size: [w, h, 1],
      format: "depth24plus",
      usage: GPUTextureUsage.RENDER_ATTACHMENT
    });

    const bytesPerPixel = 4;
    const bytesPerRow = 256; // must be 256-byte aligned for copyTextureToBuffer
    const outBuf = device.createBuffer({
      size: bytesPerRow * h,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: offColor.createView(),
        loadOp: "clear",
        storeOp: "store",
        clearValue: clear
      }],
      depthStencilAttachment: {
        view: offDepth.createView(),
        depthLoadOp: "clear",
        depthStoreOp: "store",
        depthClearValue: 1.0
      }
    });

    renderer.draw(pass);
    pass.end();

    encoder.copyTextureToBuffer(
      { texture: offColor },
      { buffer: outBuf, bytesPerRow, rowsPerImage: h },
      { width: w, height: h, depthOrArrayLayers: 1 }
    );

    device.queue.submit([encoder.finish()]);

    await outBuf.mapAsync(GPUMapMode.READ);
    const mapped = new Uint8Array(outBuf.getMappedRange()).slice();
    outBuf.unmap();

    const clear8 = rgba8FromClear(clear);
    let diff = 0;
    for (let y=0;y<h;y++) {
      for (let x=0;x<w;x++) {
        const i = y*bytesPerRow + x*bytesPerPixel;
        const dr = Math.abs(mapped[i+0] - clear8[0]);
        const dg = Math.abs(mapped[i+1] - clear8[1]);
        const db = Math.abs(mapped[i+2] - clear8[2]);
        if (dr + dg + db > 6) diff++;
      }
    }
    const rendered_anything = diff > 0;

    envInfo.render_probe_canvas = {
      performed: true,
      rendered_anything,
      sample_px: { w, h },
      diff_pixels: diff,
      clear_rgba8: clear8,
      first_rgba8: [mapped[0], mapped[1], mapped[2], mapped[3]],
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

function perspectiveZO(fovy, aspect, near, far=Infinity) {
  const out=new Float32Array(16);
  const f=1.0/Math.tan(fovy/2);
  out[0]=f/aspect; out[5]=f; out[11]=-1;
  out[1]=out[2]=out[3]=out[4]=out[6]=out[7]=out[8]=out[9]=out[12]=out[13]=out[15]=0;
  if (far!==Infinity) {
    const nf=1/(near-far);
    out[10]=far*nf;
    out[14]=far*near*nf;
  } else {
    out[10]=-1;
    out[14]=-near;
  }
  return out;
}

function identityView(z=-2.0) {
  const v=new Float32Array(16);
  v.set([
    1,0,0,0,
    0,1,0,0,
    0,0,1,0,
    0,0,z,1
  ]);
  return v;
}

function buildPlan() {
  const plan=[];
  for (const inst of instancesList) {
    for (let t=1; t<=trials; t++) plan.push({ instances: inst, trial: t });
  }
  if (shuffle) shuffleInPlace(plan, seed);
  return plan;
}

async function initWebGPU() {
  if (!navigator.gpu) throw new Error("WebGPU not supported");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference:"high-performance", xrCompatible:true });
  if (!adapter) throw new Error("No WebGPU adapter");
  device = await adapter.requestDevice();
  adapterInfo = await adapter.requestAdapterInfo?.().catch(()=>null);
// Capture reproducibility info (works even when adapterInfo is unavailable)
const adapter_features = Array.from(adapter.features || []).map(String);
const device_features = Array.from(device.features || []).map(String);
function copyLimits(lim) {
  const out = {};
  try {
    const keys = Object.keys(lim);
    if (keys && keys.length) {
      for (const k of keys) out[k] = Number(lim[k]);
      return out;
    }
  } catch (_) {}
  try {
    const keys = Object.getOwnPropertyNames(lim);
    for (const k of keys) {
      try {
        const v = lim[k];
        if (typeof v === "number") out[k] = v;
        else if (typeof v === "bigint") out[k] = Number(v);
      } catch (_) {}
    }
  } catch (_) {}
  return out;
}
const adapter_limits = copyLimits(adapter.limits || {});
const device_limits = copyLimits(device.limits || {});

  context = canvas.getContext("webgpu");
  colorFormat = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format: colorFormat, alphaMode: "opaque" });

  depthTex = device.createTexture({
    size: [canvas.width, canvas.height, 1],
    format: "depth24plus",
    usage: GPUTextureUsage.RENDER_ATTACHMENT
  });

  renderer = new WebGPUMeshRenderer(device, colorFormat, "depth24plus");

  const scene = await loadGLBMesh(modelUrl);
  sceneMesh = { positions: scene.positions, indices: scene.indices };
  renderer.setMesh(sceneMesh);

  // Set default camera for canvas mode
  const proj = perspectiveZO(Math.PI/3, canvas.clientWidth/canvas.clientHeight, 0.1, 100.0);
  const view = identityView(-2.0);
  renderer.setCamera(proj, view);

  renderer.setInstances(instancesList[0], spacing, { layout, seed });

  sceneInfo = { asset_timing: scene.timing, asset_meta: scene.meta };
  envInfo = {
    api: "webgpu",
    adapterRequest: { powerPreference:"high-performance", xrCompatible:true },
    powerPreferenceRequested: "high-performance",
    xrCompatibleRequested: true,
    hudEnabled,
    hudHz,
    xr_expected_max_views: MAX_COMPARABLE_XR_VIEWS,
    xr_scale_factor_requested: xrScaleFactor,
    xr_scale_factor_applied: null,
    runMode,
    order_control: {
      enforceOrder,
      orderMode,
      orderIndex,
      assignedApi: assignedApi || null,
      orderSeed,
      pinGpu,
      sessionGroup
    },
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
    dpr: devicePixelRatio,
    canvas_css: { w: canvas.clientWidth, h: canvas.clientHeight },
    canvas_px: { w: canvas.width, h: canvas.height },
    adapter: adapterInfo || null,
    adapter_features,
    adapter_limits,
    device_features,
    device_limits,
    colorFormat,
    url: location.href
  };

  const adapterVendor = adapterInfo?.vendor || "unknown";
  const adapterDevice = adapterInfo?.device || "unknown";
  const adapterArch = adapterInfo?.architecture || "unknown";
  const gpuIdentity = `webgpu:${adapterVendor}|${adapterDevice}|${adapterArch}`;
  envInfo.gpu_identity = gpuIdentity;
  enforcePinnedGpuIdentity(gpuIdentity);
}

function runCanvasTrial(item, planIdx, planLen) {
  renderer.setInstances(item.instances, spacing, { layout, seed });

  const dts = [];
  return new Promise((resolve) => {
    const stats = new RunStats();
    stats.meta = {
      schema_version: SCHEMA_VERSION,
      api:"webgpu",
      mode:"canvas",
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
      layout,
      seed,
      shuffle,
      spacing,
      collectPerf,
      perfDetail,
      condition_index: planIdx + 1,
      condition_count: planLen,
      suiteId,
      startedAt: new Date().toISOString(),
      ...sceneInfo,
      env: envInfo
    };

    const trialId = `trial_webgpu_canvas_inst${item.instances}_t${item.trial}_idx${planIdx+1}`;
    const memStart = collectPerf ? snapshotMemory() : null;
    if (collectPerf) {
      try {
        performance.mark(`${trialId}_start`);
        console.timeStamp?.(`${trialId}_start`);
      } catch (_) {}
    }
    
    function beginMeasured() {
      stats.markStart();
      let lastT = NaN;

      function frame(t) {
      if (Number.isFinite(lastT)) {
        const dt = t - lastT;
        dts.push(dt);
        stats.addFrame(dt);
      }
      lastT = t;

      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: context.getCurrentTexture().createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: [0.08,0.08,0.1,1]
        }],
        depthStencilAttachment: {
          view: depthTex.createView(),
          depthLoadOp: "clear",
          depthStoreOp: "store",
          depthClearValue: 1.0
        }
      });

      renderer.draw(pass);
      pass.end();
      device.queue.submit([encoder.finish()]);

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
        
          if (!perfDetail) {
            try {
              performance.clearMarks(`${trialId}_start`);
              performance.clearMarks(`${trialId}_end`);
              performance.clearMeasures(trialId);
            } catch (_) {}
          }
        }
        
        const out = { ...stats.meta, summary, extras, perf };
        if (storeFrames) out.frames_ms = dts;
        if (postIdleMs > 0) {
  clearCanvasBlankOnce();
  setTimeout(() => resolve(out), postIdleMs);
} else {
  resolve(out);
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
  try {
    resultsCanvas = [];
    await ensureCanvasRenderProbe();
    const plan = buildPlan();

    for (let i=0;i<plan.length;i++) {
      const item = plan[i];

      if (i>0 && plan[i-1].instances !== item.instances) {
        log(`Between-instances cooldown (${betweenInstancesMs}ms)`);
        await sleep(betweenInstancesMs);
      }

      log(`Canvas run ${i+1}/${plan.length}: instances=${item.instances}, trial=${item.trial}/${trials} (warmup ${warmupMs}ms)`);
      await sleep(warmupMs);

      const out = await runCanvasTrial(item, i, plan.length);
      resultsCanvas.push(out);

      await sleep(cooldownMs);
    }

    const jsonl = resultsCanvas.map(o=>JSON.stringify(o)).join("\n") + "\n";
    downloadText(jsonl, outFile, "Canvas results");
    log(`Done (canvas). ${manualDownload ? "Queued" : "Downloaded"} ${outFile}`);
    clearCanvasBlankOnce();
  } finally {
    canvasRunInProgress = false;
  }
}

async function initXR() {
  if (!navigator.xr) { log("WebXR not supported (canvas-only)"); return; }
  if (!("XRGPUBinding" in window)) { log("WebXR/WebGPU interop not supported here (canvas-only)"); return; }
  const supported = await navigator.xr.isSessionSupported("immersive-vr").catch(()=>false);
  if (!supported) { log("Immersive VR not supported here (canvas-only)"); return; }

  btn.disabled=false;
  btn.textContent="Enter VR";
  btn.addEventListener("click", async ()=>{
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
        const opts = {
          requiredFeatures: ["webgpu"],
          ...(hudEnabled ? { optionalFeatures:["dom-overlay"], domOverlay:{ root: document.body } } : {})
        };
        xrResultFlushedForSession = false;
        xrAbortReason = null;
        xrEnterClickedAt = performance.now();
        xrRequesting = true;
        const session = await navigator.xr.requestSession("immersive-vr", opts);
        xrRequesting = false;
        xrSession = session;
        await onSessionStarted(session);
      } catch (e) {
        xrRequesting = false;
        const failedSession = xrSession;
        xrSession = null;
        xrEnterClickedAt = null;
        if (failedSession) {
          try { await failedSession.end(); } catch (_) {}
        }
        const reason = `XR session failed before suite completion: ${e?.message || e}`;
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
              observedViewCount: 0
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
let xrEnterClickedAt = null;       // performance.now() when user clicked Enter VR
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


function fmtMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return "n/a";
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms/1000).toFixed(1)}s`;
}

function currentXRPlanItem() {
  return (xrPlan && xrIndex >= 0 && xrIndex < xrPlan.length) ? xrPlan[xrIndex] : null;
}

function buildXRAbortRecord({ abortCode, abortReason, observedViewCount=0 } = {}) {
  const cur = currentXRPlanItem();
  const elapsedMs = (xrStats && xrStats.startWall) ? Math.max(0, performance.now() - xrStats.startWall) : null;
  return {
    schema_version: SCHEMA_VERSION,
    api: "webgpu",
    mode: "xr",
    aborted: true,
    abort_code: abortCode || "xr_session_ended_early",
    abort_reason: abortReason || "XR session ended before suite completion.",
    observed_view_count: Number.isFinite(observedViewCount) ? observedViewCount : 0,
    expected_max_views: MAX_COMPARABLE_XR_VIEWS,
    suiteId,
    modelUrl,
    instances: cur ? cur.instances : null,
    trial: cur ? cur.trial : null,
    trials,
    durationMs,
    warmupMs,
    cooldownMs,
    preIdleMs,
    postIdleMs,
    betweenInstancesMs,
    layout,
    seed,
    shuffle,
    spacing,
    collectPerf,
    perfDetail,
    condition_index: cur ? (xrIndex + 1) : null,
    condition_count: xrPlan ? xrPlan.length : null,
    startedAt: new Date().toISOString(),
    partial_trial: {
      elapsed_ms: elapsedMs,
      frames_collected_t: xrDts ? xrDts.length : 0,
      frames_collected_now: xrDtsNow ? xrDtsNow.length : 0
    },
    ...sceneInfo,
    env: envInfo,
    xr_effective_pixels: {
      requested_scale_factor: xrScaleFactor,
      applied_scale_factor: envInfo?.xr_scale_factor_applied ?? null,
      first_frame_total_px: xrFirstFramePixels,
      first_frame_per_view_px: xrFirstFrameViewPixels || []
    },
    xr_cadence_secondary: summarizeSeries(xrDtsNow),
    xr_viewports: xrViewports || []
  };
}

function abortXRForComparability(session, observedViews) {
  if (xrAbortReason) return;
  xrAbortReason = `XR aborted: observed ${observedViews} views; max allowed is ${MAX_COMPARABLE_XR_VIEWS} for cross-API comparability.`;
  if (envInfo) {
    envInfo.xr_abort_reason = xrAbortReason;
    envInfo.xr_observed_view_count = observedViews;
    envInfo.xr_expected_max_views = MAX_COMPARABLE_XR_VIEWS;
  }
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
    const elapsed = performance.now() - xrStats.startWall;
    const rem = Math.max(0, durationMs - elapsed);
    return `XR run ${xrIndex+1}/${total}\ninstances=${inst}  trial=${tr}/${trials}\nremaining=${fmtMs(rem)}\napi=${(envInfo&&envInfo.api)||"?"}`;
  }
  return `XR idle ${xrIndex+1}/${total}\nnext instances=${inst}  trial=${tr}/${trials}`;
}


function startNextXRTrial(session) {
  if (!xrSession || session !== xrSession) return;
  if (xrAbortReason) {
    xrActive=false;
    Promise.resolve(session.end()).catch(()=>{});
    return;
  }
  if (!xrPlan || xrIndex >= xrPlan.length) {
    flushXRResults();
    xrActive=false;
    session.end();
    return;
  }

  const item = xrPlan[xrIndex];
  renderer.setInstances(item.instances, spacing, { layout, seed, isXR: true, xrFrontMinZ, xrYOffset });

  xrDts = [];
  xrDtsNow = [];
  xrViewports = [];
  xrFirstFramePixels = null;
  xrFirstFrameViewPixels = null;

  xrStats = new RunStats();
  xrStats.meta = {
    schema_version: SCHEMA_VERSION,
    api:"webgpu",
    mode:"xr",
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
    layout,
    seed,
    shuffle,
    spacing,
    collectPerf,
    perfDetail,
    condition_index: xrIndex + 1,
    condition_count: xrPlan.length,
    suiteId,
    startedAt: new Date().toISOString(),
    ...sceneInfo,
    env: envInfo
  };

function beginMeasuredXR() {
  if (!xrSession || session !== xrSession) return;
  xrStats.markStart();
  xrTrialId = `trial_webgpu_xr_inst${item.instances}_t${item.trial}_idx${xrIndex+1}`;
  xrMemStart = collectPerf ? snapshotMemory() : null;
  if (collectPerf) {
    try {
      performance.mark(`${xrTrialId}_start`);
      console.timeStamp?.(`${xrTrialId}_start`);
    } catch (_) {}
  }
  xrLastT = NaN;
  xrLastNow = NaN;
  xrActive = true;
  xrBlankClearOnce = false;
  log(`XR run ${xrIndex+1}/${xrPlan.length}: instances=${item.instances}, trial=${item.trial}/${trials} (preIdle ${preIdleMs}ms)`);
}

// Pre-idle: render a single blank frame, then do no drawing until we start the measured window.
xrActive = false;
xrBlankClearOnce = true;
if (preIdleMs > 0) {
  setTimeout(beginMeasuredXR, preIdleMs);
} else {
  beginMeasuredXR();
}

}

function flushUnexpectedXREnd() {
  if (xrResultFlushedForSession) return;
  const incomplete = !xrPlan || xrIndex < xrPlan.length;
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
    envInfo.xr_expected_max_views = MAX_COMPARABLE_XR_VIEWS;
  }
  btn.textContent="Exit VR";
  hudStartAuto(xrHudText);
  session.addEventListener("end", ()=> {
    hudStopAuto();
    xrRequesting = false;
    xrSession=null;
    btn.textContent="Enter VR";
    xrActive=false;
    flushUnexpectedXREnd();
  });

  xrGpuBinding = new XRGPUBinding(session, device);

  const preferred = xrGpuBinding.getPreferredColorFormat();
  if (preferred !== colorFormat) {
    colorFormat = preferred;
    envInfo.colorFormat = colorFormat;
    context.configure({ device, format: colorFormat, alphaMode:"opaque" });
    renderer = new WebGPUMeshRenderer(device, colorFormat, "depth24plus");
    if (!sceneMesh) throw new Error("Scene mesh not loaded");
    renderer.setMesh(sceneMesh);
    // Keep canvas path valid if a canvas trial is active/queued while entering XR.
    const proj = perspectiveZO(Math.PI/3, canvas.clientWidth/canvas.clientHeight, 0.1, 100.0);
    const view = identityView(-2.0);
    renderer.setCamera(proj, view);
  }

  try {
    projectionLayer = xrGpuBinding.createProjectionLayer({
      colorFormat,
      depthStencilFormat: "depth24plus",
      scaleFactor: xrScaleFactor
    });
    if (envInfo) {
      envInfo.xr_scale_factor_requested = xrScaleFactor;
      envInfo.xr_scale_factor_applied = xrScaleFactor;
    }
  } catch (_) {
    projectionLayer = xrGpuBinding.createProjectionLayer({
      colorFormat,
      depthStencilFormat: "depth24plus"
    });
    if (envInfo) {
      envInfo.xr_scale_factor_requested = xrScaleFactor;
      envInfo.xr_scale_factor_applied = null;
    }
  }

  session.updateRenderState({ layers:[projectionLayer] });
  xrRefSpace = await session.requestReferenceSpace("local");
  if (!xrSession) return;

  resultsXR = [];
  xrPlan = buildPlan();
  xrIndex = 0;

  await sleep(warmupMs);
  if (!xrSession) return;
  startNextXRTrial(session);
  session.requestAnimationFrame(onXRFrame);
}

function onXRFrame(t, frame) {
  const session = frame.session;
  session.requestAnimationFrame(onXRFrame);

if (!xrActive || !xrStats) {
  if (xrBlankClearOnce) {
    // Render one blank frame to "park" the compositor, then stop work.
    try {
      const pose = frame.getViewerPose(xrRefSpace);
      if (pose && projectionLayer && xrGpuBinding) {
        if (!ensureComparableXRViews(session, pose)) {
          xrBlankClearOnce = false;
          return;
        }
        const encoder = device.createCommandEncoder();
        for (const view of pose.views) {
          const subImage = xrGpuBinding.getViewSubImage(projectionLayer, view);
          const pass = encoder.beginRenderPass({
            colorAttachments: [{
              view: subImage.colorTexture.createView(subImage.getViewDescriptor()),
              loadOp: "clear",
              storeOp: "store",
              clearValue: [0,0,0,1]
            }]
          });
          pass.end();
        }
        device.queue.submit([encoder.finish()]);
      }
    } catch (_) {}
    xrBlankClearOnce = false;

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
  xrLastT = t;
  xrLastNow = now;
  if (havePrev) {
    xrDts.push(dtT);
    xrDtsNow.push(dtNow);
    xrStats.addFrame(dtT);
  }

  const pose = frame.getViewerPose(xrRefSpace);
  if (!pose) return;
  if (!ensureComparableXRViews(session, pose)) return;

  const encoder = device.createCommandEncoder();

  let framePixelTotal = 0;
  const frameViewPixels = [];
  for (let viewIndex = 0; viewIndex < pose.views.length; viewIndex++) {
    const view = pose.views[viewIndex];
    const subImage = xrGpuBinding.getViewSubImage(projectionLayer, view);
    renderer.setCamera(view.projectionMatrix, view.transform.inverse.matrix, viewIndex);

    const vp = subImage.viewport;
    xrViewports.push({ x: vp.x, y: vp.y, w: vp.width, h: vp.height });
    const px = vp.width * vp.height;
    framePixelTotal += px;
    frameViewPixels.push(px);

    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: subImage.colorTexture.createView(subImage.getViewDescriptor()),
        loadOp: "clear",
        storeOp: "store",
        clearValue: [0.05,0.05,0.08,1]
      }],
      depthStencilAttachment: {
        view: subImage.depthStencilTexture.createView(subImage.getViewDescriptor()),
        depthLoadOp: "clear",
        depthStoreOp: "store",
        depthClearValue: 1.0
      }
    });

    pass.setViewport(vp.x, vp.y, vp.width, vp.height, 0, 1);
    renderer.draw(pass, viewIndex);
    pass.end();
  }
  if (xrFirstFramePixels == null) {
    xrFirstFramePixels = framePixelTotal;
    xrFirstFrameViewPixels = frameViewPixels;
  }

  device.queue.submit([encoder.finish()]);

  if (xrEnterClickedAt != null && envInfo && envInfo.xr_enter_to_first_frame_ms == null) {
    envInfo.xr_enter_to_first_frame_ms = performance.now() - xrEnterClickedAt;
    envInfo.xr_dom_overlay_requested = hudEnabled;
  }

  if (now - xrStats.startWall > durationMs) {
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
  xr_viewports: xrViewports
};
if (storeFrames) {
  out.frames_ms = xrDts;
  out.frames_ms_now = xrDtsNow;
}

resultsXR.push(out);
    xrIndex++;
    xrActive=false;

    const next = xrPlan[xrIndex];
    const prev = xrPlan[xrIndex-1];
    const pause = (next && prev && next.instances !== prev.instances) ? betweenInstancesMs : warmupMs;
    const totalPause = pause + Math.max(0, postIdleMs|0);
    xrBlankClearOnce = true;
    setTimeout(()=>startNextXRTrial(session), totalPause);
  }
}

async function main() {
  canvas.width = Math.floor(canvas.clientWidth * devicePixelRatio);
  canvas.height = Math.floor(canvas.clientHeight * devicePixelRatio);

  enforceOrderControls(apiLabel);

  log("Loading model...");
  await initWebGPU();
  if (runMode !== "canvas") {
    await initXR();
  } else {
    btn.disabled = true;
    btn.textContent = "XR disabled (mode=canvas)";
  }

  if (runMode === "xr") {
    log(`Ready (XR-only). Canvas auto-run disabled. Enter VR to start XR suite. mode=${runMode}, xrScaleFactor=${xrScaleFactor}.`);
    return;
  }

  log(`Ready. Auto-running canvas suite in ${canvasAutoDelayMs}ms: instances=[${instancesList.join(",")}], trials=${trials}, durationMs=${durationMs}, layout=${layout}, seed=${seed}, mode=${runMode}.`);
  canvasRunScheduled = true;
  setTimeout(() => {
    runCanvasSuite().catch((e) => {
      console.error(e);
      log(String(e));
    });
  }, canvasAutoDelayMs);
}

main().catch(e=>{ console.error(e); log(String(e)); });
