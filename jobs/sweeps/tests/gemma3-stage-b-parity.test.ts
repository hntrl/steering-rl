/**
 * Tests for Gemma 3 Stage B Parity sweep automation.
 *
 * Validates:
 *   - Config construction with Gemma 3 model, seed control, and run-card metadata
 *   - Single-layer sweep emits per-layer metrics and challenger candidates
 *   - Sparse global and dense control configurations produce measurable differences
 *   - Hard gate pass/fail metrics recorded per configuration
 *   - Ramp parity checks: layer 41 behavior, sparse vs dense, degeneration cliffs
 *   - Output artifact is JSON-serializable
 */

import { strict as assert } from "node:assert";
import {
  buildParitySweepConfig,
  runParitySweep,
  writeParitySweepResult,
} from "../gemma3-stage-b-parity.ts";
import { existsSync, unlinkSync, rmdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
// Config tests
// ===========================================================================

console.log("\nGemma 3 Parity — Config construction");

test("buildParitySweepConfig returns valid config targeting Gemma 3 27B-IT", () => {
  const config = buildParitySweepConfig();
  assert.equal(config.stage, "B-parity");
  assert.equal(config.model, "gemma-3-27b-it");
  assert.ok(config.model_revision, "model_revision must be set");
  assert.ok(config.dataset_version, "dataset_version must be set");
  assert.equal(typeof config.seed, "number");
  assert.ok(config.prompts.length > 0, "prompts must not be empty");
  assert.ok(config.concepts.length > 0, "concepts must not be empty");
  assert.ok(config.judge_bundle, "judge_bundle must be set");
});

test("buildParitySweepConfig covers layer range 16-53", () => {
  const config = buildParitySweepConfig();
  assert.equal(config.candidate_layers[0], 16);
  assert.equal(config.candidate_layers[config.candidate_layers.length - 1], 53);
  assert.equal(config.candidate_layers.length, 38);
});

test("buildParitySweepConfig includes sparse global and dense control configurations", () => {
  const config = buildParitySweepConfig();
  const types = new Set(config.configurations.map((c) => c.type));
  assert.ok(types.has("sparse-global"), "must include sparse-global configurations");
  assert.ok(types.has("dense-control"), "must include dense-control configurations");
});

test("buildParitySweepConfig accepts overrides", () => {
  const config = buildParitySweepConfig({
    seed: 42,
    model_revision: "custom-rev",
  });
  assert.equal(config.seed, 42);
  assert.equal(config.model_revision, "custom-rev");
  assert.equal(config.model, "gemma-3-27b-it");
});

test("buildParitySweepConfig includes Ramp-reported multiplier range", () => {
  const config = buildParitySweepConfig();
  assert.ok(config.multipliers.includes(0.05), "must include low multiplier 0.05");
  assert.ok(config.multipliers.includes(0.75), "must include high multiplier 0.75");
  assert.ok(config.multipliers.length >= 5, "must have at least 5 multiplier values");
});

// ===========================================================================
// Sweep execution tests
// ===========================================================================

console.log("\nGemma 3 Parity — Sweep execution");

test("runParitySweep produces reproducible results (same seed = same metrics)", () => {
  const config = buildParitySweepConfig({
    candidate_layers: [35, 41, 47],
    multipliers: [0.15, 0.25],
  });
  const r1 = runParitySweep(config);
  const r2 = runParitySweep(config);
  assert.deepStrictEqual(r1.per_layer_metrics, r2.per_layer_metrics);
  assert.deepStrictEqual(r1.challenger_candidates, r2.challenger_candidates);
  assert.deepStrictEqual(r1.baseline, r2.baseline);
});

test("runParitySweep emits per-layer metrics for every layer×multiplier", () => {
  const config = buildParitySweepConfig({
    candidate_layers: [35, 41, 47],
    multipliers: [0.15, 0.25],
  });
  const result = runParitySweep(config);
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

test("runParitySweep includes coherence, adherence, degeneration, and language stability", () => {
  const config = buildParitySweepConfig({
    candidate_layers: [41],
    multipliers: [0.15],
  });
  const result = runParitySweep(config);
  const m = result.per_layer_metrics[0];
  assert.ok(m.coherence >= 0 && m.coherence <= 1, "coherence must be in [0,1]");
  assert.ok(m.concept_adherence >= 0 && m.concept_adherence <= 1, "adherence must be in [0,1]");
  assert.ok(m.degenerate_rate >= 0 && m.degenerate_rate <= 1, "degenerate_rate must be in [0,1]");
  assert.ok(m.language_stability >= 0 && m.language_stability <= 1, "language_stability must be in [0,1]");
});

test("runParitySweep produces challenger candidates with profile IDs", () => {
  const config = buildParitySweepConfig({
    candidate_layers: [35, 41, 47],
    multipliers: [0.15, 0.25],
  });
  const result = runParitySweep(config);
  assert.ok(result.challenger_candidates.length > 0, "should have at least one candidate");
  for (const c of result.challenger_candidates) {
    assert.ok(
      c.profile_id.startsWith("steer-gemma3-"),
      "profile_id must start with steer-gemma3-"
    );
    assert.equal(typeof c.rank, "number");
    assert.equal(typeof c.rank_score, "number");
    assert.ok(c.rank >= 1, "rank must be >= 1");
  }
});

test("runParitySweep candidates are ranked by rank_score descending", () => {
  const config = buildParitySweepConfig({
    candidate_layers: [23, 29, 35, 41, 47],
    multipliers: [0.15, 0.25],
  });
  const result = runParitySweep(config);
  for (let i = 1; i < result.challenger_candidates.length; i++) {
    assert.ok(
      result.challenger_candidates[i - 1].rank_score >=
        result.challenger_candidates[i].rank_score,
      "candidates must be sorted by rank_score descending"
    );
  }
});

test("runParitySweep candidates include hard gate pass/fail results", () => {
  const config = buildParitySweepConfig({
    candidate_layers: [35, 41, 47],
    multipliers: [0.15, 0.25],
  });
  const result = runParitySweep(config);
  for (const c of result.challenger_candidates) {
    assert.equal(typeof c.hard_gate_result.degenerate_rate_pass, "boolean");
    assert.equal(typeof c.hard_gate_result.coherence_pass, "boolean");
    assert.equal(typeof c.hard_gate_result.correctness_pass, "boolean");
    assert.equal(typeof c.hard_gate_result.language_stability_pass, "boolean");
    assert.equal(typeof c.hard_gate_result.overall, "boolean");
    assert.equal(c.hard_gate_result.overall, true, "top candidates must pass all hard gates");
  }
});

// ===========================================================================
// Configuration result tests
// ===========================================================================

console.log("\nGemma 3 Parity — Configuration results (sparse vs dense)");

test("runParitySweep includes configuration results for all config×multiplier combos", () => {
  const config = buildParitySweepConfig({
    candidate_layers: [35, 41, 47],
    multipliers: [0.15, 0.25],
  });
  const result = runParitySweep(config);
  const expected = config.configurations.length * config.multipliers.length;
  assert.equal(result.configuration_results.length, expected);
});

test("configuration results include hard gate pass/fail per configuration", () => {
  const config = buildParitySweepConfig({
    candidate_layers: [35, 41, 47],
    multipliers: [0.15, 0.55],
  });
  const result = runParitySweep(config);
  for (const cr of result.configuration_results) {
    assert.equal(typeof cr.hard_gate_result.overall, "boolean");
    assert.equal(typeof cr.hard_gate_result.degenerate_rate_pass, "boolean");
    assert.equal(typeof cr.hard_gate_result.coherence_pass, "boolean");
    assert.equal(typeof cr.hard_gate_result.correctness_pass, "boolean");
    assert.equal(typeof cr.hard_gate_result.language_stability_pass, "boolean");
  }
});

test("dense control configs at high multipliers show higher degeneration than sparse global", () => {
  const config = buildParitySweepConfig();
  const result = runParitySweep(config);
  const sparseAt075 = result.configuration_results.filter(
    (r) => r.type === "sparse-global" && r.multiplier === 0.75
  );
  const denseAt075 = result.configuration_results.filter(
    (r) => r.type === "dense-control" && r.multiplier === 0.75
  );
  assert.ok(sparseAt075.length > 0, "must have sparse-global results at 0.75");
  assert.ok(denseAt075.length > 0, "must have dense-control results at 0.75");

  const avgSparseDegen =
    sparseAt075.reduce((a, r) => a + r.metrics.degenerate_rate, 0) / sparseAt075.length;
  const avgDenseDegen =
    denseAt075.reduce((a, r) => a + r.metrics.degenerate_rate, 0) / denseAt075.length;
  assert.ok(
    avgDenseDegen > avgSparseDegen,
    `dense degeneration (${avgDenseDegen.toFixed(4)}) must exceed sparse (${avgSparseDegen.toFixed(4)}) at high multiplier`
  );
});

// ===========================================================================
// Ramp parity tests
// ===========================================================================

console.log("\nGemma 3 Parity — Ramp parity checks");

test("runParitySweep includes ramp_parity_check with all fields", () => {
  const config = buildParitySweepConfig();
  const result = runParitySweep(config);
  assert.equal(typeof result.ramp_parity_check.layer_41_in_top_candidates, "boolean");
  assert.equal(typeof result.ramp_parity_check.sparse_global_outperforms_dense, "boolean");
  assert.equal(typeof result.ramp_parity_check.degeneration_cliff_detected, "boolean");
  assert.equal(typeof result.ramp_parity_check.summary, "string");
  assert.ok(result.ramp_parity_check.summary.length > 0, "summary must not be empty");
});

test("full sweep finds layer 41 in top candidates (Ramp parity)", () => {
  const config = buildParitySweepConfig();
  const result = runParitySweep(config);
  assert.ok(
    result.ramp_parity_check.layer_41_in_top_candidates,
    "Layer 41 must appear in top candidates per Ramp findings"
  );
});

test("full sweep shows sparse global outperforming dense configs (Ramp parity)", () => {
  const config = buildParitySweepConfig();
  const result = runParitySweep(config);
  assert.ok(
    result.ramp_parity_check.sparse_global_outperforms_dense,
    "Sparse global must outperform dense configs per Ramp findings"
  );
});

test("full sweep detects degeneration cliffs in dense configs (Ramp parity)", () => {
  const config = buildParitySweepConfig();
  const result = runParitySweep(config);
  assert.ok(
    result.ramp_parity_check.degeneration_cliff_detected,
    "Degeneration cliffs must be detectable in dense configs at high multipliers"
  );
});

// ===========================================================================
// Run-card and metadata tests
// ===========================================================================

console.log("\nGemma 3 Parity — Run-card metadata");

test("runParitySweep includes run-card metadata", () => {
  const config = buildParitySweepConfig();
  const result = runParitySweep(config);
  assert.equal(result.run_card.task_id, "P3-02");
  assert.equal(result.run_card.model, "gemma-3-27b-it");
  assert.ok(result.run_card.run_id, "run_id must be set");
  assert.ok(result.run_card.seed, "seed must be set");
  assert.ok(result.run_card.created_at, "created_at must be set");
});

test("runParitySweep records model revision and dataset version", () => {
  const config = buildParitySweepConfig();
  const result = runParitySweep(config);
  assert.equal(result.config.model_revision, "gemma-3-27b-it-qat-q4_0-gguf-2025-03-15");
  assert.equal(result.config.dataset_version, "steer-core-ramp-parity-v1");
});

test("runParitySweep records baseline metrics", () => {
  const config = buildParitySweepConfig();
  const result = runParitySweep(config);
  assert.equal(typeof result.baseline.coherence, "number");
  assert.equal(typeof result.baseline.correctness, "number");
  assert.equal(typeof result.baseline.degenerate_rate, "number");
  assert.equal(typeof result.baseline.language_stability, "number");
});

// ===========================================================================
// Serialization and artifact tests
// ===========================================================================

console.log("\nGemma 3 Parity — Artifact serialization");

test("runParitySweep result is JSON-serializable", () => {
  const config = buildParitySweepConfig({
    candidate_layers: [35, 41],
    multipliers: [0.25],
  });
  const result = runParitySweep(config);
  const json = JSON.stringify(result);
  const parsed = JSON.parse(json);
  assert.equal(parsed.stage, "B-parity");
  assert.ok(Array.isArray(parsed.per_layer_metrics));
  assert.ok(Array.isArray(parsed.challenger_candidates));
  assert.ok(Array.isArray(parsed.configuration_results));
  assert.ok(parsed.ramp_parity_check);
  assert.ok(parsed.run_card);
  assert.ok(parsed.baseline);
});

test("writeParitySweepResult writes valid JSON artifact", () => {
  const config = buildParitySweepConfig({
    candidate_layers: [35, 41],
    multipliers: [0.25],
  });
  const result = runParitySweep(config);

  const __filename = fileURLToPath(import.meta.url);
  const tmpDir = path.join(path.dirname(__filename), "..", "..", "..", ".tmp-test-artifacts");
  const outPath = writeParitySweepResult(result, tmpDir);

  assert.ok(existsSync(outPath), "artifact file must exist");
  unlinkSync(outPath);
  rmdirSync(tmpDir);
});

test("full sweep produces candidates for follow-on calibration", () => {
  const config = buildParitySweepConfig();
  const result = runParitySweep(config);
  assert.ok(result.challenger_candidates.length > 0, "full sweep must produce candidates");
  assert.ok(result.total_configurations_tested > 0);
  assert.ok(result.passed_hard_gates > 0);
});

// ===========================================================================
// Summary
// ===========================================================================

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);

if (failed > 0) {
  process.exit(1);
}
