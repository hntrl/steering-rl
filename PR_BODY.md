## Task

**Task ID:** P0-06
**Title:** Runtime guardrails and backoff ladder
**Goal:** Detect degeneration and apply safe backoff transitions within a single request.

## Changes

### `services/steering-inference-api/src/guardrails/detector.ts`
- Detects three degeneration signals: **repetition loops** (n-gram frequency), **language shift** (non-Latin character ratio), **entropy collapse** (unique token ratio)
- Configurable thresholds via `DetectorConfig`

### `services/steering-inference-api/src/guardrails/backoff-policy.ts`
- Implements backoff ladder: `strong → medium → low → single-layer → off (no-steering)`
- Scoped to active request context only — no global state mutation
- Bounded by `maxBackoffSteps` — no infinite retry loops
- Emits `TelemetryEvent` for each backoff step
- `buildPostBackoffMetadata()` produces run metadata with active layers, preset, multiplier, and guardrail event trail

### `services/steering-inference-api/tests/guardrails.test.ts`
- 19 tests covering all detector signals, full/partial backoff sequences, telemetry emission, max-step bounds, and post-backoff metadata

## Verify Command Output

```
pnpm test --filter steering-guardrails

 ✓ tests/guardrails.test.ts (19 tests) 5ms

 Test Files  1 passed (1)
      Tests  19 passed (19)
   Duration  416ms
```

## Definition of Done

- [x] Guardrail fixtures trigger expected backoff sequence
- [x] Final metadata reflects post-backoff active layers
- [x] Fallback to no-steering mode is supported

## Constraints

- [x] Backoff applies only to active request context
- [x] No infinite retry loops (bounded by maxBackoffSteps)
- [x] Emit telemetry for each backoff step

## Rollback Note

If guardrails are overly aggressive, revert to monitor-only mode while preserving telemetry emission.
