#!/usr/bin/env node

import fs from "fs/promises";
import path from "path";

const repoRoot = process.cwd();
const manifestTag = "m2026-06-05-a";
const releaseTag = "r2026-03-24-b";
const harnessCommit = "84bb3bc";
const harnessVersion = releaseTag;
const assetRevision = "spiderman_2002_movie_version_sam_raimi_0";
const modelPath = "./assets/spiderman_2002_movie_version_sam_raimi_0.glb";
const harnessBaseUrl = `https://innominata88.github.io/webxr-harness/releases/${releaseTag}/`;
const packBaseUrl = `https://innominata88.github.io/webxr-harness/manifest-packs/${manifestTag}/manifests/`;
const launcherBaseUrl = `${harnessBaseUrl}run-launcher.html`;
const requiredFlagsProfileId = "webxr-webgpu-flags-v1";
const requiredFlagsExact = "webxr_projection_layers=1;webxr_webgpu_binding=1;webgpu=1";
const chromeProfilerConfig = "chrome_perf:screenshots=0,memory=1";

const deviceConfigs = [
  {
    slug: "samsung_fe5g",
    suitePrefix: "SAMSUNG_FE5G",
    deviceLabel: "Samsung Galaxy FE",
    deviceTag: "samsung-fe5g",
    browserTag: "chrome-android",
    xrPoseStabilityGateMs: "500",
    xrPoseStabilityPosTolM: "0.12",
    xrPoseStabilityYawTolDeg: "6.0",
    xrNoPoseGraceMs: "8000",
  },
  {
    slug: "pixel8a",
    suitePrefix: "PIXEL8A",
    deviceLabel: "Pixel 8a",
    deviceTag: "pixel8a",
    browserTag: "chrome-android",
    xrPoseStabilityGateMs: "750",
    xrPoseStabilityPosTolM: "0.08",
    xrPoseStabilityYawTolDeg: "4.0",
    xrNoPoseGraceMs: "3000",
  },
];

const campaignDefs = [
  {
    key: "warm_trace_sanity",
    priority: "fallback",
    fileSuffix: "xr_ar_material_stress_probe_a_warm_trace_paired_sanity_2sets.json",
    suiteSuffix: "XR_AR_MATERIAL_STRESS_PROBE_A_WARM_TRACE_SANITY",
    runIdBaseSuffix: "xr_ar_material_stress_probe_a_warm_trace_sanity",
    manifestRuns: 4,
    sequence: ["webgl2", "webgpu", "webgpu", "webgl2"],
    orderMode: "abba_baab",
    instances: "16,32,48,64",
    trials: "5",
    durationMs: "6000",
    warmupMs: "500",
    betweenInstancesMs: "800",
    cooldownMs: "250",
    cooldownBetweenRunsMs: 180000,
    shuffle: "1",
    xrIdlePresentMode: "none",
    surfaceMode: "basecolor",
    notes:
      "Short warm traced AR stress sanity cohort. Use this only to verify that traced collection remains stable enough before committing to the full warm trace ladder.",
  },
  {
    key: "warm_trace",
    priority: "required",
    fileSuffix: "xr_ar_material_stress_probe_a_warm_trace_paired_5sets.json",
    suiteSuffix: "XR_AR_MATERIAL_STRESS_PROBE_A_WARM_TRACE",
    runIdBaseSuffix: "xr_ar_material_stress_probe_a_warm_trace",
    manifestRuns: 10,
    sequence: ["webgl2", "webgpu", "webgpu", "webgl2", "webgpu", "webgl2", "webgl2", "webgpu", "webgl2", "webgpu"],
    orderMode: "abba_baab",
    instances: "16,32,48,64",
    trials: "5",
    durationMs: "6000",
    warmupMs: "500",
    betweenInstancesMs: "800",
    cooldownMs: "250",
    cooldownBetweenRunsMs: 300000,
    shuffle: "1",
    xrIdlePresentMode: "none",
    surfaceMode: "basecolor",
    notes:
      "Canonical warm traced AR stress cohort. This is the trace follow-up that best matches the study's existing phone trace methodology. Any phone adjustment must finish before the stable-pose gate completes.",
  },
];

function instanceLabel(instances, trials) {
  const parts = String(instances).split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 1) return parts[0];
  return `${parts[0]}-to-${parts[parts.length - 1]}-n${trials}`;
}

function encodeManifestUrl(fileName) {
  return `${packBaseUrl}${fileName}?v=${manifestTag}`;
}

function makeLauncherUrl(fileName) {
  const manifestUrl = encodeManifestUrl(fileName);
  return `${launcherBaseUrl}?v=${manifestTag}&manifest=${encodeURIComponent(manifestUrl)}`;
}

