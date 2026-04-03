/**
 * Re-export from steering-engine package.
 *
 * This module exists at the path specified in the P0-05 task contract.
 * The canonical implementation lives in services/steering-engine/.
 */
export { LayerInjectionEngine } from "../../../steering-engine/src/steering/layer-injection.js";
export type {
  InjectionConfig,
  InjectionResult,
  InjectionMetadata,
} from "../../../steering-engine/src/steering/types.js";
