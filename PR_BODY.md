Closes #31

## Goal

Reduce merge conflict churn by adding branch-sync and lockfile conflict recovery rules to worker execution.

## Changes

### `scripts/lib/worktree.mjs`
- Added `hasConflictMarkers()` — detects conflicted files via `git diff --diff-filter=U`
- Added `isOnlyLockfileConflict()` — checks if conflicts are limited to `pnpm-lock.yaml`
- Added `resolveLockfileConflict()` — resolves lockfile conflicts by checking out upstream version and regenerating via `pnpm install --lockfile-only`
- Added `syncBranch()` — fetches and rebases onto base branch with automatic lockfile conflict recovery
- Exported `MAX_CONFLICT_RETRIES` (default: 3)

### `scripts/agent-worker.mjs`
- Integrated `syncBranch()` call before each agent run to keep branch current with base
- Emits `branch_sync` event with sync status and conflicted file details
- On successful lockfile recovery: emits `conflict_recovery` event and posts issue comment
- On unresolvable conflicts: retries up to `MAX_CONFLICT_RETRIES`, then marks issue `status:blocked` with actionable remediation steps
- Non-lockfile task changes are never discarded during conflict recovery

### `scripts/lib/events.mjs`
- Added `branch_sync` and `conflict_recovery` event types

### `scripts/tests/conflict-recovery.test.mjs`
- 20 regression tests covering: clean sync, fetch failure, lockfile-only resolution, non-lockfile conflict handling, pnpm install failure, rebase-without-conflicts failure, commit fallback, repeated-failure escalation, event type validation, and preservation of non-lockfile changes

### `README.md`
- Added "Conflict recovery" section documenting automatic resolution behavior and manual override

## Verify command

```bash
node --test scripts/tests/conflict-recovery.test.mjs
```

## Verify output

```text
▶ isOnlyLockfileConflict
  ✔ returns true when only pnpm-lock.yaml is conflicted (0.435ms)
  ✔ returns true for pnpm-lock.yml variant (0.064ms)
  ✔ returns false when non-lockfile files are present (0.045ms)
  ✔ returns false for empty file list (0.035ms)
  ✔ returns false when only non-lockfile files are present (0.046ms)
✔ isOnlyLockfileConflict (1.222ms)
▶ syncBranch — clean rebase
  ✔ returns clean status when rebase succeeds (0.113ms)
✔ syncBranch — clean rebase (0.160ms)
▶ syncBranch — fetch failure
  ✔ returns fetch_failed when fetch fails (0.149ms)
✔ syncBranch — fetch failure (0.584ms)
▶ syncBranch — lockfile conflict recovery
  ✔ resolves lockfile-only conflicts automatically (0.748ms)
  ✔ preserves non-lockfile changes during lockfile resolution (0.111ms)
✔ syncBranch — lockfile conflict recovery (0.933ms)
▶ syncBranch — non-lockfile conflict
  ✔ aborts rebase and reports non-lockfile conflicts (0.128ms)
✔ syncBranch — non-lockfile conflict (0.178ms)
▶ syncBranch — lockfile resolution failure
  ✔ returns failure when pnpm install fails (0.071ms)
✔ syncBranch — lockfile resolution failure (0.100ms)
▶ syncBranch — rebase fails without conflict markers
  ✔ returns rebase_failed and aborts (0.077ms)
✔ syncBranch — rebase fails without conflict markers (0.099ms)
▶ resolveLockfileConflict — commit fallback
  ✔ falls back to git commit --no-edit when rebase --continue fails (0.071ms)
✔ resolveLockfileConflict — commit fallback (0.089ms)
▶ repeated conflict failure escalation
  ✔ MAX_CONFLICT_RETRIES is set to 3 (0.037ms)
  ✔ escalation logic: attempt >= MAX_CONFLICT_RETRIES should trigger blocked (0.031ms)
  ✔ no escalation when attempt < MAX_CONFLICT_RETRIES (0.031ms)
✔ repeated conflict failure escalation (0.140ms)
▶ event types for conflict recovery
  ✔ branch_sync and conflict_recovery are valid event types (5.297ms)
✔ event types for conflict recovery (5.334ms)
▶ hasConflictMarkers
  ✔ returns conflicted=false when git diff returns empty (0.044ms)
  ✔ returns conflicted=true with file list (0.028ms)
  ✔ returns conflicted=false when git command fails (0.023ms)
✔ hasConflictMarkers (0.121ms)
ℹ tests 20
ℹ suites 11
ℹ pass 20
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 88.339
```

## Definition of done

- [x] Worker can recover from lockfile conflicts without manual intervention in common cases
- [x] Conflict recovery emits clear run events and issue comments
- [x] Regression tests cover successful recovery and repeated-failure escalation

## Constraints

- [x] When pnpm-lock.yaml conflicts, regenerate via `pnpm install --lockfile-only`
- [x] Do not discard non-lockfile task changes during conflict recovery
- [x] After repeated conflict failures, mark issue blocked with an actionable remediation comment

## Rollback note

If automated conflict recovery is unsafe, disable lockfile auto-resolution and fall back to manual conflict resolution workflow.

## Task contract

- `tasks/P1-04.json`
