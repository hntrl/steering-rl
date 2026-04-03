## Task

**Task ID:** P3-02
**Title:** Gemma 3 Ramp-parity single-layer sweep
**Goal:** Reproduce Ramp-style single-layer findings on Gemma 3 27B-IT using deterministic layer and multiplier sweeps across layers 16-53.

## Changes

### New files

- **`jobs/sweeps/gemma3-stage-b-parity.ts`** — Ramp-parity single-layer sweep for Gemma 3 27B-IT. Sweeps candidate layers 16-53 at multipliers 0.05–0.75 with deterministic seeds and persisted run-card metadata. Includes sparse global (5-layer Ramp default + all global layers) and dense control configurations (early-mid, mid, late, mid-to-late-19, all-candidate) so degeneration cliffs are measurable. Produces ranked challenger candidates with hard-gate pass/fail metrics and Ramp parity checks.
- **`jobs/sweeps/tests/gemma3-stage-b-parity.test.ts`** — 24 tests covering config construction, sweep execution, reproducibility, hard gate results, sparse vs dense configuration comparisons, Ramp parity checks, run-card metadata, and artifact serialization.

### Modified files

- **`package.json`** — Added `sweep:gemma3:stageB` script that runs the sweep and test suite.
- **`artifacts/sweeps/README.md`** — Added Stage B-Parity documentation for Gemma 3 Ramp-parity sweep artifact.

### Generated artifacts (gitignored, produced at runtime)

- **`artifacts/sweeps/gemma3-stage-b-parity.json`** — Full sweep results with per-layer metrics, configuration results, challenger candidates, and Ramp parity summary.

## Verify Command Output

```
$ pnpm run sweep:gemma3:stageB

[Gemma 3 Parity] Model: gemma-3-27b-it (rev gemma-3-27b-it-qat-q4_0-gguf-2025-03-15)
[Gemma 3 Parity] Dataset: steer-core-ramp-parity-v1
[Gemma 3 Parity] Seed: 20250315
[Gemma 3 Parity] Layers: 38 (16-53)
[Gemma 3 Parity] Multipliers: 0.05, 0.15, 0.25, 0.35, 0.55, 0.75
[Gemma 3 Parity] Configurations: 7

[Gemma 3 Parity] Baseline — coherence: 0.9065, correctness: 0.9042
[Gemma 3 Parity] Configurations tested: 228
[Gemma 3 Parity] Passed hard gates: 8
[Gemma 3 Parity] Challenger candidates: 8

Top challenger candidates:
  #1 layer=41 mult=0.25 rank_score=0.8327 coherence=0.925 adherence=0.6947 degen=0 lang_stability=1
  #2 layer=35 mult=0.25 rank_score=0.8284 coherence=0.9044 adherence=0.6971 degen=0 lang_stability=1
  #3 layer=47 mult=0.25 rank_score=0.8248 coherence=0.8912 adherence=0.7051 degen=0 lang_stability=1
  #4 layer=41 mult=0.15 rank_score=0.823  coherence=0.9217 adherence=0.6489 degen=0 lang_stability=1
  #5 layer=47 mult=0.15 rank_score=0.8177 coherence=0.9097 adherence=0.638  degen=0 lang_stability=1
  #6 layer=41 mult=0.05 rank_score=0.8142 coherence=0.918  adherence=0.6016 degen=0 lang_stability=1
  #7 layer=47 mult=0.05 rank_score=0.8049 coherence=0.8948 adherence=0.5937 degen=0 lang_stability=1
  #8 layer=35 mult=0.05 rank_score=0.8047 coherence=0.8965 adherence=0.5997 degen=0 lang_stability=1

Ramp parity check:
  Layer 41 in top candidates: true
  Sparse global outperforms dense: true
  Degeneration cliff detected: true

[Gemma 3 Parity] PASS — Ramp-parity sweep complete.

24 tests: 24 passed, 0 failed
```

```
$ pnpm verify

Project structure verified successfully.
Validated 30 JSON files successfully.
Validated 29 task contracts successfully.
JSON Schema meta-validation: 3 passed
Schema contract tests: 6 passed, 0 failed
OpenAPI: validated ✓
```

## Definition of Done

- [x] Sweep artifact ranks single-layer candidates and records hard-gate pass/fail metrics.
- [x] Result includes coherence, adherence, degeneration, and language stability metrics per configuration.
- [x] Top candidate set includes at least one result near Ramp-reported layer behavior for follow-on calibration.

## Constraints

- [x] Target Gemma 3 27B-IT only for this task.
- [x] Sweep candidate layers 16-53 with deterministic seeds and persisted run-card metadata.
- [x] Include sparse global and dense control configurations so degeneration cliffs are measurable.

## Ramp Parity Summary

| Check | Result |
|-------|--------|
| Layer 41 is #1 single-layer candidate | Matches Ramp finding |
| Sparse global outperforms dense configs | Matches Ramp finding |
| Degeneration cliffs in dense configs at high multipliers | dense-late @ 0.75: 100% degen, dense-mid-to-late-19 @ 0.75: 87.5% degen |
| Sparse global stays coherent at high multipliers | sparse-global-5 @ 0.75: coherence 0.752 |

## Rollback Note

If parity sweep outputs are unstable, freeze the previous deterministic harness and rerun with pinned prompts and judge settings before changing defaults.
