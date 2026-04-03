## Task

**Task ID:** P3-01
**Title:** Live canary rollout controller
**Goal:** Promote challenger profiles with live traffic phases and strict automatic rollback policies using production metrics.

## Changes

### New files

- **`services/canary-router/src/controller.ts`** — `CanaryController` class that orchestrates phased traffic rollout (10% → 50% → 100%) with automatic rollback, kill switch, runtime config updates (no redeploy), freeze mode, and machine-readable event emission for all lifecycle actions.
- **`services/canary-router/tests/controller.test.ts`** — 35 unit tests covering phase progression, auto-advance, rollback on degenerate_rate/p95_latency_ms/error_rate breaches, kill switch, runtime config, freeze/unfreeze, event listener management, and full lifecycle integration.
- **`services/canary-router/tests/live-rollout-simulation.test.ts`** — 9 simulation tests validating traffic distribution per phase, rollback decision latency SLA (p95 < 5ms under 500-sample load), automatic rollback behavior, kill switch routing, and complete event audit trail.

### Modified files

- **`services/canary-router/src/index.ts`** — Added controller exports (`CanaryController`, `CanaryControllerConfig`, `ControllerEvent`, etc.).
- **`services/canary-router/tests/canary-simulation.ts`** — Extended simulation with 3 new controller scenarios (auto-advance lifecycle, rollback latency SLA, runtime config update).
- **`services/canary-router/package.json`** — Updated package name to `canary-router` to match verify filter.
- **`package.json`** — Updated `canary:simulation` script filter to match new package name.
- **`README.md`** — Added Live Canary Rollout Controller documentation section.

## Verify Command Output

```
$ pnpm test --filter canary-router

 ✓ tests/controller.test.ts (35 tests) 6ms
 ✓ tests/canary-router.test.ts (31 tests) 12ms
 ✓ tests/live-rollout-simulation.test.ts (9 tests) 26ms

 Test Files  3 passed (3)
      Tests  75 passed (75)

$ pnpm run canary:simulation

=== Canary Router Simulation ===

--- Scenario 1: Happy-path rollout (10 → 50 → 100) ---
  Phase 10%: challenger=116/1000 (11.6%) ✓
  Phase 50%: challenger=480/1000 (48.0%) ✓
  Phase 100%: challenger=1000/1000 (100.0%) ✓

--- Scenario 2: Auto-rollback on degenerate_rate breach ---
  Rollback triggered: true (metric=degenerate_rate, value=0.08, threshold=0.03)
  All traffic to champion after rollback: 100/100 ✓
  Phase advance blocked during rollback: true ✓

--- Scenario 3: Kill switch disables all steering ---
  Kill switch active — no steering: 100/100 ✓
  Kill switch disabled — steering restored: true ✓

--- Scenario 4: Recovery after rollback reset ---
  Rollback reset — phase back to: 10%
  Can route to challenger again: true ✓

--- Scenario 5: CanaryController — phase progression with events ---
  Auto-advance 10% → 50%: true (phase=50%) ✓
  Auto-advance 50% → 100%: true (phase=100%) ✓
  Phase advance events: 2 ✓
  Rollout complete event: true ✓

--- Scenario 6: Controller rollback + latency SLA ---
  Rollback triggered: true (latency=0.009ms) ✓
  Latency within SLA (<5ms): true ✓
  Rollback event emitted: true ✓

--- Scenario 7: Runtime config update ---
  Config updated: championProfileId=new-champ ✓
  Config event emitted: true ✓

✅ All simulation scenarios PASSED
```

## Definition of Done

- [x] Controller supports phase progression 10/50/100 with runtime config updates.
- [x] Rollback decision latency meets SLA under simulation tests (p95 < 5ms).
- [x] Controller emits machine-readable events for phase changes and rollback actions.

## Constraints

- [x] Rollout phase changes must be configurable without redeploy.
- [x] Rollback must trigger on degenerate rate, p95 latency, and error-rate thresholds.
- [x] Kill switch must always route to baseline no-steering path.

## Rollback Note

If controller logic is unstable, freeze rollout at champion-only routing and disable automatic phase advancement.
