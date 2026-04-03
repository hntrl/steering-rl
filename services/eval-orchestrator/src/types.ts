export interface CandidateMetrics {
  correctness: number;
  coherence: number;
  concept_adherence: number;
  solve_rate_norm: number;
  degenerate_rate: number;
  latency_norm: number;
  language_stability: number;
  p95_latency_ms: number;
  safety_critical_violations: number;
}

export interface ChampionBaseline {
  coherence: number;
  correctness: number;
  p95_latency_ms: number;
}

export interface GateResult {
  gate: string;
  passed: boolean;
  reason: string;
  actual: number | boolean | null;
  threshold: number | boolean | null;
}

export interface HardGatesOutput {
  passed: boolean;
  results: GateResult[];
}

export interface RankWeights {
  correctness: number;
  coherence: number;
  concept_adherence: number;
  solve_rate_norm: number;
  degenerate_rate_inv: number;
  latency_norm: number;
}

export interface RankComponents {
  correctness: number;
  coherence: number;
  concept_adherence: number;
  solve_rate_norm: number;
  degenerate_rate_inv: number;
  latency_norm: number;
}

export interface ExperimentDecision {
  experiment_id: string;
  champion_profile_id: string;
  challenger_profile_id: string;
  timestamp: string;
  decision: "promote" | "hold" | "fail";
  hard_gates: HardGatesOutput;
  rank_score: number | null;
  rank_components: RankComponents | null;
  champion_rank_score: number | null;
}

export interface HardGateThresholds {
  max_degenerate_rate: number;
  min_coherence_delta: number;
  min_correctness_delta: number;
  min_language_stability: number;
  max_latency_multiplier: number;
  max_safety_critical_violations: number;
}

export interface MetricsValidationResult {
  valid: boolean;
  missing: string[];
}
