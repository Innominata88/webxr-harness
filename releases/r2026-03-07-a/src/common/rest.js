// src/common/rest.js
// Simple localStorage handoff so the *next* suite can log the actual idle/rest interval.
// This is intentionally tiny and dependency-free.

const REST_KEY = "webxr_harness_rest_v1";

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch (_) { return null; }
}

export function consumeRestHandoff(nowEpochMs, recommendedRestMs=null) {
  const empty = {
    restStartTs: null,
    restEndTs: null,
    restElapsedMs: null,
    recommendedRestMs: (Number.isFinite(recommendedRestMs) && recommendedRestMs > 0) ? recommendedRestMs : null,
    previousSuiteId: null,
    previousApi: null,
    previousRunMode: null,
    previousFinalPhase: null,
    previousOutFile: null,
    previousUrl: null
  };

  let raw = null;
  try { raw = localStorage.getItem(REST_KEY); } catch (_) {}
  if (!raw) return empty;

  const token = safeJsonParse(raw);
  try { localStorage.removeItem(REST_KEY); } catch (_) {}

  if (!token || typeof token !== "object") return empty;
  const restStartTs = Number.isFinite(token.restStartTs) ? token.restStartTs : null;
  const restEndTs = Number.isFinite(nowEpochMs) ? nowEpochMs : Date.now();
  const restElapsedMs = (restStartTs != null) ? Math.max(0, restEndTs - restStartTs) : null;

  return {
    ...empty,
    restStartTs,
    restEndTs,
    restElapsedMs,
    previousSuiteId: (typeof token.previousSuiteId === "string") ? token.previousSuiteId : null,
    previousApi: (typeof token.previousApi === "string") ? token.previousApi : null,
    previousRunMode: (typeof token.previousRunMode === "string") ? token.previousRunMode : null,
    previousFinalPhase: (typeof token.previousFinalPhase === "string") ? token.previousFinalPhase : null,
    previousOutFile: (typeof token.previousOutFile === "string") ? token.previousOutFile : null,
    previousUrl: (typeof token.previousUrl === "string") ? token.previousUrl : null,
  };
}

export function writeRestHandoff({
  suiteId,
  api,
  runMode,
  finalPhase,
  outFile,
  url,
  nowEpochMs
} = {}) {
  const token = {
    restStartTs: Number.isFinite(nowEpochMs) ? nowEpochMs : Date.now(),
    previousSuiteId: (typeof suiteId === "string") ? suiteId : null,
    previousApi: (typeof api === "string") ? api : null,
    previousRunMode: (typeof runMode === "string") ? runMode : null,
    previousFinalPhase: (typeof finalPhase === "string") ? finalPhase : null,
    previousOutFile: (typeof outFile === "string") ? outFile : null,
    previousUrl: (typeof url === "string") ? url : null
  };
  try { localStorage.setItem(REST_KEY, JSON.stringify(token)); } catch (_) {}
}

function looksMobileUA(ua) {
  if (!ua) return false;
  return /Android|iPhone|iPad|iPod|Mobile|Quest|Oculus|VR|Vision|WebView/i.test(ua);
}

export function getRedirectDelayMs({ requestedMs=0, ua="" } = {}) {
  // Safer defaults: downloads on mobile / Safari can take a bit to flush.
  const base = Number.isFinite(requestedMs) && requestedMs > 0 ? requestedMs : 5000;
  const min = looksMobileUA(ua) ? 8000 : 3000;
  const max = 60000;
  return Math.min(max, Math.max(min, Math.floor(base)));
}

export function scheduleCooldownRedirect({
  cooldownPage,
  delayMs,
  betweenSuitesMs=null,
  fromSuiteId=null,
  fromApi=null
} = {}) {
  if (!cooldownPage) return;
  let dest;
  try {
    dest = new URL(cooldownPage, location.href);
  } catch (e) {
    // Malformed URLs should not crash the harness; just skip redirect.
    try { console.warn("Invalid cooldownPage; skipping redirect", cooldownPage, e); } catch (_) {}
    return;
  }
  // Avoid surprising schemes.
  if (dest.protocol !== "http:" && dest.protocol !== "https:") {
    try { console.warn("Unsupported cooldownPage protocol; skipping redirect", dest.protocol); } catch (_) {}
    return;
  }
  if (Number.isFinite(betweenSuitesMs) && betweenSuitesMs > 0) dest.searchParams.set("betweenSuitesMs", String(Math.floor(betweenSuitesMs)));
  if (fromSuiteId) dest.searchParams.set("fromSuiteId", String(fromSuiteId));
  if (fromApi) dest.searchParams.set("fromApi", String(fromApi));
  setTimeout(() => { location.href = dest.toString(); }, delayMs);
}
