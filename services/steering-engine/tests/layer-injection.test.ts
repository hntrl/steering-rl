import { describe, it, expect } from "vitest";
import { LayerInjectionEngine } from "../src/steering/layer-injection.js";
import { VectorResolver } from "../src/steering/vector-resolver.js";
import type {
  InjectionConfig,
  VectorBundle,
  SteeringProfile,
} from "../src/steering/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHiddenStates(
  layers: number[],
  dim: number = 4,
  fillValue: number = 1.0,
): Map<number, number[]> {
  const states = new Map<number, number[]>();
  for (const layer of layers) {
    states.set(layer, new Array(dim).fill(fillValue));
  }
  return states;
}

function makeVectorBundle(
  layers: number[],
  dim: number = 4,
  fillValue: number = 0.5,
  bundleId: string = "test-bundle-v1",
): VectorBundle {
  const vectors = new Map<number, number[]>();
  for (const layer of layers) {
    vectors.set(layer, new Array(dim).fill(fillValue));
  }
  return { bundleId, vectors };
}

function makeProfile(overrides: Partial<SteeringProfile> = {}): SteeringProfile {
  return {
    profileId: "steer-test-default-v1",
    baseModel: "gemma-3-27b-it",
    baseModelRevision: "2026-03-15",
    layers: [23, 29, 35, 41, 47],
    fallbackLayer: 41,
    vectorBundleId: "vec-bundle-test-v1",
    presetTable: { low: 0.12, medium: 0.22, strong: 0.34 },
    judgeBundle: "judge-v4",
    createdAt: "2026-04-02T00:00:00Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// LayerInjectionEngine
// ---------------------------------------------------------------------------

describe("LayerInjectionEngine", () => {
  const engine = new LayerInjectionEngine();

  // -----------------------------------------------------------------------
  // No-steering code path (baseline stability)
  // -----------------------------------------------------------------------

  describe("no-steering code path", () => {
    it("returns unmodified hidden states when disabled", () => {
      const hidden = makeHiddenStates([23, 29, 35, 41, 47]);
      const bundle = makeVectorBundle([23, 29, 35, 41, 47]);
      const config: InjectionConfig = {
        targetLayers: [23, 29, 35, 41, 47],
        uniformMultiplier: 0.22,
        enabled: false,
      };

      const result = engine.inject(hidden, config, bundle);

      expect(result.metadata.steeringApplied).toBe(false);
      expect(result.metadata.activeLayers).toEqual([]);
      expect(result.metadata.effectiveMultipliers).toEqual({});

      // Hidden states must be identical to input.
      for (const [layerIdx, state] of result.hiddenStates) {
        const original = hidden.get(layerIdx)!;
        expect(Array.from(state)).toEqual(Array.from(original));
      }
    });

    it("returns deep copy of states (no mutation of input)", () => {
      const hidden = makeHiddenStates([41]);
      const bundle = makeVectorBundle([41]);
      const config: InjectionConfig = {
        targetLayers: [41],
        uniformMultiplier: 0.22,
        enabled: false,
      };

      const result = engine.inject(hidden, config, bundle);
      const outputState = result.hiddenStates.get(41)! as number[];
      outputState[0] = 999;

      // Original should be untouched.
      expect(hidden.get(41)![0]).toBe(1.0);
    });

    it("emits metadata with bundleId even when disabled", () => {
      const hidden = makeHiddenStates([41]);
      const bundle = makeVectorBundle([41], 4, 0.5, "my-special-bundle");
      const config: InjectionConfig = {
        targetLayers: [41],
        uniformMultiplier: 0.22,
        enabled: false,
      };

      const result = engine.inject(hidden, config, bundle);
      expect(result.metadata.vectorBundleId).toBe("my-special-bundle");
      expect(result.metadata.timestamp).toBeTruthy();
    });
  });

  // -----------------------------------------------------------------------
  // Single-layer injection
  // -----------------------------------------------------------------------

  describe("single-layer injection", () => {
    it("injects at exactly one layer with uniform multiplier", () => {
      const hidden = makeHiddenStates([23, 29, 35, 41, 47], 4, 1.0);
      const bundle = makeVectorBundle([41], 4, 0.5);
      const config: InjectionConfig = {
        targetLayers: [41],
        uniformMultiplier: 0.22,
        enabled: true,
      };

      const result = engine.inject(hidden, config, bundle);

      expect(result.metadata.steeringApplied).toBe(true);
      expect(result.metadata.activeLayers).toEqual([41]);
      expect(result.metadata.effectiveMultipliers).toEqual({ 41: 0.22 });

      // Layer 41: h' = 1.0 + 0.22 * 0.5 = 1.11
      const modified = result.hiddenStates.get(41)! as number[];
      for (const val of modified) {
        expect(val).toBeCloseTo(1.11, 10);
      }

      // Other layers must be unmodified.
      for (const layer of [23, 29, 35, 47]) {
        const state = result.hiddenStates.get(layer)! as number[];
        for (const val of state) {
          expect(val).toBeCloseTo(1.0, 10);
        }
      }
    });

    it("handles fallback to single layer (layer 41)", () => {
      const hidden = makeHiddenStates([41], 4, 2.0);
      const bundle = makeVectorBundle([41], 4, 1.0);
      const config: InjectionConfig = {
        targetLayers: [41],
        uniformMultiplier: 0.34,
        enabled: true,
      };

      const result = engine.inject(hidden, config, bundle);

      expect(result.metadata.activeLayers).toEqual([41]);
      // h' = 2.0 + 0.34 * 1.0 = 2.34
      const modified = result.hiddenStates.get(41)! as number[];
      for (const val of modified) {
        expect(val).toBeCloseTo(2.34, 10);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Multi-layer injection
  // -----------------------------------------------------------------------

  describe("multi-layer injection", () => {
    it("injects at all configured layers with uniform multiplier", () => {
      const layers = [23, 29, 35, 41, 47];
      const hidden = makeHiddenStates(layers, 4, 1.0);
      const bundle = makeVectorBundle(layers, 4, 0.5);
      const config: InjectionConfig = {
        targetLayers: layers,
        uniformMultiplier: 0.22,
        enabled: true,
      };

      const result = engine.inject(hidden, config, bundle);

      expect(result.metadata.steeringApplied).toBe(true);
      expect(result.metadata.activeLayers).toEqual(layers);
      for (const layer of layers) {
        expect(result.metadata.effectiveMultipliers[layer]).toBe(0.22);
      }

      // All layers: h' = 1.0 + 0.22 * 0.5 = 1.11
      for (const layer of layers) {
        const state = result.hiddenStates.get(layer)! as number[];
        for (const val of state) {
          expect(val).toBeCloseTo(1.11, 10);
        }
      }
    });

    it("skips layers without vectors in the bundle", () => {
      const layers = [23, 29, 35, 41, 47];
      const hidden = makeHiddenStates(layers, 4, 1.0);
      // Only provide vectors for layers 23 and 47.
      const bundle = makeVectorBundle([23, 47], 4, 0.5);
      const config: InjectionConfig = {
        targetLayers: layers,
        uniformMultiplier: 0.22,
        enabled: true,
      };

      const result = engine.inject(hidden, config, bundle);

      expect(result.metadata.activeLayers).toEqual([23, 47]);

      // Modified layers.
      for (const layer of [23, 47]) {
        const state = result.hiddenStates.get(layer)! as number[];
        for (const val of state) {
          expect(val).toBeCloseTo(1.11, 10);
        }
      }

      // Unmodified layers.
      for (const layer of [29, 35, 41]) {
        const state = result.hiddenStates.get(layer)! as number[];
        for (const val of state) {
          expect(val).toBeCloseTo(1.0, 10);
        }
      }
    });

    it("skips target layers without hidden state entries", () => {
      const hidden = makeHiddenStates([23, 41], 4, 1.0);
      const bundle = makeVectorBundle([23, 29, 41], 4, 0.5);
      const config: InjectionConfig = {
        targetLayers: [23, 29, 41],
        uniformMultiplier: 0.22,
        enabled: true,
      };

      const result = engine.inject(hidden, config, bundle);

      // Layer 29 has no hidden state, so it's skipped.
      expect(result.metadata.activeLayers).toEqual([23, 41]);
    });
  });

  // -----------------------------------------------------------------------
  // Uniform vs per-layer multipliers
  // -----------------------------------------------------------------------

  describe("multiplier support", () => {
    it("uses uniform multiplier when perLayerMultipliers not set", () => {
      const hidden = makeHiddenStates([23, 41], 4, 1.0);
      const bundle = makeVectorBundle([23, 41], 4, 1.0);
      const config: InjectionConfig = {
        targetLayers: [23, 41],
        uniformMultiplier: 0.12,
        enabled: true,
      };

      const result = engine.inject(hidden, config, bundle);

      expect(result.metadata.effectiveMultipliers).toEqual({
        23: 0.12,
        41: 0.12,
      });

      // h' = 1.0 + 0.12 * 1.0 = 1.12
      for (const layer of [23, 41]) {
        const state = result.hiddenStates.get(layer)! as number[];
        for (const val of state) {
          expect(val).toBeCloseTo(1.12, 10);
        }
      }
    });

    it("uses per-layer multipliers when provided (overrides uniform)", () => {
      const hidden = makeHiddenStates([23, 29, 41], 4, 1.0);
      const bundle = makeVectorBundle([23, 29, 41], 4, 1.0);
      const config: InjectionConfig = {
        targetLayers: [23, 29, 41],
        uniformMultiplier: 0.22,
        perLayerMultipliers: [
          { layerIndex: 23, multiplier: 0.10 },
          { layerIndex: 41, multiplier: 0.40 },
        ],
        enabled: true,
      };

      const result = engine.inject(hidden, config, bundle);

      expect(result.metadata.effectiveMultipliers).toEqual({
        23: 0.10,
        29: 0.22, // Falls back to uniform.
        41: 0.40,
      });

      // Layer 23: h' = 1.0 + 0.10 * 1.0 = 1.10
      const s23 = result.hiddenStates.get(23)! as number[];
      expect(s23[0]).toBeCloseTo(1.10, 10);

      // Layer 29: h' = 1.0 + 0.22 * 1.0 = 1.22 (uniform fallback)
      const s29 = result.hiddenStates.get(29)! as number[];
      expect(s29[0]).toBeCloseTo(1.22, 10);

      // Layer 41: h' = 1.0 + 0.40 * 1.0 = 1.40
      const s41 = result.hiddenStates.get(41)! as number[];
      expect(s41[0]).toBeCloseTo(1.40, 10);
    });

    it("supports zero multiplier (no effective steering)", () => {
      const hidden = makeHiddenStates([41], 4, 1.0);
      const bundle = makeVectorBundle([41], 4, 1.0);
      const config: InjectionConfig = {
        targetLayers: [41],
        uniformMultiplier: 0.0,
        enabled: true,
      };

      const result = engine.inject(hidden, config, bundle);

      // Injection technically happened but with zero effect.
      expect(result.metadata.activeLayers).toEqual([41]);
      expect(result.metadata.effectiveMultipliers).toEqual({ 41: 0.0 });

      const state = result.hiddenStates.get(41)! as number[];
      for (const val of state) {
        expect(val).toBeCloseTo(1.0, 10);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Determinism
  // -----------------------------------------------------------------------

  describe("deterministic behavior", () => {
    it("produces identical results on repeated calls", () => {
      const hidden = makeHiddenStates([23, 41, 47], 8, 1.0);
      const bundle = makeVectorBundle([23, 41, 47], 8, 0.5);
      const config: InjectionConfig = {
        targetLayers: [23, 41, 47],
        uniformMultiplier: 0.22,
        perLayerMultipliers: [{ layerIndex: 47, multiplier: 0.30 }],
        enabled: true,
      };

      const result1 = engine.inject(hidden, config, bundle);
      const result2 = engine.inject(hidden, config, bundle);

      expect(result1.metadata.activeLayers).toEqual(
        result2.metadata.activeLayers,
      );
      expect(result1.metadata.effectiveMultipliers).toEqual(
        result2.metadata.effectiveMultipliers,
      );

      for (const layer of [23, 41, 47]) {
        const s1 = Array.from(result1.hiddenStates.get(layer)!);
        const s2 = Array.from(result2.hiddenStates.get(layer)!);
        expect(s1).toEqual(s2);
      }
    });

    it("does not mutate input hidden states", () => {
      const hidden = makeHiddenStates([41], 4, 1.0);
      const originalSnapshot = Array.from(hidden.get(41)!);
      const bundle = makeVectorBundle([41], 4, 0.5);
      const config: InjectionConfig = {
        targetLayers: [41],
        uniformMultiplier: 0.22,
        enabled: true,
      };

      engine.inject(hidden, config, bundle);

      expect(Array.from(hidden.get(41)!)).toEqual(originalSnapshot);
    });
  });

  // -----------------------------------------------------------------------
  // Float64Array support
  // -----------------------------------------------------------------------

  describe("Float64Array support", () => {
    it("works with Float64Array hidden states and vectors", () => {
      const hidden = new Map<number, Float64Array>();
      hidden.set(41, new Float64Array([1.0, 2.0, 3.0, 4.0]));

      const vectors = new Map<number, Float64Array>();
      vectors.set(41, new Float64Array([0.5, 0.5, 0.5, 0.5]));
      const bundle: VectorBundle = { bundleId: "float64-bundle", vectors };

      const config: InjectionConfig = {
        targetLayers: [41],
        uniformMultiplier: 0.22,
        enabled: true,
      };

      const result = engine.inject(hidden, config, bundle);
      const modified = result.hiddenStates.get(41)!;
      expect(modified).toBeInstanceOf(Float64Array);

      // h' = h + 0.22 * 0.5 = h + 0.11
      expect(modified[0]).toBeCloseTo(1.11, 10);
      expect(modified[1]).toBeCloseTo(2.11, 10);
      expect(modified[2]).toBeCloseTo(3.11, 10);
      expect(modified[3]).toBeCloseTo(4.11, 10);
    });
  });

  // -----------------------------------------------------------------------
  // Metadata emission
  // -----------------------------------------------------------------------

  describe("metadata emission", () => {
    it("emits active layer list", () => {
      const layers = [23, 35, 47];
      const hidden = makeHiddenStates(layers, 4, 1.0);
      const bundle = makeVectorBundle(layers, 4, 0.5);
      const config: InjectionConfig = {
        targetLayers: layers,
        uniformMultiplier: 0.22,
        enabled: true,
      };

      const result = engine.inject(hidden, config, bundle);

      expect(result.metadata.activeLayers).toEqual([23, 35, 47]);
    });

    it("emits effective multiplier per active layer", () => {
      const hidden = makeHiddenStates([23, 29], 4, 1.0);
      const bundle = makeVectorBundle([23, 29], 4, 0.5);
      const config: InjectionConfig = {
        targetLayers: [23, 29],
        uniformMultiplier: 0.22,
        perLayerMultipliers: [{ layerIndex: 23, multiplier: 0.15 }],
        enabled: true,
      };

      const result = engine.inject(hidden, config, bundle);

      expect(result.metadata.effectiveMultipliers).toEqual({
        23: 0.15,
        29: 0.22,
      });
    });

    it("emits timestamp in ISO format", () => {
      const hidden = makeHiddenStates([41], 4, 1.0);
      const bundle = makeVectorBundle([41], 4, 0.5);
      const config: InjectionConfig = {
        targetLayers: [41],
        uniformMultiplier: 0.22,
        enabled: true,
      };

      const result = engine.inject(hidden, config, bundle);
      const ts = result.metadata.timestamp;

      // Verify it's a valid ISO date string.
      expect(new Date(ts).toISOString()).toBe(ts);
    });

    it("emits vectorBundleId in metadata", () => {
      const hidden = makeHiddenStates([41], 4, 1.0);
      const bundle = makeVectorBundle([41], 4, 0.5, "custom-bundle-id");
      const config: InjectionConfig = {
        targetLayers: [41],
        uniformMultiplier: 0.22,
        enabled: true,
      };

      const result = engine.inject(hidden, config, bundle);
      expect(result.metadata.vectorBundleId).toBe("custom-bundle-id");
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  describe("edge cases", () => {
    it("handles empty target layers", () => {
      const hidden = makeHiddenStates([41], 4, 1.0);
      const bundle = makeVectorBundle([41], 4, 0.5);
      const config: InjectionConfig = {
        targetLayers: [],
        uniformMultiplier: 0.22,
        enabled: true,
      };

      const result = engine.inject(hidden, config, bundle);

      expect(result.metadata.steeringApplied).toBe(false);
      expect(result.metadata.activeLayers).toEqual([]);
    });

    it("handles empty hidden states", () => {
      const hidden = new Map<number, number[]>();
      const bundle = makeVectorBundle([41], 4, 0.5);
      const config: InjectionConfig = {
        targetLayers: [41],
        uniformMultiplier: 0.22,
        enabled: true,
      };

      const result = engine.inject(hidden, config, bundle);

      expect(result.metadata.steeringApplied).toBe(false);
      expect(result.metadata.activeLayers).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// VectorResolver
// ---------------------------------------------------------------------------

describe("VectorResolver", () => {
  describe("bundle registration and resolution", () => {
    it("registers and resolves a bundle", () => {
      const resolver = new VectorResolver();
      const bundle = makeVectorBundle([23, 41], 4, 0.5, "bundle-v1");

      resolver.registerBundle(bundle);
      const resolved = resolver.resolveBundle("bundle-v1");

      expect(resolved.bundleId).toBe("bundle-v1");
      expect(resolved.vectors.size).toBe(2);
    });

    it("throws for unknown bundle ID", () => {
      const resolver = new VectorResolver();

      expect(() => resolver.resolveBundle("nonexistent")).toThrow(
        "Vector bundle not found: nonexistent",
      );
    });
  });

  describe("preset resolution", () => {
    it("resolves low preset", () => {
      const resolver = new VectorResolver();
      const profile = makeProfile();

      expect(resolver.resolvePreset(profile, "low")).toBe(0.12);
    });

    it("resolves medium preset", () => {
      const resolver = new VectorResolver();
      const profile = makeProfile();

      expect(resolver.resolvePreset(profile, "medium")).toBe(0.22);
    });

    it("resolves strong preset", () => {
      const resolver = new VectorResolver();
      const profile = makeProfile();

      expect(resolver.resolvePreset(profile, "strong")).toBe(0.34);
    });

    it("throws for undefined preset", () => {
      const resolver = new VectorResolver();
      const profile = makeProfile();

      expect(() =>
        resolver.resolvePreset(profile, "extreme" as any),
      ).toThrow('Preset "extreme" not defined');
    });
  });

  describe("buildInjectionConfig", () => {
    it("builds config with all profile layers", () => {
      const resolver = new VectorResolver();
      const profile = makeProfile();

      const config = resolver.buildInjectionConfig(profile, "medium");

      expect(config.targetLayers).toEqual([23, 29, 35, 41, 47]);
      expect(config.uniformMultiplier).toBe(0.22);
      expect(config.enabled).toBe(true);
    });

    it("respects enabled=false override", () => {
      const resolver = new VectorResolver();
      const profile = makeProfile();

      const config = resolver.buildInjectionConfig(profile, "medium", {
        enabled: false,
      });

      expect(config.enabled).toBe(false);
    });

    it("filters to layer subset when provided", () => {
      const resolver = new VectorResolver();
      const profile = makeProfile();

      const config = resolver.buildInjectionConfig(profile, "low", {
        layerSubset: [23, 41],
      });

      expect(config.targetLayers).toEqual([23, 41]);
      expect(config.uniformMultiplier).toBe(0.12);
    });

    it("throws if layer subset has no overlap with profile", () => {
      const resolver = new VectorResolver();
      const profile = makeProfile();

      expect(() =>
        resolver.buildInjectionConfig(profile, "medium", {
          layerSubset: [99, 100],
        }),
      ).toThrow("No valid layers in subset");
    });

    it("passes through perLayerMultipliers", () => {
      const resolver = new VectorResolver();
      const profile = makeProfile();

      const config = resolver.buildInjectionConfig(profile, "medium", {
        perLayerMultipliers: [
          { layerIndex: 23, multiplier: 0.10 },
          { layerIndex: 47, multiplier: 0.30 },
        ],
      });

      expect(config.perLayerMultipliers).toEqual([
        { layerIndex: 23, multiplier: 0.10 },
        { layerIndex: 47, multiplier: 0.30 },
      ]);
    });

    it("single-layer config for fallback", () => {
      const resolver = new VectorResolver();
      const profile = makeProfile();

      const config = resolver.buildInjectionConfig(profile, "medium", {
        layerSubset: [profile.fallbackLayer],
      });

      expect(config.targetLayers).toEqual([41]);
      expect(config.uniformMultiplier).toBe(0.22);
    });
  });
});

// ---------------------------------------------------------------------------
// Integration: VectorResolver + LayerInjectionEngine
// ---------------------------------------------------------------------------

describe("Integration: VectorResolver + LayerInjectionEngine", () => {
  it("end-to-end: resolve profile, build config, inject", () => {
    const resolver = new VectorResolver();
    const engine = new LayerInjectionEngine();
    const profile = makeProfile();

    const bundle = makeVectorBundle(
      profile.layers,
      4,
      1.0,
      profile.vectorBundleId,
    );
    resolver.registerBundle(bundle);

    const resolved = resolver.resolveBundle(profile.vectorBundleId);
    const config = resolver.buildInjectionConfig(profile, "medium");
    const hidden = makeHiddenStates(profile.layers, 4, 0.0);

    const result = engine.inject(hidden, config, resolved);

    expect(result.metadata.steeringApplied).toBe(true);
    expect(result.metadata.activeLayers).toEqual([23, 29, 35, 41, 47]);
    expect(result.metadata.vectorBundleId).toBe("vec-bundle-test-v1");

    // h' = 0.0 + 0.22 * 1.0 = 0.22
    for (const layer of profile.layers) {
      const state = result.hiddenStates.get(layer)! as number[];
      for (const val of state) {
        expect(val).toBeCloseTo(0.22, 10);
      }
    }
  });

  it("end-to-end: disabled steering preserves baseline", () => {
    const resolver = new VectorResolver();
    const engine = new LayerInjectionEngine();
    const profile = makeProfile();

    const bundle = makeVectorBundle(
      profile.layers,
      4,
      1.0,
      profile.vectorBundleId,
    );
    resolver.registerBundle(bundle);

    const resolved = resolver.resolveBundle(profile.vectorBundleId);
    const config = resolver.buildInjectionConfig(profile, "strong", {
      enabled: false,
    });
    const hidden = makeHiddenStates(profile.layers, 4, 5.0);

    const result = engine.inject(hidden, config, resolved);

    expect(result.metadata.steeringApplied).toBe(false);

    // All values must be exactly the original baseline.
    for (const layer of profile.layers) {
      const state = result.hiddenStates.get(layer)! as number[];
      for (const val of state) {
        expect(val).toBe(5.0);
      }
    }
  });

  it("end-to-end: per-layer multipliers with profile", () => {
    const resolver = new VectorResolver();
    const engine = new LayerInjectionEngine();
    const profile = makeProfile();

    const bundle = makeVectorBundle(
      profile.layers,
      4,
      1.0,
      profile.vectorBundleId,
    );
    resolver.registerBundle(bundle);

    const resolved = resolver.resolveBundle(profile.vectorBundleId);
    const config = resolver.buildInjectionConfig(profile, "medium", {
      perLayerMultipliers: [
        { layerIndex: 23, multiplier: 0.05 },
        { layerIndex: 47, multiplier: 0.50 },
      ],
    });
    const hidden = makeHiddenStates(profile.layers, 4, 0.0);

    const result = engine.inject(hidden, config, resolved);

    // Layer 23: 0.0 + 0.05 * 1.0 = 0.05
    expect((result.hiddenStates.get(23)! as number[])[0]).toBeCloseTo(0.05, 10);
    // Layer 29: 0.0 + 0.22 * 1.0 = 0.22 (uniform)
    expect((result.hiddenStates.get(29)! as number[])[0]).toBeCloseTo(0.22, 10);
    // Layer 47: 0.0 + 0.50 * 1.0 = 0.50
    expect((result.hiddenStates.get(47)! as number[])[0]).toBeCloseTo(0.50, 10);
  });
});
