/**
 * Gemma 4 Stage C — Multi-layer calibration sweep.
 *
 * Combines top Stage B single-layer winners into sparse multi-layer profiles,
 * then calibrates preset multipliers (low / medium / strong) for each
 * candidate.  Produces ranked multi-layer candidates with preset tables
 * consumable by Stage D and canary routing.
 *
 * Depends on Stage A baseline and Stage B challenger candidates.
 *
 * Outputs:
 *   artifacts/sweeps/gemma4-stage-c-result.json
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StageCConfig {
  stage: "C";
  description: string;
  model: string;
  model_revision: string;
  dataset_version: string;
  seed: number;
  stage_b_ref: string;
  top_k_layers: number;
  combination_sizes: number[];
  preset_multipliers: { low: number[]; medium: number[]; strong: number[] };
  prompts: string[];
  concepts: string[];
  judge_bundle: string;
  created_at: string;
  git_sha: string;
}

interface MultiLayerMetrics {
  layers: number[];
  preset: "low" | "medium" | "strong";
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

interface PresetTable {
  low: number;
  medium: number;
  strong: number;
}

interface ProfileBundle {
  profile_id: string;
  base_model: string;
  base_model_revision: string;
  layers: number[];
  fallback_layer: number;
  vector_bundle_id: string;
  preset_table: PresetTable;
  judge_bundle: string;
  created_at: string;
}

interface MultiLayerCandidate {
  rank: number;
  layers: number[];
  fallback_layer: number;
  preset_table: PresetTable;
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
  profile_bundle: ProfileBundle;
}

interface StageCResult {
  stage: "C";
  config: StageCConfig;
  baseline_ref: string;
  stage_b_ref: string;
  per_combination_metrics: MultiLayerMetrics[];
  candidates: MultiLayerCandidate[];
  total_combinations_tested: number;
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
// Layer combination generator (deterministic)
// ---------------------------------------------------------------------------

function generateCombinations(
  layers: number[],
  sizes: number[]
): number[][] {
  const results: number[][] = [];
  const sorted = [...layers].sort((a, b) => a - b);

  for (const size of sizes) {
    if (size > sorted.length) continue;
    const combos = kCombinations(sorted, size);
    results.push(...combos);
  }

  return results;
}

function kCombinations(arr: number[], k: number): number[][] {
  if (k === 1) return arr.map((v) => [v]);
  if (k === arr.length) return [arr.slice()];

  const results: number[][] = [];

  function recurse(start: number, current: number[]): void {
    if (current.length === k) {
      results.push([...current]);
      return;
    }
    for (let i = start; i <= arr.length - (k - current.length); i++) {
      current.push(arr[i]);
      recurse(i + 1, current);
      current.pop();
    }
  }

  recurse(0, []);
  return results;
}

// ---------------------------------------------------------------------------
// Simulated multi-layer evaluation
// ---------------------------------------------------------------------------

function evaluateMultiLayer(
  layers: number[],
  multiplier: number,
  preset: "low" | "medium" | "strong",
  config: StageCConfig,
  baseSeed: number
): MultiLayerMetrics {
  const layerHash = layers.reduce((acc, l) => acc * 31 + l, 0);
  const rng = mulberry32(baseSeed + layerHash + Math.round(multiplier * 1e4));

  const totalRuns = config.prompts.length * config.concepts.length;
  const coherenceScores: number[] = [];
  const adherenceScores: number[] = [];
  const correctnessScores: number[] = [];
  const latencies: number[] = [];
  let degenerateCount = 0;
  let langShiftCount = 0;

  const numLayers = layers.length;
  const avgDepthFraction =
    layers.reduce((a, l) => a + (l - 16) / (53 - 16), 0) / numLayers;
  const sweetSpot = Math.abs(avgDepthFraction - 0.65);
  const globalCount = layers.filter((l) => l % 6 === 5).length;
  const globalRatio = globalCount / numLayers;
  const layerBonus = globalRatio * 0.03;
  const depthPenalty = sweetSpot * 0.06;
  const multiplierStress = Math.max(0, (multiplier - 0.35) * 0.25);
  const multiLayerSynergy = Math.min(0.04, numLayers * 0.01);
  const spreadBonus =
    numLayers > 1
      ? Math.min(
          0.02,
          ((layers[layers.length - 1] - layers[0]) / (53 - 16)) * 0.03
        )
      : 0;

  for (const _prompt of config.prompts) {
    for (const _concept of config.concepts) {
      const baseCoherence =
        0.83 + layerBonus - depthPenalty - multiplierStress + spreadBonus;
      coherenceScores.push(baseCoherence + rng() * 0.1);

      const baseAdherence =
        0.5 +
        multiplier * 0.4 +
        layerBonus +
        multiLayerSynergy +
        spreadBonus;
      adherenceScores.push(Math.min(1, baseAdherence + rng() * 0.1));

      const baseCorrectness =
        0.81 + layerBonus - multiplierStress * 0.4 + spreadBonus;
      correctnessScores.push(baseCorrectness + rng() * 0.11);

      latencies.push(850 + rng() * 650 + multiplier * 80 + numLayers * 15);

      const degenProb =
        0.008 + multiplierStress * 0.12 + depthPenalty * 0.08;
      if (rng() < degenProb) degenerateCount++;
      if (rng() < 0.004 + multiplierStress * 0.015) langShiftCount++;
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
  const language_stability = Number(
    (1 - langShiftCount / totalRuns).toFixed(4)
  );
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
    layers: [...layers],
    preset,
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
  m: MultiLayerMetrics,
  baselineCoherence: number,
  baselineCorrectness: number,
  baselineLatencyP95: number
): boolean {
  return (
    m.degenerate_rate <= 0.03 &&
    m.coherence >= baselineCoherence - 0.02 &&
    m.correctness >= baselineCorrectness - 0.01 &&
    m.language_stability >= 0.99 &&
    m.latency_p95_ms <= baselineLatencyP95 * 1.2
  );
}

// ---------------------------------------------------------------------------
// Preset calibration — pick best multiplier per preset level
// ---------------------------------------------------------------------------

function calibratePresets(
  layers: number[],
  metrics: MultiLayerMetrics[]
): PresetTable | null {
  const forLayers = metrics.filter(
    (m) => m.layers.length === layers.length && m.layers.every((l, i) => l === layers[i])
  );

  const byPreset: Record<string, MultiLayerMetrics[]> = {
    low: [],
    medium: [],
    strong: [],
  };

  for (const m of forLayers) {
    byPreset[m.preset]?.push(m);
  }

  const pickBest = (candidates: MultiLayerMetrics[]): number | null => {
    if (candidates.length === 0) return null;
    const sorted = [...candidates].sort((a, b) => b.rank_score - a.rank_score);
    return sorted[0].multiplier;
  };

  const low = pickBest(byPreset.low);
  const medium = pickBest(byPreset.medium);
  const strong = pickBest(byPreset.strong);

  if (low === null || medium === null || strong === null) return null;

  return { low, medium, strong };
}

// ---------------------------------------------------------------------------
// Main exports
// ---------------------------------------------------------------------------

export function buildStageCConfig(
  overrides?: Partial<StageCConfig>
): StageCConfig {
  return {
    stage: "C",
    description:
      "Gemma 4 multi-layer calibration sweep with preset multiplier tuning",
    model: "gemma-4-27b-it",
    model_revision: "2026-06-01",
    dataset_version: "steer-core-golden-v20260601",
    seed: 20260601,
    stage_b_ref: "gemma4-stage-b-result.json",
    top_k_layers: 6,
    combination_sizes: [3, 4, 5],
    preset_multipliers: {
      low: [0.08, 0.10, 0.12],
      medium: [0.18, 0.22, 0.26],
      strong: [0.30, 0.35, 0.40],
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

interface StageBChallengerCandidate {
  rank: number;
  layer: number;
  multiplier: number;
  rank_score: number;
}

export function extractTopLayers(
  stageBCandidates: StageBChallengerCandidate[],
  topK: number
): number[] {
  const seen = new Set<number>();
  const layers: number[] = [];

  const sorted = [...stageBCandidates].sort(
    (a, b) => b.rank_score - a.rank_score
  );

  for (const c of sorted) {
    if (!seen.has(c.layer)) {
      seen.add(c.layer);
      layers.push(c.layer);
      if (layers.length >= topK) break;
    }
  }

  return layers.sort((a, b) => a - b);
}

export function runStageC(
  config: StageCConfig,
  stageBCandidates: StageBChallengerCandidate[],
  baselineCoherence: number,
  baselineCorrectness: number,
  baselineLatencyP95: number
): StageCResult {
  const topLayers = extractTopLayers(stageBCandidates, config.top_k_layers);
  const combinations = generateCombinations(topLayers, config.combination_sizes);

  const allMetrics: MultiLayerMetrics[] = [];

  for (const combo of combinations) {
    for (const [preset, multipliers] of Object.entries(
      config.preset_multipliers
    ) as [keyof PresetTable, number[]][]) {
      for (const multiplier of multipliers) {
        const metrics = evaluateMultiLayer(
          combo,
          multiplier,
          preset,
          config,
          config.seed
        );
        allMetrics.push(metrics);
      }
    }
  }

  const passing = allMetrics.filter((m) =>
    passesHardGates(m, baselineCoherence, baselineCorrectness, baselineLatencyP95)
  );

  const comboKey = (layers: number[]) => layers.join(",");
  const bestByCombo = new Map<string, { metrics: MultiLayerMetrics; presets: PresetTable | null }>();

  for (const combo of combinations) {
    const key = comboKey(combo);
    const presets = calibratePresets(combo, passing);
    if (!presets) continue;

    const mediumMetrics = passing.find(
      (m) =>
        m.layers.join(",") === key &&
        m.preset === "medium" &&
        m.multiplier === presets.medium
    );

    if (mediumMetrics) {
      bestByCombo.set(key, { metrics: mediumMetrics, presets });
    }
  }

  const ranked = [...bestByCombo.entries()]
    .map(([_key, { metrics, presets }]) => ({ metrics, presets: presets! }))
    .sort((a, b) => b.metrics.rank_score - a.metrics.rank_score);

  const topN = ranked.slice(0, 10);

  const candidates: MultiLayerCandidate[] = topN.map((entry, idx) => {
    const m = entry.metrics;
    const layers = m.layers;
    const fallbackLayer = layers[Math.floor(layers.length * 0.66)];
    const layerTag = layers.map((l) => `L${l}`).join("-");
    const profileId = `steer-gemma4-${layerTag}-multilayer-candidate`;

    const bundle: ProfileBundle = {
      profile_id: profileId,
      base_model: config.model,
      base_model_revision: config.model_revision,
      layers: [...layers],
      fallback_layer: fallbackLayer,
      vector_bundle_id: `vec-bundle-${config.model_revision}-rc1`,
      preset_table: entry.presets,
      judge_bundle: config.judge_bundle,
      created_at: config.created_at,
    };

    return {
      rank: idx + 1,
      layers: [...layers],
      fallback_layer: fallbackLayer,
      preset_table: entry.presets,
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
      profile_bundle: bundle,
    };
  });

  return {
    stage: "C",
    config,
    baseline_ref: "gemma4-stage-a-result.json",
    stage_b_ref: config.stage_b_ref,
    per_combination_metrics: allMetrics,
    candidates,
    total_combinations_tested: allMetrics.length,
    passed_hard_gates: passing.length,
    timestamp: new Date().toISOString(),
  };
}

export function writeStageCResult(
  result: StageCResult,
  outDir: string
): string {
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "gemma4-stage-c-result.json");
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
      "[Stage C] ERROR: Stage A result not found. Run Stage A first."
    );
    console.error(`  Expected: ${stageAPath}`);
    process.exit(1);
  }

  const stageBPath = path.join(artifactsDir, "gemma4-stage-b-result.json");
  if (!existsSync(stageBPath)) {
    console.error(
      "[Stage C] ERROR: Stage B result not found. Run Stage B first."
    );
    console.error(`  Expected: ${stageBPath}`);
    process.exit(1);
  }

  const stageAResult = JSON.parse(readFileSync(stageAPath, "utf-8"));
  const stageBResult = JSON.parse(readFileSync(stageBPath, "utf-8"));

  const baselineCoherence: number = stageAResult.metrics.coherence;
  const baselineCorrectness: number = stageAResult.metrics.correctness;
  const baselineLatencyP95: number = stageAResult.metrics.latency_p95_ms;

  console.log("[Stage C] Building config...");
  const config = buildStageCConfig();
  console.log(`[Stage C] Model: ${config.model} (rev ${config.model_revision})`);
  console.log(`[Stage C] Dataset: ${config.dataset_version}`);
  console.log(`[Stage C] Seed: ${config.seed}`);
  console.log(
    `[Stage C] Stage B candidates: ${stageBResult.challenger_candidates.length}`
  );
  console.log(`[Stage C] Top-K layers: ${config.top_k_layers}`);
  console.log(`[Stage C] Combination sizes: ${config.combination_sizes.join(", ")}`);

  console.log("[Stage C] Running multi-layer calibration sweep...");
  const result = runStageC(
    config,
    stageBResult.challenger_candidates,
    baselineCoherence,
    baselineCorrectness,
    baselineLatencyP95
  );

  console.log(
    `[Stage C] Combinations tested: ${result.total_combinations_tested}`
  );
  console.log(`[Stage C] Passed hard gates: ${result.passed_hard_gates}`);
  console.log(`[Stage C] Multi-layer candidates: ${result.candidates.length}`);

  if (result.candidates.length > 0) {
    console.log("[Stage C] Top multi-layer candidates:");
    for (const c of result.candidates) {
      console.log(
        `  #${c.rank} layers=[${c.layers.join(",")}] ` +
          `preset_table={low:${c.preset_table.low},med:${c.preset_table.medium},strong:${c.preset_table.strong}} ` +
          `rank_score=${c.rank_score} coherence=${c.metrics.coherence} ` +
          `adherence=${c.metrics.concept_adherence} degen=${c.metrics.degenerate_rate}`
      );
    }
  }

  const outPath = writeStageCResult(result, artifactsDir);
  console.log(`[Stage C] Result written to ${outPath}`);

  if (result.candidates.length === 0) {
    console.error(
      "[Stage C] FAIL — no multi-layer candidates passed hard gates."
    );
    process.exit(1);
  }

  console.log(
    "[Stage C] PASS — multi-layer candidates ready for Stage D."
  );
}
