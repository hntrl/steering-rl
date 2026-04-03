import { describe, it, expect, vi } from "vitest";
import {
  ParityGate,
  aggregateMetrics,
  computeMetricDeltas,
  evaluateParityVerdicts,
} from "../src/shadow-parity.js";
import type {
  ShadowSampleMetrics,
  MetricDelta,
  ParityGateResult,
  ParityGateEvent,
} from "../src/shadow-parity.js";
import type { CandidateMetrics, ChampionBaseline } from "../src/types.js";
import { DEFAULT_HARD_GATE_THRESHOLDS } from "../src/defaults.js";

// --- Test Helpers ---

function makeMetrics(overrides?: Partial<CandidateMetrics>): CandidateMetrics {
  return {
    correctness: 0.92,
    coherence: 0.88,
    concept_adherence: 0.85,
    solve_rate_norm: 0.70,
    degenerate_rate: 0.01,
    latency_norm: 0.80,
    language_stability: 1.0,
    p95_latency_ms: 1500,
    safety_critical_violations: 0,
    ...overrides,
  };
}

function makeChampionBaseline(
  overrides?: Partial<ChampionBaseline>,
): ChampionBaseline {
  return {
    coherence: 0.87,
    correctness: 0.91,
    p95_latency_ms: 1400,
    ...overrides,
  };
}

function makeSample(
  championOverrides?: Partial<CandidateMetrics>,
  challengerOverrides?: Partial<CandidateMetrics>,
): ShadowSampleMetrics {
  return {
    champion: makeMetrics(championOverrides),
    challenger: makeMetrics(challengerOverrides),
  };
}

function makeSamples(
  count: number,
  championOverrides?: Partial<CandidateMetrics>,
  challengerOverrides?: Partial<CandidateMetrics>,
): ShadowSampleMetrics[] {
  return Array.from({ length: count }, () =>
    makeSample(championOverrides, challengerOverrides),
  );
}

// --- Test Suites ---

describe("aggregateMetrics", () => {
  it("computes mean of champion and challenger metrics across samples", () => {
    const samples: ShadowSampleMetrics[] = [
      {
        champion: makeMetrics({ correctness: 0.90 }),
        challenger: makeMetrics({ correctness: 0.80 }),
      },
      {
        champion: makeMetrics({ correctness: 0.80 }),
        challenger: makeMetrics({ correctness: 0.90 }),
      },
    ];
    const agg = aggregateMetrics(samples);
    expect(agg.champion.correctness).toBeCloseTo(0.85, 10);
    expect(agg.challenger.correctness).toBeCloseTo(0.85, 10);
  });

  it("returns exact values for single sample", () => {
    const samples = [makeSample({ correctness: 0.95 }, { correctness: 0.90 })];
    const agg = aggregateMetrics(samples);
    expect(agg.champion.correctness).toBe(0.95);
    expect(agg.challenger.correctness).toBe(0.90);
  });
});

describe("computeMetricDeltas", () => {
  it("computes delta as challenger minus champion", () => {
    const samples = makeSamples(5, { correctness: 0.90 }, { correctness: 0.92 });
    const deltas = computeMetricDeltas(samples, 0.95);
    const correctnessDelta = deltas.find((d) => d.metric === "correctness");
    expect(correctnessDelta).toBeDefined();
    expect(correctnessDelta!.delta).toBeCloseTo(0.02, 10);
  });

  it("includes confidence intervals for each metric", () => {
    const samples = makeSamples(10);
    const deltas = computeMetricDeltas(samples, 0.95);
    for (const d of deltas) {
      expect(typeof d.ci_lower).toBe("number");
      expect(typeof d.ci_upper).toBe("number");
      expect(d.ci_lower).toBeLessThanOrEqual(d.ci_upper);
    }
  });

  it("confidence intervals widen with higher variance", () => {
    const lowVariance = [
      makeSample({ correctness: 0.90 }, { correctness: 0.91 }),
      makeSample({ correctness: 0.90 }, { correctness: 0.91 }),
      makeSample({ correctness: 0.90 }, { correctness: 0.91 }),
      makeSample({ correctness: 0.90 }, { correctness: 0.91 }),
      makeSample({ correctness: 0.90 }, { correctness: 0.91 }),
    ];
    const highVariance = [
      makeSample({ correctness: 0.90 }, { correctness: 0.70 }),
      makeSample({ correctness: 0.90 }, { correctness: 1.00 }),
      makeSample({ correctness: 0.90 }, { correctness: 0.80 }),
      makeSample({ correctness: 0.90 }, { correctness: 1.00 }),
      makeSample({ correctness: 0.90 }, { correctness: 0.95 }),
    ];
    const lowDelta = computeMetricDeltas(lowVariance, 0.95).find(
      (d) => d.metric === "correctness",
    )!;
    const highDelta = computeMetricDeltas(highVariance, 0.95).find(
      (d) => d.metric === "correctness",
    )!;
    const lowWidth = lowDelta.ci_upper - lowDelta.ci_lower;
    const highWidth = highDelta.ci_upper - highDelta.ci_lower;
    expect(highWidth).toBeGreaterThan(lowWidth);
  });

  it("reports champion and challenger values", () => {
    const samples = makeSamples(5, { coherence: 0.85 }, { coherence: 0.90 });
    const deltas = computeMetricDeltas(samples, 0.95);
    const coherence = deltas.find((d) => d.metric === "coherence")!;
    expect(coherence.champion_value).toBeCloseTo(0.85, 10);
    expect(coherence.challenger_value).toBeCloseTo(0.90, 10);
  });
});

