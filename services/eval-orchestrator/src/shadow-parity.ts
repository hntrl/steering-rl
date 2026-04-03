import type {
  CandidateMetrics,
  ChampionBaseline,
  GateResult,
  HardGateThresholds,
  HardGatesOutput,
} from "./types.js";
import { checkHardGates } from "./gate-checker.js";
import { DEFAULT_HARD_GATE_THRESHOLDS } from "./defaults.js";

export interface ShadowSampleMetrics {
  champion: CandidateMetrics;
  challenger: CandidateMetrics;
}

export interface MetricDelta {
  metric: string;
  champion_value: number;
  challenger_value: number;
  delta: number;
  ci_lower: number;
  ci_upper: number;
}

export interface ParityVerdict {
  passed: boolean;
  reason: string;
}

export interface ParityGateResult {
  experiment_id: string;
  timestamp: string;
  passed: boolean;
  verdicts: ParityVerdict[];
  metric_deltas: MetricDelta[];
  hard_gates: HardGatesOutput;
  sample_size: number;
  confidence_level: number;
}

export interface ParityGateConfig {
  gate_thresholds?: Partial<HardGateThresholds>;
  confidence_level?: number;
  min_sample_size?: number;
  max_regression_tolerance?: Partial<Record<keyof CandidateMetrics, number>>;
}

export type ParityGateListener = (event: ParityGateEvent) => void;

export interface ParityGateEvent {
  type: "parity_check_complete" | "parity_check_failed" | "insufficient_samples";
  experiment_id: string;
  timestamp: string;
  detail: Record<string, unknown>;
}

const DEFAULT_CONFIDENCE_LEVEL = 0.95;
const DEFAULT_MIN_SAMPLE_SIZE = 5;

const DEFAULT_REGRESSION_TOLERANCE: Record<string, number> = {
  correctness: -0.01,
  coherence: -0.02,
  concept_adherence: -0.03,
  solve_rate_norm: -0.05,
  degenerate_rate: 0.02,
  latency_norm: -0.05,
  language_stability: -0.005,
  p95_latency_ms: 200,
  safety_critical_violations: 0,
};

const Z_SCORES: Record<number, number> = {
  0.90: 1.645,
  0.95: 1.960,
  0.99: 2.576,
};

function getZScore(confidence: number): number {
  return Z_SCORES[confidence] ?? 1.960;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0;
  const avg = mean(values);
  const squaredDiffs = values.map((v) => (v - avg) ** 2);
  return Math.sqrt(squaredDiffs.reduce((sum, v) => sum + v, 0) / (values.length - 1));
}

function computeConfidenceInterval(
  deltas: number[],
  confidence: number,
): { ci_lower: number; ci_upper: number } {
  const n = deltas.length;
  if (n < 2) {
    const m = mean(deltas);
    return { ci_lower: m, ci_upper: m };
  }
  const avg = mean(deltas);
  const sd = standardDeviation(deltas);
  const z = getZScore(confidence);
  const margin = z * (sd / Math.sqrt(n));
  return { ci_lower: avg - margin, ci_upper: avg + margin };
}

export function aggregateMetrics(samples: ShadowSampleMetrics[]): ShadowSampleMetrics {
  const keys = Object.keys(samples[0].champion) as (keyof CandidateMetrics)[];
  const champion: Record<string, number> = {};
  const challenger: Record<string, number> = {};

  for (const key of keys) {
    const champValues = samples.map((s) => s.champion[key]);
    const challValues = samples.map((s) => s.challenger[key]);
    champion[key] = mean(champValues);
    challenger[key] = mean(challValues);
  }

  return {
    champion: champion as unknown as CandidateMetrics,
    challenger: challenger as unknown as CandidateMetrics,
  };
}

export function computeMetricDeltas(
  samples: ShadowSampleMetrics[],
  confidence: number,
): MetricDelta[] {
  const keys = Object.keys(samples[0].champion) as (keyof CandidateMetrics)[];
  const deltas: MetricDelta[] = [];

  for (const key of keys) {
    const champValues = samples.map((s) => s.champion[key]);
    const challValues = samples.map((s) => s.challenger[key]);
    const perSampleDeltas = champValues.map((c, i) => challValues[i] - c);

    const avgChampion = mean(champValues);
    const avgChallenger = mean(challValues);
    const delta = avgChallenger - avgChampion;
    const ci = computeConfidenceInterval(perSampleDeltas, confidence);

    deltas.push({
      metric: key,
      champion_value: avgChampion,
      challenger_value: avgChallenger,
      delta,
      ci_lower: ci.ci_lower,
      ci_upper: ci.ci_upper,
    });
  }

  return deltas;
}

