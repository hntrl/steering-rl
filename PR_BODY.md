## Task

**Task ID:** P2-03
**Title:** Gemma 4 Stage D champion-challenger bake-off
**Goal:** Run Stage D head-to-head experiments and emit machine-readable promotion decisions for Gemma 4 challengers versus current champion.

## Changes

### New files

- **`jobs/sweeps/gemma4-stage-d.ts`** — Stage D champion-challenger sweep. Takes Stage C multi-layer candidates, runs each head-to-head against the champion, applies hard gates first (fail closed on missing metrics), then computes weighted rank scores to emit `promote` or `hold` decisions. Decision artifacts include experiment IDs, evidence bundle IDs, hard-gate reasons, rank component breakdowns, and scores.
- **`jobs/sweeps/tests/gemma4-stage-d.test.ts`** — 32 tests covering config construction, fail-closed metric validation, hard gate evaluation, rank scoring, and full bake-off execution with reproducibility checks.
- **`artifacts/sweeps/gemma4-stage-d-decision.json`** — Generated decision artifact with all required fields.

### Modified files

- **`services/eval-orchestrator/src/gate-checker.ts`** — Added `validateMetricsPresent()` function that fails closed when required metrics are missing (null, undefined, NaN, or non-numeric).
- **`services/eval-orchestrator/src/types.ts`** — Added `MetricsValidationResult` interface.
- **`services/eval-orchestrator/tests/gate-checker.test.ts`** — Added 8 tests for `validateMetricsPresent` covering missing, null, NaN, undefined, and non-numeric values.
- **`package.json`** — Added `sweep:gemma4:stageD` script.

## Verify Command Output

```
$ pnpm run sweep:gemma4:stageD

[Stage A] PASS — baseline complete.
[Stage B] PASS — 6 challenger candidates ready for Stage C.
[Stage C] PASS — 1 multi-layer candidate ready for Stage D.
[Stage D] Model: gemma-4-27b-it (rev 2026-06-01)
[Stage D] Dataset: steer-core-golden-v20260601
[Stage D] Seed: 20260601
[Stage D] Suite: core
[Stage D] Stage C candidates: 1
[Stage D] Champion: steer-gemma4-baseline-champion
[Stage D] Total challengers: 1
[Stage D] Passed hard gates: 1
[Stage D] Promoted: 0
[Stage D] Held: 1
[Stage D] Decisions:
  HOLD steer-gemma4-L35-L41-L47-multilayer-candidate
    rank_score=0.8283 champion_rank_score=0.8580 gates_passed=true
[Stage D] PASS — promotion decisions emitted.

Stage D tests: 32 passed, 0 failed

$ pnpm test --filter experiment-gates

gate-checker.test.ts: 40 tests passed (32 existing + 8 new validateMetricsPresent)

$ pnpm verify

Structure: verified
JSON: 24 files validated
Tasks: 23 contracts validated
Contracts: lint passed, 6 schema tests passed
```

## Definition of Done

- [x] Stage D produces explicit promote or hold decision artifacts
- [x] Decision output includes hard-gate reasons and rank component breakdown
- [x] Champion and challenger comparisons are reproducible from stored artifacts

## Constraints

- [x] Apply hard gates before weighted rank comparisons
- [x] Record evidence bundle IDs and experiment IDs in decision artifacts
- [x] Fail closed when required metrics are missing

## Rollback Note

If Stage D decisioning is inconsistent, lock promotion decisions to hold and require manual review using raw experiment metrics.