describe("evaluateParityVerdicts", () => {
  it("passes when all metrics are within tolerance", () => {
    const deltas: MetricDelta[] = [
      { metric: "correctness", champion_value: 0.90, challenger_value: 0.90, delta: 0.0, ci_lower: -0.01, ci_upper: 0.01 },
      { metric: "coherence", champion_value: 0.88, challenger_value: 0.87, delta: -0.01, ci_lower: -0.02, ci_upper: 0.0 },
    ];
    const tolerance = { correctness: -0.01, coherence: -0.02 };
    const verdicts = evaluateParityVerdicts(deltas, tolerance);
    expect(verdicts.every((v) => v.passed)).toBe(true);
  });

  it("fails when a metric exceeds negative tolerance", () => {
    const deltas: MetricDelta[] = [
      { metric: "correctness", champion_value: 0.90, challenger_value: 0.85, delta: -0.05, ci_lower: -0.06, ci_upper: -0.04 },
    ];
    const tolerance = { correctness: -0.01 };
    const verdicts = evaluateParityVerdicts(deltas, tolerance);
    expect(verdicts[0].passed).toBe(false);
    expect(verdicts[0].reason).toContain("correctness");
    expect(verdicts[0].reason).toContain("-0.0500");
  });

  it("handles inverse metrics (degenerate_rate) where increase is bad", () => {
    const deltas: MetricDelta[] = [
      { metric: "degenerate_rate", champion_value: 0.01, challenger_value: 0.05, delta: 0.04, ci_lower: 0.03, ci_upper: 0.05 },
    ];
    const tolerance = { degenerate_rate: 0.02 };
    const verdicts = evaluateParityVerdicts(deltas, tolerance);
    expect(verdicts[0].passed).toBe(false);
  });

  it("passes degenerate_rate when within tolerance", () => {
    const deltas: MetricDelta[] = [
      { metric: "degenerate_rate", champion_value: 0.01, challenger_value: 0.02, delta: 0.01, ci_lower: 0.005, ci_upper: 0.015 },
    ];
    const tolerance = { degenerate_rate: 0.02 };
    const verdicts = evaluateParityVerdicts(deltas, tolerance);
    expect(verdicts[0].passed).toBe(true);
  });

  it("includes CI in reason strings", () => {
    const deltas: MetricDelta[] = [
      { metric: "correctness", champion_value: 0.90, challenger_value: 0.91, delta: 0.01, ci_lower: -0.005, ci_upper: 0.025 },
    ];
    const tolerance = { correctness: -0.01 };
    const verdicts = evaluateParityVerdicts(deltas, tolerance);
    expect(verdicts[0].reason).toContain("CI:");
    expect(verdicts[0].reason).toContain("-0.0050");
    expect(verdicts[0].reason).toContain("0.0250");
  });

  it("skips metrics not in tolerance map", () => {
    const deltas: MetricDelta[] = [
      { metric: "unknown_metric", champion_value: 0.5, challenger_value: 0.5, delta: 0.0, ci_lower: 0.0, ci_upper: 0.0 },
    ];
    const tolerance = { correctness: -0.01 };
    const verdicts = evaluateParityVerdicts(deltas, tolerance);
    expect(verdicts).toHaveLength(0);
  });
});

