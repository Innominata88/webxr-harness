#!/usr/bin/env node

import fs from "fs/promises";
import path from "path";

const repoRoot = process.cwd();
const manifestTag = "m2026-05-15-a";
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
    slug: "samsung_fe5g",
    suitePrefix: "SAMSUNG_FE5G",
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
    key: "stress_validity_manual",
    fileSuffix: "xr_ar_material_stress_probe_a_validity_manual_paired_1sets.json",
    suiteSuffix: "XR_AR_MATERIAL_STRESS_PROBE_A_VALIDITY_MANUAL",
    runIdBaseSuffix: "xr_ar_material_stress_probe_a_validity_manual",
    manifestRuns: 2,
    sequence: ["webgl2", "webgpu"],
    orderMode: "abba_baab",
    instances: "16",
    trials: "1",
    durationMs: "2000",
    warmupMs: "250",
    betweenInstancesMs: "200",
    cooldownMs: "100",
    cooldownBetweenRunsMs: 30000,
    shuffle: "0",
    manualStart: "1",
    xrIdlePresentMode: "clear_each_frame",
    surfaceMode: "basecolor",
    notes:
      "Manual AR stress validity smoke at 16 instances. Startup adjustment is acceptable before the stable-pose gate completes; do not keep correcting after the measured window begins.",
  },
  {
    key: "stress_probe_a_sanity",
    fileSuffix: "xr_ar_material_stress_probe_a_paired_sanity_2sets.json",
    suiteSuffix: "XR_AR_MATERIAL_STRESS_PROBE_A_SANITY",
    runIdBaseSuffix: "xr_ar_material_stress_probe_a_sanity",
    manifestRuns: 4,
    sequence: ["webgl2", "webgpu", "webgpu", "webgl2"],
    orderMode: "abba_baab",
    instances: "16,32,48,64",
    trials: "5",
    durationMs: "6000",
    warmupMs: "500",
    betweenInstancesMs: "800",
    cooldownMs: "250",
    cooldownBetweenRunsMs: 120000,
    shuffle: "1",
    manualStart: "0",
    xrIdlePresentMode: "none",
    surfaceMode: "basecolor",
    notes:
      "Short AR stress sanity cohort. Use only if the 16-instance validity smoke shows real passthrough and stable enough anchoring to keep the model in frame.",
  },
  {
    key: "stress_probe_a",
    fileSuffix: "xr_ar_material_stress_probe_a_paired_5sets.json",
    suiteSuffix: "XR_AR_MATERIAL_STRESS_PROBE_A",
    runIdBaseSuffix: "xr_ar_material_stress_probe_a",
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
    manualStart: "0",
    xrIdlePresentMode: "none",
    surfaceMode: "basecolor",
    notes:
      "Full AR stress reevaluation cohort. This is only methodologically usable if startup adjustment is limited to the pre-measurement stable-pose period.",
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
    profilerMode: "baseline_untraced",
    profilerConfig: "",
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
    manualStart: def.manualStart,
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
    profilerMode: "baseline_untraced",
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
    traceGate: "0",
    traceMarkers: "1",
    traceOverlay: "0",
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
      profiler_mode: "baseline_untraced",
      profiler_config: "",
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
      chrome_trace_name: resultPrefix.replace("results__run=", "chrome_trace__run=").replace(".jsonl", ".json"),
      safari_timeline_name: resultPrefix.replace("results__run=", "safari_timeline__run=").replace(".jsonl", ".json"),
      results_name: resultPrefix,
      device_tag: device.deviceTag,
      browser_tag: device.browserTag,
      power_log_file: "",
      external_metrics_file: "",
      notes: def.notes,
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
    "# Phone AR Stress Reevaluation Links",
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
    <title>Phone AR Stress Reevaluation Links</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 2rem; }
      table { border-collapse: collapse; width: 100%; }
      th, td { border: 1px solid #ccc; padding: 0.5rem; text-align: left; }
      code { font-size: 0.95em; }
    </style>
  </head>
  <body>
    <h1>Phone AR Stress Reevaluation Links</h1>
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
    for (const def of campaignDefs) {
      manifests.push(makeManifest(device, def));
    }
  }

  for (const { fileName, manifest } of manifests) {
    await fs.writeFile(path.join(outDir, fileName), `${JSON.stringify(manifest, null, 2)}\n`);
  }

  const links = manifestLinks(manifests);
  await fs.writeFile(path.join(outDir, "launcher-links-phone-ar-stress-reeval.md"), linksMarkdown(links));
  await fs.writeFile(path.join(outDir, "launcher-links-phone-ar-stress-reeval.csv"), linksCsv(links));
  await fs.writeFile(path.join(outDir, "launcher-links-phone-ar-stress-reeval.html"), linksHtml(links));
  await fs.writeFile(
    path.join(repoRoot, "manifest-packs", manifestTag, "MANIFEST_PACK_INFO.json"),
    `${JSON.stringify(
      {
        manifestTag,
        releaseTag,
        generatedAt: new Date().toISOString(),
        description: "Phone immersive-ar stress reevaluation pack: 16-instance validity smoke plus AR stress sanity/full cohorts for Samsung FE and Pixel 8a.",
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