function baseSource(def, device) {
  return {
    manifestOrderMode: def.orderMode,
    manifestApiScope: "paired",
    manifestRuns: def.manifestRuns,
    manifestOrderSeed: "12345",
    effectiveBaseUrl: harnessBaseUrl,
    manifestVersion: manifestTag,
    releaseTag,
    cacheMode: "warm",
    profilerMode: "traced_recording",
    profilerConfig: chromeProfilerConfig,
    layout: "xrwall",
    spacing: "0.12",
    canvasScaleFactor: "1",
    surfaceMode: def.surfaceMode,
    xrIdlePresentMode: def.xrIdlePresentMode,
    xrPoseStabilityGateMs: device.xrPoseStabilityGateMs,
    xrPoseStabilityPosTolM: device.xrPoseStabilityPosTolM,
    xrPoseStabilityYawTolDeg: device.xrPoseStabilityYawTolDeg,
    injectOutputNames: true,
    cooldownBetweenRunsMs: def.cooldownBetweenRunsMs,
    required_flags_profile_id: requiredFlagsProfileId,
    required_flags_exact: requiredFlagsExact,
  };
}

function makeQueryParams({ device, def, runNumber, api, suiteId, runId }) {
  const instances = def.instances;
  const trials = def.trials;
  const instLabel = instanceLabel(instances, trials);
  const resultPrefix = `results__run=${runId}__m=xr__i=${instLabel}__t=${trials}__d=${device.deviceTag}__b=${device.browserTag}__ts=YYYYMMDD-HHMMSS.jsonl`;
  const params = new URLSearchParams({
    assetRevision,
    batteryTelemetry: "1",
    betweenInstancesMs: def.betweenInstancesMs,
    canvasAutoDelayMs: "1000",
    canvasScaleFactor: "1",
    collectPerf: "1",
    connectionTelemetry: "1",
    cooldownMs: def.cooldownMs,
    debugColor: "flat",
    durationMs: def.durationMs,
    enforceOrder: "1",
    featureFlagsExact: requiredFlagsExact,
    featureFlagsProfile: requiredFlagsProfileId,
    harnessCommit,
    harnessVersion,
    hud: "0",
    hudHz: "2",
    instances,
    layout: "xrwall",
    manualDownload: "1",
    manualStart: "0",
    minFrames: "30",
    model: modelPath,
    orderIndex: String(runNumber),
    orderMode: def.orderMode,
    orderSeed: "12345",
    outxr: resultPrefix,
    perfDetail: "0",
    pinGpu: "0",
    postIdleMs: "0",
    preIdleMs: "0",
    profilerConfig: chromeProfilerConfig,
    profilerMode: "traced_recording",
    renderProbe: "1",
    runId,
    runMode: "xr",
    seed: "12345",
    sessionGroup: "default",
    shuffle: def.shuffle,
    spacing: "0.12",
    storeFrames: "0",
    suiteId,
    surfaceMode: def.surfaceMode,
    traceGate: "1",
    traceMarkers: "1",
    traceOverlay: "1",
    trials,
    warmupMs: def.warmupMs,
    xrAnchorMode: "trial",
    xrAnchorToFirstPose: "1",
    xrFrontMinZ: "-1.6",
    xrIdlePresentMode: def.xrIdlePresentMode,
    xrNoPoseGraceMs: device.xrNoPoseGraceMs,
    xrPoseStabilityGateMs: device.xrPoseStabilityGateMs,
    xrPoseStabilityPosTolM: device.xrPoseStabilityPosTolM,
    xrPoseStabilityYawTolDeg: device.xrPoseStabilityYawTolDeg,
    xrProbeReadback: "0",
    xrScaleFactor: "0.25",
    xrSessionMode: "immersive-ar",
    xrStartOnFirstPose: "1",
    xrYOffset: "0.0",
  });
  if (api === "webgpu") {
    params.set("webgpuInitTimeoutMs", "15000");
  }
  return { params, resultPrefix };
}

function makeManifest(device, def) {
  const fileName = `${device.slug}_${def.fileSuffix}`;
  const suiteId = `${device.suitePrefix}_${def.suiteSuffix}`;
  const manifest = {
    schema: "webxr-harness-manifest/v1",
    generatedAt: new Date().toISOString(),
    source: baseSource(def, device),
    required_flags_profile_id: requiredFlagsProfileId,
    required_flags_exact: requiredFlagsExact,
    manifest_version: manifestTag,
    harness_release_tag: releaseTag,
    rows: [],
  };

  for (let i = 0; i < def.sequence.length; i += 1) {
    const runNumber = i + 1;
    const api = def.sequence[i];
    const apiSuffix = api === "webgpu" ? "wgpu" : "wgl2";
    const runId = `${device.slug}_${def.runIdBaseSuffix}_r${String(runNumber).padStart(2, "0")}_${apiSuffix}`;
    const { params, resultPrefix } = makeQueryParams({ device, def, runNumber, api, suiteId, runId });
    const page = api === "webgpu" ? "webgpu.html" : "webgl.html";
    const url = `${harnessBaseUrl}${page}?${params.toString()}`;
    manifest.rows.push({
      run_number: runNumber,
      api,
      suite_id: suiteId,
      run_id: runId,
      order_mode: def.orderMode,
      api_scope: "paired",
      order_index: String(runNumber),
      enforce_order: "1",
      assigned_api: "",
      order_seed: "12345",
      session_group: "default",
      cache_mode: "warm",
      profiler_mode: "traced_recording",
      profiler_config: chromeProfilerConfig,
      cooldown_after_ms: def.cooldownBetweenRunsMs,
      run_mode: "xr",
      instances: def.instances,
      trials: def.trials,
      duration_ms: def.durationMs,
      layout: "xrwall",
      seed: "12345",
      shuffle: def.shuffle,
      surface_mode: def.surfaceMode,
      debug_color: "flat",
      harness_commit: harnessCommit,
      harness_version: harnessVersion,
      asset_revision: assetRevision,
      url,
      chrome_trace_name: resultPrefix.replace(/^results/, "chrome_trace").replace(/\.jsonl$/, ".json"),
      safari_timeline_name: resultPrefix.replace(/^results/, "safari_timeline").replace(/\.jsonl$/, ".json"),
      results_name: resultPrefix,
      device_tag: device.deviceTag,
      browser_tag: device.browserTag,
      power_log_file: "",
      external_metrics_file: "",
      notes: def.notes,
    });
  }

  return { fileName, suiteId, manifest };
}

