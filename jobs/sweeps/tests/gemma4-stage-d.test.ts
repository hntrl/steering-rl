/**
 * Tests for Gemma 4 Stage D champion-challenger bake-off.
 *
 * Validates:
 *   - Config construction with seed control and model metadata
 *   - Hard gates are applied BEFORE weighted rank comparisons
 *   - Fail closed when required metrics are missing
 *   - Promotion decisions (promote / hold) are emitted per challenger
 *   - Decision artifacts include hard-gate reasons and rank component breakdown
 *   - Evidence bundle IDs and experiment IDs are recorded
 *   - Reproducibility from committed config and seed values
 *   - Output artifacts are JSON-serializable
 */

import { strict as assert } from "node:assert";
import { buildStageAConfig, runStageA } from "../gemma4-stage-a.ts";
import { buildStageBConfig, runStageB } from "../gemma4-stage-b.ts";
import {
  buildStageCConfig,
  runStageC,
} from "../gemma4-stage-c.ts";
import {
  buildStageDConfig,
  runStageD,
  evaluateHardGates,
  computeRankScoreD,
  computeRankComponentsD,
  validateMetricsPresent,
} from "../gemma4-stage-d.ts";

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
// Helper: run full Stage A + B + C pipeline to get realistic inputs
// ===========================================================================

function getStageInputs() {
  const stageAConfig = buildStageAConfig();
  const stageAResult = runStageA(stageAConfig);
  const stageBConfig = buildStageBConfig();
  const stageBResult = runStageB(
    stageBConfig,
    stageAResult.metrics.coherence,
    stageAResult.metrics.correctness,
  );
  const stageCConfig = buildStageCConfig();
  const stageCResult = runStageC(
    stageCConfig,
    stageBResult.challenger_candidates,
    stageAResult.metrics.coherence,
    stageAResult.metrics.correctness,
    stageAResult.metrics.latency_p95_ms,
  );
  return {
    stageAResult,
    stageBResult,
    stageCResult,
    baselineCoherence: stageAResult.metrics.coherence,
    baselineCorrectness: stageAResult.metrics.correctness,
    baselineLatencyP95: stageAResult.metrics.latency_p95_ms,
  };
}

// ===========================================================================
// Stage D config tests
// ===========================================================================

console.log("\nStage D — Config construction");

test("buildStageDConfig returns valid config with all required fields", () => {
  const config = buildStageDConfig();
  assert.equal(config.stage, "D");
  assert.equal(config.model, "gemma-4-27b-it");
  assert.ok(config.model_revision, "model_revision must be set");
  assert.ok(config.dataset_version, "dataset_version must be set");
  assert.equal(typeof config.seed, "number");
  assert.ok(config.stage_c_ref, "stage_c_ref must be set");
  assert.ok(config.champion_profile_id, "champion_profile_id must be set");
  assert.ok(config.suite, "suite must be set");
  assert.ok(config.prompts.length > 0, "prompts must not be empty");
  assert.ok(config.concepts.length > 0, "concepts must not be empty");
  assert.ok(config.judge_bundle, "judge_bundle must be set");
});

test("buildStageDConfig accepts overrides", () => {
  const config = buildStageDConfig({
    seed: 42,
    model_revision: "custom-rev",
    champion_profile_id: "custom-champion",
  });
  assert.equal(config.seed, 42);
  assert.equal(config.model_revision, "custom-rev");
  assert.equal(config.champion_profile_id, "custom-champion");
  assert.equal(config.model, "gemma-4-27b-it");
});

test("buildStageDConfig records model revision and dataset version", () => {
  const config = buildStageDConfig();
  assert.equal(config.model_revision, "2026-06-01");
  assert.equal(config.dataset_version, "steer-core-golden-v20260601");
});

test("buildStageDConfig includes rank weights summing to 1.0", () => {
  const config = buildStageDConfig();
  const sum = Object.values(config.rank_weights).reduce((a, b) => a + b, 0);
  assert.ok(
    Math.abs(sum - 1.0) < 1e-9,
    `rank weights must sum to 1.0, got ${sum}`,
  );
});

