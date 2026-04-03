/**
 * Export module for trained vector bundles.
 *
 * Converts TrainedBundle into formats directly resolvable by
 * the steering-engine VectorResolver and produces serializable
 * artifact metadata.
 */

import type {
  TrainedBundle,
  ConceptVector,
  PresetCalibrationTable,
} from "./train.js";

/**
 * Vector bundle in the format expected by steering-engine VectorResolver.
 * Matches the VectorBundle interface: { bundleId, vectors: Map<number, number[]> }
 */
export interface ResolvableVectorBundle {
  bundleId: string;
  vectors: Map<number, number[]>;
}

/**
 * Serializable representation of a vector bundle for storage/transport.
 */
export interface SerializedVectorBundle {
  bundleId: string;
  vectors: Record<string, number[]>;
}

/**
 * Complete artifact output from the export pipeline.
 */
export interface BundleArtifact {
  vector_bundle_id: string;
  model_revision: string;
  seed: number;
  base_model: string;
  created_at: string;
  concepts: string[];
  bundles: Record<string, SerializedVectorBundle>;
  preset_calibration: Record<string, PresetCalibrationTable>;
}

/**
 * Convert a TrainedBundle into per-concept ResolvableVectorBundles
 * that can be directly registered with the steering-engine VectorResolver.
 */
export function toResolvableBundles(
  trained: TrainedBundle,
): Map<string, ResolvableVectorBundle> {
  const grouped = new Map<string, ConceptVector[]>();

  for (const cv of trained.concepts) {
    let list = grouped.get(cv.conceptId);
    if (!list) {
      list = [];
      grouped.set(cv.conceptId, list);
    }
    list.push(cv);
  }

  const result = new Map<string, ResolvableVectorBundle>();

  for (const [conceptId, vectors] of grouped) {
    const vectorMap = new Map<number, number[]>();
    for (const cv of vectors) {
      vectorMap.set(cv.layerIndex, cv.values);
    }

    result.set(conceptId, {
      bundleId: `${trained.vectorBundleId}:${conceptId}`,
      vectors: vectorMap,
    });
  }

  return result;
}

/**
 * Serialize a ResolvableVectorBundle for JSON storage.
 */
export function serializeBundle(
  bundle: ResolvableVectorBundle,
): SerializedVectorBundle {
  const vectors: Record<string, number[]> = {};
  for (const [layer, values] of bundle.vectors) {
    vectors[String(layer)] = Array.from(values);
  }
  return {
    bundleId: bundle.bundleId,
    vectors,
  };
}

/**
 * Deserialize a stored bundle back to a ResolvableVectorBundle.
 */
export function deserializeBundle(
  serialized: SerializedVectorBundle,
): ResolvableVectorBundle {
  const vectors = new Map<number, number[]>();
  for (const [layer, values] of Object.entries(serialized.vectors)) {
    vectors.set(Number(layer), values);
  }
  return {
    bundleId: serialized.bundleId,
    vectors,
  };
}

/**
 * Export a TrainedBundle as a complete BundleArtifact.
 *
 * The artifact includes:
 * - vector_bundle_id, model_revision, seed metadata (required by constraints)
 * - Per-concept serialized vector bundles
 * - Preset calibration tables per concept
 */
export function exportArtifact(trained: TrainedBundle): BundleArtifact {
  const resolvable = toResolvableBundles(trained);
  const bundles: Record<string, SerializedVectorBundle> = {};
  const concepts: string[] = [];

  for (const [conceptId, bundle] of resolvable) {
    concepts.push(conceptId);
    bundles[conceptId] = serializeBundle(bundle);
  }

  concepts.sort();

  return {
    vector_bundle_id: trained.vectorBundleId,
    model_revision: trained.baseModelRevision,
    seed: trained.seed,
    base_model: trained.baseModel,
    created_at: trained.createdAt,
    concepts,
    bundles,
    preset_calibration: trained.presetCalibration,
  };
}

/**
 * Validate a BundleArtifact has all required fields and structural integrity.
 */
export function validateArtifact(artifact: BundleArtifact): string[] {
  const errors: string[] = [];

  if (!artifact.vector_bundle_id) {
    errors.push("Missing vector_bundle_id");
  }
  if (!artifact.model_revision) {
    errors.push("Missing model_revision");
  }
  if (artifact.seed === undefined || artifact.seed === null) {
    errors.push("Missing seed");
  }
  if (!artifact.base_model) {
    errors.push("Missing base_model");
  }
  if (!artifact.created_at) {
    errors.push("Missing created_at");
  }

  for (const conceptId of artifact.concepts) {
    if (!artifact.bundles[conceptId]) {
      errors.push(`Missing bundle for concept: ${conceptId}`);
    }
    if (!artifact.preset_calibration[conceptId]) {
      errors.push(`Missing preset calibration for concept: ${conceptId}`);
    }

    const bundle = artifact.bundles[conceptId];
    if (bundle) {
      if (!bundle.bundleId) {
        errors.push(`Bundle for ${conceptId} missing bundleId`);
      }
      const layerKeys = Object.keys(bundle.vectors);
      if (layerKeys.length === 0) {
        errors.push(`Bundle for ${conceptId} has no vectors`);
      }
    }

    const calibration = artifact.preset_calibration[conceptId];
    if (calibration) {
      for (const preset of ["low", "medium", "strong"] as const) {
        if (typeof calibration[preset] !== "number") {
          errors.push(
            `Preset calibration for ${conceptId} missing "${preset}"`,
          );
        }
      }
    }
  }

  return errors;
}
