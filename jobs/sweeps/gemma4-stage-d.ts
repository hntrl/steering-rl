/**
 * Gemma 4 Stage D — Champion-challenger head-to-head bake-off.
 *
 * Takes the top Stage C multi-layer candidates and runs them head-to-head
 * against the current champion profile. Applies hard gates first (fail closed),
 * then uses weighted rank comparison to emit machine-readable promotion
 * decisions (promote or hold) for each challenger.
 *
 * Constraints:
 *   - Hard gates are applied BEFORE weighted rank comparisons.
 *   - Required metrics must be present; missing metrics fail closed.
 *   - Evidence bundle IDs and experiment IDs are recorded in decision artifacts.
 *
 * Depends on Stage A baseline, Stage B candidates, and Stage C multi-layer results.
 *
 * Outputs:
 *   artifacts/sweeps/gemma4-stage-d-decision.json
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StageDConfig {
  stage: "D";
  description: string;
  model: string;
  model_revision: string;
  dataset_version: string;
  seed: number;
  stage_c_ref: string;
  champion_profile_id: string;
  suite: string;
  rank_weights: {
    correctness: number;
    coherence: number;
    concept_adherence: number;
    solve_rate_norm: number;
    non_degenerate: number;
    latency_norm: number;
  };
  hard_gate_thresholds: {
    max_degenerate_rate: number;
    min_coherence_delta: number;
    min_correctness_delta: number;
    min_language_stability: number;
    max_latency_multiplier: number;
    max_safety_critical_violations: number;
  };
  prompts: string[];
  concepts: string[];
  judge_bundle: string;
  created_at: string;
  git_sha: string;
}

interface CandidateMetricsD {
  coherence: number;
  concept_adherence: number;
  correctness: number;
  degenerate_rate: number;
  language_stability: number;
  latency_p50_ms: number;
  latency_p95_ms: number;
  solve_rate_norm: number;
  safety_critical_violations: number;
}

interface GateResultD {
  gate: string;
  passed: boolean;
  reason: string;
  value: number;
  threshold: number;
}

interface HardGatesOutputD {
  passed: boolean;
  degenerate_rate: GateResultD;
  coherence: GateResultD;
  correctness: GateResultD;
  language_stability: GateResultD;
  p95_latency_ms: GateResultD;
  safety: GateResultD;
}

interface RankComponentsD {
  correctness: number;
  coherence: number;
  concept_adherence: number;
  solve_rate_norm: number;
  degenerate_rate_inv: number;
  latency_norm: number;
}

interface ExperimentCandidateD {
  profile_id: string;
  base_model: string;
}

interface ExperimentScoresD {
  correctness: number;
  coherence: number;
  concept_adherence: number;
  degenerate_rate: number;
  language_stability: number;
  solve_rate: number;
  latency_p95_ms: number;
}

interface DecisionArtifact {
  experiment_id: string;
  date: string;
  suite: string;
  dataset_version: string;
  champion: ExperimentCandidateD;
  challenger: ExperimentCandidateD;
  hard_gates: HardGatesOutputD;
  scores: ExperimentScoresD;
  rank_score: number;
  decision: "promote" | "hold" | "rollback";
  decided_at: string;
  rationale: string;
  rank_components: RankComponentsD;
  champion_rank_score: number;
  evidence_bundle_id: string;
}

interface StageCCandidate {
  rank: number;
  layers: number[];
  fallback_layer: number;
  preset_table: { low: number; medium: number; strong: number };
  rank_score: number;
  metrics: {
    coherence: number;
    concept_adherence: number;
    correctness: number;
    degenerate_rate: number;
    language_stability: number;
    latency_p50_ms: number;
    latency_p95_ms: number;
  };
  profile_bundle: {
    profile_id: string;
    base_model: string;
    base_model_revision: string;
    layers: number[];
    fallback_layer: number;
    vector_bundle_id: string;
    preset_table: { low: number; medium: number; strong: number };
    judge_bundle: string;
    created_at: string;
  };
}

interface StageDResult {
  stage: "D";
  config: StageDConfig;
  baseline_ref: string;
  stage_c_ref: string;
  champion_profile_id: string;
  champion_metrics: CandidateMetricsD;
  decisions: DecisionArtifact[];
  summary: {
    total_challengers: number;
    passed_hard_gates: number;
    promoted: number;
    held: number;
    failed_gates: number;
  };
  timestamp: string;
}

const REQUIRED_METRIC_KEYS: (keyof CandidateMetricsD)[] = [
  "coherence",
  "concept_adherence",
  "correctness",
  "degenerate_rate",
  "language_stability",
  "latency_p50_ms",
  "latency_p95_ms",
  "solve_rate_norm",
  "safety_critical_violations",
];

// ---------------------------------------------------------------------------
// Deterministic PRNG (Mulberry32)
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Fail-closed metric validation
// ---------------------------------------------------------------------------

export function validateMetricsPresent(
  metrics: Record<string, unknown>,
  requiredKeys: string[],
): { valid: boolean; missing: string[] } {
  const missing: string[] = [];
  for (const key of requiredKeys) {
    const val = metrics[key];
    if (val === undefined || val === null || typeof val !== "number" || Number.isNaN(val)) {
      missing.push(key);
    }
  }
  return { valid: missing.length === 0, missing };
}

// ---------------------------------------------------------------------------
// Simulated champion evaluation (deterministic from seed)
// ---------------------------------------------------------------------------

function simulateChampionMetrics(
  config: StageDConfig,
  baseSeed: number,
): CandidateMetricsD {
  const rng = mulberry32(baseSeed + 7777);

  const totalRuns = config.prompts.length * config.concepts.length;
  const coherenceScores: number[] = [];
  const correctnessScores: number[] = [];
  const latencies: number[] = [];
  let degenerateCount = 0;
  let langShiftCount = 0;

  for (const _prompt of config.prompts) {
    for (const _concept of config.concepts) {
      coherenceScores.push(0.85 + rng() * 0.12);
      correctnessScores.push(0.82 + rng() * 0.15);
      latencies.push(800 + rng() * 600);
      if (rng() < 0.015) degenerateCount++;
      if (rng() < 0.005) langShiftCount++;
    }
  }

  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const percentile = (arr: number[], p: number) => {
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.ceil(p * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
  };

  return {
    coherence: Number(avg(coherenceScores).toFixed(4)),
    correctness: Number(avg(correctnessScores).toFixed(4)),
    concept_adherence: 0.82,
    degenerate_rate: Number((degenerateCount / totalRuns).toFixed(4)),
    language_stability: Number((1 - langShiftCount / totalRuns).toFixed(4)),
    latency_p50_ms: Number(percentile(latencies, 0.5).toFixed(1)),
    latency_p95_ms: Number(percentile(latencies, 0.95).toFixed(1)),
    solve_rate_norm: 0.75,
    safety_critical_violations: 0,
  };
}

// ---------------------------------------------------------------------------
// Build challenger CandidateMetricsD from Stage C candidate
// ---------------------------------------------------------------------------

function buildChallengerMetrics(
  candidate: StageCCandidate,
  config: StageDConfig,
  baseSeed: number,
): CandidateMetricsD {
  const layerHash = candidate.layers.reduce((acc, l) => acc * 31 + l, 0);
  const rng = mulberry32(baseSeed + layerHash + 9999);

  const solveRate = 0.7 + rng() * 0.15;
  const safetyViolations = rng() < 0.005 ? 1 : 0;

  return {
    coherence: candidate.metrics.coherence,
    concept_adherence: candidate.metrics.concept_adherence,
    correctness: candidate.metrics.correctness,
    degenerate_rate: candidate.metrics.degenerate_rate,
    language_stability: candidate.metrics.language_stability,
    latency_p50_ms: candidate.metrics.latency_p50_ms,
    latency_p95_ms: candidate.metrics.latency_p95_ms,
    solve_rate_norm: Number(solveRate.toFixed(4)),
    safety_critical_violations: safetyViolations,
  };
}

// ---------------------------------------------------------------------------
// Hard gate evaluation (matches experiment-decision.json schema)
// ---------------------------------------------------------------------------

export function evaluateHardGates(
  challenger: CandidateMetricsD,
  champion: CandidateMetricsD,
  thresholds: StageDConfig["hard_gate_thresholds"],
): HardGatesOutputD {
  const EPSILON = 1e-9;

  const degeneratePass =
    challenger.degenerate_rate <= thresholds.max_degenerate_rate + EPSILON;
  const degenerate_rate: GateResultD = {
    gate: "degenerate_rate",
    passed: degeneratePass,
    reason: degeneratePass
      ? `degenerate_rate=${challenger.degenerate_rate} <= ${thresholds.max_degenerate_rate}`
      : `degenerate_rate=${challenger.degenerate_rate} > ${thresholds.max_degenerate_rate}`,
    value: challenger.degenerate_rate,
    threshold: thresholds.max_degenerate_rate,
  };

  const coherenceDelta = challenger.coherence - champion.coherence;
  const coherencePass = coherenceDelta >= thresholds.min_coherence_delta - EPSILON;
  const coherence: GateResultD = {
    gate: "coherence",
    passed: coherencePass,
    reason: coherencePass
      ? `coherence_delta=${coherenceDelta.toFixed(4)} >= ${thresholds.min_coherence_delta}`
      : `coherence_delta=${coherenceDelta.toFixed(4)} < ${thresholds.min_coherence_delta}`,
    value: challenger.coherence,
    threshold: champion.coherence + thresholds.min_coherence_delta,
  };

  const correctnessDelta = challenger.correctness - champion.correctness;
  const correctnessPass =
    correctnessDelta >= thresholds.min_correctness_delta - EPSILON;
  const correctness: GateResultD = {
    gate: "correctness",
    passed: correctnessPass,
    reason: correctnessPass
      ? `correctness_delta=${correctnessDelta.toFixed(4)} >= ${thresholds.min_correctness_delta}`
      : `correctness_delta=${correctnessDelta.toFixed(4)} < ${thresholds.min_correctness_delta}`,
    value: challenger.correctness,
    threshold: champion.correctness + thresholds.min_correctness_delta,
  };

  const langPass =
    challenger.language_stability >= thresholds.min_language_stability - EPSILON;
  const language_stability: GateResultD = {
    gate: "language_stability",
    passed: langPass,
    reason: langPass
      ? `language_stability=${challenger.language_stability} >= ${thresholds.min_language_stability}`
      : `language_stability=${challenger.language_stability} < ${thresholds.min_language_stability}`,
    value: challenger.language_stability,
    threshold: thresholds.min_language_stability,
  };

  const latencyThreshold =
    champion.latency_p95_ms * thresholds.max_latency_multiplier;
  const latencyPass =
    challenger.latency_p95_ms <= latencyThreshold + EPSILON;
  const p95_latency_ms: GateResultD = {
    gate: "p95_latency_ms",
    passed: latencyPass,
    reason: latencyPass
      ? `p95_latency_ms=${challenger.latency_p95_ms} <= ${latencyThreshold.toFixed(1)}`
      : `p95_latency_ms=${challenger.latency_p95_ms} > ${latencyThreshold.toFixed(1)}`,
    value: challenger.latency_p95_ms,
    threshold: latencyThreshold,
  };

  const safetyPass =
    challenger.safety_critical_violations <=
    thresholds.max_safety_critical_violations;
  const safety: GateResultD = {
    gate: "safety",
    passed: safetyPass,
    reason: safetyPass
      ? `safety_critical_violations=${challenger.safety_critical_violations} <= ${thresholds.max_safety_critical_violations}`
      : `safety_critical_violations=${challenger.safety_critical_violations} > ${thresholds.max_safety_critical_violations}`,
    value: challenger.safety_critical_violations,
    threshold: thresholds.max_safety_critical_violations,
  };

  const allPassed = [
    degenerate_rate,
    coherence,
    correctness,
    language_stability,
    p95_latency_ms,
    safety,
  ].every((g) => g.passed);

  return {
    passed: allPassed,
    degenerate_rate,
    coherence,
    correctness,
    language_stability,
    p95_latency_ms,
    safety,
  };
}

// ---------------------------------------------------------------------------
// Rank score computation (weighted)
// ---------------------------------------------------------------------------

export function computeRankComponentsD(
  metrics: CandidateMetricsD,
  weights: StageDConfig["rank_weights"],
): RankComponentsD {
  const latency_norm = Math.max(0, 1 - metrics.latency_p95_ms / 2000);
  return {
    correctness: weights.correctness * metrics.correctness,
    coherence: weights.coherence * metrics.coherence,
    concept_adherence: weights.concept_adherence * metrics.concept_adherence,
    solve_rate_norm: weights.solve_rate_norm * metrics.solve_rate_norm,
    degenerate_rate_inv: weights.non_degenerate * (1 - metrics.degenerate_rate),
    latency_norm: weights.latency_norm * latency_norm,
  };
}

export function computeRankScoreD(
  metrics: CandidateMetricsD,
  weights: StageDConfig["rank_weights"],
): number {
  const c = computeRankComponentsD(metrics, weights);
  return Number(
    (
      c.correctness +
      c.coherence +
      c.concept_adherence +
      c.solve_rate_norm +
      c.degenerate_rate_inv +
      c.latency_norm
    ).toFixed(4),
  );
}

// ---------------------------------------------------------------------------
// Build experiment ID (deterministic naming)
// ---------------------------------------------------------------------------

function buildExperimentId(
  date: string,
  suite: string,
  championId: string,
  challengerId: string,
): string {
  const champShort = championId.replace(/^steer-/, "").replace(/-/g, "").slice(0, 12);
  const challShort = challengerId.replace(/^steer-/, "").replace(/-/g, "").slice(0, 12);
  return `exp-${date.replace(/-/g, "")}-${suite}-${champShort}-vs-${challShort}`;
}

// ---------------------------------------------------------------------------
// Main exports
// ---------------------------------------------------------------------------

export function buildStageDConfig(
  overrides?: Partial<StageDConfig>,
): StageDConfig {
  return {
    stage: "D",
    description:
      "Gemma 4 Stage D champion-challenger head-to-head bake-off with promotion decisions",
    model: "gemma-4-27b-it",
    model_revision: "2026-06-01",
    dataset_version: "steer-core-golden-v20260601",
    seed: 20260601,
    stage_c_ref: "gemma4-stage-c-result.json",
    champion_profile_id: "steer-gemma4-baseline-champion",
    suite: "core",
    rank_weights: {
      correctness: 0.35,
      coherence: 0.20,
      concept_adherence: 0.20,
      solve_rate_norm: 0.10,
      non_degenerate: 0.10,
      latency_norm: 0.05,
    },
    hard_gate_thresholds: {
      max_degenerate_rate: 0.03,
      min_coherence_delta: -0.02,
      min_correctness_delta: -0.01,
      min_language_stability: 0.99,
      max_latency_multiplier: 1.20,
      max_safety_critical_violations: 0,
    },
    prompts: [
      "Explain how a startup should manage runway.",
      "Draft a weekly status update for an engineering team.",
      "Write a product requirements document for a mobile app.",
      "Summarize the key risks in a Series A term sheet.",
      "Describe best practices for remote team communication.",
    ],
    concepts: [
      "expense-management",
      "team-leadership",
      "product-strategy",
      "risk-assessment",
    ],
    judge_bundle: "judge-v4",
    created_at: new Date().toISOString(),
    git_sha: process.env.GIT_SHA ?? "local",
    ...overrides,
  };
}

export function runStageD(
  config: StageDConfig,
  stageCCandidates: StageCCandidate[],
  baselineCoherence: number,
  baselineCorrectness: number,
  baselineLatencyP95: number,
): StageDResult {
  const championMetrics = simulateChampionMetrics(config, config.seed);

  const championValidation = validateMetricsPresent(
    championMetrics as unknown as Record<string, unknown>,
    REQUIRED_METRIC_KEYS as string[],
  );
  if (!championValidation.valid) {
    throw new Error(
      `[Stage D] FAIL CLOSED: Champion metrics missing required fields: ${championValidation.missing.join(", ")}`,
    );
  }

  const decisions: DecisionArtifact[] = [];
  const today = new Date().toISOString().slice(0, 10);
  let passedGates = 0;
  let promoted = 0;
  let held = 0;
  let failedGates = 0;

  for (const candidate of stageCCandidates) {
    const challengerMetrics = buildChallengerMetrics(
      candidate,
      config,
      config.seed,
    );

    const challengerValidation = validateMetricsPresent(
      challengerMetrics as unknown as Record<string, unknown>,
      REQUIRED_METRIC_KEYS as string[],
    );
    if (!challengerValidation.valid) {
      const experimentId = buildExperimentId(
        today,
        config.suite,
        config.champion_profile_id,
        candidate.profile_bundle.profile_id,
      );
      decisions.push({
        experiment_id: experimentId,
        date: today,
        suite: config.suite,
        dataset_version: config.dataset_version,
        champion: {
          profile_id: config.champion_profile_id,
          base_model: config.model,
        },
        challenger: {
          profile_id: candidate.profile_bundle.profile_id,
          base_model: config.model,
        },
        hard_gates: {
          passed: false,
          degenerate_rate: { gate: "degenerate_rate", passed: false, reason: `FAIL CLOSED: missing metrics: ${challengerValidation.missing.join(", ")}`, value: 0, threshold: config.hard_gate_thresholds.max_degenerate_rate },
          coherence: { gate: "coherence", passed: false, reason: "FAIL CLOSED: missing metrics", value: 0, threshold: 0 },
          correctness: { gate: "correctness", passed: false, reason: "FAIL CLOSED: missing metrics", value: 0, threshold: 0 },
          language_stability: { gate: "language_stability", passed: false, reason: "FAIL CLOSED: missing metrics", value: 0, threshold: config.hard_gate_thresholds.min_language_stability },
          p95_latency_ms: { gate: "p95_latency_ms", passed: false, reason: "FAIL CLOSED: missing metrics", value: 0, threshold: 0 },
          safety: { gate: "safety", passed: false, reason: "FAIL CLOSED: missing metrics", value: 0, threshold: config.hard_gate_thresholds.max_safety_critical_violations },
        },
        scores: {
          correctness: 0,
          coherence: 0,
          concept_adherence: 0,
          degenerate_rate: 0,
          language_stability: 0,
          solve_rate: 0,
          latency_p95_ms: 0,
        },
        rank_score: 0,
        decision: "hold",
        decided_at: new Date().toISOString(),
        rationale: `FAIL CLOSED: challenger missing required metrics: ${challengerValidation.missing.join(", ")}`,
        rank_components: {
          correctness: 0,
          coherence: 0,
          concept_adherence: 0,
          solve_rate_norm: 0,
          degenerate_rate_inv: 0,
          latency_norm: 0,
        },
        champion_rank_score: 0,
        evidence_bundle_id: candidate.profile_bundle.vector_bundle_id,
      });
      failedGates++;
      continue;
    }

    const hardGates = evaluateHardGates(
      challengerMetrics,
      championMetrics,
      config.hard_gate_thresholds,
    );

    const experimentId = buildExperimentId(
      today,
      config.suite,
      config.champion_profile_id,
      candidate.profile_bundle.profile_id,
    );

    const challengerRankScore = computeRankScoreD(
      challengerMetrics,
      config.rank_weights,
    );
    const challengerRankComponents = computeRankComponentsD(
      challengerMetrics,
      config.rank_weights,
    );
    const championRankScore = computeRankScoreD(
      championMetrics,
      config.rank_weights,
    );

    const scores: ExperimentScoresD = {
      correctness: challengerMetrics.correctness,
      coherence: challengerMetrics.coherence,
      concept_adherence: challengerMetrics.concept_adherence,
      degenerate_rate: challengerMetrics.degenerate_rate,
      language_stability: challengerMetrics.language_stability,
      solve_rate: challengerMetrics.solve_rate_norm,
      latency_p95_ms: challengerMetrics.latency_p95_ms,
    };

    let decision: "promote" | "hold" | "rollback";
    let rationale: string;

    if (!hardGates.passed) {
      decision = "hold";
      const failedGateNames = [
        hardGates.degenerate_rate,
        hardGates.coherence,
        hardGates.correctness,
        hardGates.language_stability,
        hardGates.p95_latency_ms,
        hardGates.safety,
      ]
        .filter((g) => !g.passed)
        .map((g) => g.gate);
      rationale = `Hard gates failed: ${failedGateNames.join(", ")}. Decision held.`;
      failedGates++;
    } else {
      passedGates++;
      if (challengerRankScore > championRankScore) {
        decision = "promote";
        rationale =
          `Challenger passes all hard gates and outscores champion ` +
          `(${challengerRankScore.toFixed(4)} > ${championRankScore.toFixed(4)}). ` +
          `Concept adherence: ${challengerMetrics.concept_adherence}, ` +
          `coherence delta: ${(challengerMetrics.coherence - championMetrics.coherence).toFixed(4)}.`;
        promoted++;
      } else {
        decision = "hold";
        rationale =
          `Challenger passes hard gates but does not outscore champion ` +
          `(${challengerRankScore.toFixed(4)} <= ${championRankScore.toFixed(4)}). Hold for further evaluation.`;
        held++;
      }
    }

    decisions.push({
      experiment_id: experimentId,
      date: today,
      suite: config.suite,
      dataset_version: config.dataset_version,
      champion: {
        profile_id: config.champion_profile_id,
        base_model: config.model,
      },
      challenger: {
        profile_id: candidate.profile_bundle.profile_id,
        base_model: config.model,
      },
      hard_gates: hardGates,
      scores,
      rank_score: challengerRankScore,
      decision,
      decided_at: new Date().toISOString(),
      rationale,
      rank_components: challengerRankComponents,
      champion_rank_score: championRankScore,
      evidence_bundle_id: candidate.profile_bundle.vector_bundle_id,
    });
  }

  return {
    stage: "D",
    config,
    baseline_ref: "gemma4-stage-a-result.json",
    stage_c_ref: config.stage_c_ref,
    champion_profile_id: config.champion_profile_id,
    champion_metrics: championMetrics,
    decisions,
    summary: {
      total_challengers: stageCCandidates.length,
      passed_hard_gates: passedGates,
      promoted,
      held,
      failed_gates: failedGates,
    },
    timestamp: new Date().toISOString(),
  };
}

export function writeStageDResult(
  result: StageDResult,
  outDir: string,
): string {
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "gemma4-stage-d-decision.json");
  writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n");
  return outPath;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const isMain = process.argv[1] === __filename;

if (isMain) {
  const root = path.resolve(path.dirname(__filename), "..", "..");
  const artifactsDir = path.join(root, "artifacts", "sweeps");

  const stageAPath = path.join(artifactsDir, "gemma4-stage-a-result.json");
  if (!existsSync(stageAPath)) {
    console.error(
      "[Stage D] ERROR: Stage A result not found. Run Stage A first.",
    );
    console.error(`  Expected: ${stageAPath}`);
    process.exit(1);
  }

  const stageCPath = path.join(artifactsDir, "gemma4-stage-c-result.json");
  if (!existsSync(stageCPath)) {
    console.error(
      "[Stage D] ERROR: Stage C result not found. Run Stage C first.",
    );
    console.error(`  Expected: ${stageCPath}`);
    process.exit(1);
  }

  const stageAResult = JSON.parse(readFileSync(stageAPath, "utf-8"));
  const stageCResult = JSON.parse(readFileSync(stageCPath, "utf-8"));

  const baselineCoherence: number = stageAResult.metrics.coherence;
  const baselineCorrectness: number = stageAResult.metrics.correctness;
  const baselineLatencyP95: number = stageAResult.metrics.latency_p95_ms;

  console.log("[Stage D] Building config...");
  const config = buildStageDConfig();
  console.log(
    `[Stage D] Model: ${config.model} (rev ${config.model_revision})`,
  );
  console.log(`[Stage D] Dataset: ${config.dataset_version}`);
  console.log(`[Stage D] Seed: ${config.seed}`);
  console.log(`[Stage D] Suite: ${config.suite}`);
  console.log(
    `[Stage D] Stage C candidates: ${stageCResult.candidates.length}`,
  );
  console.log(
    `[Stage D] Champion: ${config.champion_profile_id}`,
  );

  console.log("[Stage D] Running champion-challenger bake-off...");
  const result = runStageD(
    config,
    stageCResult.candidates,
    baselineCoherence,
    baselineCorrectness,
    baselineLatencyP95,
  );

  console.log(
    `[Stage D] Total challengers: ${result.summary.total_challengers}`,
  );
  console.log(
    `[Stage D] Passed hard gates: ${result.summary.passed_hard_gates}`,
  );
  console.log(`[Stage D] Promoted: ${result.summary.promoted}`);
  console.log(`[Stage D] Held: ${result.summary.held}`);
  console.log(
    `[Stage D] Failed gates: ${result.summary.failed_gates}`,
  );

  console.log("[Stage D] Decisions:");
  for (const d of result.decisions) {
    console.log(
      `  ${d.decision.toUpperCase()} ${d.challenger.profile_id} ` +
        `rank_score=${d.rank_score.toFixed(4)} ` +
        `champion_rank_score=${d.champion_rank_score.toFixed(4)} ` +
        `gates_passed=${d.hard_gates.passed}`,
    );
  }

  const outPath = writeStageDResult(result, artifactsDir);
  console.log(`[Stage D] Decision artifact written to ${outPath}`);

  if (result.summary.total_challengers === 0) {
    console.error("[Stage D] FAIL — no challengers to evaluate.");
    process.exit(1);
  }

  console.log("[Stage D] PASS — promotion decisions emitted.");
}
