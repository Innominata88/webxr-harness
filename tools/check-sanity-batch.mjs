#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

function usage() {
  process.stdout.write(
    [
      "Usage:",
      "  node tools/check-sanity-batch.mjs [options] <results.jsonl|directory> [more ...]",
      "",
      "Options:",
      "  --manifests-dir <path>  Sanity manifest directory (default: ./manifests)",
      "  --out-base <path>       Output prefix (default: ./reports/sanity_check_<timestamp>)",
      "  --strict <0|1>          Exit non-zero if any suite fails (default: 1)",
      "  --no-write              Print summary only; do not write JSON/CSV files",
      "  -h, --help              Show this help",
      "",
      "Example:",
      "  node tools/check-sanity-batch.mjs --strict 0 ~/Downloads/Performance\\ Study",
    ].join("\n")
  );
}

function nowStamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "_");
}

function asNumber(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function basenameNoExt(file) {
  const base = path.basename(file);
  return base.replace(/\.[^.]+$/, "");
}

async function statSafe(p) {
  try {
    return await fs.stat(p);
  } catch (_) {
    return null;
  }
}

async function collectJsonlFiles(inputs) {
  const out = [];
  for (const raw of inputs) {
    const target = path.resolve(raw);
    const st = await statSafe(target);
    if (!st) continue;
    if (st.isFile()) {
      if (target.toLowerCase().endsWith(".jsonl")) out.push(target);
      continue;
    }
    if (st.isDirectory()) {
      const stack = [target];
      while (stack.length) {
        const dir = stack.pop();
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const e of entries) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            stack.push(full);
            continue;
          }
          if (e.isFile() && full.toLowerCase().endsWith(".jsonl")) out.push(full);
        }
      }
    }
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

function runIdFromFilename(file) {
  const name = basenameNoExt(file);
  const m = name.match(/(?:^|__)run=([^_]+(?:_[^_]+)*)/i);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch (_) {
    return m[1];
  }
}

async function parseJsonlFile(file) {
  const raw = await fs.readFile(file, "utf8");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const records = [];
  const parseErrors = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    try {
      const obj = JSON.parse(line);
      if (isObject(obj)) records.push(obj);
    } catch (err) {
      parseErrors.push({
        line: i + 1,
        error: err?.message || String(err),
      });
    }
  }

  let suiteId = null;
  let api = null;
  let mode = null;
  let runId = null;
  let aborted = false;
  let webgpuBindingUnavailable = false;
  let recordCount = records.length;
  let validTrialCount = 0;

  for (const rec of records) {
    if (!suiteId && typeof rec.suiteId === "string" && rec.suiteId.trim()) suiteId = rec.suiteId.trim();
    if (!api && typeof rec.api === "string" && rec.api.trim()) api = rec.api.trim();
    if (!mode && typeof rec.mode === "string" && rec.mode.trim()) mode = rec.mode.trim();
    if (!runId) {
      if (typeof rec.run_id === "string" && rec.run_id.trim()) runId = rec.run_id.trim();
      else if (isObject(rec.env) && typeof rec.env.run_id === "string" && rec.env.run_id.trim()) runId = rec.env.run_id.trim();
    }
    if (rec.aborted === true) aborted = true;
    if (isObject(rec.summary)) validTrialCount += 1;
    if (rec.api === "webgpu" && rec.mode === "xr") {
      const env = isObject(rec.env) ? rec.env : {};
      if (env.xr_webgpu_binding_available !== true) webgpuBindingUnavailable = true;
    }
  }

  if (!runId) runId = runIdFromFilename(file) || basenameNoExt(file);

  return {
    file,
    suiteId,
    api,
    mode,
    runId,
    aborted,
    webgpuBindingUnavailable,
    recordCount,
    validTrialCount,
    parseErrors,
  };
}

