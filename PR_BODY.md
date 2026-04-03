## Task

**Task ID:** P2-05
**Title:** Vector trainer service for calibration artifacts
**Goal:** Add a vector-trainer service that produces versioned concept vector bundles and preset calibration tables from training corpora.

## Changes

### `services/vector-trainer/src/train.ts`
- Deterministic training pipeline using seeded PRNG (xoshiro128**)
- Computes concept activation vectors (CAV) via mean-difference method per layer
- Normalizes vectors to unit norm and calibrates preset multipliers per `effective_strength ~= alpha * ||v||`
- Generates versioned bundle IDs encoding date and seed hex
- Outputs `TrainedBundle` with `vectorBundleId`, `baseModelRevision`, `seed`, concept vectors, and per-concept `PresetCalibrationTable`

### `services/vector-trainer/src/export.ts`
- `toResolvableBundles()` — converts trained output to `ResolvableVectorBundle` format directly compatible with steering-engine `VectorResolver.registerBundle()`
- `serializeBundle()` / `deserializeBundle()` — JSON-safe roundtrip serialization
- `exportArtifact()` — produces complete `BundleArtifact` with `vector_bundle_id`, `model_revision`, `seed` metadata, per-concept bundles, and preset calibration tables
- `validateArtifact()` — structural validation of artifact integrity

### `services/vector-trainer/src/index.ts`
- Public API re-exporting all types and functions from train and export modules

### `services/vector-trainer/tests/vector-trainer.test.ts`
- 28 tests covering:
  - SeededRng determinism, range, and cross-seed divergence
  - Training determinism for same corpus + seed
  - Bundle metadata (vector_bundle_id, model revision, seed)
  - Concept vector generation across all target layers
  - Vector normalization (unit norm)
  - Preset calibration table generation and ordering
  - Multi-concept training runs
  - Resolvable bundle format compatibility with VectorResolver
  - Serialization roundtrip integrity
  - Artifact schema validation
  - End-to-end determinism: train → export → serialize → deserialize

### `services/vector-trainer/package.json`, `tsconfig.json`, `vitest.config.ts`
- Service scaffolding following existing patterns (steering-engine)

## Verify Command Output

```
$ pnpm test --filter vector-trainer

> vector-trainer@0.1.0 test
> vitest run

 RUN  v3.2.4

 ✓ tests/vector-trainer.test.ts (28 tests) 16ms

 Test Files  1 passed (1)
      Tests  28 passed (28)
   Start at  01:11:06
   Duration  327ms (transform 38ms, setup 0ms, collect 36ms, tests 16ms, environment 0ms, prepare 52ms)
```

## Definition of Done

- [x] Vector trainer emits versioned bundle artifacts and preset calibration tables
- [x] Generated artifacts pass schema validation and resolve in runtime tests
- [x] Training/export behavior is covered by deterministic unit tests

## Constraints

- [x] Artifact output includes `vector_bundle_id`, model revision, and seed metadata
- [x] Training pipeline is deterministic for the same dataset and seed
- [x] Export format is directly resolvable by steering-engine vector resolver

## Rollback Note

If training artifacts are unstable, pin runtime to previous vector bundle IDs and disable automatic bundle promotion.
