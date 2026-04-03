import { describe, it, expect } from "vitest";
import {
  trainBundle,
  SeededRng,
  type TrainingCorpus,
  type TrainingConfig,
} from "../src/train.js";
import {
  toResolvableBundles,
  serializeBundle,
  deserializeBundle,
  exportArtifact,
  validateArtifact,
} from "../src/export.js";

const FIXED_TIMESTAMP = "2026-04-15T12:00:00.000Z";

const DEFAULT_LAYERS = [23, 29, 35, 41, 47];
const DIMENSIONS = 16;

function makeConfig(overrides?: Partial<TrainingConfig>): TrainingConfig {
  return {
    seed: 42,
    baseModel: "gemma-3-27b-it",
    baseModelRevision: "2026-03-15",
    layers: DEFAULT_LAYERS,
    dimensions: DIMENSIONS,
    ...overrides,
  };
}

function makeCorpus(conceptId: string): TrainingCorpus {
  return {
    conceptId,
    positiveExamples: [
      Array.from({ length: DIMENSIONS }, (_, i) => 0.5 + i * 0.1),
      Array.from({ length: DIMENSIONS }, (_, i) => 0.6 + i * 0.1),
    ],
    negativeExamples: [
      Array.from({ length: DIMENSIONS }, (_, i) => -0.3 + i * 0.05),
      Array.from({ length: DIMENSIONS }, (_, i) => -0.2 + i * 0.05),
    ],
  };
}

describe("SeededRng", () => {
  it("produces deterministic output for the same seed", () => {
    const rng1 = new SeededRng(123);
    const rng2 = new SeededRng(123);

    const seq1 = Array.from({ length: 100 }, () => rng1.next());
    const seq2 = Array.from({ length: 100 }, () => rng2.next());

    expect(seq1).toEqual(seq2);
  });

  it("produces different output for different seeds", () => {
    const rng1 = new SeededRng(1);
    const rng2 = new SeededRng(2);

    const seq1 = Array.from({ length: 10 }, () => rng1.next());
    const seq2 = Array.from({ length: 10 }, () => rng2.next());

    expect(seq1).not.toEqual(seq2);
  });

  it("produces values in [0, 1)", () => {
    const rng = new SeededRng(99);
    for (let i = 0; i < 1000; i++) {
      const val = rng.next();
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThan(1);
    }
  });

  it("nextGaussian is deterministic for the same seed", () => {
    const rng1 = new SeededRng(55);
    const rng2 = new SeededRng(55);

    const seq1 = Array.from({ length: 50 }, () => rng1.nextGaussian());
    const seq2 = Array.from({ length: 50 }, () => rng2.nextGaussian());

    expect(seq1).toEqual(seq2);
  });
});

