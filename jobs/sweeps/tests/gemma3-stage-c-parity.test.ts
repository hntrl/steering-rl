/**
 * Tests for Gemma 3 Stage C Parity — sparse multi-layer preset calibration.
 *
 * Validates:
 *   - Config construction with Gemma 3 model metadata and seed control
 *   - Multi-layer candidate generation from Stage B hard-gate passers only
 *   - Sparse global candidates near 23/29/35/41/47 and dense control groups
 *   - Preset calibration (low / medium / strong) with degeneration thresholds
 *   - Safe operating bands and cliff boundaries per candidate
 *   - Fallback configuration and single-layer fallback behavior
 *   - Output artifacts are JSON-serializable
 *   - Reproducibility from committed config and seed values
 */

import { strict as assert } from "node:assert";
import { existsSync, unlinkSync, rmdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildParitySweepConfig,
  runParitySweep,
} from "../gemma3-stage-b-parity.ts";

import {
  buildStageCParityConfig,
  extractTopLayers,
  runStageCParity,
  writeStageCParityResult,
  writePresetCalibration,
} from "../gemma3-stage-c-parity.ts";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ✗ ${name}`);
    console.error(`    ${msg}`);
    failed++;
  }
}

// ===========================================================================
// Helper: run Stage B pipeline to get realistic inputs
// ===========================================================================

function getStageBInputs() {
  const stageBConfig = buildParitySweepConfig();
  const stageBResult = runParitySweep(stageBConfig);
  return {
    stageBResult,
    baselineCoherence: stageBResult.baseline.coherence,
    baselineCorrectness: stageBResult.baseline.correctness,
  };
}

// ===========================================================================
// Stage C config tests
// ===========================================================================

console.log("\nGemma 3 Stage C Parity — Config construction");

test("buildStageCParityConfig returns valid config with all required fields", () => {
  const config = buildStageCParityConfig();
  assert.equal(config.stage, "C-parity");
  assert.equal(config.model, "gemma-3-27b-it");
  assert.ok(config.model_revision, "model_revision must be set");
  assert.ok(config.dataset_version, "dataset_version must be set");
  assert.equal(typeof config.seed, "number");
  assert.ok(config.stage_b_ref, "stage_b_ref must be set");
  assert.ok(config.top_k_layers > 0, "top_k_layers must be > 0");
  assert.ok(
    config.combination_sizes.length > 0,
    "combination_sizes must not be empty"
  );
  assert.ok(
    config.preset_multipliers.low.length > 0,
    "low presets must exist"
  );
  assert.ok(
    config.preset_multipliers.medium.length > 0,
    "medium presets must exist"
  );
  assert.ok(
    config.preset_multipliers.strong.length > 0,
    "strong presets must exist"
  );
  assert.ok(config.prompts.length > 0, "prompts must not be empty");
  assert.ok(config.concepts.length > 0, "concepts must not be empty");
  assert.ok(config.judge_bundle, "judge_bundle must be set");
});

test("buildStageCParityConfig accepts overrides", () => {
  const config = buildStageCParityConfig({
    seed: 42,
    model_revision: "custom-rev",
  });
  assert.equal(config.seed, 42);
  assert.equal(config.model_revision, "custom-rev");
  assert.equal(config.model, "gemma-3-27b-it");
});

test("buildStageCParityConfig records model revision and dataset version", () => {
  const config = buildStageCParityConfig();
  assert.equal(
    config.model_revision,
    "gemma-3-27b-it-qat-q4_0-gguf-2025-03-15"
  );
  assert.equal(config.dataset_version, "steer-core-ramp-parity-v1");
});

test("buildStageCParityConfig references Stage B artifact", () => {
  const config = buildStageCParityConfig();
  assert.equal(config.stage_b_ref, "gemma3-stage-b-parity.json");
});

// ===========================================================================
// extractTopLayers tests
// ===========================================================================

console.log("\nGemma 3 Stage C Parity — Layer extraction from Stage B");

test("extractTopLayers selects unique layers sorted ascending from hard-gate passers", () => {
  const candidates = [
    { rank: 1, layer: 41, multiplier: 0.15, rank_score: 0.9, hard_gate_result: { overall: true } },
    { rank: 2, layer: 35, multiplier: 0.15, rank_score: 0.88, hard_gate_result: { overall: true } },
    { rank: 3, layer: 41, multiplier: 0.25, rank_score: 0.87, hard_gate_result: { overall: true } },
    { rank: 4, layer: 29, multiplier: 0.15, rank_score: 0.86, hard_gate_result: { overall: true } },
    { rank: 5, layer: 47, multiplier: 0.15, rank_score: 0.85, hard_gate_result: { overall: true } },
  ];
  const layers = extractTopLayers(candidates, 4);
  assert.deepStrictEqual(layers, [29, 35, 41, 47]);
});

test("extractTopLayers respects top_k limit", () => {
  const candidates = [
    { rank: 1, layer: 41, multiplier: 0.15, rank_score: 0.9, hard_gate_result: { overall: true } },
    { rank: 2, layer: 35, multiplier: 0.15, rank_score: 0.88, hard_gate_result: { overall: true } },
    { rank: 3, layer: 29, multiplier: 0.15, rank_score: 0.86, hard_gate_result: { overall: true } },
    { rank: 4, layer: 47, multiplier: 0.15, rank_score: 0.85, hard_gate_result: { overall: true } },
    { rank: 5, layer: 23, multiplier: 0.15, rank_score: 0.84, hard_gate_result: { overall: true } },
  ];
  const layers = extractTopLayers(candidates, 3);
  assert.equal(layers.length, 3);
});

test("extractTopLayers deduplicates layers appearing at multiple multipliers", () => {
  const candidates = [
    { rank: 1, layer: 41, multiplier: 0.15, rank_score: 0.9, hard_gate_result: { overall: true } },
    { rank: 2, layer: 41, multiplier: 0.25, rank_score: 0.89, hard_gate_result: { overall: true } },
    { rank: 3, layer: 41, multiplier: 0.05, rank_score: 0.88, hard_gate_result: { overall: true } },
    { rank: 4, layer: 35, multiplier: 0.15, rank_score: 0.87, hard_gate_result: { overall: true } },
  ];
  const layers = extractTopLayers(candidates, 3);
  assert.ok(
    new Set(layers).size === layers.length,
    "layers must be unique"
  );
});

test("extractTopLayers only includes hard-gate passers", () => {
  const candidates = [
    { rank: 1, layer: 41, multiplier: 0.15, rank_score: 0.95, hard_gate_result: { overall: false } },
    { rank: 2, layer: 35, multiplier: 0.15, rank_score: 0.88, hard_gate_result: { overall: true } },
    { rank: 3, layer: 29, multiplier: 0.15, rank_score: 0.86, hard_gate_result: { overall: true } },
  ];
  const layers = extractTopLayers(candidates, 3);
  assert.ok(!layers.includes(41), "layer 41 should be excluded (failed hard gate)");
  assert.ok(layers.includes(35), "layer 35 should be included");
  assert.ok(layers.includes(29), "layer 29 should be included");
});

// ===========================================================================
// Stage C execution tests
// ===========================================================================

console.log("\nGemma 3 Stage C Parity — Multi-layer calibration sweep");

test("runStageCParity produces reproducible results (same seed = same metrics)", () => {
  const { stageBResult, baselineCoherence, baselineCorrectness } =
    getStageBInputs();
  const config = buildStageCParityConfig({
    top_k_layers: 5,
    combination_sizes: [3],
    preset_multipliers: {
      low: [0.08],
      medium: [0.20],
      strong: [0.40],
    },
  });

  const r1 = runStageCParity(
    config,
    stageBResult.challenger_candidates,
    baselineCoherence,
    baselineCorrectness
  );
  const r2 = runStageCParity(
    config,
    stageBResult.challenger_candidates,
    baselineCoherence,
    baselineCorrectness
  );

  assert.deepStrictEqual(
    r1.per_combination_metrics,
    r2.per_combination_metrics
  );
  assert.deepStrictEqual(r1.candidates, r2.candidates);
});

test("runStageCParity produces ranked multi-layer candidates", () => {
  const { stageBResult, baselineCoherence, baselineCorrectness } =
    getStageBInputs();
  const config = buildStageCParityConfig();
  const result = runStageCParity(
    config,
    stageBResult.challenger_candidates,
    baselineCoherence,
    baselineCorrectness
  );

  assert.ok(
    result.candidates.length > 0,
    "must produce at least one multi-layer candidate"
  );

  for (let i = 1; i < result.candidates.length; i++) {
    assert.ok(
      result.candidates[i - 1].rank_score >= result.candidates[i].rank_score,
      "candidates must be sorted by rank_score descending"
    );
  }
});

test("runStageCParity candidates have complete preset tables", () => {
  const { stageBResult, baselineCoherence, baselineCorrectness } =
    getStageBInputs();
  const config = buildStageCParityConfig();
  const result = runStageCParity(
    config,
    stageBResult.challenger_candidates,
    baselineCoherence,
    baselineCorrectness
  );

  for (const c of result.candidates) {
    assert.equal(typeof c.preset_table.low, "number", "low must be a number");
    assert.equal(
      typeof c.preset_table.medium,
      "number",
      "medium must be a number"
    );
    assert.equal(
      typeof c.preset_table.strong,
      "number",
      "strong must be a number"
    );
    assert.ok(
      c.preset_table.low < c.preset_table.medium,
      "low < medium"
    );
    assert.ok(
      c.preset_table.medium < c.preset_table.strong,
      "medium < strong"
    );
  }
});

test("runStageCParity candidates have multi-layer sets (not single layer)", () => {
  const { stageBResult, baselineCoherence, baselineCorrectness } =
    getStageBInputs();
  const config = buildStageCParityConfig();
  const result = runStageCParity(
    config,
    stageBResult.challenger_candidates,
    baselineCoherence,
    baselineCorrectness
  );

  for (const c of result.candidates) {
    assert.ok(
      c.layers.length >= 3,
      "multi-layer candidates must have >= 3 layers"
    );
    const sorted = [...c.layers].sort((a, b) => a - b);
    assert.deepStrictEqual(
      c.layers,
      sorted,
      "layers must be sorted ascending"
    );
  }
});

test("runStageCParity includes sparse global candidates near 23/29/35/41/47", () => {
  const { stageBResult, baselineCoherence, baselineCorrectness } =
    getStageBInputs();
  const config = buildStageCParityConfig();
  const result = runStageCParity(
    config,
    stageBResult.challenger_candidates,
    baselineCoherence,
    baselineCorrectness
  );

  const rampLayers = [23, 29, 35, 41, 47];
  const sparseGlobal = result.candidates.filter(
    (c) => c.config_type === "sparse-global"
  );
  assert.ok(
    sparseGlobal.length > 0,
    "must include sparse global candidates"
  );

  const hasRampLike = sparseGlobal.some((c) =>
    rampLayers.filter((l) => c.layers.includes(l)).length >= 3
  );
  assert.ok(
    hasRampLike,
    "at least one sparse global candidate must include layers near Ramp default [23,29,35,41,47]"
  );
});

test("runStageCParity includes at least two dense control groups", () => {
  const { stageBResult, baselineCoherence, baselineCorrectness } =
    getStageBInputs();
  const config = buildStageCParityConfig();
  const result = runStageCParity(
    config,
    stageBResult.challenger_candidates,
    baselineCoherence,
    baselineCorrectness
  );

  const denseControl = result.candidates.filter(
    (c) => c.config_type === "dense-control"
  );
  assert.ok(
    denseControl.length >= 2,
    `must include at least 2 dense control groups, got ${denseControl.length}`
  );
});

// ===========================================================================
// Safe operating bands and cliff boundaries
// ===========================================================================

console.log("\nGemma 3 Stage C Parity — Safe operating bands and cliffs");

test("runStageCParity candidates include safe operating bands", () => {
  const { stageBResult, baselineCoherence, baselineCorrectness } =
    getStageBInputs();
  const config = buildStageCParityConfig();
  const result = runStageCParity(
    config,
    stageBResult.challenger_candidates,
    baselineCoherence,
    baselineCorrectness
  );

  for (const c of result.candidates) {
    assert.ok(
      c.safe_operating_bands.length > 0,
      "each candidate must have safe operating bands"
    );
    for (const band of c.safe_operating_bands) {
      assert.ok(
        ["low", "medium", "strong"].includes(band.preset),
        "band preset must be low/medium/strong"
      );
      assert.ok(
        band.multiplier_min <= band.multiplier_max,
        "multiplier_min <= multiplier_max"
      );
      assert.equal(typeof band.coherence_floor, "number");
      assert.equal(typeof band.degenerate_rate_ceiling, "number");
    }
  }
});

test("runStageCParity candidates include degeneration thresholds", () => {
  const { stageBResult, baselineCoherence, baselineCorrectness } =
    getStageBInputs();
  const config = buildStageCParityConfig();
  const result = runStageCParity(
    config,
    stageBResult.challenger_candidates,
    baselineCoherence,
    baselineCorrectness
  );

  for (const c of result.candidates) {
    assert.ok(
      c.degeneration_thresholds.length > 0,
      "each candidate must have degeneration thresholds"
    );
    for (const t of c.degeneration_thresholds) {
      assert.ok(
        ["low", "medium", "strong"].includes(t.preset),
        "threshold preset must be low/medium/strong"
      );
      assert.equal(typeof t.max_multiplier_before_cliff, "number");
      assert.equal(typeof t.degenerate_rate_at_cliff, "number");
    }
  }
});

test("runStageCParity candidates have cliff_boundaries arrays", () => {
  const { stageBResult, baselineCoherence, baselineCorrectness } =
    getStageBInputs();
  const config = buildStageCParityConfig();
  const result = runStageCParity(
    config,
    stageBResult.challenger_candidates,
    baselineCoherence,
    baselineCorrectness
  );

  for (const c of result.candidates) {
    assert.ok(
      Array.isArray(c.cliff_boundaries),
      "cliff_boundaries must be an array"
    );
    for (const cliff of c.cliff_boundaries) {
      assert.equal(typeof cliff.multiplier_threshold, "number");
      assert.equal(typeof cliff.coherence_before, "number");
      assert.equal(typeof cliff.coherence_after, "number");
      assert.equal(typeof cliff.description, "string");
    }
  }
});

// ===========================================================================
// Preset calibration table
// ===========================================================================

console.log("\nGemma 3 Stage C Parity — Preset calibration table");

test("runStageCParity includes preset calibration table", () => {
  const { stageBResult, baselineCoherence, baselineCorrectness } =
    getStageBInputs();
  const config = buildStageCParityConfig();
  const result = runStageCParity(
    config,
    stageBResult.challenger_candidates,
    baselineCoherence,
    baselineCorrectness
  );

  const table = result.preset_calibration_table;
  assert.equal(table.stage, "C-parity");
  assert.equal(table.model, "gemma-3-27b-it");
  assert.ok(table.presets.length > 0, "presets must not be empty");
  assert.ok(table.calibration_notes.length > 0, "calibration_notes must exist");
});

test("preset calibration table defines low, medium, strong operating points", () => {
  const { stageBResult, baselineCoherence, baselineCorrectness } =
    getStageBInputs();
  const config = buildStageCParityConfig();
  const result = runStageCParity(
    config,
    stageBResult.challenger_candidates,
    baselineCoherence,
    baselineCorrectness
  );

  const table = result.preset_calibration_table;
  const presetTypes = new Set(table.presets.map((p) => p.preset));
  assert.ok(presetTypes.has("low"), "must have low preset entries");
  assert.ok(presetTypes.has("medium"), "must have medium preset entries");
  assert.ok(presetTypes.has("strong"), "must have strong preset entries");
});

test("preset calibration entries include degeneration thresholds and safe bands", () => {
  const { stageBResult, baselineCoherence, baselineCorrectness } =
    getStageBInputs();
  const config = buildStageCParityConfig();
  const result = runStageCParity(
    config,
    stageBResult.challenger_candidates,
    baselineCoherence,
    baselineCorrectness
  );

  for (const entry of result.preset_calibration_table.presets) {
    assert.equal(typeof entry.calibrated_multiplier, "number");
    assert.equal(typeof entry.degeneration_threshold, "number");
    assert.equal(typeof entry.safe_band_min, "number");
    assert.equal(typeof entry.safe_band_max, "number");
    assert.ok(
      entry.safe_band_min <= entry.safe_band_max,
      "safe_band_min <= safe_band_max"
    );
  }
});

// ===========================================================================
// Fallback configuration
// ===========================================================================

console.log("\nGemma 3 Stage C Parity — Fallback configuration");

test("runStageCParity includes fallback configuration", () => {
  const { stageBResult, baselineCoherence, baselineCorrectness } =
    getStageBInputs();
  const config = buildStageCParityConfig();
  const result = runStageCParity(
    config,
    stageBResult.challenger_candidates,
    baselineCoherence,
    baselineCorrectness
  );

  const fb = result.fallback_configuration;
  assert.ok(fb.single_layer_fallback, "must have single_layer_fallback");
  assert.equal(typeof fb.single_layer_fallback.layer, "number");
  assert.equal(
    typeof fb.single_layer_fallback.preset_table.low,
    "number"
  );
  assert.equal(
    typeof fb.single_layer_fallback.preset_table.medium,
    "number"
  );
  assert.equal(
    typeof fb.single_layer_fallback.preset_table.strong,
    "number"
  );
  assert.ok(
    fb.single_layer_fallback.description.length > 0,
    "fallback description must exist"
  );
  assert.ok(
    fb.fallback_behavior.length > 0,
    "fallback_behavior must describe behavior"
  );
});

test("fallback configuration single-layer fallback prefers layer 41", () => {
  const { stageBResult, baselineCoherence, baselineCorrectness } =
    getStageBInputs();
  const config = buildStageCParityConfig();
  const result = runStageCParity(
    config,
    stageBResult.challenger_candidates,
    baselineCoherence,
    baselineCorrectness
  );

  assert.equal(
    result.fallback_configuration.single_layer_fallback.layer,
    41,
    "single-layer fallback should be layer 41 per Ramp findings"
  );
});

test("preset calibration table includes fallback configuration", () => {
  const { stageBResult, baselineCoherence, baselineCorrectness } =
    getStageBInputs();
  const config = buildStageCParityConfig();
  const result = runStageCParity(
    config,
    stageBResult.challenger_candidates,
    baselineCoherence,
    baselineCorrectness
  );

  const table = result.preset_calibration_table;
  assert.ok(
    table.fallback_configuration,
    "calibration table must include fallback"
  );
  assert.equal(
    table.fallback_configuration.single_layer_fallback.layer,
    41
  );
});

// ===========================================================================
// Profile bundles
// ===========================================================================

console.log("\nGemma 3 Stage C Parity — Profile bundles");

test("runStageCParity candidates include profile bundles with required fields", () => {
  const { stageBResult, baselineCoherence, baselineCorrectness } =
    getStageBInputs();
  const config = buildStageCParityConfig();
  const result = runStageCParity(
    config,
    stageBResult.challenger_candidates,
    baselineCoherence,
    baselineCorrectness
  );

  for (const c of result.candidates) {
    const b = c.profile_bundle;
    assert.ok(b.profile_id, "profile_id must be set");
    assert.ok(
      b.profile_id.startsWith("steer-gemma3-"),
      "profile_id must start with steer-gemma3-"
    );
    assert.equal(b.base_model, "gemma-3-27b-it");
    assert.equal(
      b.base_model_revision,
      "gemma-3-27b-it-qat-q4_0-gguf-2025-03-15"
    );
    assert.ok(
      Array.isArray(b.layers) && b.layers.length > 0,
      "layers must exist"
    );
    assert.equal(typeof b.fallback_layer, "number");
    assert.ok(
      b.layers.includes(b.fallback_layer),
      "fallback_layer must be in layers"
    );
    assert.ok(b.vector_bundle_id, "vector_bundle_id must be set");
    assert.equal(typeof b.preset_table.low, "number");
    assert.equal(typeof b.preset_table.medium, "number");
    assert.equal(typeof b.preset_table.strong, "number");
    assert.ok(b.judge_bundle, "judge_bundle must be set");
    assert.ok(b.created_at, "created_at must be set");
  }
});

// ===========================================================================
// Candidates built from Stage B passers only
// ===========================================================================

console.log("\nGemma 3 Stage C Parity — Stage B passer constraint");

test("runStageCParity builds candidates from Stage B hard-gate passers only", () => {
  const { stageBResult, baselineCoherence, baselineCorrectness } =
    getStageBInputs();
  const config = buildStageCParityConfig();
  const result = runStageCParity(
    config,
    stageBResult.challenger_candidates,
    baselineCoherence,
    baselineCorrectness
  );

  const stageBLayers = new Set(
    stageBResult.challenger_candidates
      .filter((c: { hard_gate_result: { overall: boolean } }) => c.hard_gate_result.overall)
      .map((c: { layer: number }) => c.layer)
  );

  for (const c of result.candidates) {
    for (const l of c.layers) {
      assert.ok(
        stageBLayers.has(l),
        `Layer ${l} must come from Stage B hard-gate passers`
      );
    }
  }
});

// ===========================================================================
// Serialization and artifact tests
// ===========================================================================

console.log("\nGemma 3 Stage C Parity — Artifact serialization");

test("runStageCParity result is JSON-serializable", () => {
  const { stageBResult, baselineCoherence, baselineCorrectness } =
    getStageBInputs();
  const config = buildStageCParityConfig({
    top_k_layers: 5,
    combination_sizes: [3],
    preset_multipliers: {
      low: [0.08],
      medium: [0.20],
      strong: [0.40],
    },
  });
  const result = runStageCParity(
    config,
    stageBResult.challenger_candidates,
    baselineCoherence,
    baselineCorrectness
  );

  const json = JSON.stringify(result);
  const parsed = JSON.parse(json);
  assert.equal(parsed.stage, "C-parity");
  assert.ok(Array.isArray(parsed.per_combination_metrics));
  assert.ok(Array.isArray(parsed.candidates));
  assert.ok(parsed.config.seed === config.seed);
  assert.ok(parsed.preset_calibration_table);
  assert.ok(parsed.fallback_configuration);
});

test("writeStageCParityResult writes valid JSON artifact", () => {
  const { stageBResult, baselineCoherence, baselineCorrectness } =
    getStageBInputs();
  const config = buildStageCParityConfig({
    top_k_layers: 5,
    combination_sizes: [3],
    preset_multipliers: {
      low: [0.08],
      medium: [0.20],
      strong: [0.40],
    },
  });
  const result = runStageCParity(
    config,
    stageBResult.challenger_candidates,
    baselineCoherence,
    baselineCorrectness
  );

  const __filename = fileURLToPath(import.meta.url);
  const tmpDir = path.join(
    path.dirname(__filename),
    "..",
    "..",
    "..",
    ".tmp-test-stage-c-parity"
  );
  const outPath = writeStageCParityResult(result, tmpDir);
  assert.ok(existsSync(outPath), "artifact file must exist");
  unlinkSync(outPath);

  const calibPath = writePresetCalibration(
    result.preset_calibration_table,
    tmpDir
  );
  assert.ok(existsSync(calibPath), "calibration file must exist");
  unlinkSync(calibPath);
  rmdirSync(tmpDir);
});

test("runStageCParity tracks total combinations tested and hard gate pass count", () => {
  const { stageBResult, baselineCoherence, baselineCorrectness } =
    getStageBInputs();
  const config = buildStageCParityConfig();
  const result = runStageCParity(
    config,
    stageBResult.challenger_candidates,
    baselineCoherence,
    baselineCorrectness
  );

  assert.ok(
    result.total_combinations_tested > 0,
    "must test at least one combination"
  );
  assert.ok(
    result.passed_hard_gates > 0,
    "at least some combinations must pass hard gates"
  );
  assert.ok(
    result.passed_hard_gates <= result.total_combinations_tested,
    "passed cannot exceed total"
  );
});

test("runStageCParity references Stage B result", () => {
  const { stageBResult, baselineCoherence, baselineCorrectness } =
    getStageBInputs();
  const config = buildStageCParityConfig();
  const result = runStageCParity(
    config,
    stageBResult.challenger_candidates,
    baselineCoherence,
    baselineCorrectness
  );

  assert.ok(result.stage_b_ref, "must reference Stage B");
  assert.equal(result.stage_b_ref, "gemma3-stage-b-parity.json");
});

// ===========================================================================
// Summary
// ===========================================================================

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);

if (failed > 0) {
  process.exit(1);
}