export function evaluateParityVerdicts(
  metricDeltas: MetricDelta[],
  regressionTolerance: Record<string, number>,
): ParityVerdict[] {
  const verdicts: ParityVerdict[] = [];

  for (const md of metricDeltas) {
    const tolerance = regressionTolerance[md.metric];
    if (tolerance === undefined) continue;

    if (md.metric === "degenerate_rate" || md.metric === "p95_latency_ms" || md.metric === "safety_critical_violations") {
      const passed = md.delta <= tolerance + 1e-9;
      verdicts.push({
        passed,
        reason: passed
          ? `${md.metric}: delta=${md.delta.toFixed(4)} <= tolerance=${tolerance} [CI: ${md.ci_lower.toFixed(4)}, ${md.ci_upper.toFixed(4)}]`
          : `${md.metric}: delta=${md.delta.toFixed(4)} > tolerance=${tolerance} [CI: ${md.ci_lower.toFixed(4)}, ${md.ci_upper.toFixed(4)}]`,
      });
    } else {
      const passed = md.delta >= tolerance - 1e-9;
      verdicts.push({
        passed,
        reason: passed
          ? `${md.metric}: delta=${md.delta.toFixed(4)} >= tolerance=${tolerance} [CI: ${md.ci_lower.toFixed(4)}, ${md.ci_upper.toFixed(4)}]`
          : `${md.metric}: delta=${md.delta.toFixed(4)} < tolerance=${tolerance} [CI: ${md.ci_lower.toFixed(4)}, ${md.ci_upper.toFixed(4)}]`,
      });
    }
  }

  return verdicts;
}

export class ParityGate {
  private readonly config: Required<
    Pick<ParityGateConfig, "confidence_level" | "min_sample_size">
  > &
    ParityGateConfig;
  private readonly regressionTolerance: Record<string, number>;
  private readonly listeners: ParityGateListener[] = [];
  private readonly results: Map<string, ParityGateResult> = new Map();

  constructor(config?: ParityGateConfig) {
    this.config = {
      ...config,
      confidence_level: config?.confidence_level ?? DEFAULT_CONFIDENCE_LEVEL,
      min_sample_size: config?.min_sample_size ?? DEFAULT_MIN_SAMPLE_SIZE,
    };
    this.regressionTolerance = {
      ...DEFAULT_REGRESSION_TOLERANCE,
      ...(config?.max_regression_tolerance as Record<string, number> | undefined),
    };
  }

  on(listener: ParityGateListener): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  private emit(event: ParityGateEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  evaluate(
    experiment_id: string,
    samples: ShadowSampleMetrics[],
    champion_baseline: ChampionBaseline,
  ): ParityGateResult {
    if (samples.length < this.config.min_sample_size) {
      const result: ParityGateResult = {
        experiment_id,
        timestamp: new Date().toISOString(),
        passed: false,
        verdicts: [
          {
            passed: false,
            reason: `Insufficient samples: ${samples.length} < ${this.config.min_sample_size}`,
          },
        ],
        metric_deltas: [],
        hard_gates: { passed: false, results: [] },
        sample_size: samples.length,
        confidence_level: this.config.confidence_level,
      };
      this.results.set(experiment_id, result);
      this.emit({
        type: "insufficient_samples",
        experiment_id,
        timestamp: result.timestamp,
        detail: { sample_size: samples.length, min_required: this.config.min_sample_size },
      });
      return result;
    }

    const aggregated = aggregateMetrics(samples);
    const metricDeltas = computeMetricDeltas(samples, this.config.confidence_level);
    const parityVerdicts = evaluateParityVerdicts(metricDeltas, this.regressionTolerance);
    const hardGates = checkHardGates(
      aggregated.challenger,
      champion_baseline,
      this.config.gate_thresholds,
    );

    const hardGateVerdicts: ParityVerdict[] = hardGates.results.map((gr: GateResult) => ({
      passed: gr.passed,
      reason: `hard_gate:${gr.gate}: ${gr.reason}`,
    }));

    const allVerdicts = [...parityVerdicts, ...hardGateVerdicts];
    const passed = allVerdicts.every((v) => v.passed);

    const result: ParityGateResult = {
      experiment_id,
      timestamp: new Date().toISOString(),
      passed,
      verdicts: allVerdicts,
      metric_deltas: metricDeltas,
      hard_gates: hardGates,
      sample_size: samples.length,
      confidence_level: this.config.confidence_level,
    };

    this.results.set(experiment_id, result);

    this.emit({
      type: passed ? "parity_check_complete" : "parity_check_failed",
      experiment_id,
      timestamp: result.timestamp,
      detail: {
        passed,
        sample_size: samples.length,
        parity_verdicts_passed: parityVerdicts.filter((v) => v.passed).length,
        parity_verdicts_total: parityVerdicts.length,
        hard_gates_passed: hardGates.passed,
      },
    });

    return result;
  }

  getResult(experiment_id: string): ParityGateResult | undefined {
    return this.results.get(experiment_id);
  }

  getAllResults(): Map<string, ParityGateResult> {
    return new Map(this.results);
  }

  canAdvanceRollout(experiment_id: string): boolean {
    const result = this.results.get(experiment_id);
    if (!result) return false;
    return result.passed;
  }
}