describe("trainBundle", () => {
  it("produces a deterministic bundle for the same corpus and seed", () => {
    const corpus = [makeCorpus("curiosity")];
    const config = makeConfig();

    const bundle1 = trainBundle(corpus, config, FIXED_TIMESTAMP);
    const bundle2 = trainBundle(corpus, config, FIXED_TIMESTAMP);

    expect(bundle1).toEqual(bundle2);
  });

  it("produces different bundles for different seeds", () => {
    const corpus = [makeCorpus("curiosity")];
    const config1 = makeConfig({ seed: 1 });
    const config2 = makeConfig({ seed: 2 });

    const bundle1 = trainBundle(corpus, config1, FIXED_TIMESTAMP);
    const bundle2 = trainBundle(corpus, config2, FIXED_TIMESTAMP);

    expect(bundle1.vectorBundleId).not.toEqual(bundle2.vectorBundleId);
    expect(bundle1.concepts[0].values).not.toEqual(bundle2.concepts[0].values);
  });

  it("includes vector_bundle_id, model revision, and seed metadata", () => {
    const corpus = [makeCorpus("empathy")];
    const config = makeConfig();
    const bundle = trainBundle(corpus, config, FIXED_TIMESTAMP);

    expect(bundle.vectorBundleId).toMatch(/^vec-bundle-/);
    expect(bundle.baseModelRevision).toBe("2026-03-15");
    expect(bundle.seed).toBe(42);
    expect(bundle.baseModel).toBe("gemma-3-27b-it");
    expect(bundle.createdAt).toBe(FIXED_TIMESTAMP);
  });

  it("generates concept vectors for every layer", () => {
    const corpus = [makeCorpus("creativity")];
    const config = makeConfig();
    const bundle = trainBundle(corpus, config, FIXED_TIMESTAMP);

    const layersInBundle = bundle.concepts.map((c) => c.layerIndex);
    expect(layersInBundle).toEqual(DEFAULT_LAYERS);
  });

  it("generates normalized vectors (unit norm)", () => {
    const corpus = [makeCorpus("logic")];
    const config = makeConfig();
    const bundle = trainBundle(corpus, config, FIXED_TIMESTAMP);

    for (const cv of bundle.concepts) {
      const norm = Math.sqrt(cv.values.reduce((s, v) => s + v * v, 0));
      expect(norm).toBeCloseTo(1.0, 3);
    }
  });

  it("generates preset calibration tables for each concept", () => {
    const corpus = [makeCorpus("humor"), makeCorpus("empathy")];
    const config = makeConfig();
    const bundle = trainBundle(corpus, config, FIXED_TIMESTAMP);

    expect(bundle.presetCalibration).toHaveProperty("humor");
    expect(bundle.presetCalibration).toHaveProperty("empathy");

    for (const conceptId of ["humor", "empathy"]) {
      const table = bundle.presetCalibration[conceptId];
      expect(table.low).toBeTypeOf("number");
      expect(table.medium).toBeTypeOf("number");
      expect(table.strong).toBeTypeOf("number");
      expect(table.low).toBeLessThan(table.medium);
      expect(table.medium).toBeLessThan(table.strong);
    }
  });

  it("handles multiple concepts in a single training run", () => {
    const corpora = [
      makeCorpus("curiosity"),
      makeCorpus("empathy"),
      makeCorpus("creativity"),
    ];
    const config = makeConfig();
    const bundle = trainBundle(corpora, config, FIXED_TIMESTAMP);

    const conceptIds = [...new Set(bundle.concepts.map((c) => c.conceptId))];
    expect(conceptIds.sort()).toEqual(["creativity", "curiosity", "empathy"]);

    expect(bundle.concepts.length).toBe(3 * DEFAULT_LAYERS.length);
  });

  it("generates a bundle ID with date and seed hex", () => {
    const config = makeConfig({ seed: 255 });
    const bundle = trainBundle([makeCorpus("test")], config, FIXED_TIMESTAMP);

    expect(bundle.vectorBundleId).toBe("vec-bundle-2026-04-15-s00ff");
  });
});

describe("toResolvableBundles", () => {
  it("produces bundles compatible with VectorResolver.registerBundle", () => {
    const corpus = [makeCorpus("curiosity")];
    const config = makeConfig();
    const trained = trainBundle(corpus, config, FIXED_TIMESTAMP);
    const resolvable = toResolvableBundles(trained);

    const bundle = resolvable.get("curiosity");
    expect(bundle).toBeDefined();
    expect(bundle!.bundleId).toContain(trained.vectorBundleId);
    expect(bundle!.vectors).toBeInstanceOf(Map);

    for (const layerIdx of DEFAULT_LAYERS) {
      expect(bundle!.vectors.has(layerIdx)).toBe(true);
      const vec = bundle!.vectors.get(layerIdx)!;
      expect(vec.length).toBe(DIMENSIONS);
    }
  });

  it("creates separate bundles per concept", () => {
    const corpora = [makeCorpus("humor"), makeCorpus("empathy")];
    const config = makeConfig();
    const trained = trainBundle(corpora, config, FIXED_TIMESTAMP);
    const resolvable = toResolvableBundles(trained);

    expect(resolvable.size).toBe(2);
    expect(resolvable.has("humor")).toBe(true);
    expect(resolvable.has("empathy")).toBe(true);

    const humorId = resolvable.get("humor")!.bundleId;
    const empathyId = resolvable.get("empathy")!.bundleId;
    expect(humorId).not.toBe(empathyId);
  });
});

