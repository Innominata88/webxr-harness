#!/usr/bin/env node

import fs from "fs/promises";
import path from "path";

const repoRoot = process.cwd();
const manifestTag = "m2026-06-12-a";
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

const deviceConfigs = [
  {
    slug: "hololens2",
    suitePrefix: "HOLOLENS2",
    deviceTag: "hololens2",
    browserTag: "edge-hololens",
    xrPoseStabilityGateMs: "1000",
    xrPoseStabilityPosTolM: "0.08",
    xrPoseStabilityYawTolDeg: "4.0",
    xrNoPoseGraceMs: "8000",
    capabilityNote:
      "HoloLens 2 split-browser plan: paired Canvas for WebGL2/WebGPU, WebGL-only XR fallback because WebGPU XR is not expected to work.",
  },
  {
    slug: "magicleap2",
    suitePrefix: "MAGICLEAP2",
    deviceTag: "magicleap2",
    browserTag: "chromium-magicleap",
    xrPoseStabilityGateMs: "750",
    xrPoseStabilityPosTolM: "0.08",
    xrPoseStabilityYawTolDeg: "4.0",
    xrNoPoseGraceMs: "8000",
    capabilityNote:
      "Magic Leap 2 beta-browser plan: run the same split Canvas/WebGL-only XR matrix first, then decide whether any paired XR/WebGPU diagnostic smoke is worth attempting.",
  },
];

const cohortDefs = [
  {
    key: "canvas_material_complexity_regular",
    fileBase: "canvas_material_complexity_regular",
    suiteSuffix: "CANVAS_MATERIAL_COMPLEXITY_REGULAR",
    runIdBaseSuffix: "canvas_material_complexity_regular",
    runMode: "canvas",
    apiScope: "paired",
    instances: "1,2,4,8,16",
    trials: "5",
    surfaceMode: "basecolor",
    notes:
      "Quest-style headset browser canvas material cohort. Use this to test WebGL2 vs WebGPU without XR-session support confounds.",
  },
  {
    key: "canvas_material_complexity_regular_webgl_only",
    fileBase: "canvas_material_complexity_regular",
    suiteSuffix: "CANVAS_MATERIAL_COMPLEXITY_REGULAR",
    runIdBaseSuffix: "canvas_material_complexity_regular",
    runMode: "canvas",
    apiScope: "webgl_only",
    instances: "1,2,4,8,16",
    trials: "5",
    surfaceMode: "basecolor",
    notes:
      "Quest-style headset browser canvas fallback cohort. Use this when the headset browser exposes WebGL but not a usable WebGPU adapter.",
  },
  {
    key: "canvas_primary_regular",
    fileBase: "canvas_primary_regular",
    suiteSuffix: "CANVAS_PRIMARY_REGULAR",
    runIdBaseSuffix: "canvas_primary_regular",
    runMode: "canvas",
    apiScope: "paired",
    instances: "64,128,192",
    trials: "10",
    surfaceMode: "flat",
    notes:
      "Quest-style headset browser canvas primary cohort. Use this if the material cohort is clean and you want the heavier flat ladder.",
  },
  {
    key: "canvas_primary_regular_webgl_only",
    fileBase: "canvas_primary_regular",
    suiteSuffix: "CANVAS_PRIMARY_REGULAR",
    runIdBaseSuffix: "canvas_primary_regular",
    runMode: "canvas",
    apiScope: "webgl_only",
    instances: "64,128,192",
    trials: "10",
    surfaceMode: "flat",
    notes:
      "Quest-style headset browser canvas fallback primary cohort. Use this when the headset browser supports only WebGL in browser mode.",
  },
  {
    key: "xr_ar_material_complexity_regular",
    fileBase: "xr_ar_material_complexity_regular",
    suiteSuffix: "XR_AR_MATERIAL_COMPLEXITY_REGULAR",
    runIdBaseSuffix: "xr_ar_material_complexity_regular",
    runMode: "xr",
    apiScope: "webgl_only",
    instances: "1,2,4,8,16",
    trials: "5",
    surfaceMode: "basecolor",
    notes:
      "Quest-style headset XR fallback cohort. WebGL-only because the current plan assumes WebGPU XR is unavailable or not trustworthy on the enterprise headset browser.",
  },
  {
    key: "xr_ar_primary_regular",
    fileBase: "xr_ar_primary_regular",
    suiteSuffix: "XR_AR_PRIMARY_REGULAR",
    runIdBaseSuffix: "xr_ar_primary_regular",
    runMode: "xr",
    apiScope: "webgl_only",
    instances: "64,128,192",
    trials: "10",
    surfaceMode: "flat",
    notes:
      "Quest-style headset XR fallback primary cohort. Only run this after the material XR WebGL-only cohort succeeds cleanly.",
  },
];