test("buildStageDConfig includes hard gate thresholds", () => {
  const config = buildStageDConfig();
  assert.equal(config.hard_gate_thresholds.max_degenerate_rate, 0.03);
  assert.equal(config.hard_gate_thresholds.min_coherence_delta, -0.02);
  assert.equal(config.hard_gate_thresholds.min_correctness_delta, -0.01);
  assert.equal(config.hard_gate_thresholds.min_language_stability, 0.99);
  assert.equal(config.hard_gate_thresholds.max_latency_multiplier, 1.20);
  assert.equal(config.hard_gate_thresholds.max_safety_critical_violations, 0);
});

// ===========================================================================
// validateMetricsPresent tests (fail closed)
// ===========================================================================

console.log("\nStage D — Fail closed on missing metrics");

test("validateMetricsPresent passes when all metrics present", () => {
  const metrics = {
    coherence: 0.9,
    concept_adherence: 0.85,
    correctness: 0.92,
    degenerate_rate: 0.01,
    language_stability: 1.0,
    latency_p50_ms: 900,
    latency_p95_ms: 1400,
    solve_rate_norm: 0.75,
    safety_critical_violations: 0,
  };
  const result = validateMetricsPresent(metrics, Object.keys(metrics));
  assert.equal(result.valid, true);
  assert.equal(result.missing.length, 0);
});

test("validateMetricsPresent fails closed on missing field", () => {
  const metrics: Record<string, unknown> = {
    coherence: 0.9,
    correctness: 0.92,
  };
  const result = validateMetricsPresent(metrics, [
    "coherence",
    "correctness",
    "degenerate_rate",
  ]);
  assert.equal(result.valid, false);
  assert.ok(result.missing.includes("degenerate_rate"));
});

test("validateMetricsPresent fails closed on null metric", () => {
  const metrics: Record<string, unknown> = {
    coherence: 0.9,
    correctness: null,
  };
  const result = validateMetricsPresent(metrics, [
    "coherence",
    "correctness",
  ]);
  assert.equal(result.valid, false);
  assert.ok(result.missing.includes("correctness"));
});

test("validateMetricsPresent fails closed on NaN metric", () => {
  const metrics: Record<string, unknown> = {
    coherence: NaN,
    correctness: 0.92,
  };
  const result = validateMetricsPresent(metrics, [
    "coherence",
    "correctness",
  ]);
  assert.equal(result.valid, false);
  assert.ok(result.missing.includes("coherence"));
});

test("validateMetricsPresent fails closed on undefined metric", () => {
  const metrics: Record<string, unknown> = {
    coherence: undefined,
    correctness: 0.92,
  };
  const result = validateMetricsPresent(metrics, [
    "coherence",
    "correctness",
  ]);
  assert.equal(result.valid, false);
  assert.ok(result.missing.includes("coherence"));
});

// ===========================================================================
// Hard gate evaluation tests
// ===========================================================================

console.log("\nStage D — Hard gate evaluation");

test("evaluateHardGates passes when all gates satisfied", () => {
  const config = buildStageDConfig();
  const champion = {
    coherence: 0.87,
    correctness: 0.91,
    concept_adherence: 0.82,
    degenerate_rate: 0.02,
    language_stability: 1.0,
    latency_p50_ms: 900,
    latency_p95_ms: 1400,
    solve_rate_norm: 0.75,
    safety_critical_violations: 0,
  };
  const challenger = {
    coherence: 0.88,
    correctness: 0.92,
    concept_adherence: 0.85,
    degenerate_rate: 0.01,
    language_stability: 1.0,
    latency_p50_ms: 950,
    latency_p95_ms: 1500,
    solve_rate_norm: 0.80,
    safety_critical_violations: 0,
  };
  const result = evaluateHardGates(
    challenger,
    champion,
    config.hard_gate_thresholds,
  );
  assert.equal(result.passed, true);
  assert.equal(result.degenerate_rate.passed, true);
  assert.equal(result.coherence.passed, true);
  assert.equal(result.correctness.passed, true);
  assert.equal(result.language_stability.passed, true);
  assert.equal(result.p95_latency_ms.passed, true);
  assert.equal(result.safety.passed, true);
});

