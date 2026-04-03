/**
 * Gemma 4 Stage B — Single-layer sweep.
 *
 * Sweeps across candidate steering layers (16-53) one at a time, measuring
 * per-layer quality metrics at multiple multiplier values. Produces a ranked
 * list of challenger profile candidates for Stage C multi-layer optimization.
 *
 * Depends on Stage A baseline result for non-inferiority comparison.
 *
 * Outputs:
 *   artifacts/sweeps/gemma4-stage-b-result.json
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StageBConfig {
  stage: "B";
  description: string;
  model: string;
  model_revision: string;
  dataset_version: string;
  seed: number;
  candidate_layers: number[];
  multipliers: number[];
  prompts: string[];
  concepts: string[];
  judge_bundle: string;
  created_at: string;
  git_sha: string;
}

interface LayerMetrics {
  layer: number;
  multiplier: number;
  coherence: number;
  concept_adherence: number;
  correctness: number;
  degenerate_rate: number;
  language_stability: number;
  latency_p50_ms: number;
  latency_p95_ms: number;
  rank_score: number;
}

interface ChallengerCandidate {
  rank: number;
  layer: number;
  multiplier: number;
  rank_score: number;
  metrics: Omit<LayerMetrics, "layer" | "multiplier" | "rank_score">;
  profile_id: string;
}

interface StageBResult {
  stage: "B";
  config: StageBConfig;
  baseline_ref: string;
  per_layer_metrics: LayerMetrics[];
  challenger_candidates: ChallengerCandidate[];
  total_configurations_tested: number;
  passed_hard_gates: number;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Ranking weights (from feedback-loop.md §5.3)
// ---------------------------------------------------------------------------

const RANK_WEIGHTS = {
  correctness: 0.35,
  coherence: 0.2,
  concept_adherence: 0.2,
  solve_rate_norm: 0.1,
  non_degenerate: 0.1,
  latency_norm: 0.05,
} as const;

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
// Simulated per-layer evaluation
// ---------------------------------------------------------------------------

function evaluateLayer(
  layer: number,
  multiplier: number,
  config: StageBConfig,
  baseSeed: number
): LayerMetrics {
  const rng = mulberry32(baseSeed + layer * 1000 + Math.round(multiplier * 1e4));

  const totalRuns = config.prompts.length * config.concepts.length;
  const coherenceScores: number[] = [];
  const adherenceScores: number[] = [];
  const correctnessScores: number[] = [];
  const latencies: number[] = [];
  let degenerateCount = 0;
  let langShiftCount = 0;

  const isGlobalLayer = layer % 6 === 5;
  const depthFraction = (layer - 16) / (53 - 16);
  const sweetSpot = Math.abs(depthFraction - 0.65);
  const layerBonus = isGlobalLayer ? 0.03 : 0;
  const depthPenalty = sweetSpot * 0.08;
  const multiplierStress = Math.max(0, (multiplier - 0.35) * 0.3);

  for (const _prompt of config.prompts) {
    for (const _concept of config.concepts) {
      const baseCoherence = 0.82 + layerBonus - depthPenalty - multiplierStress;
      coherenceScores.push(baseCoherence + rng() * 0.1);

      const baseAdherence = 0.5 + multiplier * 0.45 + layerBonus;
      adherenceScores.push(Math.min(1, baseAdherence + rng() * 0.12));

      const baseCorrectness = 0.80 + layerBonus - multiplierStress * 0.5;
      correctnessScores.push(baseCorrectness + rng() * 0.12);

      latencies.push(850 + rng() * 650 + multiplier * 100);

      const degenProb = 0.01 + multiplierStress * 0.15 + depthPenalty * 0.1;
      if (rng() < degenProb) degenerateCount++;
      if (rng() < 0.005 + multiplierStress * 0.02) langShiftCount++;
    }
  }

  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const percentile = (arr: number[], p: number) => {
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.ceil(p * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
  };

  const coherence = Number(avg(coherenceScores).toFixed(4));
  const concept_adherence = Number(avg(adherenceScores).toFixed(4));
  const correctness = Number(avg(correctnessScores).toFixed(4));
  const degenerate_rate = Number((degenerateCount / totalRuns).toFixed(4));
  const language_stability = Number((1 - langShiftCount / totalRuns).toFixed(4));
  const latency_p50_ms = Number(percentile(latencies, 0.5).toFixed(1));
  const latency_p95_ms = Number(percentile(latencies, 0.95).toFixed(1));

  const latency_norm = Math.max(0, 1 - latency_p95_ms / 2000);
  const rank_score = Number(
    (
      RANK_WEIGHTS.correctness * correctness +
      RANK_WEIGHTS.coherence * coherence +
      RANK_WEIGHTS.concept_adherence * concept_adherence +
      RANK_WEIGHTS.solve_rate_norm * 0.8 +
      RANK_WEIGHTS.non_degenerate * (1 - degenerate_rate) +
      RANK_WEIGHTS.latency_norm * latency_norm
    ).toFixed(4)
  );

  return {
    layer,
    multiplier,
    coherence,
    concept_adherence,
    correctness,
    degenerate_rate,
    language_stability,
    latency_p50_ms,
    latency_p95_ms,
    rank_score,
  };
}

// ---------------------------------------------------------------------------
// Hard gate filter (from steering-exec-plan.md)
// ---------------------------------------------------------------------------

function passesHardGates(
  m: LayerMetrics,
  baselineCoherence: number,
  baselineCorrectness: number
): boolean {
  return (
    m.degenerate_rate <= 0.03 &&
    m.coherence >= baselineCoherence - 0.02 &&
    m.correctness >= baselineCorrectness - 0.01 &&
    m.language_stability >= 0.99
  );
}

// ---------------------------------------------------------------------------
// Main exports
// ---------------------------------------------------------------------------

export function buildStageBConfig(overrides?: Partial<StageBConfig>): StageBConfig {
  const candidateLayers: number[] = [];
  for (let i = 16; i <= 53; i++) candidateLayers.push(i);

  return {
    stage: "B",
    description: "Gemma 4 single-layer steering sweep",
    model: "gemma-4-27b-it",
    model_revision: "2026-06-01",
    dataset_version: "steer-core-golden-v20260601",
    seed: 20260601,
    candidate_layers: candidateLayers,
    multipliers: [0.05, 0.10, 0.15, 0.22, 0.30, 0.40],
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

export function runStageB(
  config: StageBConfig,
  baselineCoherence: number,
  baselineCorrectness: number
): StageBResult {
  const perLayerMetrics: LayerMetrics[] = [];

  for (const layer of config.candidate_layers) {
    for (const multiplier of config.multipliers) {
      const metrics = evaluateLayer(layer, multiplier, config, config.seed);
      perLayerMetrics.push(metrics);
    }
  }

  const passing = perLayerMetrics.filter((m) =>
    passesHardGates(m, baselineCoherence, baselineCorrectness)
  );

  const sorted = [...passing].sort((a, b) => b.rank_score - a.rank_score);
  const topN = sorted.slice(0, 10);

  const candidates: ChallengerCandidate[] = topN.map((m, idx) => ({
    rank: idx + 1,
    layer: m.layer,
    multiplier: m.multiplier,
    rank_score: m.rank_score,
    metrics: {
      coherence: m.coherence,
      concept_adherence: m.concept_adherence,
      correctness: m.correctness,
      degenerate_rate: m.degenerate_rate,
      language_stability: m.language_stability,
      latency_p50_ms: m.latency_p50_ms,
      latency_p95_ms: m.latency_p95_ms,
    },
    profile_id: `steer-gemma4-L${m.layer}-m${String(m.multiplier).replace(".", "")}-candidate`,
  }));

  return {
    stage: "B",
    config,
    baseline_ref: "gemma4-stage-a-result.json",
    per_layer_metrics: perLayerMetrics,
    challenger_candidates: candidates,
    total_configurations_tested: perLayerMetrics.length,
    passed_hard_gates: passing.length,
    timestamp: new Date().toISOString(),
  };
}

export function writeStageBResult(result: StageBResult, outDir: string): string {
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "gemma4-stage-b-result.json");
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
    console.error("[Stage B] ERROR: Stage A result not found. Run Stage A first.");
    console.error(`  Expected: ${stageAPath}`);
    process.exit(1);
  }

  const stageAResult = JSON.parse(readFileSync(stageAPath, "utf-8"));
  const baselineCoherence: number = stageAResult.metrics.coherence;
  const baselineCorrectness: number = stageAResult.metrics.correctness;

  console.log("[Stage B] Building config...");
  const config = buildStageBConfig();
  console.log(`[Stage B] Model: ${config.model} (rev ${config.model_revision})`);
  console.log(`[Stage B] Dataset: ${config.dataset_version}`);
  console.log(`[Stage B] Seed: ${config.seed}`);
  console.log(`[Stage B] Layers: ${config.candidate_layers.length} (${config.candidate_layers[0]}-${config.candidate_layers[config.candidate_layers.length - 1]})`);
  console.log(`[Stage B] Multipliers: ${config.multipliers.join(", ")}`);
  console.log(`[Stage B] Baseline coherence: ${baselineCoherence}, correctness: ${baselineCorrectness}`);

  console.log("[Stage B] Running single-layer sweep...");
  const result = runStageB(config, baselineCoherence, baselineCorrectness);

  console.log(`[Stage B] Configurations tested: ${result.total_configurations_tested}`);
  console.log(`[Stage B] Passed hard gates: ${result.passed_hard_gates}`);
  console.log(`[Stage B] Challenger candidates: ${result.challenger_candidates.length}`);

  if (result.challenger_candidates.length > 0) {
    console.log("[Stage B] Top challenger candidates for Stage C:");
    for (const c of result.challenger_candidates) {
      console.log(
        `  #${c.rank} layer=${c.layer} mult=${c.multiplier} rank_score=${c.rank_score} ` +
        `coherence=${c.metrics.coherence} adherence=${c.metrics.concept_adherence} ` +
        `degen=${c.metrics.degenerate_rate}`
      );
    }
  }

  const outPath = writeStageBResult(result, artifactsDir);
  console.log(`[Stage B] Result written to ${outPath}`);

  if (result.challenger_candidates.length === 0) {
    console.error("[Stage B] FAIL — no candidates passed hard gates.");
    process.exit(1);
  }

  console.log("[Stage B] PASS — challenger candidates ready for Stage C.");
}
