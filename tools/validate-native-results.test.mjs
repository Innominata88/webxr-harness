import assert from "node:assert/strict";
import test from "node:test";

import {
  validateNativeRecord,
  validateNativeRun,
} from "./validate-native-results.mjs";

function record(overrides = {}) {
  const base = {
    schema_version: "1.1.0",
    api: "metal",
    mode: "canvas",
    surface_mode: "basecolor",
    surfaceMode: "basecolor",
    suiteId: "MACBOOKPRO_M1_NATIVE_CANVAS_MATERIAL_COMPLEXITY_REGULAR",
    runId: "macbookpro_m1_native_canvas_material_complexity_regular_r01",
    startedAt: "2026-07-24T12:00:00Z",
    layout: "xrwall",
    trial: 1,
    trials: 1,
    instances: 1,
    condition_index: 0,
    condition_count: 1,
    durationMs: 2000,
    warmupMs: 250,
    cooldownMs: 100,
    betweenInstancesMs: 200,
    minFrames: 30,
    spacing: 0.35,
    seed: 12345,
    shuffle: true,
    aborted: false,
    abort_code: "",
    abort_reason: "",
    env: {
      runtime_family: "native-apple",
      runtime_mode: "window",
      xr_runtime: "none",
      renderer_path: "metal-basecolor",
      surface_mode: "basecolor",
      timing_source_primary: "mtkview_draw_callback",
      asset_revision: "spiderman_2002_movie_version_sam_raimi_0",
      plan_id: "macbookpro_m1_native_canvas_material_complexity_regular_v1",
      device_model: "MacBookPro17,1",
      os_version: "Version 26.3",
      gpu_renderer: "Apple M1",
    },
    scene: {
      vertex_count: 167495,
      index_count: 500000,
      triangle_count: 166666,
      primitives_loaded: 15,
      textured_primitives_loaded: 11,
      materials_total: 15,
      images_total: 18,
      textures_total: 18,
      material_scene_primitives: 15,
      material_scene_textures: 9,
      norm_scale: 0.5,
      norm_center: [0, 0, 0],
      norm_max_dim: 2,
    },
    summary: {
      frames: 120,
      duration_ms: 2000,
      mean_ms: 16.67,
      p50_ms: 16.67,
      p95_ms: 17,
      p99_ms: 18,
    },
    extras: {
      fps_effective: 60,
      fps_from_mean: 59.98,
      max_frame_ms: 18,
      jank_p99_over_p50: 1.08,
      missed_1p5x: 0,
      missed_1p5x_pct: 0,
      missed_2x: 0,
      target_ms: 16.67,
    },
  };
  return { ...base, ...overrides };
}

test("accepts a valid native material record", () => {
  assert.deepEqual(validateNativeRecord(record()), []);
});

test("rejects material suite rendered by flat pipeline", () => {
  const invalid = record({
    surface_mode: "flat",
    surfaceMode: "flat",
    env: {
      ...record().env,
      surface_mode: "flat",
      renderer_path: "metal-flat",
    },
  });
  assert.match(validateNativeRecord(invalid).join("\n"), /MATERIAL suite must use basecolor/);
});

test("rejects incomplete or duplicate condition sets", () => {
  const first = record({ condition_count: 2 });
  const duplicate = record({ condition_count: 2 });
  const errors = validateNativeRun([first, duplicate]);
  assert.match(errors.join("\n"), /duplicate condition_index/);
  assert.match(errors.join("\n"), /missing condition_index 1/);
});
