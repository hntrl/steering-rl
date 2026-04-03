import type { HardGateThresholds, RankWeights } from "./types.js";

export const DEFAULT_HARD_GATE_THRESHOLDS: HardGateThresholds = {
  max_degenerate_rate: 0.03,
  min_coherence_delta: -0.02,
  min_correctness_delta: -0.01,
  min_language_stability: 0.99,
  max_latency_multiplier: 1.20,
  max_safety_critical_violations: 0,
};

export const DEFAULT_RANK_WEIGHTS: RankWeights = {
  correctness: 0.35,
  coherence: 0.20,
  concept_adherence: 0.20,
  solve_rate_norm: 0.10,
  degenerate_rate_inv: 0.10,
  latency_norm: 0.05,
};
