## Task

**Task ID:** P3-05
**Title:** Cost and quota guardrails
**Goal:** Enforce per-route token budgets and request quotas so production traffic cannot exceed cost or safety envelopes.

## Changes

### New files

- **`services/steering-inference-api/src/guardrails/cost-policy.ts`** — `CostPolicy` class that enforces per-route token budgets and request quotas with rolling-window tracking. Supports per-model and per-profile budget overrides with specificity-based resolution, soft-limit warnings, deterministic hard-limit rejections (429 with Retry-After), runtime config updates, and structured telemetry event emission for all policy decisions.
- **`services/steering-inference-api/tests/cost-policy.test.ts`** — 23 unit tests covering basic budget checks, soft-limit warnings (token and request thresholds), hard-limit rejections with deterministic retry guidance, warning-only mode (hard limits disabled), per-model/per-profile/combined overrides, telemetry event emission, and runtime configuration updates.
- **`services/canary-router/src/budget-hooks.ts`** — `BudgetHooks` class that connects budget breach signals from the inference path to the rollout controller. Warning signals are recorded as telemetry; breach signals freeze the controller (halt phase progression) after a configurable threshold, with optional rollback-on-breach mode.
- **`services/canary-router/tests/budget-hooks.test.ts`** — 18 unit tests covering warning signal handling, breach-triggered freeze behavior, breach count thresholds, rollback-on-breach mode, reset/unfreeze, telemetry event structure, and runtime config updates.

### Modified files

- **`services/steering-inference-api/vitest.config.ts`** — Added `tests/cost-policy.test.ts` to the test include list.
- **`services/canary-router/src/index.ts`** — Added `BudgetHooks` exports (`BudgetHooks`, `BudgetHookConfig`, `BudgetSignal`, etc.).
- **`README.md`** — Added Cost and Quota Guardrails documentation section.

## Verify Command Output

```
$ pnpm test --filter steering-inference-api && pnpm test --filter canary-router

steering-inference-api:
 ✓ tests/cost-policy.test.ts (23 tests) 4ms
 ✓ tests/guardrails.test.ts (19 tests) 5ms
 ✓ tests/chat-completions.test.ts (47 tests) 61ms

 Test Files  3 passed (3)
      Tests  89 passed (89)

canary-router:
 ✓ tests/controller.test.ts (35 tests) 5ms
 ✓ tests/budget-hooks.test.ts (18 tests) 4ms
 ✓ tests/canary-router.test.ts (31 tests) 11ms
 ✓ tests/live-rollout-simulation.test.ts (9 tests) 30ms

 Test Files  4 passed (4)
      Tests  93 passed (93)
```

## Definition of Done

- [x] Inference path enforces token and cost budgets before provider execution.
- [x] Rollout controller receives budget breach signals and can halt phase progression.
- [x] Budget policy tests cover soft-limit warnings and hard-limit rejection behavior.

## Constraints

- [x] Guardrails must support per-model and per-profile budget overrides.
- [x] Over-budget requests must return deterministic errors with retry guidance.
- [x] Policy decisions must be emitted as telemetry events for auditing.

## Rollback Note

If budget enforcement blocks valid traffic unexpectedly, disable hard limits and retain warning-only telemetry until policy thresholds are corrected.
