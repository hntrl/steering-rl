import { describe, it, expect } from "vitest";
import { checkHardGates, computeDecision } from "../src/gate-checker.js";
import { computeRankScore, computeRankComponents } from "../src/score.js";
import { DEFAULT_RANK_WEIGHTS, DEFAULT_HARD_GATE_THRESHOLDS } from "../src/defaults.js";
import type {
  CandidateMetrics,
  ChampionBaseline,
  ExperimentDecision,
  RankWeights,
} from "../src/types.js";
import decisionSchema from "../../../contracts/schema/experiment-decision.json";

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

function validateAgainstSchema(
  decision: ExperimentDecision,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  const requiredFields = [
    "experiment_id",
    "champion_profile_id",
    "challenger_profile_id",
    "timestamp",
    "decision",
    "hard_gates",
    "rank_score",
  ];
  for (const field of requiredFields) {
    if (!(field in decision)) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  if (!["promote", "hold", "fail"].includes(decision.decision)) {
    errors.push(`Invalid decision value: ${decision.decision}`);
  }

  if (typeof decision.hard_gates?.passed !== "boolean") {
    errors.push("hard_gates.passed must be a boolean");
  }

  if (!Array.isArray(decision.hard_gates?.results)) {
    errors.push("hard_gates.results must be an array");
  } else {
    for (const result of decision.hard_gates.results) {
      if (typeof result.gate !== "string") {
        errors.push("gate_result.gate must be a string");
      }
      if (typeof result.passed !== "boolean") {
        errors.push("gate_result.passed must be a boolean");
      }
      if (typeof result.reason !== "string") {
        errors.push("gate_result.reason must be a string");
      }
    }
  }

  if (decision.rank_score !== null && typeof decision.rank_score !== "number") {
    errors.push("rank_score must be a number or null");
  }

  if (decision.timestamp && isNaN(Date.parse(decision.timestamp))) {
    errors.push("timestamp must be a valid ISO-8601 date");
  }

  const allowedTopLevel = new Set([
    "experiment_id",
    "champion_profile_id",
    "challenger_profile_id",
    "timestamp",
    "decision",
    "hard_gates",
    "rank_score",
    "rank_components",
    "champion_rank_score",
  ]);
  for (const key of Object.keys(decision)) {
    if (!allowedTopLevel.has(key)) {
      errors.push(`Unexpected top-level field: ${key}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

describe("checkHardGates", () => {
  it("passes when all gates are satisfied", () => {
    const result = checkHardGates(makeMetrics(), makeChampionBaseline());
    expect(result.passed).toBe(true);
    expect(result.results).toHaveLength(6);
    expect(result.results.every((r) => r.passed)).toBe(true);
  });

  it("fails when degenerate_rate exceeds threshold", () => {
    const result = checkHardGates(
      makeMetrics({ degenerate_rate: 0.05 }),
      makeChampionBaseline(),
    );
    expect(result.passed).toBe(false);
    const gate = result.results.find((r) => r.gate === "degenerate_rate");
    expect(gate?.passed).toBe(false);
    expect(gate?.reason).toContain("0.05");
    expect(gate?.reason).toContain("0.03");
  });

  it("fails when coherence drops below champion by more than threshold", () => {
    const result = checkHardGates(
      makeMetrics({ coherence: 0.84 }),
      makeChampionBaseline({ coherence: 0.87 }),
    );
    expect(result.passed).toBe(false);
    const gate = result.results.find((r) => r.gate === "coherence");
    expect(gate?.passed).toBe(false);
  });

  it("passes when coherence is exactly at threshold boundary", () => {
    const result = checkHardGates(
      makeMetrics({ coherence: 0.85 }),
      makeChampionBaseline({ coherence: 0.87 }),
    );
    const gate = result.results.find((r) => r.gate === "coherence");
    expect(gate?.passed).toBe(true);
  });

  it("fails when correctness drops below champion by more than threshold", () => {
    const result = checkHardGates(
      makeMetrics({ correctness: 0.89 }),
      makeChampionBaseline({ correctness: 0.91 }),
    );
    expect(result.passed).toBe(false);
    const gate = result.results.find((r) => r.gate === "correctness");
    expect(gate?.passed).toBe(false);
  });

  it("fails when language_stability is below threshold", () => {
    const result = checkHardGates(
      makeMetrics({ language_stability: 0.98 }),
      makeChampionBaseline(),
    );
    expect(result.passed).toBe(false);
    const gate = result.results.find((r) => r.gate === "language_stability");
    expect(gate?.passed).toBe(false);
  });

  it("fails when p95 latency exceeds champion * multiplier", () => {
    const result = checkHardGates(
      makeMetrics({ p95_latency_ms: 1700 }),
      makeChampionBaseline({ p95_latency_ms: 1400 }),
    );
    expect(result.passed).toBe(false);
    const gate = result.results.find((r) => r.gate === "p95_latency");
    expect(gate?.passed).toBe(false);
  });

  it("fails when there are critical safety violations", () => {
    const result = checkHardGates(
      makeMetrics({ safety_critical_violations: 1 }),
      makeChampionBaseline(),
    );
    expect(result.passed).toBe(false);
    const gate = result.results.find((r) => r.gate === "safety_critical");
    expect(gate?.passed).toBe(false);
  });

  it("reports all failures, not just the first", () => {
    const result = checkHardGates(
      makeMetrics({
        degenerate_rate: 0.10,
        coherence: 0.50,
        correctness: 0.50,
        language_stability: 0.80,
        p95_latency_ms: 5000,
        safety_critical_violations: 3,
      }),
      makeChampionBaseline(),
    );
    expect(result.passed).toBe(false);
    const failedCount = result.results.filter((r) => !r.passed).length;
    expect(failedCount).toBe(6);
  });

  it("emits machine-readable gate results with actual and threshold", () => {
    const result = checkHardGates(makeMetrics(), makeChampionBaseline());
    for (const r of result.results) {
      expect(typeof r.gate).toBe("string");
      expect(typeof r.passed).toBe("boolean");
      expect(typeof r.reason).toBe("string");
      expect(r.actual).not.toBeUndefined();
      expect(r.threshold).not.toBeUndefined();
    }
  });

  it("accepts custom thresholds", () => {
    const result = checkHardGates(
      makeMetrics({ degenerate_rate: 0.05 }),
      makeChampionBaseline(),
      { max_degenerate_rate: 0.10 },
    );
    const gate = result.results.find((r) => r.gate === "degenerate_rate");
    expect(gate?.passed).toBe(true);
  });
});

describe("computeRankScore", () => {
  it("returns a numeric score for valid metrics", () => {
    const score = computeRankScore(makeMetrics());
    expect(typeof score).toBe("number");
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it("uses default weights from feedback-loop.md", () => {
    expect(DEFAULT_RANK_WEIGHTS.correctness).toBe(0.35);
    expect(DEFAULT_RANK_WEIGHTS.coherence).toBe(0.20);
    expect(DEFAULT_RANK_WEIGHTS.concept_adherence).toBe(0.20);
    expect(DEFAULT_RANK_WEIGHTS.solve_rate_norm).toBe(0.10);
    expect(DEFAULT_RANK_WEIGHTS.degenerate_rate_inv).toBe(0.10);
    expect(DEFAULT_RANK_WEIGHTS.latency_norm).toBe(0.05);
  });

  it("weights sum to 1.0", () => {
    const sum = Object.values(DEFAULT_RANK_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 10);
  });

  it("computes expected score with known inputs", () => {
    const metrics = makeMetrics({
      correctness: 1.0,
      coherence: 1.0,
      concept_adherence: 1.0,
      solve_rate_norm: 1.0,
      degenerate_rate: 0.0,
      latency_norm: 1.0,
    });
    const score = computeRankScore(metrics);
    expect(score).toBeCloseTo(1.0, 10);
  });

  it("returns component breakdown via computeRankComponents", () => {
    const metrics = makeMetrics();
    const components = computeRankComponents(metrics);
    expect(components.correctness).toBeCloseTo(
      DEFAULT_RANK_WEIGHTS.correctness * metrics.correctness,
    );
    expect(components.degenerate_rate_inv).toBeCloseTo(
      DEFAULT_RANK_WEIGHTS.degenerate_rate_inv * (1 - metrics.degenerate_rate),
    );
  });

  it("accepts custom weights", () => {
    const metrics = makeMetrics({ correctness: 1.0, coherence: 0.0 });
    const customWeights: Partial<RankWeights> = {
      correctness: 1.0,
      coherence: 0.0,
      concept_adherence: 0.0,
      solve_rate_norm: 0.0,
      degenerate_rate_inv: 0.0,
      latency_norm: 0.0,
    };
    const score = computeRankScore(metrics, customWeights);
    expect(score).toBeCloseTo(1.0, 10);
  });

  it("higher correctness produces higher score", () => {
    const low = computeRankScore(makeMetrics({ correctness: 0.5 }));
    const high = computeRankScore(makeMetrics({ correctness: 0.9 }));
    expect(high).toBeGreaterThan(low);
  });
});

describe("computeDecision", () => {
  const baseInput = {
    experiment_id: "exp-20260402-core-gemma3v12-vs-gemma4v3",
    champion_profile_id: "steer-gemma3-default-v12",
    challenger_profile_id: "steer-gemma4-default-v3",
    champion_metrics: makeMetrics({
      correctness: 0.91,
      coherence: 0.87,
      concept_adherence: 0.83,
      solve_rate_norm: 0.65,
      degenerate_rate: 0.02,
      latency_norm: 0.75,
      language_stability: 1.0,
      p95_latency_ms: 1400,
      safety_critical_violations: 0,
    }),
    champion_baseline: makeChampionBaseline(),
  };

  it("returns 'fail' when any hard gate fails", () => {
    const decision = computeDecision({
      ...baseInput,
      challenger_metrics: makeMetrics({ degenerate_rate: 0.10 }),
    });
    expect(decision.decision).toBe("fail");
    expect(decision.hard_gates.passed).toBe(false);
    expect(decision.rank_score).toBeNull();
    expect(decision.rank_components).toBeNull();
    expect(decision.champion_rank_score).toBeNull();
  });

  it("returns 'promote' when hard gates pass and challenger outscores champion", () => {
    const decision = computeDecision({
      ...baseInput,
      challenger_metrics: makeMetrics({
        correctness: 0.95,
        coherence: 0.90,
        concept_adherence: 0.90,
        solve_rate_norm: 0.80,
        degenerate_rate: 0.01,
        latency_norm: 0.85,
      }),
    });
    expect(decision.decision).toBe("promote");
    expect(decision.hard_gates.passed).toBe(true);
    expect(decision.rank_score).toBeGreaterThan(decision.champion_rank_score!);
  });

  it("returns 'hold' when hard gates pass but champion has higher rank", () => {
    const weakChallenger = makeMetrics({
      correctness: 0.90,
      coherence: 0.87,
      concept_adherence: 0.80,
      solve_rate_norm: 0.60,
      degenerate_rate: 0.02,
      latency_norm: 0.70,
    });
    const strongChampion = makeMetrics({
      correctness: 0.95,
      coherence: 0.92,
      concept_adherence: 0.90,
      solve_rate_norm: 0.80,
      degenerate_rate: 0.01,
      latency_norm: 0.85,
      language_stability: 1.0,
      p95_latency_ms: 1400,
      safety_critical_violations: 0,
    });
    const decision = computeDecision({
      ...baseInput,
      champion_metrics: strongChampion,
      challenger_metrics: weakChallenger,
      champion_baseline: {
        coherence: 0.87,
        correctness: 0.90,
        p95_latency_ms: 1400,
      },
    });
    expect(decision.decision).toBe("hold");
    expect(decision.hard_gates.passed).toBe(true);
    expect(decision.rank_score).toBeLessThanOrEqual(
      decision.champion_rank_score!,
    );
  });

  it("rank score is generated for all hard-pass candidates", () => {
    const decision = computeDecision({
      ...baseInput,
      challenger_metrics: makeMetrics(),
    });
    if (decision.hard_gates.passed) {
      expect(typeof decision.rank_score).toBe("number");
      expect(typeof decision.champion_rank_score).toBe("number");
      expect(decision.rank_components).not.toBeNull();
    }
  });

  it("includes rank_components breakdown when hard gates pass", () => {
    const decision = computeDecision({
      ...baseInput,
      challenger_metrics: makeMetrics(),
    });
    expect(decision.rank_components).not.toBeNull();
    const rc = decision.rank_components!;
    expect(typeof rc.correctness).toBe("number");
    expect(typeof rc.coherence).toBe("number");
    expect(typeof rc.concept_adherence).toBe("number");
    expect(typeof rc.solve_rate_norm).toBe("number");
    expect(typeof rc.degenerate_rate_inv).toBe("number");
    expect(typeof rc.latency_norm).toBe("number");
  });

  it("hard gates are evaluated before ranking", () => {
    const decision = computeDecision({
      ...baseInput,
      challenger_metrics: makeMetrics({
        degenerate_rate: 0.10,
        correctness: 0.99,
      }),
    });
    expect(decision.decision).toBe("fail");
    expect(decision.rank_score).toBeNull();
  });

  it("accepts custom gate thresholds", () => {
    const decision = computeDecision({
      ...baseInput,
      challenger_metrics: makeMetrics({ degenerate_rate: 0.05 }),
      gate_thresholds: { max_degenerate_rate: 0.10 },
    });
    expect(decision.hard_gates.passed).toBe(true);
  });

  it("accepts custom rank weights", () => {
    const decision = computeDecision({
      ...baseInput,
      challenger_metrics: makeMetrics(),
      rank_weights: { correctness: 0.50 },
    });
    expect(decision.hard_gates.passed).toBe(true);
    expect(typeof decision.rank_score).toBe("number");
  });
});

describe("decision output validates against experiment decision schema", () => {
  it("schema file defines required fields", () => {
    expect(decisionSchema.required).toContain("experiment_id");
    expect(decisionSchema.required).toContain("decision");
    expect(decisionSchema.required).toContain("hard_gates");
    expect(decisionSchema.required).toContain("rank_score");
  });

  it("fail decision validates against schema", () => {
    const decision = computeDecision({
      experiment_id: "exp-test",
      champion_profile_id: "champ-1",
      challenger_profile_id: "chal-1",
      champion_metrics: makeMetrics(),
      challenger_metrics: makeMetrics({ degenerate_rate: 0.10 }),
      champion_baseline: makeChampionBaseline(),
    });
    const { valid, errors } = validateAgainstSchema(decision);
    expect(errors).toEqual([]);
    expect(valid).toBe(true);
  });

  it("promote decision validates against schema", () => {
    const decision = computeDecision({
      experiment_id: "exp-test-promote",
      champion_profile_id: "champ-1",
      challenger_profile_id: "chal-1",
      champion_metrics: makeMetrics({
        correctness: 0.85,
        coherence: 0.80,
      }),
      challenger_metrics: makeMetrics({
        correctness: 0.95,
        coherence: 0.92,
      }),
      champion_baseline: makeChampionBaseline({ coherence: 0.80, correctness: 0.85 }),
    });
    const { valid, errors } = validateAgainstSchema(decision);
    expect(errors).toEqual([]);
    expect(valid).toBe(true);
    expect(decision.decision).toBe("promote");
  });

  it("hold decision validates against schema", () => {
    const champion = makeMetrics({
      correctness: 0.95,
      coherence: 0.92,
    });
    const decision = computeDecision({
      experiment_id: "exp-test-hold",
      champion_profile_id: "champ-1",
      challenger_profile_id: "chal-1",
      champion_metrics: champion,
      challenger_metrics: makeMetrics({
        correctness: 0.91,
        coherence: 0.87,
      }),
      champion_baseline: makeChampionBaseline(),
    });
    const { valid, errors } = validateAgainstSchema(decision);
    expect(errors).toEqual([]);
    expect(valid).toBe(true);
  });

  it("decision has valid ISO-8601 timestamp", () => {
    const decision = computeDecision({
      experiment_id: "exp-ts",
      champion_profile_id: "champ-1",
      challenger_profile_id: "chal-1",
      champion_metrics: makeMetrics(),
      challenger_metrics: makeMetrics(),
      champion_baseline: makeChampionBaseline(),
    });
    expect(Date.parse(decision.timestamp)).not.toBeNaN();
  });

  it("decision contains no unexpected fields", () => {
    const decision = computeDecision({
      experiment_id: "exp-fields",
      champion_profile_id: "champ-1",
      challenger_profile_id: "chal-1",
      champion_metrics: makeMetrics(),
      challenger_metrics: makeMetrics(),
      champion_baseline: makeChampionBaseline(),
    });
    const { valid, errors } = validateAgainstSchema(decision);
    expect(errors).toEqual([]);
    expect(valid).toBe(true);
  });
});