const phaseDefs = [
  {
    key: "smoke",
    suffix: "smoke_1sets",
    label: "smoke",
    manifestRunsPaired: 2,
    manifestRunsWebglOnly: 1,
    sequencePaired: ["webgl2", "webgpu"],
    sequenceWebglOnly: ["webgl2"],
    cooldownBetweenRunsMs: 30000,
    durationMs: "3000",
    notesPrefix: "Smoke gate.",
  },
  {
    key: "sanity",
    suffix: "sanity_2sets",
    label: "sanity",
    manifestRunsPaired: 4,
    manifestRunsWebglOnly: 2,
    sequencePaired: ["webgl2", "webgpu", "webgpu", "webgl2"],
    sequenceWebglOnly: ["webgl2", "webgl2"],
    cooldownBetweenRunsMs: 120000,
    durationMs: "6000",
    notesPrefix: "Short sanity cohort.",
  },
  {
    key: "full",
    suffix: "5sets",
    label: "full",
    manifestRunsPaired: 10,
    manifestRunsWebglOnly: 5,
    sequencePaired: [
      "webgl2",
      "webgpu",
      "webgpu",
      "webgl2",
      "webgpu",
      "webgl2",
      "webgl2",
      "webgpu",
      "webgl2",
      "webgpu",
    ],
    sequenceWebglOnly: ["webgl2", "webgl2", "webgl2", "webgl2", "webgl2"],
    cooldownBetweenRunsMs: 300000,
    durationMs: "6000",
    notesPrefix: "Full collection cohort.",
  },
];

function manifestApiScopeData(apiScope, phase) {
  if (apiScope === "paired") {
    return {
      manifestRuns: phase.manifestRunsPaired,
      sequence: phase.sequencePaired,
      orderMode: "abba_baab",
      enforceOrder: "1",
    };
  }
  return {
    manifestRuns: phase.manifestRunsWebglOnly,
    sequence: phase.sequenceWebglOnly,
    orderMode: "none",
    enforceOrder: "0",
  };
}

function instanceLabel(instances, trials) {
  const parts = String(instances)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 1) return parts[0];
  if (parts.length === 3 && !String(instances).includes("1,2,4")) {
    return parts.join("-");
  }
  return `${parts[0]}-to-${parts[parts.length - 1]}-n${trials}`;
}

function encodeManifestUrl(fileName) {
  return `${packBaseUrl}${fileName}?v=${manifestTag}`;
}

function makeLauncherUrl(fileName) {
  const manifestUrl = encodeManifestUrl(fileName);
  return `${launcherBaseUrl}?v=${manifestTag}&manifest=${encodeURIComponent(manifestUrl)}`;
}

function baseSource(device, cohort, phase, apiData) {
  return {
    manifestOrderMode: apiData.orderMode,
    manifestApiScope: cohort.apiScope,
    manifestRuns: apiData.manifestRuns,
    manifestOrderSeed: "12345",
    effectiveBaseUrl: harnessBaseUrl,
    manifestVersion: manifestTag,
    releaseTag,
    cacheMode: "warm",
    profilerMode: "baseline_untraced",
    profilerConfig: "",
    layout: "xrwall",
    spacing: "0.12",
    canvasScaleFactor: "1",
    surfaceMode: cohort.surfaceMode,
    xrIdlePresentMode: "none",
    xrPoseStabilityGateMs: device.xrPoseStabilityGateMs,
    xrPoseStabilityPosTolM: device.xrPoseStabilityPosTolM,
    xrPoseStabilityYawTolDeg: device.xrPoseStabilityYawTolDeg,
    injectOutputNames: true,
    cooldownBetweenRunsMs: phase.cooldownBetweenRunsMs,
    required_flags_profile_id: requiredFlagsProfileId,
    required_flags_exact: requiredFlagsExact,
  };
}

