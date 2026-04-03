## Task

**Task ID:** P2-02
**Title:** Gemma 4 Stage C multi-layer calibration sweep
**Goal:** Implement Stage C jobs that combine top Stage B layers into sparse multi-layer profiles and calibrate preset multipliers.

## Changes

### `jobs/sweeps/gemma4-stage-c.ts`
- Stage C multi-layer calibration sweep job
- Extracts top-K unique layers from Stage B challenger candidates
- Generates all k-combinations of sizes 3, 4, 5 from winner layers
- Evaluates each combination across low/medium/strong preset multiplier ranges
- Applies hard gates (degenerate_rate, coherence, correctness, language_stability, latency)
- Calibrates preset tables by selecting best multiplier per preset level per combination
- Ranks candidates by composite rank_score and emits top-10 with full profile bundles
- Profile bundles conform to the `contracts/schema/profile.json` schema
- Deterministic: uses Mulberry32 PRNG seeded by config seed + layer hash + multiplier
- CLI entry point reads Stage A/B artifacts, runs sweep, writes `gemma4-stage-c-result.json`

### `jobs/sweeps/tests/gemma4-stage-c.test.ts`
- 16 tests covering:
  - Config construction with seed control and model metadata
  - Config overrides and default values
  - `extractTopLayers` deduplication, sorting, and top-K limiting
  - Reproducibility (same seed + config = identical metrics and candidates)
  - Ranked multi-layer candidate generation
  - Preset table completeness and ordering (low < medium < strong)
  - Multi-layer sets (>= 3 layers, sorted ascending)
  - Profile bundle field validation
  - Output includes model revision, dataset version, selected layer sets
  - JSON-serializability for gate checker ingestion
  - Combination and hard gate tracking counters
  - Stage A/B reference linkage
  - Candidate layers sourced exclusively from Stage B winners

### `package.json`
- Added `sweep:gemma4:stageC` script (runs Stage A → B → C pipeline + Stage C tests)

### `artifacts/sweeps/README.md`
- Added Stage C documentation (sweep axes, hard gates, preset calibration, output format)
- Updated artifact table and gate checker compatibility section

## Verify Command Output

```
$ pnpm run sweep:gemma4:stageC

[Stage A] PASS — baseline complete.
[Stage B] Configurations tested: 228
[Stage B] Passed hard gates: 6
[Stage B] PASS — challenger candidates ready for Stage C.
[Stage C] Model: gemma-4-27b-it (rev 2026-06-01)
[Stage C] Dataset: steer-core-golden-v20260601
[Stage C] Seed: 20260601
[Stage C] Stage B candidates: 6
[Stage C] Top-K layers: 6
[Stage C] Combination sizes: 3, 4, 5
[Stage C] Combinations tested: 9
[Stage C] Passed hard gates: 8
[Stage C] Multi-layer candidates: 1
[Stage C] Top multi-layer candidates:
  #1 layers=[35,41,47] preset_table={low:0.12,med:0.26,strong:0.35}
     rank_score=0.8362 coherence=0.9163 adherence=0.7227 degen=0
[Stage C] PASS — multi-layer candidates ready for Stage D.

16 tests: 16 passed, 0 failed
```

## Definition of Done

- [x] Stage C produces ranked multi-layer candidates with preset tables
- [x] Output artifact includes model revision, dataset version, and selected layer sets
- [x] Stage C run is reproducible from committed config and seed values

## Constraints

- [x] Use deterministic seeds and persist config used for each candidate
- [x] Build multi-layer candidates from Stage B passing layers only
- [x] Emit profile bundles consumable by Stage D and canary routing

## Rollback Note

If Stage C quality regresses, freeze Stage B winners as temporary challengers and defer multi-layer promotion until calibration is corrected.
