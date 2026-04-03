/**
 * Tests for Gemma 4 Stage C multi-layer calibration sweep.
 *
 * Validates:
 *   - Config construction with seed control and model metadata
 *   - Multi-layer candidate generation from Stage B winners
 *   - Preset calibration (low / medium / strong) for each candidate
 *   - Output profile bundles match the profile schema
 *   - Reproducibility from committed config and seed values
 *   - Output artifacts are JSON-serializable (ingestible by gate checker)
 */

import { strict as assert } from "node:assert";
import { buildStageAConfig, runStageA } from "../gemma4-stage-a.ts";
import { buildStageBConfig, runStageB } from "../gemma4-stage-b.ts";
import {
  buildStageCConfig,
  extractTopLayers,
  runStageC,
} from "../gemma4-stage-c.ts";

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
// Helper: run full Stage A + B pipeline to get realistic inputs
// ===========================================================================

function getStageBCandidates() {
  const stageAConfig = buildStageAConfig();
  const stageAResult = runStageA(stageAConfig);
  const stageBConfig = buildStageBConfig();
  const stageBResult = runStageB(
    stageBConfig,
    stageAResult.metrics.coherence,
    stageAResult.metrics.correctness
  );
  return {
    stageAResult,
    stageBResult,
    baselineCoherence: stageAResult.metrics.coherence,
    baselineCorrectness: stageAResult.metrics.correctness,
    baselineLatencyP95: stageAResult.metrics.latency_p95_ms,
  };
}

// ===========================================================================
// Stage C config tests
// ===========================================================================

console.log("\nStage C — Config construction");

