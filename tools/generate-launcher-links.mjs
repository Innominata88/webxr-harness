#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const MANIFEST_DIR = path.join(ROOT, "manifests");

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

async function main() {
  const baseUrl = normalizeBaseUrl(process.env.HARNESS_BASE_URL);
  const versionToken = String(process.env.LAUNCHER_VERSION || process.env.HARNESS_VERSION || "").trim();
  const manifestFilter = String(process.env.MANIFEST_FILTER || "").trim();
  const outName = String(process.env.LAUNCHER_LINKS_OUT || "launcher-links.csv").trim() || "launcher-links.csv";

  const entries = await fs.readdir(MANIFEST_DIR, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => e.name)
    .filter((name) => !manifestFilter || name.includes(manifestFilter))
    .sort((a, b) => a.localeCompare(b));

  if (!files.length) {
    throw new Error(
      manifestFilter
        ? `No manifest .json files found in ./manifests for MANIFEST_FILTER=${manifestFilter}`
        : "No manifest .json files found in ./manifests"
    );
  }

  const rows = [];
  for (const file of files) {
    const manifestRelPath = `manifests/${file}`;

    const manifestUrl = new URL(manifestRelPath, baseUrl);
    if (versionToken) manifestUrl.searchParams.set("v", versionToken);

    const launcherUrl = new URL("run-launcher.html", baseUrl);
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

  const outPath = path.join(MANIFEST_DIR, outName);
  await fs.writeFile(outPath, `${csv}\n`, "utf8");

  process.stdout.write(`Wrote ${rows.length} launcher links to ${path.relative(ROOT, outPath)}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err?.message || err}\n`);
  process.exit(1);
});
