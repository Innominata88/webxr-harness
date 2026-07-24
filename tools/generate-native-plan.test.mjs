import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { generateNativePlan } from "./generate-native-plan.mjs";

const materialManifestPath = new URL(
  "../manifests/pixel8a_canvas_material_complexity_regular_paired_5sets.json",
  import.meta.url
);

function loadMaterialManifest() {
  return JSON.parse(fs.readFileSync(materialManifestPath, "utf8"));
}

test("paired ten-row material manifest becomes five native runs", () => {
  const plan = generateNativePlan(loadMaterialManifest(), {
    sourceName: materialManifestPath.pathname,
    api: "vulkan",
    generatedAt: "2026-07-24T00:00:00.000Z",
  });

  assert.equal(plan.schema, "native-benchmark-manifest/v1");
  assert.equal(plan.runtime_family, "native-android");
  assert.equal(plan.api, "vulkan");
  assert.equal(plan.mode, "canvas");
  assert.equal(plan.surface_mode, "basecolor");
  assert.deepEqual(plan.instances, [1, 2, 4, 8, 16, 32]);
  assert.equal(plan.trials_per_instance, 5);
  assert.equal(plan.duration_ms, 6000);
  assert.equal(plan.warmup_ms, 500);
  assert.equal(plan.cooldown_ms, 1000);
  assert.equal(plan.between_instances_ms, 800);
  assert.equal(plan.between_runs_ms, 300000);
  assert.equal(plan.run_count, 5);
  assert.equal(plan.runs.length, 5);
  assert.equal(plan.runs[0].run_id, "pixel8a_native_canvas_material_complexity_regular_r01");
  assert.equal(plan.runs[4].run_id, "pixel8a_native_canvas_material_complexity_regular_r05");
  assert.match(plan.runs[0].suite_id, /_NATIVE_CANVAS_MATERIAL_/);
});

test("generator rejects mixed flat and material rows", () => {
  const source = loadMaterialManifest();
  const url = new URL(source.rows[1].url);
  url.searchParams.set("surfaceMode", "flat");
  source.rows[1].url = url.toString();

  assert.throws(
    () => generateNativePlan(source, {
      sourceName: materialManifestPath.pathname,
      api: "vulkan",
    }),
    /mixes workload parameters/
  );
});

test("generator rejects unequal source API repetition counts", () => {
  const source = loadMaterialManifest();
  source.rows.pop();

  assert.throws(
    () => generateNativePlan(source, {
      sourceName: materialManifestPath.pathname,
      api: "vulkan",
    }),
    /unequal repetition counts/
  );
});

test("explicit run count is honored without replaying source rows", () => {
  const plan = generateNativePlan(loadMaterialManifest(), {
    sourceName: materialManifestPath.pathname,
    api: "metal",
    runCount: 2,
  });

  assert.equal(plan.runtime_family, "native-apple");
  assert.equal(plan.run_count, 2);
  assert.equal(plan.runs.length, 2);
});