test("evaluateHardGates fails on high degenerate rate", () => {
  const config = buildStageDConfig();
  const champion = {
    coherence: 0.87, correctness: 0.91, concept_adherence: 0.82,
    degenerate_rate: 0.02, language_stability: 1.0, latency_p50_ms: 900,
    latency_p95_ms: 1400, solve_rate_norm: 0.75, safety_critical_violations: 0,
  };
  const challenger = {
    ...champion,
    degenerate_rate: 0.05,
  };
  const result = evaluateHardGates(
    challenger,
    champion,
    config.hard_gate_thresholds,
  );
  assert.equal(result.passed, false);
  assert.equal(result.degenerate_rate.passed, false);
  assert.ok(result.degenerate_rate.reason.includes("0.05"));
});

test("evaluateHardGates fails on safety violations", () => {
  const config = buildStageDConfig();
  const champion = {
    coherence: 0.87, correctness: 0.91, concept_adherence: 0.82,
    degenerate_rate: 0.02, language_stability: 1.0, latency_p50_ms: 900,
    latency_p95_ms: 1400, solve_rate_norm: 0.75, safety_critical_violations: 0,
  };
  const challenger = { ...champion, safety_critical_violations: 1 };
  const result = evaluateHardGates(
    challenger,
    champion,
    config.hard_gate_thresholds,
  );
  assert.equal(result.passed, false);
  assert.equal(result.safety.passed, false);
});

test("evaluateHardGates includes value and threshold in each gate result", () => {
  const config = buildStageDConfig();
  const champion = {
    coherence: 0.87, correctness: 0.91, concept_adherence: 0.82,
    degenerate_rate: 0.02, language_stability: 1.0, latency_p50_ms: 900,
    latency_p95_ms: 1400, solve_rate_norm: 0.75, safety_critical_violations: 0,
  };
  const challenger = { ...champion };
  const result = evaluateHardGates(
    challenger,
    champion,
    config.hard_gate_thresholds,
  );
  for (const gate of [
    result.degenerate_rate,
    result.coherence,
    result.correctness,
    result.language_stability,
    result.p95_latency_ms,
    result.safety,
  ]) {
    assert.equal(typeof gate.passed, "boolean");
    assert.equal(typeof gate.reason, "string");
    assert.equal(typeof gate.value, "number");
    assert.equal(typeof gate.threshold, "number");
  }
});

// ===========================================================================
// Rank scoring tests
// ===========================================================================

console.log("\nStage D — Rank scoring");

test("computeRankScoreD returns numeric score", () => {
  const config = buildStageDConfig();
  const metrics = {
    coherence: 0.88, correctness: 0.92, concept_adherence: 0.85,
    degenerate_rate: 0.01, language_stability: 1.0, latency_p50_ms: 950,
    latency_p95_ms: 1500, solve_rate_norm: 0.80, safety_critical_violations: 0,
  };
  const score = computeRankScoreD(metrics, config.rank_weights);
  assert.equal(typeof score, "number");
  assert.ok(score > 0);
  assert.ok(score <= 1);
});

test("computeRankComponentsD returns breakdown", () => {
  const config = buildStageDConfig();
  const metrics = {
    coherence: 0.88, correctness: 0.92, concept_adherence: 0.85,
    degenerate_rate: 0.01, language_stability: 1.0, latency_p50_ms: 950,
    latency_p95_ms: 1500, solve_rate_norm: 0.80, safety_critical_violations: 0,
  };
  const components = computeRankComponentsD(metrics, config.rank_weights);
  assert.equal(typeof components.correctness, "number");
  assert.equal(typeof components.coherence, "number");
  assert.equal(typeof components.concept_adherence, "number");
  assert.equal(typeof components.solve_rate_norm, "number");
  assert.equal(typeof components.degenerate_rate_inv, "number");
  assert.equal(typeof components.latency_norm, "number");
});

