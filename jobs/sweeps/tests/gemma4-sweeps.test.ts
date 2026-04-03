/**
 * Tests for Gemma 4 Stage A/B sweep automation.
 *
 * Validates:
 *   - Config construction with seed control and model metadata
 *   - Stage A baseline produces reproducible metrics that pass hard gates
 *   - Stage B single-layer sweep emits per-layer metrics and challenger candidates
 *   - Output artifacts are JSON-serializable (ingestible by gate checker)
 */

import { strict as assert } from "node:assert";
import { buildStageAConfig, runStageA } from "../gemma4-stage-a.ts";
import { buildStageBConfig, runStageB } from "../gemma4-stage-b.ts";

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
// Stage A tests
// ===========================================================================

console.log("\nStage A — Baseline config & execution");

test("buildStageAConfig returns valid config with all required fields", () => {
  const config = buildStageAConfig();
  assert.equal(config.stage, "A");
  assert.equal(config.model, "gemma-4-27b-it");
  assert.ok(config.model_revision, "model_revision must be set");
  assert.ok(config.dataset_version, "dataset_version must be set");
  assert.equal(typeof config.seed, "number");
  assert.equal(config.steering_enabled, false);
  assert.ok(config.prompts.length > 0, "prompts must not be empty");
  assert.ok(config.concepts.length > 0, "concepts must not be empty");
  assert.ok(config.judge_bundle, "judge_bundle must be set");
});

test("buildStageAConfig accepts overrides", () => {
  const config = buildStageAConfig({ seed: 42, model_revision: "custom-rev" });
  assert.equal(config.seed, 42);
  assert.equal(config.model_revision, "custom-rev");
  assert.equal(config.model, "gemma-4-27b-it");
});

test("runStageA produces reproducible results (same seed = same metrics)", () => {
  const config = buildStageAConfig({ seed: 12345 });
  const r1 = runStageA(config);
  const r2 = runStageA(config);
  assert.deepStrictEqual(r1.metrics, r2.metrics);
});

test("runStageA baseline passes hard gates", () => {
  const config = buildStageAConfig();
  const result = runStageA(config);
  assert.equal(result.status, "pass");
  assert.equal(result.challenger_eligible, true);
  assert.ok(result.metrics.degenerate_rate <= 0.03, "degenerate_rate must be <= 3%");
  assert.ok(result.metrics.language_stability >= 0.99, "language_stability must be >= 99%");
  assert.ok(result.metrics.coherence >= 0.80, "coherence must be >= 0.80");
});

test("runStageA result includes model revision and dataset version", () => {
  const config = buildStageAConfig();
  const result = runStageA(config);
  assert.equal(result.config.model_revision, "2026-06-01");
  assert.equal(result.config.dataset_version, "steer-core-golden-v20260601");
});

test("runStageA result is JSON-serializable", () => {
  const config = buildStageAConfig();
  const result = runStageA(config);
  const json = JSON.stringify(result);
  const parsed = JSON.parse(json);
  assert.equal(parsed.stage, "A");
  assert.equal(typeof parsed.metrics.coherence, "number");
});

// ===========================================================================
// Stage B tests
// ===========================================================================

console.log("\nStage B — Single-layer sweep");

test("buildStageBConfig returns valid config with all required fields", () => {
  const config = buildStageBConfig();
  assert.equal(config.stage, "B");
  assert.equal(config.model, "gemma-4-27b-it");
  assert.ok(config.model_revision, "model_revision must be set");
  assert.ok(config.dataset_version, "dataset_version must be set");
  assert.equal(typeof config.seed, "number");
  assert.ok(config.candidate_layers.length > 0, "candidate_layers must not be empty");
  assert.ok(config.multipliers.length > 0, "multipliers must not be empty");
  assert.ok(config.judge_bundle, "judge_bundle must be set");
});

test("buildStageBConfig covers layer range 16-53", () => {
  const config = buildStageBConfig();
  assert.equal(config.candidate_layers[0], 16);
  assert.equal(config.candidate_layers[config.candidate_layers.length - 1], 53);
  assert.equal(config.candidate_layers.length, 38);
});