describe("serializeBundle / deserializeBundle", () => {
  it("roundtrips a bundle through serialization", () => {
    const corpus = [makeCorpus("curiosity")];
    const config = makeConfig();
    const trained = trainBundle(corpus, config, FIXED_TIMESTAMP);
    const resolvable = toResolvableBundles(trained);
    const original = resolvable.get("curiosity")!;

    const serialized = serializeBundle(original);
    const deserialized = deserializeBundle(serialized);

    expect(deserialized.bundleId).toBe(original.bundleId);
    expect(deserialized.vectors.size).toBe(original.vectors.size);

    for (const [layer, values] of original.vectors) {
      expect(deserialized.vectors.has(layer)).toBe(true);
      expect(deserialized.vectors.get(layer)).toEqual(Array.from(values));
    }
  });

  it("serialized form is JSON-safe", () => {
    const corpus = [makeCorpus("test")];
    const config = makeConfig();
    const trained = trainBundle(corpus, config, FIXED_TIMESTAMP);
    const resolvable = toResolvableBundles(trained);
    const serialized = serializeBundle(resolvable.get("test")!);

    const json = JSON.stringify(serialized);
    const parsed = JSON.parse(json);
    expect(parsed.bundleId).toBe(serialized.bundleId);
    expect(Object.keys(parsed.vectors).length).toBeGreaterThan(0);
  });
});

describe("exportArtifact", () => {
  it("includes vector_bundle_id, model_revision, and seed metadata", () => {
    const corpus = [makeCorpus("curiosity")];
    const config = makeConfig();
    const trained = trainBundle(corpus, config, FIXED_TIMESTAMP);
    const artifact = exportArtifact(trained);

    expect(artifact.vector_bundle_id).toBe(trained.vectorBundleId);
    expect(artifact.model_revision).toBe("2026-03-15");
    expect(artifact.seed).toBe(42);
    expect(artifact.base_model).toBe("gemma-3-27b-it");
    expect(artifact.created_at).toBe(FIXED_TIMESTAMP);
  });

  it("includes per-concept serialized bundles", () => {
    const corpora = [makeCorpus("humor"), makeCorpus("empathy")];
    const config = makeConfig();
    const trained = trainBundle(corpora, config, FIXED_TIMESTAMP);
    const artifact = exportArtifact(trained);

    expect(artifact.concepts.sort()).toEqual(["empathy", "humor"]);
    expect(artifact.bundles["humor"]).toBeDefined();
    expect(artifact.bundles["empathy"]).toBeDefined();
  });

  it("includes preset calibration tables", () => {
    const corpus = [makeCorpus("curiosity")];
    const config = makeConfig();
    const trained = trainBundle(corpus, config, FIXED_TIMESTAMP);
    const artifact = exportArtifact(trained);

    const cal = artifact.preset_calibration["curiosity"];
    expect(cal).toBeDefined();
    expect(cal.low).toBeTypeOf("number");
    expect(cal.medium).toBeTypeOf("number");
    expect(cal.strong).toBeTypeOf("number");
  });

  it("passes schema validation", () => {
    const corpus = [makeCorpus("curiosity"), makeCorpus("empathy")];
    const config = makeConfig();
    const trained = trainBundle(corpus, config, FIXED_TIMESTAMP);
    const artifact = exportArtifact(trained);
    const errors = validateArtifact(artifact);

    expect(errors).toEqual([]);
  });

  it("is fully JSON-serializable", () => {
    const corpus = [makeCorpus("curiosity")];
    const config = makeConfig();
    const trained = trainBundle(corpus, config, FIXED_TIMESTAMP);
    const artifact = exportArtifact(trained);

    const json = JSON.stringify(artifact);
    const parsed = JSON.parse(json);
    expect(parsed.vector_bundle_id).toBe(artifact.vector_bundle_id);
    expect(parsed.model_revision).toBe(artifact.model_revision);
    expect(parsed.seed).toBe(artifact.seed);
  });
});

