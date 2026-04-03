/**
 * Re-export from steering-engine package.
 *
 * This module exists at the path specified in the P0-05 task contract.
 * The canonical implementation lives in services/steering-engine/.
 */
export { VectorResolver } from "../../../steering-engine/src/steering/vector-resolver.js";
export type {
  VectorBundle,
  SteeringProfile,
  PresetLevel,
} from "../../../steering-engine/src/steering/types.js";