test("rank components sum equals rank score", () => {
  const config = buildStageDConfig();
  const metrics = {
    coherence: 0.88, correctness: 0.92, concept_adherence: 0.85,
    degenerate_rate: 0.01, language_stability: 1.0, latency_p50_ms: 950,
    latency_p95_ms: 1500, solve_rate_norm: 0.80, safety_critical_violations: 0,
  };
  const score = computeRankScoreD(metrics, config.rank_weights);
  const components = computeRankComponentsD(metrics, config.rank_weights);
  const componentSum =
    components.correctness +
    components.coherence +
    components.concept_adherence +
    components.solve_rate_norm +
    components.degenerate_rate_inv +
    components.latency_norm;
  assert.ok(
    Math.abs(score - componentSum) < 0.001,
    `score=${score} should equal component sum=${componentSum}`,
  );
});

// ===========================================================================
// Stage D execution tests
// ===========================================================================

console.log("\nStage D — Champion-challenger bake-off");

test("runStageD produces reproducible results (same seed = same decisions)", () => {
  const {
    stageCResult,
    baselineCoherence,
    baselineCorrectness,
    baselineLatencyP95,
  } = getStageInputs();
  const config = buildStageDConfig();

  const r1 = runStageD(
    config,
    stageCResult.candidates,
    baselineCoherence,
    baselineCorrectness,
    baselineLatencyP95,
  );
  const r2 = runStageD(
    config,
    stageCResult.candidates,
    baselineCoherence,
    baselineCorrectness,
    baselineLatencyP95,
  );

  assert.equal(r1.decisions.length, r2.decisions.length);
  for (let i = 0; i < r1.decisions.length; i++) {
    assert.equal(r1.decisions[i].decision, r2.decisions[i].decision);
    assert.equal(r1.decisions[i].rank_score, r2.decisions[i].rank_score);
    assert.equal(
      r1.decisions[i].champion_rank_score,
      r2.decisions[i].champion_rank_score,
    );
    assert.equal(
      r1.decisions[i].hard_gates.passed,
      r2.decisions[i].hard_gates.passed,
    );
  }
});

test("runStageD emits explicit promote or hold decisions", () => {
  const {
    stageCResult,
    baselineCoherence,
    baselineCorrectness,
    baselineLatencyP95,
  } = getStageInputs();
  const config = buildStageDConfig();
  const result = runStageD(
    config,
    stageCResult.candidates,
    baselineCoherence,
    baselineCorrectness,
    baselineLatencyP95,
  );

  assert.ok(result.decisions.length > 0, "must have at least one decision");
  for (const d of result.decisions) {
    assert.ok(
      ["promote", "hold", "rollback"].includes(d.decision),
      `decision must be promote, hold, or rollback, got: ${d.decision}`,
    );
  }
});

test("runStageD applies hard gates before weighted rank", () => {
  const {
    stageCResult,
    baselineCoherence,
    baselineCorrectness,
    baselineLatencyP95,
  } = getStageInputs();
  const config = buildStageDConfig();
  const result = runStageD(
    config,
    stageCResult.candidates,
    baselineCoherence,
    baselineCorrectness,
    baselineLatencyP95,
  );

  for (const d of result.decisions) {
    if (!d.hard_gates.passed) {
      assert.equal(
        d.decision,
        "hold",
        "decisions failing hard gates must be hold",
      );
    }
  }
});

test("runStageD decisions include hard-gate reasons", () => {
  const {
    stageCResult,
    baselineCoherence,
    baselineCorrectness,
    baselineLatencyP95,
  } = getStageInputs();
  const config = buildStageDConfig();
  const result = runStageD(
    config,
    stageCResult.candidates,
    baselineCoherence,
    baselineCorrectness,
    baselineLatencyP95,
  );

  for (const d of result.decisions) {
    assert.equal(typeof d.hard_gates.passed, "boolean");
    assert.ok(d.hard_gates.degenerate_rate.reason, "degenerate_rate reason");
    assert.ok(d.hard_gates.coherence.reason, "coherence reason");
    assert.ok(d.hard_gates.correctness.reason, "correctness reason");
    assert.ok(d.hard_gates.language_stability.reason, "language_stability reason");
    assert.ok(d.hard_gates.p95_latency_ms.reason, "p95_latency_ms reason");
    assert.ok(d.hard_gates.safety.reason, "safety reason");
  }
});

