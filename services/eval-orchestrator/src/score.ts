import type { CandidateMetrics, RankComponents, RankWeights } from "./types.js";
import { DEFAULT_RANK_WEIGHTS } from "./defaults.js";

export function computeRankComponents(
  metrics: CandidateMetrics,
  weights?: Partial<RankWeights>,
): RankComponents {
  const w: RankWeights = { ...DEFAULT_RANK_WEIGHTS, ...weights };

  return {
    correctness: w.correctness * metrics.correctness,
    coherence: w.coherence * metrics.coherence,
    concept_adherence: w.concept_adherence * metrics.concept_adherence,
    solve_rate_norm: w.solve_rate_norm * metrics.solve_rate_norm,
    degenerate_rate_inv: w.degenerate_rate_inv * (1 - metrics.degenerate_rate),
    latency_norm: w.latency_norm * metrics.latency_norm,
  };
}

export function computeRankScore(
  metrics: CandidateMetrics,
  weights?: Partial<RankWeights>,
): number {
  const components = computeRankComponents(metrics, weights);
  return (
    components.correctness +
    components.coherence +
    components.concept_adherence +
    components.solve_rate_norm +
    components.degenerate_rate_inv +
    components.latency_norm
  );
}
