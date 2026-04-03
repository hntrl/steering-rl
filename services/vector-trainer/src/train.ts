/**
 * Deterministic vector training pipeline.
 *
 * Produces versioned concept vector bundles and preset calibration tables
 * from training corpora. Deterministic for the same dataset and seed.
 */

export interface TrainingCorpus {
  conceptId: string;
  positiveExamples: number[][];
  negativeExamples: number[][];
}

export interface TrainingConfig {
  seed: number;
  baseModel: string;
  baseModelRevision: string;
  layers: number[];
  dimensions: number;
}

export interface ConceptVector {
  conceptId: string;
  layerIndex: number;
  values: number[];
  norm: number;
}

export interface PresetCalibrationTable {
  low: number;
  medium: number;
  strong: number;
}

export interface TrainedBundle {
  vectorBundleId: string;
  baseModel: string;
  baseModelRevision: string;
  seed: number;
  createdAt: string;
  concepts: ConceptVector[];
  presetCalibration: Record<string, PresetCalibrationTable>;
}

/**
 * Seeded pseudo-random number generator (xoshiro128**).
 * Ensures deterministic output for the same seed.
 */
export class SeededRng {
  private state: [number, number, number, number];

  constructor(seed: number) {
    let s = seed >>> 0;
    this.state = [
      this.splitmix32(s),
      this.splitmix32(s + 1),
      this.splitmix32(s + 2),
      this.splitmix32(s + 3),
    ];
  }

  private splitmix32(seed: number): number {
    seed = (seed + 0x9e3779b9) | 0;
    let t = seed ^ (seed >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    t = t ^ (t >>> 15);
    return t >>> 0;
  }

  next(): number {
    const s = this.state;
    const result = Math.imul(s[1] * 5, 1) << 0;
    const rotl = ((result << 7) | (result >>> 25)) >>> 0;
    const out = (Math.imul(rotl, 9) >>> 0) / 0x100000000;

    const t = (s[1] << 9) >>> 0;
    s[2] ^= s[0];
    s[3] ^= s[1];
    s[1] ^= s[2];
    s[0] ^= s[3];
    s[2] ^= t;
    s[3] = ((s[3] << 11) | (s[3] >>> 21)) >>> 0;

    return out;
  }

  nextGaussian(): number {
    const u1 = this.next() || 1e-10;
    const u2 = this.next();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
}

function vectorNorm(values: number[]): number {
  let sum = 0;
  for (const v of values) sum += v * v;
  return Math.sqrt(sum);
}

function normalizeVector(values: number[]): number[] {
  const norm = vectorNorm(values);
  if (norm === 0) return values;
  return values.map((v) => v / norm);
}

/**
 * Compute the mean activation difference between positive and negative examples.
 * This is the core CAV (Concept Activation Vector) approach:
 * direction = mean(positive) - mean(negative)
 */
function computeMeanDifference(
  positive: number[][],
  negative: number[][],
): number[] {
  const dim = positive[0]?.length ?? 0;
  const posMean = new Array<number>(dim).fill(0);
  const negMean = new Array<number>(dim).fill(0);

  for (const example of positive) {
    for (let i = 0; i < dim; i++) posMean[i] += example[i] / positive.length;
  }
  for (const example of negative) {
    for (let i = 0; i < dim; i++) negMean[i] += example[i] / negative.length;
  }

  return posMean.map((p, i) => p - negMean[i]);
}

/**
 * Generate synthetic layer activations from corpus examples using seeded noise.
 * Simulates per-layer representation differences.
 */
function generateLayerActivations(
  examples: number[][],
  layerIndex: number,
  rng: SeededRng,
  dimensions: number,
): number[][] {
  return examples.map((example) => {
    const activation = new Array<number>(dimensions);
    for (let d = 0; d < dimensions; d++) {
      const baseVal = example[d % example.length] ?? 0;
      const layerScale = 1 + layerIndex * 0.01;
      activation[d] = baseVal * layerScale + rng.nextGaussian() * 0.01;
    }
    return activation;
  });
}

/**
 * Calibrate preset multipliers for a concept based on vector norms.
 * Follows model-and-layers.md effective_strength ~= alpha * ||v||.
 * We target specific effective strengths and back-solve for alpha.
 */
function calibratePresets(avgNorm: number): PresetCalibrationTable {
  const targetLow = 0.05;
  const targetMedium = 0.15;
  const targetStrong = 0.30;

  const safeNorm = avgNorm > 0 ? avgNorm : 1;
  return {
    low: Math.round((targetLow / safeNorm) * 1000) / 1000,
    medium: Math.round((targetMedium / safeNorm) * 1000) / 1000,
    strong: Math.round((targetStrong / safeNorm) * 1000) / 1000,
  };
}

/**
 * Generate a deterministic bundle ID from config and timestamp.
 */
function generateBundleId(
  config: TrainingConfig,
  timestamp: string,
): string {
  const dateStr = timestamp.slice(0, 10);
  const seedHex = (config.seed >>> 0).toString(16).padStart(4, "0").slice(0, 4);
  return `vec-bundle-${dateStr}-s${seedHex}`;
}

/**
 * Train concept vectors from a corpus, producing a versioned bundle.
 *
 * The pipeline is fully deterministic for the same corpus + config:
 * 1. Initialize seeded RNG from config.seed.
 * 2. For each concept × layer, generate synthetic activations and compute CAV.
 * 3. Normalize vectors and calibrate preset multipliers.
 * 4. Package into a versioned TrainedBundle.
 */
export function trainBundle(
  corpora: TrainingCorpus[],
  config: TrainingConfig,
  timestamp?: string,
): TrainedBundle {
  const rng = new SeededRng(config.seed);
  const ts = timestamp ?? new Date().toISOString();
  const bundleId = generateBundleId(config, ts);

  const concepts: ConceptVector[] = [];
  const presetCalibration: Record<string, PresetCalibrationTable> = {};

  for (const corpus of corpora) {
    const norms: number[] = [];

    for (const layerIndex of config.layers) {
      const posActivations = generateLayerActivations(
        corpus.positiveExamples,
        layerIndex,
        rng,
        config.dimensions,
      );
      const negActivations = generateLayerActivations(
        corpus.negativeExamples,
        layerIndex,
        rng,
        config.dimensions,
      );

      const rawDirection = computeMeanDifference(posActivations, negActivations);
      const norm = vectorNorm(rawDirection);
      const normalized = normalizeVector(rawDirection);

      concepts.push({
        conceptId: corpus.conceptId,
        layerIndex,
        values: normalized,
        norm,
      });

      norms.push(norm);
    }

    const avgNorm =
      norms.length > 0 ? norms.reduce((a, b) => a + b, 0) / norms.length : 1;
    presetCalibration[corpus.conceptId] = calibratePresets(avgNorm);
  }

  return {
    vectorBundleId: bundleId,
    baseModel: config.baseModel,
    baseModelRevision: config.baseModelRevision,
    seed: config.seed,
    createdAt: ts,
    concepts,
    presetCalibration,
  };
}
