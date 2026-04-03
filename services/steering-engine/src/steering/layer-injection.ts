import type {
  InjectionConfig,
  InjectionResult,
  InjectionMetadata,
  VectorBundle,
} from "./types.js";

/**
 * Layer injection engine for applying steering vectors at configured
 * transformer layers with deterministic behavior.
 *
 * Design principles (from model-and-layers.md):
 * - Inject only in requested layers.
 * - Support single-layer and multi-layer configs.
 * - No-steering code path must remain baseline-stable.
 * - Runtime emits active layer list and effective multiplier metadata.
 *
 * Injection formula per layer:
 *   h' = h + alpha[layer] * v[layer]
 *
 * Where alpha is either the uniform multiplier or a per-layer override.
 */
export class LayerInjectionEngine {
  /**
   * Apply steering vectors to hidden states at configured layers.
   *
   * @param hiddenStates - Map of layer index to hidden state vectors.
   *   Each entry represents the residual stream state after that layer's
   *   transformer block has executed.
   * @param config - The injection configuration (layers, multipliers, enabled flag).
   * @param vectorBundle - The resolved vector bundle containing steering vectors.
   * @returns InjectionResult with modified hidden states and metadata.
   */
  inject(
    hiddenStates: Map<number, Float64Array | number[]>,
    config: InjectionConfig,
    vectorBundle: VectorBundle,
  ): InjectionResult {
    // No-steering code path: return unmodified states with metadata.
    if (!config.enabled) {
      return this.buildNoSteeringResult(hiddenStates, vectorBundle.bundleId);
    }

    const activeLayers: number[] = [];
    const effectiveMultipliers: Record<number, number> = {};
    const result = new Map<number, Float64Array | number[]>();

    // Copy all hidden states first (preserve non-targeted layers).
    for (const [layerIdx, state] of hiddenStates) {
      result.set(layerIdx, this.copyState(state));
    }

    // Apply injection at each target layer.
    for (const layerIdx of config.targetLayers) {
      const state = result.get(layerIdx);
      if (!state) {
        continue;
      }

      const vector = vectorBundle.vectors.get(layerIdx);
      if (!vector) {
        continue;
      }

      const alpha = this.resolveMultiplier(layerIdx, config);
      const modified = this.applySteeringVector(state, vector, alpha);
      result.set(layerIdx, modified);

      activeLayers.push(layerIdx);
      effectiveMultipliers[layerIdx] = alpha;
    }

    const metadata: InjectionMetadata = {
      steeringApplied: activeLayers.length > 0,
      activeLayers,
      effectiveMultipliers,
      vectorBundleId: vectorBundle.bundleId,
      timestamp: new Date().toISOString(),
    };

    return { hiddenStates: result, metadata };
  }

  /**
   * Resolve the effective multiplier for a given layer.
   * Per-layer multipliers take precedence over the uniform multiplier.
   */
  private resolveMultiplier(
    layerIdx: number,
    config: InjectionConfig,
  ): number {
    if (config.perLayerMultipliers) {
      const override = config.perLayerMultipliers.find(
        (m) => m.layerIndex === layerIdx,
      );
      if (override !== undefined) {
        return override.multiplier;
      }
    }
    return config.uniformMultiplier;
  }

  /**
   * Apply steering vector to a hidden state:
   *   h' = h + alpha * v
   *
   * Deterministic: no randomness, pure arithmetic.
   */
  private applySteeringVector(
    state: Float64Array | number[],
    vector: Float64Array | number[],
    alpha: number,
  ): Float64Array | number[] {
    const len = Math.min(state.length, vector.length);

    if (state instanceof Float64Array) {
      const result = new Float64Array(state.length);
      for (let i = 0; i < state.length; i++) {
        result[i] = state[i] + (i < len ? alpha * vector[i] : 0);
      }
      return result;
    }

    const result: number[] = new Array(state.length);
    for (let i = 0; i < state.length; i++) {
      result[i] = state[i] + (i < len ? alpha * (vector[i] ?? 0) : 0);
    }
    return result;
  }

  /**
   * Build result for no-steering path.
   * Hidden states are returned unmodified (deep copy for safety).
   */
  private buildNoSteeringResult(
    hiddenStates: Map<number, Float64Array | number[]>,
    bundleId: string,
  ): InjectionResult {
    const copied = new Map<number, Float64Array | number[]>();
    for (const [layerIdx, state] of hiddenStates) {
      copied.set(layerIdx, this.copyState(state));
    }

    return {
      hiddenStates: copied,
      metadata: {
        steeringApplied: false,
        activeLayers: [],
        effectiveMultipliers: {},
        vectorBundleId: bundleId,
        timestamp: new Date().toISOString(),
      },
    };
  }

  /**
   * Deep copy a state array.
   */
  private copyState(state: Float64Array | number[]): Float64Array | number[] {
    if (state instanceof Float64Array) {
      return new Float64Array(state);
    }
    return [...state];
  }
}