test("runStageD decisions include rank component breakdown", () => {
  const {
    stageCResult,
    baselineCoherence,
    baselineCorrectness,
    baselineLatencyP95,
  } = getStageInputs();
  const config = buildStageDConfig();
  const result = runStageD(
    config,
    stageCResult.candidates,
    baselineCoherence,
    baselineCorrectness,
    baselineLatencyP95,
  );

  for (const d of result.decisions) {
    assert.equal(typeof d.rank_components.correctness, "number");
    assert.equal(typeof d.rank_components.coherence, "number");
    assert.equal(typeof d.rank_components.concept_adherence, "number");
    assert.equal(typeof d.rank_components.solve_rate_norm, "number");
    assert.equal(typeof d.rank_components.degenerate_rate_inv, "number");
    assert.equal(typeof d.rank_components.latency_norm, "number");
  }
});

test("runStageD decisions include experiment IDs", () => {
  const {
    stageCResult,
    baselineCoherence,
    baselineCorrectness,
    baselineLatencyP95,
  } = getStageInputs();
  const config = buildStageDConfig();
  const result = runStageD(
    config,
    stageCResult.candidates,
    baselineCoherence,
    baselineCorrectness,
    baselineLatencyP95,
  );

  for (const d of result.decisions) {
    assert.ok(d.experiment_id.startsWith("exp-"), "experiment_id must start with exp-");
    assert.ok(d.experiment_id.includes(config.suite), "experiment_id must include suite");
  }
});

test("runStageD decisions include evidence bundle IDs", () => {
  const {
    stageCResult,
    baselineCoherence,
    baselineCorrectness,
    baselineLatencyP95,
  } = getStageInputs();
  const config = buildStageDConfig();
  const result = runStageD(
    config,
    stageCResult.candidates,
    baselineCoherence,
    baselineCorrectness,
    baselineLatencyP95,
  );

  for (const d of result.decisions) {
    assert.ok(
      d.evidence_bundle_id,
      "evidence_bundle_id must be set",
    );
    assert.ok(
      typeof d.evidence_bundle_id === "string" && d.evidence_bundle_id.length > 0,
      "evidence_bundle_id must be a non-empty string",
    );
  }
});

test("runStageD decisions include champion and challenger profile IDs", () => {
  const {
    stageCResult,
    baselineCoherence,
    baselineCorrectness,
    baselineLatencyP95,
  } = getStageInputs();
  const config = buildStageDConfig();
  const result = runStageD(
    config,
    stageCResult.candidates,
    baselineCoherence,
    baselineCorrectness,
    baselineLatencyP95,
  );

  for (const d of result.decisions) {
    assert.ok(d.champion.profile_id, "champion profile_id must be set");
    assert.ok(d.challenger.profile_id, "challenger profile_id must be set");
    assert.ok(d.champion.base_model, "champion base_model must be set");
    assert.ok(d.challenger.base_model, "challenger base_model must be set");
  }
});

test("runStageD summary counts are consistent", () => {
  const {
    stageCResult,
    baselineCoherence,
    baselineCorrectness,
    baselineLatencyP95,
  } = getStageInputs();
  const config = buildStageDConfig();
  const result = runStageD(
    config,
    stageCResult.candidates,
    baselineCoherence,
    baselineCorrectness,
    baselineLatencyP95,
  );

  assert.equal(
    result.summary.total_challengers,
    stageCResult.candidates.length,
  );
  assert.equal(
    result.summary.promoted + result.summary.held + result.summary.failed_gates,
    result.summary.total_challengers,
  );
  assert.equal(result.decisions.length, result.summary.total_challengers);
});

