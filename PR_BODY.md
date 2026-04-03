## Task

**Task ID:** P3-02
**Title:** Shadow traffic parity gate
**Goal:** Evaluate challenger responses in shadow mode and block rollout when parity or hard-gate thresholds regress.

## Changes

### New files

- **`services/steering-inference-api/src/shadow-runner.ts`** — `ShadowRunner` class that executes champion and challenger adapters on mirrored traffic samples. Champion response is always returned to the caller (shadow mode never affects user-visible payloads). Supports configurable sample rates, challenger timeouts, and structured telemetry events (`shadow_execution_complete`, `shadow_execution_error`, `shadow_sample_skipped`).
- **`services/eval-orchestrator/src/shadow-parity.ts`** — `ParityGate` class that evaluates challenger parity against champion across shadow samples. Computes per-metric deltas with confidence intervals, evaluates regression tolerance verdicts, integrates hard gate checks, stores results by experiment ID for auditability, and exposes `canAdvanceRollout()` as a rollout precondition.
- **`services/eval-orchestrator/tests/shadow-parity.test.ts`** — 39 tests covering metric aggregation, delta computation, confidence intervals, parity verdicts, hard gate integration, sample size requirements, machine-readable verdicts, auditability/storage, rollout preconditions, telemetry events, and regression tolerance configuration.

### Modified files

- **`services/eval-orchestrator/package.json`** — Renamed package from `experiment-gates` to `eval-orchestrator` to match the verify command filter.
- **`README.md`** — Added Shadow Traffic Parity Gate documentation section covering shadow runner and parity gate usage.

## Verify Command Output

```
$ pnpm test --filter eval-orchestrator

> eval-orchestrator@0.0.1 test
> vitest run

 RUN  v3.2.4

 ✓ tests/shadow-parity.test.ts (39 tests) 6ms
 ✓ tests/gate-checker.test.ts (40 tests) 5ms

 Test Files  2 passed (2)
      Tests  79 passed (79)
   Duration  332ms
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

- [x] Shadow runner executes champion and challenger on mirrored traffic samples.
- [x] Parity gate emits pass/fail verdicts with machine-readable reasons.
- [x] Rollout path can consume parity verdicts as a precondition for phase advancement.

## Constraints

- [x] Shadow mode must never affect user-visible response payloads.
- [x] Parity gate output must include per-metric deltas and confidence intervals.
- [x] Store parity results with experiment IDs for auditability.

## Rollback Note

If shadow runner causes overhead or instability, disable mirrored challenger execution and retain static gate checks.