describe("validateArtifact", () => {
  it("returns empty array for valid artifact", () => {
    const corpus = [makeCorpus("curiosity")];
    const config = makeConfig();
    const trained = trainBundle(corpus, config, FIXED_TIMESTAMP);
    const artifact = exportArtifact(trained);

    expect(validateArtifact(artifact)).toEqual([]);
  });

  it("detects missing vector_bundle_id", () => {
    const corpus = [makeCorpus("curiosity")];
    const config = makeConfig();
    const trained = trainBundle(corpus, config, FIXED_TIMESTAMP);
    const artifact = exportArtifact(trained);
    artifact.vector_bundle_id = "";

    const errors = validateArtifact(artifact);
    expect(errors).toContain("Missing vector_bundle_id");
  });

  it("detects missing model_revision", () => {
    const corpus = [makeCorpus("curiosity")];
    const config = makeConfig();
    const trained = trainBundle(corpus, config, FIXED_TIMESTAMP);
    const artifact = exportArtifact(trained);
    artifact.model_revision = "";

    const errors = validateArtifact(artifact);
    expect(errors).toContain("Missing model_revision");
  });

  it("detects missing bundle for a listed concept", () => {
    const corpus = [makeCorpus("curiosity")];
    const config = makeConfig();
    const trained = trainBundle(corpus, config, FIXED_TIMESTAMP);
    const artifact = exportArtifact(trained);
    delete artifact.bundles["curiosity"];

    const errors = validateArtifact(artifact);
    expect(errors).toContain("Missing bundle for concept: curiosity");
  });

  it("detects missing preset calibration for a listed concept", () => {
    const corpus = [makeCorpus("curiosity")];
    const config = makeConfig();
    const trained = trainBundle(corpus, config, FIXED_TIMESTAMP);
    const artifact = exportArtifact(trained);
    delete artifact.preset_calibration["curiosity"];

    const errors = validateArtifact(artifact);
    expect(errors).toContain(
      "Missing preset calibration for concept: curiosity",
    );
  });
});

describe("runtime resolution integration", () => {
  it("exported bundles resolve as VectorBundle for VectorResolver", () => {
    const corpus = [makeCorpus("curiosity")];
    const config = makeConfig();
    const trained = trainBundle(corpus, config, FIXED_TIMESTAMP);

    const artifact = exportArtifact(trained);
    const serialized = artifact.bundles["curiosity"];
    const deserialized = deserializeBundle(serialized);

    expect(deserialized.bundleId).toBeTruthy();
    expect(deserialized.vectors).toBeInstanceOf(Map);
    expect(deserialized.vectors.size).toBe(DEFAULT_LAYERS.length);

    for (const layer of DEFAULT_LAYERS) {
      const vec = deserialized.vectors.get(layer);
      expect(vec).toBeDefined();
      expect(vec!.length).toBe(DIMENSIONS);
      const norm = Math.sqrt(vec!.reduce((s, v) => s + v * v, 0));
      expect(norm).toBeCloseTo(1.0, 3);
    }
  });

  it("end-to-end: train → export → serialize → deserialize is deterministic", () => {
    const corpus = [makeCorpus("curiosity"), makeCorpus("empathy")];
    const config = makeConfig();

    const artifact1 = exportArtifact(trainBundle(corpus, config, FIXED_TIMESTAMP));
    const artifact2 = exportArtifact(trainBundle(corpus, config, FIXED_TIMESTAMP));

    const json1 = JSON.stringify(artifact1);
    const json2 = JSON.stringify(artifact2);

    expect(json1).toBe(json2);
  });
});
