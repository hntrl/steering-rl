/**
 * Re-export test suite from steering-engine package.
 *
 * This file exists at the path specified in the P0-05 task contract.
 * The canonical test suite lives in services/steering-engine/tests/.
 *
 * Run via: pnpm test --filter steering-engine
 */
export {} from "../../steering-engine/tests/layer-injection.test.js";
