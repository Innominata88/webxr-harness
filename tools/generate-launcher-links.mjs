#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

function normalizeBaseUrl(raw) {
  const input = String(raw || "https://innominata88.github.io/webxr-harness/").trim();
  const url = new URL(input);
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function csvCell(value) {
  const s = String(value ?? "");
  if (!/[",\n\r]/.test(s)) return s;
  return `"${s.replaceAll("\"", "\"\"")}"`;
}

function toCsv(rows, columns) {
  const lines = [];
  lines.push(columns.join(","));
  for (const row of rows) {
    lines.push(columns.map((c) => csvCell(row[c])).join(","));
  }
  return lines.join("\n");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

function toMarkdown(rows, meta) {
  const lines = [];
  lines.push(`# Launcher Links`);
  lines.push("");
  lines.push(`- generated_at: ${meta.generatedAt}`);
  lines.push(`- launcher_base_url: ${meta.baseUrl}`);
  lines.push(`- manifest_base_url: ${meta.manifestBaseUrl}`);
  lines.push(`- launcher_version: ${meta.versionToken || "(none)"}`);
  if (meta.manifestFilter) lines.push(`- manifest_filter: ${meta.manifestFilter}`);
  lines.push("");
  lines.push(`| Manifest File | Launcher | Manifest URL |`);
  lines.push(`|---|---|---|`);
  for (const row of rows) {
    lines.push(`| ${row.manifest_file} | [Open Launcher](${row.launcher_url}) | [Manifest JSON](${row.manifest_url}) |`);
  }
  lines.push("");
  return lines.join("\n");
}

function toHtml(rows, meta) {
  const generated = escapeHtml(meta.generatedAt);
  const baseUrl = escapeHtml(meta.baseUrl);
  const manifestBaseUrl = escapeHtml(meta.manifestBaseUrl || meta.baseUrl);
  const version = escapeHtml(meta.versionToken || "(none)");
  const filter = escapeHtml(meta.manifestFilter || "(none)");

  const tableRows = rows.map((row) => {
    const file = escapeHtml(row.manifest_file);
    const launcher = escapeHtml(row.launcher_url);
    const manifest = escapeHtml(row.manifest_url);
    return `<tr>
      <td><code>${file}</code></td>
      <td><a href="${launcher}" target="_blank" rel="noopener">Open Launcher</a></td>
      <td><a href="${manifest}" target="_blank" rel="noopener">Manifest JSON</a></td>
    </tr>`;
  }).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Launcher Links</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 16px; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #d0d7de; padding: 8px; text-align: left; }
    th { background: #f6f8fa; }
    code { font-size: 12px; }
    .meta { margin-bottom: 14px; color: #444; font-size: 13px; }
  </style>
</head>
<body>
  <h1>Launcher Links</h1>
  <div class="meta">
    generated_at=${generated}<br/>
    launcher_base_url=${baseUrl}<br/>
    manifest_base_url=${manifestBaseUrl}<br/>
    launcher_version=${version}<br/>
    manifest_filter=${filter}
  </div>
  <table>
    <thead>
      <tr>
        <th>Manifest File</th>
        <th>Launcher</th>
        <th>Manifest URL</th>
      </tr>
    </thead>
    <tbody>
${tableRows}
    </tbody>
  </table>
</body>
</html>
`;
}

async function main() {
  const manifestDir = path.resolve(ROOT, String(process.env.MANIFEST_DIR || "manifests").trim() || "manifests");
  const manifestBaseUrl = normalizeBaseUrl(process.env.MANIFEST_PUBLIC_BASE_URL || process.env.HARNESS_BASE_URL);
  const launcherBaseUrl = normalizeBaseUrl(process.env.LAUNCHER_BASE_URL || process.env.HARNESS_BASE_URL);
  const versionToken = String(process.env.LAUNCHER_VERSION || process.env.HARNESS_VERSION || "").trim();
  const manifestFilter = String(process.env.MANIFEST_FILTER || "").trim();
  const outName = String(process.env.LAUNCHER_LINKS_OUT || "launcher-links.csv").trim() || "launcher-links.csv";

  const entries = await fs.readdir(manifestDir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => e.name)
    .filter((name) => !manifestFilter || name.includes(manifestFilter))
    .sort((a, b) => a.localeCompare(b));

  if (!files.length) {
    throw new Error(
      manifestFilter
        ? `No manifest .json files found in ./manifests for MANIFEST_FILTER=${manifestFilter}`
        : "No manifest .json files found in manifest directory"
    );
  }

  const rows = [];
  for (const file of files) {
    const manifestRelPath = path.posix.join("manifests", file);

    const manifestUrl = new URL(manifestRelPath, manifestBaseUrl);
    if (versionToken) manifestUrl.searchParams.set("v", versionToken);

    const launcherUrl = new URL("run-launcher.html", launcherBaseUrl);
    if (versionToken) launcherUrl.searchParams.set("v", versionToken);
    launcherUrl.searchParams.set("manifest", manifestUrl.toString());

    rows.push({
      manifest_file: file,
      manifest_path: manifestRelPath,
      manifest_url: manifestUrl.toString(),
      launcher_url: launcherUrl.toString()
    });
  }

  const columns = ["manifest_file", "manifest_path", "manifest_url", "launcher_url"];
  const csv = toCsv(rows, columns);
  const meta = {
    generatedAt: String(process.env.GENERATED_AT || "").trim() || new Date().toISOString(),
    baseUrl: launcherBaseUrl.toString(),
    manifestBaseUrl: manifestBaseUrl.toString(),
    versionToken,
    manifestFilter
  };
  const markdown = toMarkdown(rows, meta);
  const html = toHtml(rows, meta);

  const outPath = path.join(manifestDir, outName);
  const outPathBase = outPath.replace(/\.csv$/i, "");
  const mdOutPath = `${outPathBase}.md`;
  const htmlOutPath = `${outPathBase}.html`;
  await fs.writeFile(outPath, `${csv}\n`, "utf8");
  await fs.writeFile(mdOutPath, `${markdown}\n`, "utf8");
  await fs.writeFile(htmlOutPath, html, "utf8");

  process.stdout.write(`Wrote ${rows.length} launcher links to ${path.relative(ROOT, outPath)}\n`);
  process.stdout.write(`Wrote clickable markdown to ${path.relative(ROOT, mdOutPath)}\n`);
  process.stdout.write(`Wrote clickable HTML to ${path.relative(ROOT, htmlOutPath)}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err?.message || err}\n`);
  process.exit(1);
});
