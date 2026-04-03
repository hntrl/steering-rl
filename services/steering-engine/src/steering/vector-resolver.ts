import type {
  VectorBundle,
  SteeringProfile,
  PresetLevel,
  InjectionConfig,
  LayerMultiplier,
} from "./types.js";

/**
 * Resolves steering vectors and builds injection configs from profiles.
 *
 * The VectorResolver is responsible for:
 * 1. Loading vector bundles by ID.
 * 2. Resolving preset levels to multiplier values.
 * 3. Building complete InjectionConfig from a profile + preset.
 */
export class VectorResolver {
  private bundles: Map<string, VectorBundle> = new Map();

  /**
   * Register a vector bundle for resolution.
   * In production this would load from a vector store / registry.
   */
  registerBundle(bundle: VectorBundle): void {
    this.bundles.set(bundle.bundleId, bundle);
  }

  /**
   * Resolve a vector bundle by ID.
   * @throws Error if bundle is not found.
   */
  resolveBundle(bundleId: string): VectorBundle {
    const bundle = this.bundles.get(bundleId);
    if (!bundle) {
      throw new Error(`Vector bundle not found: ${bundleId}`);
    }
    return bundle;
  }

  /**
   * Resolve a preset level to a multiplier value using a profile's preset table.
   * @throws Error if preset is not defined in profile.
   */
  resolvePreset(profile: SteeringProfile, preset: PresetLevel): number {
    const multiplier = profile.presetTable[preset];
    if (multiplier === undefined) {
      throw new Error(
        `Preset "${preset}" not defined in profile ${profile.profileId}`,
      );
    }
    return multiplier;
  }

  /**
   * Build a complete InjectionConfig from a profile, preset, and optional overrides.
   *
   * @param profile - The steering profile to use.
   * @param preset - The preset intensity level.
   * @param options - Optional overrides.
   * @param options.enabled - Feature flag override (default: true).
   * @param options.layerSubset - Restrict injection to a subset of profile layers.
   * @param options.perLayerMultipliers - Per-layer multiplier overrides.
   */
  buildInjectionConfig(
    profile: SteeringProfile,
    preset: PresetLevel,
    options: {
      enabled?: boolean;
      layerSubset?: number[];
      perLayerMultipliers?: LayerMultiplier[];
    } = {},
  ): InjectionConfig {
    const uniformMultiplier = this.resolvePreset(profile, preset);

    let targetLayers = profile.layers;
    if (options.layerSubset) {
      targetLayers = options.layerSubset.filter((l) =>
        profile.layers.includes(l),
      );
      if (targetLayers.length === 0) {
        throw new Error(
          "No valid layers in subset — none match profile layers",
        );
      }
    }

    return {
      targetLayers,
      uniformMultiplier,
      perLayerMultipliers: options.perLayerMultipliers,
      enabled: options.enabled ?? true,
    };
  }
}
