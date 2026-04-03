## Task

**Task ID:** P1-02
**Title:** Reconciler canonical run-state cleanup
**Goal:** Make reconciliation collapse duplicate task runs into a canonical merged state so stale ready-for-review records do not linger.

## Changes

### `scripts/lib/state.mjs`
- Added `canonicalizeRuns(runs)` — pure function that collapses duplicate runs per task into a single canonical merged entry. Stale `ready_for_review` and `dispatched` runs are removed when a merged run exists. Prefers merged PR metadata for `merged_at`. Preserves unrelated task history (running, failed, etc.) untouched.
- Added `writeCanonicalizedRuns(stateDir)` — reads runs from disk, canonicalizes, and writes back.

### `scripts/agent-reconciler.mjs`
- Calls `writeCanonicalizedRuns()` at the end of each reconciliation loop, after merged PR and dead worker reconciliation.

### `scripts/agent-doctor.mjs`
- Applies `canonicalizeRuns()` to runs before computing status summary, so the doctor report reflects the canonical state (ready_for_review=0 for fully merged queues).

### `scripts/tests/reconciler-run-state.test.mjs`
- 9 tests covering: duplicate collapse, stale ready_for_review conversion, fully merged queue reporting, idempotency, unrelated entry preservation, merged_at metadata preference, dispatched run conversion, no-merged preservation, and empty input.

## Verify Command Output

```
node --test scripts/tests/reconciler-run-state.test.mjs

▶ canonicalizeRuns
  ✔ collapses duplicate merged runs into one canonical entry per task
  ✔ converts stale ready_for_review to merged when a merged run exists
  ✔ reports ready_for_review as zero for fully merged queues
  ✔ is idempotent across repeated runs
  ✔ does not mutate unrelated task history entries
  ✔ prefers merged PR metadata when normalizing merged_at
  ✔ converts stale dispatched runs to merged when a merged run exists
  ✔ preserves tasks with no merged runs unchanged
  ✔ handles empty runs array
✔ canonicalizeRuns
ℹ tests 9
ℹ pass 9
ℹ fail 0
```

## Definition of Done

- [x] Only one latest canonical run status remains for each merged task.
- [x] Doctor summary reports ready_for_review as zero after reconciliation for fully merged queues.
- [x] Reconciler tests cover duplicate-run normalization behavior.

## Constraints

- [x] Reconciliation is idempotent across repeated runs.
- [x] Unrelated task history entries are not mutated.
- [x] Merged PR metadata is preferred when normalizing status and merged_at fields.

## Rollback Note

If canonicalization causes incorrect history, disable normalization writes and run reconciler in read-only mode until state migration rules are corrected.