describe("ParityGate", () => {
  const experimentId = "exp-20260402-core-gemma3v12-vs-gemma4v3";
  const baseline = makeChampionBaseline();

  describe("basic evaluation", () => {
    it("passes when challenger matches or exceeds champion", () => {
      const gate = new ParityGate();
      const samples = makeSamples(10);
      const result = gate.evaluate(experimentId, samples, baseline);
      expect(result.passed).toBe(true);
      expect(result.experiment_id).toBe(experimentId);
      expect(result.sample_size).toBe(10);
    });

    it("fails when challenger has significantly worse metrics", () => {
      const gate = new ParityGate();
      const samples = makeSamples(
        10,
        { correctness: 0.92, coherence: 0.88 },
        { correctness: 0.70, coherence: 0.60, degenerate_rate: 0.10, language_stability: 0.90 },
      );
      const result = gate.evaluate(experimentId, samples, baseline);
      expect(result.passed).toBe(false);
    });

    it("includes per-metric deltas in output", () => {
      const gate = new ParityGate();
      const samples = makeSamples(10);
      const result = gate.evaluate(experimentId, samples, baseline);
      expect(result.metric_deltas.length).toBeGreaterThan(0);
      for (const md of result.metric_deltas) {
        expect(typeof md.metric).toBe("string");
        expect(typeof md.delta).toBe("number");
        expect(typeof md.ci_lower).toBe("number");
        expect(typeof md.ci_upper).toBe("number");
        expect(typeof md.champion_value).toBe("number");
        expect(typeof md.challenger_value).toBe("number");
      }
    });

    it("includes confidence intervals in metric deltas", () => {
      const gate = new ParityGate({ confidence_level: 0.99 });
      const samples = makeSamples(10);
      const result = gate.evaluate(experimentId, samples, baseline);
      expect(result.confidence_level).toBe(0.99);
      for (const md of result.metric_deltas) {
        expect(md.ci_lower).toBeLessThanOrEqual(md.ci_upper);
      }
    });

    it("includes hard gate results", () => {
      const gate = new ParityGate();
      const samples = makeSamples(10);
      const result = gate.evaluate(experimentId, samples, baseline);
      expect(typeof result.hard_gates.passed).toBe("boolean");
      expect(Array.isArray(result.hard_gates.results)).toBe(true);
    });

    it("produces valid ISO-8601 timestamp", () => {
      const gate = new ParityGate();
      const samples = makeSamples(10);
      const result = gate.evaluate(experimentId, samples, baseline);
      expect(isNaN(Date.parse(result.timestamp))).toBe(false);
    });
  });

  describe("hard gate integration", () => {
    it("fails when hard gates fail even if parity metrics pass", () => {
      const gate = new ParityGate();
      const samples = makeSamples(
        10,
        {},
        { safety_critical_violations: 5, degenerate_rate: 0.10 },
      );
      const result = gate.evaluate(experimentId, samples, baseline);
      expect(result.passed).toBe(false);
      expect(result.hard_gates.passed).toBe(false);
    });

    it("applies custom gate thresholds", () => {
      const gate = new ParityGate({
        gate_thresholds: { max_degenerate_rate: 0.20 },
      });
      const samples = makeSamples(10, {}, { degenerate_rate: 0.15 });
      const result = gate.evaluate(experimentId, samples, baseline);
      const degGate = result.hard_gates.results.find(
        (r) => r.gate === "degenerate_rate",
      );
      expect(degGate?.passed).toBe(true);
    });
  });

  describe("sample size requirements", () => {
    it("fails when samples are below minimum", () => {
      const gate = new ParityGate({ min_sample_size: 10 });
      const samples = makeSamples(3);
      const result = gate.evaluate(experimentId, samples, baseline);
      expect(result.passed).toBe(false);
      expect(result.verdicts[0].reason).toContain("Insufficient samples");
    });

    it("passes with exactly min_sample_size samples", () => {
      const gate = new ParityGate({ min_sample_size: 5 });
      const samples = makeSamples(5);
      const result = gate.evaluate(experimentId, samples, baseline);
      expect(result.sample_size).toBe(5);
      expect(result.verdicts[0].reason).not.toContain("Insufficient");
    });
  });

  describe("machine-readable verdicts", () => {
    it("emits pass/fail verdicts with string reasons", () => {
      const gate = new ParityGate();
      const samples = makeSamples(10);
      const result = gate.evaluate(experimentId, samples, baseline);
      for (const v of result.verdicts) {
        expect(typeof v.passed).toBe("boolean");
        expect(typeof v.reason).toBe("string");
        expect(v.reason.length).toBeGreaterThan(0);
      }
    });

    it("verdict reasons include metric names", () => {
      const gate = new ParityGate();
      const samples = makeSamples(10);
      const result = gate.evaluate(experimentId, samples, baseline);
      const reasons = result.verdicts.map((v) => v.reason).join(" ");
      expect(reasons).toContain("correctness");
      expect(reasons).toContain("coherence");
    });

    it("hard gate verdicts are prefixed with hard_gate:", () => {
      const gate = new ParityGate();
      const samples = makeSamples(10);
      const result = gate.evaluate(experimentId, samples, baseline);
      const hardVerdicts = result.verdicts.filter((v) =>
        v.reason.startsWith("hard_gate:"),
      );
      expect(hardVerdicts.length).toBeGreaterThan(0);
    });
  });

  describe("auditability and storage", () => {
    it("stores results by experiment_id", () => {
      const gate = new ParityGate();
      const samples = makeSamples(10);
      gate.evaluate(experimentId, samples, baseline);
      const stored = gate.getResult(experimentId);
      expect(stored).toBeDefined();
      expect(stored!.experiment_id).toBe(experimentId);
    });

    it("getAllResults returns all stored results", () => {
      const gate = new ParityGate();
      gate.evaluate("exp-1", makeSamples(10), baseline);
      gate.evaluate("exp-2", makeSamples(10), baseline);
      const all = gate.getAllResults();
      expect(all.size).toBe(2);
      expect(all.has("exp-1")).toBe(true);
      expect(all.has("exp-2")).toBe(true);
    });

    it("returns undefined for unknown experiment_id", () => {
      const gate = new ParityGate();
      expect(gate.getResult("nonexistent")).toBeUndefined();
    });

    it("result includes experiment_id for traceability", () => {
      const gate = new ParityGate();
      const result = gate.evaluate(experimentId, makeSamples(10), baseline);
      expect(result.experiment_id).toBe(experimentId);
    });
  });

  describe("rollout precondition", () => {
    it("canAdvanceRollout returns true when parity passes", () => {
      const gate = new ParityGate();
      gate.evaluate(experimentId, makeSamples(10), baseline);
      expect(gate.canAdvanceRollout(experimentId)).toBe(true);
    });

    it("canAdvanceRollout returns false when parity fails", () => {
      const gate = new ParityGate();
      gate.evaluate(
        experimentId,
        makeSamples(10, {}, { correctness: 0.70, coherence: 0.60, degenerate_rate: 0.10, language_stability: 0.90 }),
        baseline,
      );
      expect(gate.canAdvanceRollout(experimentId)).toBe(false);
    });

    it("canAdvanceRollout returns false for unknown experiments", () => {
      const gate = new ParityGate();
      expect(gate.canAdvanceRollout("unknown-exp")).toBe(false);
    });
  });

  describe("telemetry events", () => {
    it("emits parity_check_complete on pass", () => {
      const gate = new ParityGate();
      const events: ParityGateEvent[] = [];
      gate.on((event) => events.push(event));
      gate.evaluate(experimentId, makeSamples(10), baseline);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("parity_check_complete");
      expect(events[0].experiment_id).toBe(experimentId);
    });

    it("emits parity_check_failed on fail", () => {
      const gate = new ParityGate();
      const events: ParityGateEvent[] = [];
      gate.on((event) => events.push(event));
      gate.evaluate(
        experimentId,
        makeSamples(10, {}, { correctness: 0.70, coherence: 0.60, degenerate_rate: 0.10, language_stability: 0.90 }),
        baseline,
      );
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("parity_check_failed");
    });

    it("emits insufficient_samples when below minimum", () => {
      const gate = new ParityGate({ min_sample_size: 20 });
      const events: ParityGateEvent[] = [];
      gate.on((event) => events.push(event));
      gate.evaluate(experimentId, makeSamples(5), baseline);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("insufficient_samples");
    });

    it("event detail includes sample_size and pass counts", () => {
      const gate = new ParityGate();
      const events: ParityGateEvent[] = [];
      gate.on((event) => events.push(event));
      gate.evaluate(experimentId, makeSamples(10), baseline);
      expect(events[0].detail.sample_size).toBe(10);
      expect(typeof events[0].detail.parity_verdicts_passed).toBe("number");
      expect(typeof events[0].detail.parity_verdicts_total).toBe("number");
    });

    it("unsubscribe stops receiving events", () => {
      const gate = new ParityGate();
      const events: ParityGateEvent[] = [];
      const unsub = gate.on((event) => events.push(event));
      unsub();
      gate.evaluate(experimentId, makeSamples(10), baseline);
      expect(events).toHaveLength(0);
    });
  });

  describe("regression tolerance configuration", () => {
    it("uses default regression tolerances", () => {
      const gate = new ParityGate();
      const samples = makeSamples(10);
      const result = gate.evaluate(experimentId, samples, baseline);
      expect(result.passed).toBe(true);
    });

    it("accepts custom regression tolerance overrides", () => {
      const gate = new ParityGate({
        max_regression_tolerance: { correctness: 0.0 },
      });
      const samples = makeSamples(
        10,
        { correctness: 0.95 },
        { correctness: 0.94 },
      );
      const result = gate.evaluate(experimentId, samples, baseline);
      const correctnessVerdict = result.verdicts.find((v) =>
        v.reason.includes("correctness") && !v.reason.startsWith("hard_gate:"),
      );
      expect(correctnessVerdict?.passed).toBe(false);
    });
  });
});
