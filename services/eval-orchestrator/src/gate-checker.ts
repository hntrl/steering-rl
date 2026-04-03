import type {
  CandidateMetrics,
  ChampionBaseline,
  ExperimentDecision,
  GateResult,
  HardGateThresholds,
  HardGatesOutput,
  MetricsValidationResult,
  RankWeights,
} from "./types.js";
import { DEFAULT_HARD_GATE_THRESHOLDS } from "./defaults.js";
import { computeRankComponents, computeRankScore } from "./score.js";

const EPSILON = 1e-9;

const REQUIRED_CANDIDATE_METRICS: (keyof CandidateMetrics)[] = [
  "correctness",
  "coherence",
  "concept_adherence",
  "solve_rate_norm",
  "degenerate_rate",
  "latency_norm",
  "language_stability",
  "p95_latency_ms",
  "safety_critical_violations",
];

export function validateMetricsPresent(
  metrics: Record<string, unknown>,
  requiredKeys?: string[],
): MetricsValidationResult {
  const keys = requiredKeys ?? (REQUIRED_CANDIDATE_METRICS as string[]);
  const missing: string[] = [];
  for (const key of keys) {
    const val = metrics[key];
    if (val === undefined || val === null || typeof val !== "number" || Number.isNaN(val)) {
      missing.push(key);
    }
  }
  return { valid: missing.length === 0, missing };
}

export interface ComputeDecisionInput {
  experiment_id: string;
  champion_profile_id: string;
  challenger_profile_id: string;
  champion_metrics: CandidateMetrics;
  challenger_metrics: CandidateMetrics;
  champion_baseline: ChampionBaseline;
  gate_thresholds?: Partial<HardGateThresholds>;
  rank_weights?: Partial<RankWeights>;
}

export function checkHardGates(
  candidate: CandidateMetrics,
  champion: ChampionBaseline,
  thresholds?: Partial<HardGateThresholds>,
): HardGatesOutput {
  const t: HardGateThresholds = {
    ...DEFAULT_HARD_GATE_THRESHOLDS,
    ...thresholds,
  };

  const results: GateResult[] = [];

  const degeneratePass =
    candidate.degenerate_rate <= t.max_degenerate_rate + EPSILON;
  results.push({
    gate: "degenerate_rate",
    passed: degeneratePass,
    reason: degeneratePass
      ? `degenerate_rate=${candidate.degenerate_rate} <= ${t.max_degenerate_rate}`
      : `degenerate_rate=${candidate.degenerate_rate} > ${t.max_degenerate_rate}`,
    actual: candidate.degenerate_rate,
    threshold: t.max_degenerate_rate,
  });

  const coherenceDelta = candidate.coherence - champion.coherence;
  const coherencePass = coherenceDelta >= t.min_coherence_delta - EPSILON;
  results.push({
    gate: "coherence",
    passed: coherencePass,
    reason: coherencePass
      ? `coherence_delta=${coherenceDelta.toFixed(4)} >= ${t.min_coherence_delta}`
      : `coherence_delta=${coherenceDelta.toFixed(4)} < ${t.min_coherence_delta}`,
    actual: candidate.coherence,
    threshold: champion.coherence + t.min_coherence_delta,
  });

  const correctnessDelta = candidate.correctness - champion.correctness;
  const correctnessPass = correctnessDelta >= t.min_correctness_delta - EPSILON;
  results.push({
    gate: "correctness",
    passed: correctnessPass,
    reason: correctnessPass
      ? `correctness_delta=${correctnessDelta.toFixed(4)} >= ${t.min_correctness_delta}`
      : `correctness_delta=${correctnessDelta.toFixed(4)} < ${t.min_correctness_delta}`,
    actual: candidate.correctness,
    threshold: champion.correctness + t.min_correctness_delta,
  });

  const langPass =
    candidate.language_stability >= t.min_language_stability - EPSILON;
  results.push({
    gate: "language_stability",
    passed: langPass,
    reason: langPass
      ? `language_stability=${candidate.language_stability} >= ${t.min_language_stability}`
      : `language_stability=${candidate.language_stability} < ${t.min_language_stability}`,
    actual: candidate.language_stability,
    threshold: t.min_language_stability,
  });

  const latencyThreshold = champion.p95_latency_ms * t.max_latency_multiplier;
  const latencyPass =
    candidate.p95_latency_ms <= latencyThreshold + EPSILON;
  results.push({
    gate: "p95_latency",
    passed: latencyPass,
    reason: latencyPass
      ? `p95_latency_ms=${candidate.p95_latency_ms} <= ${latencyThreshold}`
      : `p95_latency_ms=${candidate.p95_latency_ms} > ${latencyThreshold}`,
    actual: candidate.p95_latency_ms,
    threshold: latencyThreshold,
  });

  const safetyPass =
    candidate.safety_critical_violations <= t.max_safety_critical_violations;
  results.push({
    gate: "safety_critical",
    passed: safetyPass,
    reason: safetyPass
      ? `safety_critical_violations=${candidate.safety_critical_violations} <= ${t.max_safety_critical_violations}`
      : `safety_critical_violations=${candidate.safety_critical_violations} > ${t.max_safety_critical_violations}`,
    actual: candidate.safety_critical_violations,
    threshold: t.max_safety_critical_violations,
  });

  return {
    passed: results.every((r) => r.passed),
    results,
  };
}

export function computeDecision(
  input: ComputeDecisionInput,
): ExperimentDecision {
  const hardGates = checkHardGates(
    input.challenger_metrics,
    input.champion_baseline,
    input.gate_thresholds,
  );

  if (!hardGates.passed) {
    return {
      experiment_id: input.experiment_id,
      champion_profile_id: input.champion_profile_id,
      challenger_profile_id: input.challenger_profile_id,
      timestamp: new Date().toISOString(),
      decision: "fail",
      hard_gates: hardGates,
      rank_score: null,
      rank_components: null,
      champion_rank_score: null,
    };
  }

  const challengerScore = computeRankScore(
    input.challenger_metrics,
    input.rank_weights,
  );
  const challengerComponents = computeRankComponents(
    input.challenger_metrics,
    input.rank_weights,
  );
  const championScore = computeRankScore(
    input.champion_metrics,
    input.rank_weights,
  );

  const decision = challengerScore > championScore ? "promote" : "hold";

  return {
    experiment_id: input.experiment_id,
    champion_profile_id: input.champion_profile_id,
    challenger_profile_id: input.challenger_profile_id,
    timestamp: new Date().toISOString(),
    decision,
    hard_gates: hardGates,
    rank_score: challengerScore,
    rank_components: challengerComponents,
    champion_rank_score: championScore,
  };
}
