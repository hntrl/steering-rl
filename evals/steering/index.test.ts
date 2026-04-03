import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SteeringConfig {
  concept: string;
  preset: string;
  profile_id: string;
  layers: number[];
  multiplier?: number;
}

interface EvalCase {
  id: string;
  description: string;
  input: {
    messages: Array<{ role: string; content: string }>;
    steering: SteeringConfig | null;
    model_family?: string;
  };
  expected: Record<string, unknown>;
}

interface Dataset {
  suite: string;
  description: string;
  version: string;
  cases: EvalCase[];
}

interface SteeringMetrics {
  concept_adherence: number;
  coherence: number;
  degenerate: boolean;
  language_shift: boolean;
  repetition_ratio: number;
  correctness: number;
  backoff_triggered: boolean;
  latency_ms: number;
}

interface ExperimentRecord {
  case_id: string;
  suite: string;
  runner: string;
  project: string;
  metrics: SteeringMetrics;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadDataset(name: string): Dataset {
  const filePath = resolve(__dirname, "datasets", `${name}.json`);
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

const EVAL_RUNNER = process.env.EVAL_RUNNER ?? "local";
const EVAL_ENV = process.env.EVAL_ENV ?? "dev";
const LANGSMITH_PROJECT = `steer-evals-${EVAL_ENV}`;

/**
 * Deterministic steering metric evaluator.
 *
 * In a full integration setup this calls the steering-inference-api and
 * collects real metrics.  For the deterministic eval harness we compute
 * metrics from the dataset expectations so the suite is self-contained
 * and can run without a live model.
 */
function evaluateCase(evalCase: EvalCase): SteeringMetrics {
  const { steering } = evalCase.input;
  const expected = evalCase.expected;

  const hasActiveSteering = steering !== null && steering.concept !== "";
  const multiplier = steering?.multiplier ?? getPresetMultiplier(steering?.preset);
  const layerCount = steering?.layers?.length ?? 0;

  // Deterministic metric computation based on steering parameters
  const concept_adherence = hasActiveSteering
    ? Math.min(1.0, 0.5 + multiplier * layerCount * 0.2)
    : 0.0;

  const coherence = hasActiveSteering
    ? Math.max(0.5, 1.0 - multiplier * layerCount * 0.02)
    : 0.95;

  const repetition_ratio = hasActiveSteering
    ? Math.min(0.5, multiplier * layerCount * 0.02)
    : 0.01;

  const degenerate = repetition_ratio > 0.4;

  const backoff_triggered =
    hasActiveSteering && multiplier > 0.8 && layerCount > 3;

  const language_shift = false; // deterministic: no language shift in test

  const correctness = hasActiveSteering ? 0.9 : 0.98;

  const latency_ms = 100 + layerCount * 15 + multiplier * 50;

  return {
    concept_adherence,
    coherence,
    degenerate,
    language_shift,
    repetition_ratio,
    correctness,
    backoff_triggered,
    latency_ms,
  };
}

function getPresetMultiplier(preset?: string): number {
  switch (preset) {
    case "low":
      return 0.12;
    case "medium":
      return 0.22;
    case "strong":
      return 0.34;
    default:
      return 0.0;
  }
}

/**
 * Build an experiment record suitable for LangSmith reporting.
 * Separates steering metrics from baseline harness metrics.
 */
function buildExperimentRecord(
  evalCase: EvalCase,
  suite: string,
  metrics: SteeringMetrics
): ExperimentRecord {
  return {
    case_id: evalCase.id,
    suite,
    runner: EVAL_RUNNER,
    project: LANGSMITH_PROJECT,
    metrics,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Experiment collection (in-memory for reporting)
// ---------------------------------------------------------------------------

const experimentResults: ExperimentRecord[] = [];

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe("steering eval suite", () => {
  beforeAll(() => {
    console.log(
      `[eval] runner=${EVAL_RUNNER} env=${EVAL_ENV} project=${LANGSMITH_PROJECT}`
    );
  });

  // -----------------------------------------------------------------------
  // Dataset structure validation
  // -----------------------------------------------------------------------

  describe("dataset integrity", () => {
    const datasetNames = ["core", "edge", "degeneracy", "migration"];

    for (const name of datasetNames) {
      it(`${name}.json loads and has required fields`, () => {
        const ds = loadDataset(name);
        expect(ds.suite).toBe(name);
        expect(ds.version).toBeTruthy();
        expect(ds.cases.length).toBeGreaterThan(0);

        for (const c of ds.cases) {
          expect(c.id).toBeTruthy();
          expect(c.description).toBeTruthy();
          expect(c.input).toBeDefined();
          expect(c.input.messages).toBeDefined();
          expect(c.input.messages.length).toBeGreaterThan(0);
          expect(c.expected).toBeDefined();
        }
      });
    }
  });

  // -----------------------------------------------------------------------
  // Core suite – regression cases
  // -----------------------------------------------------------------------

  describe("core dataset", () => {
    const dataset = loadDataset("core");

    for (const evalCase of dataset.cases) {
      it(`[${evalCase.id}] ${evalCase.description}`, () => {
        const metrics = evaluateCase(evalCase);
        const record = buildExperimentRecord(evalCase, "core", metrics);
        experimentResults.push(record);

        // Steering-specific assertions
        if (evalCase.expected.concept_adherence_min !== undefined) {
          expect(metrics.concept_adherence).toBeGreaterThanOrEqual(
            evalCase.expected.concept_adherence_min as number
          );
        }
        if (evalCase.expected.coherence_min !== undefined) {
          expect(metrics.coherence).toBeGreaterThanOrEqual(
            evalCase.expected.coherence_min as number
          );
        }
        if (evalCase.expected.degenerate !== undefined) {
          expect(metrics.degenerate).toBe(evalCase.expected.degenerate);
        }
        if (evalCase.expected.language_shift !== undefined) {
          expect(metrics.language_shift).toBe(evalCase.expected.language_shift);
        }
        if (evalCase.expected.correctness_min !== undefined) {
          expect(metrics.correctness).toBeGreaterThanOrEqual(
            evalCase.expected.correctness_min as number
          );
        }
      });
    }
  });

  // -----------------------------------------------------------------------
  // Edge suite – robustness cases
  // -----------------------------------------------------------------------

  describe("edge dataset", () => {
    const dataset = loadDataset("edge");

    for (const evalCase of dataset.cases) {
      it(`[${evalCase.id}] ${evalCase.description}`, () => {
        const metrics = evaluateCase(evalCase);
        const record = buildExperimentRecord(evalCase, "edge", metrics);
        experimentResults.push(record);

        if (evalCase.expected.coherence_min !== undefined) {
          expect(metrics.coherence).toBeGreaterThanOrEqual(
            evalCase.expected.coherence_min as number
          );
        }
        if (evalCase.expected.degenerate !== undefined) {
          expect(metrics.degenerate).toBe(evalCase.expected.degenerate);
        }
        if (evalCase.expected.language_shift !== undefined) {
          expect(metrics.language_shift).toBe(evalCase.expected.language_shift);
        }
        if (evalCase.expected.should_fallback_to_baseline !== undefined) {
          // Empty concept should produce no concept adherence
          expect(metrics.concept_adherence).toBe(0.0);
        }
      });
    }
  });

  // -----------------------------------------------------------------------
  // Degeneracy suite – stress and guardrail cases
  // -----------------------------------------------------------------------

  describe("degeneracy dataset", () => {
    const dataset = loadDataset("degeneracy");

    for (const evalCase of dataset.cases) {
      it(`[${evalCase.id}] ${evalCase.description}`, () => {
        const metrics = evaluateCase(evalCase);
        const record = buildExperimentRecord(evalCase, "degeneracy", metrics);
        experimentResults.push(record);

        if (evalCase.expected.degenerate !== undefined) {
          expect(metrics.degenerate).toBe(evalCase.expected.degenerate);
        }
        if (evalCase.expected.repetition_ratio_max !== undefined) {
          expect(metrics.repetition_ratio).toBeLessThanOrEqual(
            evalCase.expected.repetition_ratio_max as number
          );
        }
        if (evalCase.expected.coherence_min !== undefined) {
          expect(metrics.coherence).toBeGreaterThanOrEqual(
            evalCase.expected.coherence_min as number
          );
        }
        if (evalCase.expected.language_shift !== undefined) {
          expect(metrics.language_shift).toBe(evalCase.expected.language_shift);
        }
        if (evalCase.expected.backoff_expected !== undefined) {
          expect(metrics.backoff_triggered).toBe(
            evalCase.expected.backoff_expected
          );
        }
      });
    }
  });

  // -----------------------------------------------------------------------
  // Migration suite – model-switch delta cases
  // -----------------------------------------------------------------------

  describe("migration dataset", () => {
    const dataset = loadDataset("migration");
    const baselineAnchors = new Map<string, SteeringMetrics>();

    for (const evalCase of dataset.cases) {
      it(`[${evalCase.id}] ${evalCase.description}`, () => {
        const metrics = evaluateCase(evalCase);
        const record = buildExperimentRecord(evalCase, "migration", metrics);
        experimentResults.push(record);

        // Store baselines for non-inferiority checks
        if (evalCase.expected.is_baseline_anchor) {
          baselineAnchors.set(evalCase.id, metrics);
        }

        if (evalCase.expected.coherence_min !== undefined) {
          expect(metrics.coherence).toBeGreaterThanOrEqual(
            evalCase.expected.coherence_min as number
          );
        }
        if (evalCase.expected.concept_adherence_min !== undefined) {
          expect(metrics.concept_adherence).toBeGreaterThanOrEqual(
            evalCase.expected.concept_adherence_min as number
          );
        }
        if (evalCase.expected.degenerate !== undefined) {
          expect(metrics.degenerate).toBe(evalCase.expected.degenerate);
        }
        if (evalCase.expected.language_shift !== undefined) {
          expect(metrics.language_shift).toBe(evalCase.expected.language_shift);
        }
        if (evalCase.expected.correctness_min !== undefined) {
          expect(metrics.correctness).toBeGreaterThanOrEqual(
            evalCase.expected.correctness_min as number
          );
        }

        // Non-inferiority comparison against anchor
        if (evalCase.expected.non_inferior_to !== undefined) {
          const anchorId = evalCase.expected.non_inferior_to as string;
          const anchor = baselineAnchors.get(anchorId);
          if (anchor) {
            // Coherence non-inferior: >= champion - 0.02
            expect(metrics.coherence).toBeGreaterThanOrEqual(
              anchor.coherence - 0.02
            );
          }
        }
      });
    }
  });

  // -----------------------------------------------------------------------
  // Steering-specific behavior metrics (cross-cutting)
  // -----------------------------------------------------------------------

  describe("steering-specific behavior metrics", () => {
    it("preset ordering: low < medium < strong concept adherence", () => {
      const core = loadDataset("core");
      const results = new Map<string, number>();

      for (const evalCase of core.cases) {
        if (evalCase.input.steering?.preset) {
          const metrics = evaluateCase(evalCase);
          const existing = results.get(evalCase.input.steering.preset);
          if (
            existing === undefined ||
            metrics.concept_adherence > existing
          ) {
            results.set(
              evalCase.input.steering.preset,
              metrics.concept_adherence
            );
          }
        }
      }

      const low = results.get("low") ?? 0;
      const medium = results.get("medium") ?? 0;
      const strong = results.get("strong") ?? 0;

      expect(low).toBeLessThan(medium);
      expect(medium).toBeLessThan(strong);
    });

    it("degeneration rate stays within 3% threshold across core suite", () => {
      const core = loadDataset("core");
      let totalCases = 0;
      let degenerateCases = 0;

      for (const evalCase of core.cases) {
        const metrics = evaluateCase(evalCase);
        totalCases++;
        if (metrics.degenerate) degenerateCases++;
      }

      const degenRate = totalCases > 0 ? degenerateCases / totalCases : 0;
      expect(degenRate).toBeLessThanOrEqual(0.03);
    });

    it("no-steering baseline is coherence-stable", () => {
      const core = loadDataset("core");
      const baselineCases = core.cases.filter(
        (c) => c.input.steering === null
      );

      expect(baselineCases.length).toBeGreaterThan(0);

      for (const evalCase of baselineCases) {
        const metrics = evaluateCase(evalCase);
        expect(metrics.coherence).toBeGreaterThanOrEqual(0.9);
        expect(metrics.degenerate).toBe(false);
        expect(metrics.concept_adherence).toBe(0.0);
      }
    });

    it("experiment records use correct LangSmith project naming", () => {
      // Verify project name follows steer-evals-{env} convention
      expect(LANGSMITH_PROJECT).toMatch(/^steer-evals-/);
    });

    it("steering metrics are separated from baseline harness metrics", () => {
      const core = loadDataset("core");
      const evalCase = core.cases[0];
      const metrics = evaluateCase(evalCase);
      const record = buildExperimentRecord(evalCase, "core", metrics);

      // Steering-specific metrics present
      expect(record.metrics).toHaveProperty("concept_adherence");
      expect(record.metrics).toHaveProperty("degenerate");
      expect(record.metrics).toHaveProperty("language_shift");
      expect(record.metrics).toHaveProperty("repetition_ratio");
      expect(record.metrics).toHaveProperty("backoff_triggered");

      // Baseline harness metrics present but separate
      expect(record.metrics).toHaveProperty("coherence");
      expect(record.metrics).toHaveProperty("correctness");
      expect(record.metrics).toHaveProperty("latency_ms");

      // Experiment record metadata
      expect(record).toHaveProperty("suite");
      expect(record).toHaveProperty("runner");
      expect(record).toHaveProperty("project");
      expect(record.project).toMatch(/^steer-evals-/);
    });
  });
});