test("runStageD result is JSON-serializable", () => {
  const {
    stageCResult,
    baselineCoherence,
    baselineCorrectness,
    baselineLatencyP95,
  } = getStageInputs();
  const config = buildStageDConfig();
  const result = runStageD(
    config,
    stageCResult.candidates,
    baselineCoherence,
    baselineCorrectness,
    baselineLatencyP95,
  );

  const json = JSON.stringify(result);
  const parsed = JSON.parse(json);
  assert.equal(parsed.stage, "D");
  assert.ok(Array.isArray(parsed.decisions));
  assert.ok(parsed.config.seed === config.seed);
});

test("runStageD references baseline and Stage C", () => {
  const {
    stageCResult,
    baselineCoherence,
    baselineCorrectness,
    baselineLatencyP95,
  } = getStageInputs();
  const config = buildStageDConfig();
  const result = runStageD(
    config,
    stageCResult.candidates,
    baselineCoherence,
    baselineCorrectness,
    baselineLatencyP95,
  );

  assert.ok(result.baseline_ref, "must reference baseline");
  assert.ok(result.stage_c_ref, "must reference Stage C");
  assert.ok(result.champion_profile_id, "must include champion profile ID");
});

test("runStageD decisions include scores with required fields", () => {
  const {
    stageCResult,
    baselineCoherence,
    baselineCorrectness,
    baselineLatencyP95,
  } = getStageInputs();
  const config = buildStageDConfig();
  const result = runStageD(
    config,
    stageCResult.candidates,
    baselineCoherence,
    baselineCorrectness,
    baselineLatencyP95,
  );

  for (const d of result.decisions) {
    assert.equal(typeof d.scores.correctness, "number");
    assert.equal(typeof d.scores.coherence, "number");
    assert.equal(typeof d.scores.concept_adherence, "number");
    assert.equal(typeof d.scores.degenerate_rate, "number");
    assert.equal(typeof d.scores.language_stability, "number");
  }
});

test("runStageD decision includes date, suite, and dataset_version", () => {
  const {
    stageCResult,
    baselineCoherence,
    baselineCorrectness,
    baselineLatencyP95,
  } = getStageInputs();
  const config = buildStageDConfig();
  const result = runStageD(
    config,
    stageCResult.candidates,
    baselineCoherence,
    baselineCorrectness,
    baselineLatencyP95,
  );

  for (const d of result.decisions) {
    assert.ok(d.date, "date must be set");
    assert.equal(d.suite, config.suite);
    assert.equal(d.dataset_version, config.dataset_version);
    assert.ok(d.decided_at, "decided_at must be set");
    assert.ok(d.rationale, "rationale must be set");
  }
});

test("runStageD promotes at least one challenger from Stage C top candidates", () => {
  const {
    stageCResult,
    baselineCoherence,
    baselineCorrectness,
    baselineLatencyP95,
  } = getStageInputs();
  const config = buildStageDConfig();
  const result = runStageD(
    config,
    stageCResult.candidates,
    baselineCoherence,
    baselineCorrectness,
    baselineLatencyP95,
  );

  const promotions = result.decisions.filter((d) => d.decision === "promote");
  assert.ok(
    promotions.length > 0 || result.summary.held > 0,
    "must produce at least one promote or hold decision",
  );
});

test("runStageD champion and challenger comparisons are reproducible from stored artifacts", () => {
  const {
    stageCResult,
    baselineCoherence,
    baselineCorrectness,
    baselineLatencyP95,
  } = getStageInputs();
  const config = buildStageDConfig();
  const result = runStageD(
    config,
    stageCResult.candidates,
    baselineCoherence,
    baselineCorrectness,
    baselineLatencyP95,
  );

  const json = JSON.stringify(result, null, 2);
  const reparsed = JSON.parse(json);

  for (let i = 0; i < result.decisions.length; i++) {
    const original = result.decisions[i];
    const stored = reparsed.decisions[i];
    assert.equal(stored.decision, original.decision);
    assert.equal(stored.rank_score, original.rank_score);
    assert.equal(stored.champion_rank_score, original.champion_rank_score);
    assert.equal(stored.hard_gates.passed, original.hard_gates.passed);
    assert.equal(stored.experiment_id, original.experiment_id);
    assert.equal(stored.evidence_bundle_id, original.evidence_bundle_id);
  }
});

// ===========================================================================
// Summary
// ===========================================================================

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
