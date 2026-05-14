import { promises as fs } from 'fs';
import path from 'path';

const repoRoot = process.cwd();
const sourcePack = path.join(repoRoot, 'manifest-packs', 'm2026-04-24-a', 'manifests');
const outPackRoot = path.join(repoRoot, 'manifest-packs', 'm2026-04-24-b');
const outDir = path.join(outPackRoot, 'manifests');
const manifestTag = 'm2026-04-24-b';
const publicBase = `https://innominata88.github.io/webxr-harness/manifest-packs/${manifestTag}/manifests/`;
const launcherBase = 'https://innominata88.github.io/webxr-harness/releases/r2026-03-24-b/run-launcher.html';

const cases = [
  {
    source: 'samsung_fe5g_xr_ar_material_probe_a_paired_5sets.json',
    rows: [2, 10],
    outputs: [
      { row: 2, name: 'samsung_fe5g_xr_ar_material_webgpu_diag_row2_exact_1set.json' },
      { row: 10, name: 'samsung_fe5g_xr_ar_material_webgpu_diag_row10_exact_1set.json' },
      { row: 10, name: 'samsung_fe5g_xr_ar_material_webgpu_diag_row10_order2_1set.json', mutate: (r) => rewriteOrder(r, 2, 'row10_order2') },
    ],
  },
  {
    source: 'pixel8a_xr_ar_material_probe_a_paired_5sets.json',
    rows: [2, 10],
    outputs: [
      { row: 2, name: 'pixel8a_xr_ar_material_webgpu_diag_row2_exact_1set.json' },
      { row: 10, name: 'pixel8a_xr_ar_material_webgpu_diag_row10_exact_1set.json' },
      { row: 10, name: 'pixel8a_xr_ar_material_webgpu_diag_row10_order2_1set.json', mutate: (r) => rewriteOrder(r, 2, 'row10_order2') },
    ],
  },
];

function replaceQuery(urlString, updates) {
  const url = new URL(urlString);
  for (const [k, v] of Object.entries(updates)) {
    if (v == null) url.searchParams.delete(k);
    else url.searchParams.set(k, String(v));
  }
  return url.toString();
}

function rewriteOrder(row, orderIndex, suffix) {
  const clone = JSON.parse(JSON.stringify(row));
  const runId = `${row.run_id}__${suffix}`;
  clone.run_number = 1;
  clone.order_index = String(orderIndex);
  clone.run_id = runId;
  clone.results_name = clone.results_name.replace(row.run_id, runId);
  clone.chrome_trace_name = clone.chrome_trace_name.replace(row.run_id, runId);
  clone.safari_timeline_name = clone.safari_timeline_name.replace(row.run_id, runId);
  clone.url = replaceQuery(clone.url, {
    orderIndex,
    runId,
    outxr: String(new URL(clone.url).searchParams.get('outxr')).replace(row.run_id, runId),
  });
  clone.notes = `${row.notes} Diagnostic variant with orderIndex=${orderIndex}.`;
  return clone;
}

function cloneExact(row) {
  const clone = JSON.parse(JSON.stringify(row));
  clone.run_number = 1;
  return clone;
}

function makeManifest(baseManifest, row) {
  const m = {
    schema: baseManifest.schema,
    generatedAt: new Date().toISOString(),
    source: { ...baseManifest.source, manifestRuns: 1 },
    required_flags_profile_id: baseManifest.required_flags_profile_id,
    required_flags_exact: baseManifest.required_flags_exact,
    manifest_version: manifestTag,
    harness_release_tag: baseManifest.harness_release_tag,
    rows: [row],
  };
  m.source.manifestVersion = manifestTag;
  return m;
}

function makeLauncherUrl(fileName) {
  const manifestUrl = `${publicBase}${fileName}?v=${manifestTag}`;
  return `${launcherBase}?v=${manifestTag}&manifest=${encodeURIComponent(manifestUrl)}`;
}

await fs.mkdir(outDir, { recursive: true });
const links = [];

for (const cfg of cases) {
  const fullPath = path.join(sourcePack, cfg.source);
  const base = JSON.parse(await fs.readFile(fullPath, 'utf8'));
  const byRun = new Map(base.rows.map((r) => [Number(r.run_number), r]));
  for (const out of cfg.outputs) {
    const sourceRow = byRun.get(out.row);
    if (!sourceRow) throw new Error(`Missing row ${out.row} in ${cfg.source}`);
    const row = out.mutate ? out.mutate(sourceRow) : cloneExact(sourceRow);
    const manifest = makeManifest(base, row);
    await fs.writeFile(path.join(outDir, out.name), JSON.stringify(manifest, null, 2) + '\n');
    links.push({ fileName: out.name, launcherUrl: makeLauncherUrl(out.name), manifestUrl: `${publicBase}${out.name}?v=${manifestTag}` });
  }
}

const md = ['# Phone AR Row Diagnostics', '', '| Manifest | Open Launcher | Manifest JSON |', '| --- | --- | --- |'];
for (const link of links) md.push(`| ${link.fileName} | [Open Launcher](${link.launcherUrl}) | [Manifest JSON](${link.manifestUrl}) |`);
await fs.writeFile(path.join(outDir, 'launcher-links-phone-ar-row-diagnostics.md'), md.join('\n') + '\n');
await fs.writeFile(path.join(outPackRoot, 'MANIFEST_PACK_INFO.json'), JSON.stringify({ manifestTag, createdFrom: 'm2026-04-24-a', purpose: 'Phone AR WebGPU row diagnostics' }, null, 2) + '\n');