test("buildStageCConfig returns valid config with all required fields", () => {
  const config = buildStageCConfig();
  assert.equal(config.stage, "C");
  assert.equal(config.model, "gemma-4-27b-it");
  assert.ok(config.model_revision, "model_revision must be set");
  assert.ok(config.dataset_version, "dataset_version must be set");
  assert.equal(typeof config.seed, "number");
  assert.ok(config.stage_b_ref, "stage_b_ref must be set");
  assert.ok(config.top_k_layers > 0, "top_k_layers must be > 0");
  assert.ok(
    config.combination_sizes.length > 0,
    "combination_sizes must not be empty"
  );
  assert.ok(config.preset_multipliers.low.length > 0, "low presets must exist");
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

test("buildStageCConfig accepts overrides", () => {
  const config = buildStageCConfig({ seed: 42, model_revision: "custom-rev" });
  assert.equal(config.seed, 42);
  assert.equal(config.model_revision, "custom-rev");
  assert.equal(config.model, "gemma-4-27b-it");
});

test("buildStageCConfig records model revision and dataset version", () => {
  const config = buildStageCConfig();
  assert.equal(config.model_revision, "2026-06-01");
  assert.equal(config.dataset_version, "steer-core-golden-v20260601");
});

// ===========================================================================
// extractTopLayers tests
// ===========================================================================

console.log("\nStage C — Layer extraction from Stage B");

test("extractTopLayers selects unique layers sorted ascending", () => {
  const candidates = [
    { rank: 1, layer: 41, multiplier: 0.22, rank_score: 0.9 },
    { rank: 2, layer: 35, multiplier: 0.15, rank_score: 0.88 },
    { rank: 3, layer: 41, multiplier: 0.15, rank_score: 0.87 },
    { rank: 4, layer: 29, multiplier: 0.22, rank_score: 0.86 },
    { rank: 5, layer: 47, multiplier: 0.10, rank_score: 0.85 },
  ];
  const layers = extractTopLayers(candidates, 4);
  assert.deepStrictEqual(layers, [29, 35, 41, 47]);
});

test("extractTopLayers respects top_k limit", () => {
  const candidates = [
    { rank: 1, layer: 41, multiplier: 0.22, rank_score: 0.9 },
    { rank: 2, layer: 35, multiplier: 0.15, rank_score: 0.88 },
    { rank: 3, layer: 29, multiplier: 0.22, rank_score: 0.86 },
    { rank: 4, layer: 47, multiplier: 0.10, rank_score: 0.85 },
    { rank: 5, layer: 23, multiplier: 0.10, rank_score: 0.84 },
  ];
  const layers = extractTopLayers(candidates, 3);
  assert.equal(layers.length, 3);
});

test("extractTopLayers deduplicates layers appearing at multiple multipliers", () => {
  const candidates = [
    { rank: 1, layer: 41, multiplier: 0.22, rank_score: 0.9 },
    { rank: 2, layer: 41, multiplier: 0.15, rank_score: 0.89 },
    { rank: 3, layer: 41, multiplier: 0.10, rank_score: 0.88 },
    { rank: 4, layer: 35, multiplier: 0.22, rank_score: 0.87 },
  ];
  const layers = extractTopLayers(candidates, 3);
  assert.ok(
    new Set(layers).size === layers.length,
    "layers must be unique"
  );
});

// ===========================================================================
// Stage C execution tests
// ===========================================================================

console.log("\nStage C — Multi-layer calibration sweep");

test("runStageC produces reproducible results (same seed = same metrics)", () => {
  const { stageBResult, baselineCoherence, baselineCorrectness, baselineLatencyP95 } =
    getStageBCandidates();
  const config = buildStageCConfig({
    top_k_layers: 4,
    combination_sizes: [3],
    preset_multipliers: {
      low: [0.10],
      medium: [0.22],
      strong: [0.35],
    },
  });

  const r1 = runStageC(
    config,
    stageBResult.challenger_candidates,
    baselineCoherence,
    baselineCorrectness,
    baselineLatencyP95
  );
  const r2 = runStageC(
    config,
    stageBResult.challenger_candidates,
    baselineCoherence,
    baselineCorrectness,
    baselineLatencyP95
  );

  assert.deepStrictEqual(
    r1.per_combination_metrics,
    r2.per_combination_metrics
  );
  assert.deepStrictEqual(r1.candidates, r2.candidates);
});

test("runStageC produces ranked multi-layer candidates", () => {
  const { stageBResult, baselineCoherence, baselineCorrectness, baselineLatencyP95 } =
    getStageBCandidates();
  const config = buildStageCConfig();
  const result = runStageC(
    config,
    stageBResult.challenger_candidates,
    baselineCoherence,
    baselineCorrectness,
    baselineLatencyP95
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

test("runStageC candidates have complete preset tables", () => {
  const { stageBResult, baselineCoherence, baselineCorrectness, baselineLatencyP95 } =
    getStageBCandidates();
  const config = buildStageCConfig();
  const result = runStageC(
    config,
    stageBResult.challenger_candidates,
    baselineCoherence,
    baselineCorrectness,
    baselineLatencyP95
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

test("runStageC candidates have multi-layer sets (not single layer)", () => {
  const { stageBResult, baselineCoherence, baselineCorrectness, baselineLatencyP95 } =
    getStageBCandidates();
  const config = buildStageCConfig();
  const result = runStageC(
    config,
    stageBResult.challenger_candidates,
    baselineCoherence,
    baselineCorrectness,
    baselineLatencyP95
  );

  for (const c of result.candidates) {
    assert.ok(c.layers.length >= 3, "multi-layer candidates must have >= 3 layers");
    const sorted = [...c.layers].sort((a, b) => a - b);
    assert.deepStrictEqual(c.layers, sorted, "layers must be sorted ascending");
  }
});

test("runStageC candidates include profile bundles with required fields", () => {
  const { stageBResult, baselineCoherence, baselineCorrectness, baselineLatencyP95 } =
    getStageBCandidates();
  const config = buildStageCConfig();
  const result = runStageC(
    config,
    stageBResult.challenger_candidates,
    baselineCoherence,
    baselineCorrectness,
    baselineLatencyP95
  );

  for (const c of result.candidates) {
    const b = c.profile_bundle;
    assert.ok(b.profile_id, "profile_id must be set");
    assert.equal(b.base_model, "gemma-4-27b-it");
    assert.equal(b.base_model_revision, "2026-06-01");
    assert.ok(Array.isArray(b.layers) && b.layers.length > 0, "layers must exist");
    assert.equal(typeof b.fallback_layer, "number");
    assert.ok(b.layers.includes(b.fallback_layer), "fallback_layer must be in layers");
    assert.ok(b.vector_bundle_id, "vector_bundle_id must be set");
    assert.equal(typeof b.preset_table.low, "number");
    assert.equal(typeof b.preset_table.medium, "number");
    assert.equal(typeof b.preset_table.strong, "number");
    assert.ok(b.judge_bundle, "judge_bundle must be set");
    assert.ok(b.created_at, "created_at must be set");
  }
});

test("runStageC output includes model revision, dataset version, and selected layer sets", () => {
  const { stageBResult, baselineCoherence, baselineCorrectness, baselineLatencyP95 } =
    getStageBCandidates();
  const config = buildStageCConfig();
  const result = runStageC(
    config,
    stageBResult.challenger_candidates,
    baselineCoherence,
    baselineCorrectness,
    baselineLatencyP95
  );

  assert.equal(result.config.model_revision, "2026-06-01");
  assert.equal(result.config.dataset_version, "steer-core-golden-v20260601");
  for (const c of result.candidates) {
    assert.ok(
      c.layers.length >= 3,
      "selected layer sets must be present"
    );
  }
});

test("runStageC result is JSON-serializable (gate checker ingestible)", () => {
  const { stageBResult, baselineCoherence, baselineCorrectness, baselineLatencyP95 } =
    getStageBCandidates();
  const config = buildStageCConfig({
    top_k_layers: 4,
    combination_sizes: [3],
    preset_multipliers: {
      low: [0.10],
      medium: [0.22],
      strong: [0.35],
    },
  });
  const result = runStageC(
    config,
    stageBResult.challenger_candidates,
    baselineCoherence,
    baselineCorrectness,
    baselineLatencyP95
  );

  const json = JSON.stringify(result);
  const parsed = JSON.parse(json);
  assert.equal(parsed.stage, "C");
  assert.ok(Array.isArray(parsed.per_combination_metrics));
  assert.ok(Array.isArray(parsed.candidates));
  assert.ok(parsed.config.seed === config.seed);
});

test("runStageC tracks total combinations tested and hard gate pass count", () => {
  const { stageBResult, baselineCoherence, baselineCorrectness, baselineLatencyP95 } =
    getStageBCandidates();
  const config = buildStageCConfig();
  const result = runStageC(
    config,
    stageBResult.challenger_candidates,
    baselineCoherence,
    baselineCorrectness,
    baselineLatencyP95
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

test("runStageC references both Stage A and Stage B results", () => {
  const { stageBResult, baselineCoherence, baselineCorrectness, baselineLatencyP95 } =
    getStageBCandidates();
  const config = buildStageCConfig();
  const result = runStageC(
    config,
    stageBResult.challenger_candidates,
    baselineCoherence,
    baselineCorrectness,
    baselineLatencyP95
  );

  assert.ok(result.baseline_ref, "must reference baseline");
  assert.ok(result.stage_b_ref, "must reference Stage B");
});

test("runStageC builds candidates from Stage B passing layers only", () => {
  const { stageBResult, baselineCoherence, baselineCorrectness, baselineLatencyP95 } =
    getStageBCandidates();
  const config = buildStageCConfig();
  const result = runStageC(
    config,
    stageBResult.challenger_candidates,
    baselineCoherence,
    baselineCorrectness,
    baselineLatencyP95
  );

  const stageBLayers = new Set(
    stageBResult.challenger_candidates.map(
      (c: { layer: number }) => c.layer
    )
  );

  for (const c of result.candidates) {
    for (const l of c.layers) {
      assert.ok(
        stageBLayers.has(l),
        `Layer ${l} must come from Stage B passing candidates`
      );
    }
  }
});

// ===========================================================================
// Summary
// ===========================================================================

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);

if (failed > 0) {
  process.exit(1);
}