test("runStageB produces reproducible results (same seed = same metrics)", () => {
  const config = buildStageBConfig({
    candidate_layers: [35, 41, 47],
    multipliers: [0.15, 0.22],
  });
  const r1 = runStageB(config, 0.90, 0.88);
  const r2 = runStageB(config, 0.90, 0.88);
  assert.deepStrictEqual(r1.per_layer_metrics, r2.per_layer_metrics);
  assert.deepStrictEqual(r1.challenger_candidates, r2.challenger_candidates);
});

test("runStageB emits per-layer quality metrics for every configuration", () => {
  const config = buildStageBConfig({
    candidate_layers: [35, 41, 47],
    multipliers: [0.15, 0.22],
  });
  const result = runStageB(config, 0.90, 0.88);
  assert.equal(result.per_layer_metrics.length, 3 * 2);
  for (const m of result.per_layer_metrics) {
    assert.equal(typeof m.layer, "number");
    assert.equal(typeof m.multiplier, "number");
    assert.equal(typeof m.coherence, "number");
    assert.equal(typeof m.concept_adherence, "number");
    assert.equal(typeof m.correctness, "number");
    assert.equal(typeof m.degenerate_rate, "number");
    assert.equal(typeof m.language_stability, "number");
    assert.equal(typeof m.rank_score, "number");
  }
});

test("runStageB produces challenger candidates with profile IDs", () => {
  const config = buildStageBConfig({
    candidate_layers: [35, 41, 47],
    multipliers: [0.15, 0.22],
  });
  const result = runStageB(config, 0.85, 0.82);
  assert.ok(result.challenger_candidates.length > 0, "should have at least one candidate");
  for (const c of result.challenger_candidates) {
    assert.ok(c.profile_id.startsWith("steer-gemma4-"), "profile_id must start with steer-gemma4-");
    assert.equal(typeof c.rank, "number");
    assert.equal(typeof c.rank_score, "number");
    assert.ok(c.rank >= 1, "rank must be >= 1");
  }
});

test("runStageB candidates are ranked by rank_score descending", () => {
  const config = buildStageBConfig({
    candidate_layers: [23, 29, 35, 41, 47],
    multipliers: [0.10, 0.15, 0.22],
  });
  const result = runStageB(config, 0.85, 0.82);
  for (let i = 1; i < result.challenger_candidates.length; i++) {
    assert.ok(
      result.challenger_candidates[i - 1].rank_score >=
        result.challenger_candidates[i].rank_score,
      "candidates must be sorted by rank_score descending"
    );
  }
});

test("runStageB result records model revision and dataset version", () => {
  const config = buildStageBConfig();
  const result = runStageB(config, 0.90, 0.88);
  assert.equal(result.config.model_revision, "2026-06-01");
  assert.equal(result.config.dataset_version, "steer-core-golden-v20260601");
});

test("runStageB result is JSON-serializable (gate checker ingestible)", () => {
  const config = buildStageBConfig({
    candidate_layers: [35, 41],
    multipliers: [0.22],
  });
  const result = runStageB(config, 0.85, 0.82);
  const json = JSON.stringify(result);
  const parsed = JSON.parse(json);
  assert.equal(parsed.stage, "B");
  assert.ok(Array.isArray(parsed.per_layer_metrics));
  assert.ok(Array.isArray(parsed.challenger_candidates));
});

test("runStageB full sweep produces candidates for Stage C", () => {
  const config = buildStageBConfig();
  const stageAConfig = buildStageAConfig();
  const stageAResult = runStageA(stageAConfig);
  const result = runStageB(
    config,
    stageAResult.metrics.coherence,
    stageAResult.metrics.correctness
  );
  assert.ok(result.challenger_candidates.length > 0, "full sweep must produce Stage C candidates");
  assert.ok(result.total_configurations_tested > 0);
  assert.ok(result.passed_hard_gates > 0);
  assert.ok(result.baseline_ref, "must reference baseline");
});

// ===========================================================================
// Summary
// ===========================================================================

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);

if (failed > 0) {
  process.exit(1);
}