async function loadSanityManifestExpectations(manifestsDir) {
  const dir = path.resolve(manifestsDir);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith("_sanity_2sets.json"))
    .map((e) => path.join(dir, e.name))
    .sort((a, b) => a.localeCompare(b));

  const expectations = new Map();
  for (const file of files) {
    const raw = await fs.readFile(file, "utf8");
    const manifest = JSON.parse(raw);
    const rows = Array.isArray(manifest.rows) ? manifest.rows : [];
    if (!rows.length) continue;

    const suiteId = String(rows[0].suite_id || "").trim();
    if (!suiteId) continue;

    const expectedByApi = {};
    for (const row of rows) {
      const api = String(row.api || "").trim();
      if (!api) continue;
      expectedByApi[api] = (expectedByApi[api] || 0) + 1;
    }

    const modeSet = new Set(rows.map((r) => String(r.run_mode || "").trim()).filter(Boolean));
    const xrSessionModeSet = new Set(
      rows
        .map((r) => {
          const url = String(r.url || "");
          if (!url) return "";
          try {
            const u = new URL(url);
            return String(u.searchParams.get("xrSessionMode") || "").trim();
          } catch (_) {
            return "";
          }
        })
        .filter(Boolean)
    );

    expectations.set(suiteId, {
      manifest_file: path.basename(file),
      expected_total_runs: rows.length,
      expected_by_api: expectedByApi,
      expected_mode: modeSet.size === 1 ? Array.from(modeSet)[0] : null,
      expected_xr_session_mode: xrSessionModeSet.size === 1 ? Array.from(xrSessionModeSet)[0] : null,
    });
  }
  return expectations;
}

function pickBestRunCandidate(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.aborted !== b.aborted) return a.aborted ? b : a;
  if (a.validTrialCount !== b.validTrialCount) return a.validTrialCount > b.validTrialCount ? a : b;
  if (a.recordCount !== b.recordCount) return a.recordCount > b.recordCount ? a : b;
  return a.file.localeCompare(b.file) <= 0 ? a : b;
}