async function writePack() {
  const packDir = path.join(repoRoot, "manifest-packs", manifestTag, "manifests");
  await fs.mkdir(packDir, { recursive: true });

  const csvRows = [["priority", "device", "manifest", "manifest_json", "launcher"]];
  const mdLines = [
    `# Phone AR Stress Trace Pack (${manifestTag})`,
    "",
    "Warm traced phone immersive-ar stress cohorts for the two diagnostic devices from the AR reevaluation.",
    "",
    "Priority order:",
    "1. Required: full warm trace for Pixel 8a",
    "2. Required: full warm trace for Samsung Galaxy FE",
    "3. Fallback only if traced mode looks unstable: the corresponding sanity 2-set manifest",
    "",
    "| Priority | Device | Manifest | Launcher | JSON |",
    "| --- | --- | --- | --- | --- |",
  ];
  const htmlRows = [];

  for (const device of deviceConfigs) {
    for (const def of campaignDefs) {
      const { fileName, manifest } = makeManifest(device, def);
      const manifestPath = path.join(packDir, fileName);
      await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      const manifestUrl = encodeManifestUrl(fileName);
      const launcherUrl = makeLauncherUrl(fileName);
      csvRows.push([def.priority, device.deviceLabel, fileName, manifestUrl, launcherUrl]);
      mdLines.push(`| ${def.priority} | ${device.deviceLabel} | \`${fileName}\` | [Open Launcher](${launcherUrl}) | [Manifest JSON](${manifestUrl}) |`);
      htmlRows.push(`    <tr><td>${def.priority}</td><td>${device.deviceLabel}</td><td><code>${fileName}</code></td><td><a href="${launcherUrl}" target="_blank" rel="noopener">Open Launcher</a></td><td><a href="${manifestUrl}" target="_blank" rel="noopener">Manifest JSON</a></td></tr>`);
    }
  }

  const info = {
    manifest_tag: manifestTag,
    release_tag: releaseTag,
    harness_commit: harnessCommit,
    description: "Phone immersive-ar warm trace pack: canonical full warm traces plus sanity fallback manifests for Pixel 8a and Samsung Galaxy FE AR stress cohorts.",
    generated_at: new Date().toISOString(),
  };
  await fs.writeFile(path.join(repoRoot, "manifest-packs", manifestTag, "MANIFEST_PACK_INFO.json"), `${JSON.stringify(info, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(packDir, "launcher-links-phone-ar-stress-trace.csv"), csvRows.map((row) => row.join(",")).join("\n") + "\n", "utf8");
  await fs.writeFile(path.join(packDir, "launcher-links-phone-ar-stress-trace.md"), mdLines.join("\n") + "\n", "utf8");
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Phone AR Stress Trace Pack</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 2rem; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #ccc; padding: 0.5rem; text-align: left; vertical-align: top; }
    code { font-size: 0.95em; }
  </style>
</head>
<body>
  <h1>Phone AR Stress Trace Pack (${manifestTag})</h1>
  <p>Warm traced phone immersive-ar stress cohorts for Pixel 8a and Samsung Galaxy FE.</p>
  <p>Use the <strong>required</strong> full warm traces as the canonical study runs. The <strong>fallback</strong> sanity manifests are only for traced-mode stability checking.</p>
  <table>
    <thead>
      <tr><th>Priority</th><th>Device</th><th>Manifest</th><th>Launcher</th><th>JSON</th></tr>
    </thead>
    <tbody>
${htmlRows.join("\n")}
    </tbody>
  </table>
</body>
</html>
`;
  await fs.writeFile(path.join(packDir, "launcher-links-phone-ar-stress-trace.html"), html, "utf8");
}

writePack().catch((err) => {
  console.error(err);
  process.exit(1);
});
