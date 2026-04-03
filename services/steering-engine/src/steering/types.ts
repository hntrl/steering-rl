/**
 * Types for the steering layer injection engine.
 *
 * Based on model-and-layers.md and feedback-loop.md specifications.
 */

/** A steering vector for a specific layer. */
export interface LayerVector {
  /** Transformer layer index where this vector should be injected. */
  layerIndex: number;
  /** The steering vector values (residual stream dimensions). */
  values: Float64Array | number[];
}

/** Per-layer multiplier override. */
export interface LayerMultiplier {
  layerIndex: number;
  multiplier: number;
}

/** Configuration for a single steering injection pass. */
export interface InjectionConfig {
  /** Target layer indices for injection. */
  targetLayers: number[];

  /**
   * Uniform multiplier applied to all layers (alpha).
   * Used when perLayerMultipliers is not provided.
   */
  uniformMultiplier: number;

  /**
   * Optional per-layer multiplier overrides.
   * When provided, these take precedence over uniformMultiplier for the specified layers.
   */
  perLayerMultipliers?: LayerMultiplier[];

  /** Feature flag to enable/disable steering entirely. */
  enabled: boolean;
}

/** Resolved vector bundle: maps layer indices to their vectors. */
export interface VectorBundle {
  /** Bundle identifier for traceability. */
  bundleId: string;
  /** Map of layer index to steering vector values. */
  vectors: Map<number, Float64Array | number[]>;
}

/** Metadata emitted by the injection engine at runtime. */
export interface InjectionMetadata {
  /** Whether steering was applied. */
  steeringApplied: boolean;
  /** Layer indices where injection was actually performed. */
  activeLayers: number[];
  /** Effective multiplier used at each active layer. */
  effectiveMultipliers: Record<number, number>;
  /** The bundle ID of the vectors used. */
  vectorBundleId: string;
  /** Timestamp of the injection operation. */
  timestamp: string;
}

/** Result of applying injection to a residual stream state. */
export interface InjectionResult {
  /** The modified (or unmodified for no-steering) hidden states. */
  hiddenStates: Map<number, Float64Array | number[]>;
  /** Metadata describing what was done. */
  metadata: InjectionMetadata;
}

/** Steering profile as described in feedback-loop.md. */
export interface SteeringProfile {
  profileId: string;
  baseModel: string;
  baseModelRevision: string;
  layers: number[];
  fallbackLayer: number;
  vectorBundleId: string;
  presetTable: Record<string, number>;
  judgeBundle: string;
  createdAt: string;
}

/** Preset intensity levels. */
export type PresetLevel = "low" | "medium" | "strong";