function toCsv(rows, columns) {
  const esc = (v) => {
    const s = String(v ?? "");
    if (!/[",\n\r]/.test(s)) return s;
    return `"${s.replaceAll("\"", "\"\"")}"`;
  };
  return [columns.join(","), ...rows.map((r) => columns.map((c) => esc(r[c])).join(","))].join("\n");
}

function buildSuiteReport(suiteId, expectation, candidates) {
  const byRun = new Map();
  for (const c of candidates) {
    const key = c.runId || c.file;
    byRun.set(key, pickBestRunCandidate(byRun.get(key), c));
  }
  const chosen = Array.from(byRun.values());

  const observedByApi = {};
  let abortedRuns = 0;
  let bindingUnavailableRuns = 0;
  let parseErrorFiles = 0;
  const modes = new Set();
  for (const c of chosen) {
    if (c.api) observedByApi[c.api] = (observedByApi[c.api] || 0) + 1;
    if (c.mode) modes.add(c.mode);
    if (c.aborted) abortedRuns += 1;
    if (c.webgpuBindingUnavailable) bindingUnavailableRuns += 1;
    if (Array.isArray(c.parseErrors) && c.parseErrors.length) parseErrorFiles += 1;
  }

  const reasons = [];
  if (!chosen.length) reasons.push("no_runs_found");
  if (abortedRuns > 0) reasons.push("aborted_runs_present");
  if (parseErrorFiles > 0) reasons.push("json_parse_errors_present");
  if (bindingUnavailableRuns > 0) reasons.push("webgpu_xr_binding_unavailable");

  if (expectation) {
    const expectedTotal = asNumber(expectation.expected_total_runs, 0);
    if (chosen.length !== expectedTotal) {
      reasons.push(`run_count_mismatch_expected_${expectedTotal}_got_${chosen.length}`);
    }
    for (const [api, expectedCount] of Object.entries(expectation.expected_by_api || {})) {
      const got = observedByApi[api] || 0;
      if (got !== expectedCount) reasons.push(`api_count_mismatch_${api}_expected_${expectedCount}_got_${got}`);
    }
    if (expectation.expected_mode && modes.size === 1) {
      const only = Array.from(modes)[0];
      if (only !== expectation.expected_mode) {
        reasons.push(`mode_mismatch_expected_${expectation.expected_mode}_got_${only}`);
      }
    }
  } else {
    reasons.push("suite_not_in_sanity_manifests");
  }

  return {
    suite_id: suiteId,
    manifest_file: expectation?.manifest_file || "",
    status: reasons.length ? "FAIL" : "PASS",
    reasons,
    observed_total_runs: chosen.length,
    expected_total_runs: expectation?.expected_total_runs ?? null,
    observed_by_api: observedByApi,
    expected_by_api: expectation?.expected_by_api ?? {},
    aborted_runs: abortedRuns,
    binding_unavailable_runs: bindingUnavailableRuns,
    parse_error_files: parseErrorFiles,
    files_used: chosen.map((c) => c.file),
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    usage();
    process.exit(0);
  }

  let manifestsDir = "manifests";
  let outBase = `reports/sanity_check_${nowStamp()}`;
  let strict = true;
  let writeOutputs = true;
  const inputs = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--manifests-dir") {
      manifestsDir = args[++i];
      if (!manifestsDir) throw new Error("Missing value for --manifests-dir");
      continue;
    }
    if (a === "--out-base") {
      outBase = args[++i];
      if (!outBase) throw new Error("Missing value for --out-base");
      continue;
    }
    if (a === "--strict") {
      const v = args[++i];
      if (v !== "0" && v !== "1") throw new Error("--strict must be 0 or 1");
      strict = v === "1";
      continue;
    }
    if (a === "--no-write") {
      writeOutputs = false;
      continue;
    }
    if (a.startsWith("-")) throw new Error(`Unknown option: ${a}`);
    inputs.push(a);
  }

  if (!inputs.length) {
    usage();
    process.exit(1);
  }

  const jsonlFiles = await collectJsonlFiles(inputs);
  if (!jsonlFiles.length) {
    throw new Error("No .jsonl files found in provided inputs.");
  }

  const expectations = await loadSanityManifestExpectations(manifestsDir);
  if (!expectations.size) {
    throw new Error(`No *_sanity_2sets.json manifests found in ${path.resolve(manifestsDir)}`);
  }

  const parsedFiles = await Promise.all(jsonlFiles.map((f) => parseJsonlFile(f)));
  const bySuite = new Map();
  for (const p of parsedFiles) {
    const suiteId = p.suiteId || "__unknown__";
    if (!bySuite.has(suiteId)) bySuite.set(suiteId, []);
    bySuite.get(suiteId).push(p);
  }

  const suiteIds = new Set([...expectations.keys(), ...bySuite.keys()]);
  const reports = Array.from(suiteIds)
    .sort((a, b) => a.localeCompare(b))
    .map((suiteId) => buildSuiteReport(suiteId, expectations.get(suiteId), bySuite.get(suiteId) || []));

  const passCount = reports.filter((r) => r.status === "PASS").length;
  const failCount = reports.length - passCount;

  process.stdout.write(`Sanity suites checked: ${reports.length}\n`);
  process.stdout.write(`PASS=${passCount} FAIL=${failCount}\n`);
  for (const r of reports) {
    const reasonText = r.reasons.length ? ` reasons=${r.reasons.join("|")}` : "";
    process.stdout.write(
      `[${r.status}] ${r.suite_id} observed=${r.observed_total_runs}/${r.expected_total_runs ?? "?"} apis=${JSON.stringify(r.observed_by_api)}${reasonText}\n`
    );
  }

  if (writeOutputs) {
    const outJson = `${outBase}.json`;
    const outCsv = `${outBase}.csv`;
    await fs.mkdir(path.dirname(path.resolve(outBase)), { recursive: true });
    const payload = {
      schema: "webxr-harness-sanity-check/v1",
      generated_at: new Date().toISOString(),
      inputs: jsonlFiles,
      manifests_dir: path.resolve(manifestsDir),
      suite_reports: reports,
      summary: {
        suites_checked: reports.length,
        pass_count: passCount,
        fail_count: failCount,
      },
    };
    await fs.writeFile(outJson, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    const csvRows = reports.map((r) => ({
      suite_id: r.suite_id,
      status: r.status,
      observed_total_runs: r.observed_total_runs,
      expected_total_runs: r.expected_total_runs ?? "",
      observed_by_api: JSON.stringify(r.observed_by_api),
      expected_by_api: JSON.stringify(r.expected_by_api),
      aborted_runs: r.aborted_runs,
      binding_unavailable_runs: r.binding_unavailable_runs,
      parse_error_files: r.parse_error_files,
      reasons: r.reasons.join("|"),
      manifest_file: r.manifest_file,
    }));
    const csv = toCsv(csvRows, [
      "suite_id",
      "status",
      "observed_total_runs",
      "expected_total_runs",
      "observed_by_api",
      "expected_by_api",
      "aborted_runs",
      "binding_unavailable_runs",
      "parse_error_files",
      "reasons",
      "manifest_file",
    ]);
    await fs.writeFile(outCsv, `${csv}\n`, "utf8");
    process.stdout.write(`Wrote ${outJson}\n`);
    process.stdout.write(`Wrote ${outCsv}\n`);
  }

  if (strict && failCount > 0) process.exit(2);
}

main().catch((err) => {
  process.stderr.write(`${err?.stack || err?.message || String(err)}\n`);
  process.exit(1);
});