function queryParams({ device, cohort, phase, apiData, runNumber, api, suiteId, runId }) {
  const instances = cohort.instances;
  const trials = cohort.trials;
  const instLabel = instanceLabel(instances, trials);
  const resultPrefix = `results__run=${runId}__m=${cohort.runMode}__i=${instLabel}__t=${trials}__d=${device.deviceTag}__b=${device.browserTag}__ts=YYYYMMDD-HHMMSS.jsonl`;
  const params = new URLSearchParams({
    assetRevision,
    batteryTelemetry: "1",
    betweenInstancesMs: "800",
    canvasAutoDelayMs: "1000",
    canvasScaleFactor: "1",
    collectPerf: "1",
    connectionTelemetry: "1",
    cooldownMs: "250",
    debugColor: "flat",
    durationMs: phase.durationMs,
    enforceOrder: apiData.enforceOrder,
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
    orderMode: apiData.orderMode,
    orderSeed: "12345",
    perfDetail: "0",
    pinGpu: "0",
    postIdleMs: "0",
    preIdleMs: "0",
    profilerMode: "baseline_untraced",
    renderProbe: "1",
    runId,
    runMode: cohort.runMode,
    seed: "12345",
    sessionGroup: "default",
    shuffle: "1",
    spacing: "0.12",
    storeFrames: "0",
    suiteId,
    surfaceMode: cohort.surfaceMode,
    traceGate: "0",
    traceMarkers: "1",
    traceOverlay: "0",
    trials,
    warmupMs: "500",
    xrAnchorMode: "trial",
    xrAnchorToFirstPose: "1",
    xrFrontMinZ: "-1.6",
    xrIdlePresentMode: "none",
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

  params.set(cohort.runMode === "xr" ? "outxr" : "out", resultPrefix);
  if (api === "webgpu") {
    params.set("webgpuInitTimeoutMs", "15000");
  }

  return { params, resultPrefix };
}

function makeManifest(device, cohort, phase) {
  const apiData = manifestApiScopeData(cohort.apiScope, phase);
  const fileName = `${device.slug}_${cohort.fileBase}_${cohort.apiScope}_${phase.suffix}.json`;
  const suiteId = `${device.suitePrefix}_${cohort.suiteSuffix}`;
  const manifest = {
    schema: "webxr-harness-manifest/v1",
    generatedAt: new Date().toISOString(),
    source: baseSource(device, cohort, phase, apiData),
    required_flags_profile_id: requiredFlagsProfileId,
    required_flags_exact: requiredFlagsExact,
    manifest_version: manifestTag,
    harness_release_tag: releaseTag,
    rows: [],
  };

  for (let i = 0; i < apiData.sequence.length; i += 1) {
    const runNumber = i + 1;
    const api = apiData.sequence[i];
    const apiSuffix = api === "webgpu" ? "wgpu" : "wgl2";
    const runId = `${device.slug}_${cohort.runIdBaseSuffix}_r${String(runNumber).padStart(2, "0")}_${apiSuffix}`;
    const { params, resultPrefix } = queryParams({
      device,
      cohort,
      phase,
      apiData,
      runNumber,
      api,
      suiteId,
      runId,
    });
    const page = api === "webgpu" ? "webgpu.html" : "webgl.html";
    const url = `${harnessBaseUrl}${page}?${params.toString()}`;
    manifest.rows.push({
      run_number: runNumber,
      api,
      suite_id: suiteId,
      run_id: runId,
      order_mode: apiData.orderMode,
      api_scope: cohort.apiScope,
      order_index: String(runNumber),
      enforce_order: apiData.enforceOrder,
      assigned_api: "",
      order_seed: "12345",
      session_group: "default",
      cache_mode: "warm",
      profiler_mode: "baseline_untraced",
      profiler_config: "",
      cooldown_after_ms: phase.cooldownBetweenRunsMs,
      run_mode: cohort.runMode,
      instances: cohort.instances,
      trials: cohort.trials,
      duration_ms: phase.durationMs,
      layout: "xrwall",
      seed: "12345",
      shuffle: "1",
      surface_mode: cohort.surfaceMode,
      debug_color: "flat",
      harness_commit: harnessCommit,
      harness_version: harnessVersion,
      asset_revision: assetRevision,
      url,
      chrome_trace_name: resultPrefix
        .replace("results__run=", "chrome_trace__run=")
        .replace(".jsonl", ".json"),
      safari_timeline_name: resultPrefix
        .replace("results__run=", "safari_timeline__run=")
        .replace(".jsonl", ".json"),
      results_name: resultPrefix,
      device_tag: device.deviceTag,
      browser_tag: device.browserTag,
      power_log_file: "",
      external_metrics_file: "",
      notes: `${phase.notesPrefix} ${cohort.notes} ${device.capabilityNote}`,
    });
  }

  return { fileName, manifest };
}

function manifestLinks(manifests) {
  return manifests.map(({ fileName }) => ({
    fileName,
    manifestUrl: encodeManifestUrl(fileName),
    launcherUrl: makeLauncherUrl(fileName),
  }));
}

function linksMarkdown(links) {
  const lines = [
    "# Headset Browser Reevaluation Links",
    "",
    "| Manifest | Open Launcher | Manifest JSON |",
    "| --- | --- | --- |",
  ];
  for (const link of links) {
    lines.push(
      `| ${link.fileName} | [Open Launcher](${link.launcherUrl}) | [Manifest JSON](${link.manifestUrl}) |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function linksCsv(links) {
  const rows = ["file_name,manifest_url,launcher_url"];
  for (const link of links) {
    rows.push(`${link.fileName},${link.manifestUrl},${link.launcherUrl}`);
  }
  return `${rows.join("\n")}\n`;
}

function linksHtml(links) {
  const rows = links
    .map(
      (link) => `    <tr>
      <td><code>${link.fileName}</code></td>
      <td><a href="${link.launcherUrl}" target="_blank" rel="noopener">Open Launcher</a></td>
      <td><a href="${link.manifestUrl}" target="_blank" rel="noopener">Manifest JSON</a></td>
    </tr>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Headset Browser Reevaluation Links</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 2rem; }
      table { border-collapse: collapse; width: 100%; }
      th, td { border: 1px solid #ccc; padding: 0.5rem; text-align: left; }
      code { font-size: 0.95em; }
    </style>
  </head>
  <body>
    <h1>Headset Browser Reevaluation Links</h1>
    <table>
      <thead>
        <tr>
          <th>Manifest</th>
          <th>Open Launcher</th>
          <th>Manifest JSON</th>
        </tr>
      </thead>
      <tbody>
${rows}
      </tbody>
    </table>
  </body>
</html>
`;
}

async function main() {
  const outDir = path.join(repoRoot, "manifest-packs", manifestTag, "manifests");
  await fs.mkdir(outDir, { recursive: true });

  const manifests = [];
  for (const device of deviceConfigs) {
    for (const cohort of cohortDefs) {
      for (const phase of phaseDefs) {
        manifests.push(makeManifest(device, cohort, phase));
      }
    }
  }

  for (const { fileName, manifest } of manifests) {
    await fs.writeFile(path.join(outDir, fileName), `${JSON.stringify(manifest, null, 2)}\n`);
  }

  const links = manifestLinks(manifests);
  await fs.writeFile(
    path.join(outDir, "launcher-links-headset-browser-reeval.md"),
    linksMarkdown(links),
  );
  await fs.writeFile(
    path.join(outDir, "launcher-links-headset-browser-reeval.csv"),
    linksCsv(links),
  );
  await fs.writeFile(
    path.join(outDir, "launcher-links-headset-browser-reeval.html"),
    linksHtml(links),
  );
  await fs.writeFile(
    path.join(repoRoot, "manifest-packs", manifestTag, "MANIFEST_PACK_INFO.json"),
    `${JSON.stringify(
      {
        manifestTag,
        releaseTag,
        generatedAt: new Date().toISOString(),
        description:
          "Headset browser reevaluation pack: HoloLens 2 and Magic Leap 2 split into Quest-style paired Canvas cohorts and WebGL-only XR fallback cohorts.",
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
