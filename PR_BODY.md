Closes #28

## Goal

Ensure the worker treats clean worktrees with ahead commits as review-ready by creating or updating PRs instead of blocking issues.

## Changes

### `scripts/agent-worker.mjs`

- Extracted `resolveNoChangesOutcome()` — a pure function that decides the worker outcome when the working tree is clean:
  - `ready_for_review` when ahead commits or an existing PR exist
  - `no_changes` only when there are zero ahead commits AND no existing PR
  - `has_changes` when the worktree is dirty (delegates to normal commit flow)
- Exported `resolveNoChangesOutcome`, `countCommitsAheadOfBase`, `findTaskPr`, and `buildPrBody` for testability.
- Refactored `main()` to delegate the no-changes decision to `resolveNoChangesOutcome`.
- Guarded `main()` with `import.meta.url` check so the module can be imported in tests without triggering execution.

### `scripts/tests/agent-worker-no-changes.test.mjs` (new)

- 11 tests using Node.js built-in test runner (`node:test`):
  - **clean+ahead** → `ready_for_review` (3 variants: commits only, PR only, both)
  - **clean+not-ahead** → `no_changes`
  - **dirty worktree** → `has_changes` (2 variants)
  - **regression** — verifies clean+ahead does NOT resolve to `no_changes`
  - **payload shape** — verifies returned objects contain expected fields
- Zero live GitHub network calls.

## Verify command

```bash
node --test scripts/tests/agent-worker-no-changes.test.mjs
```

## Verify output

```text
▶ resolveNoChangesOutcome
  ✔ returns ready_for_review when worktree is clean and branch has ahead commits
  ✔ returns ready_for_review when worktree is clean and an existing PR exists
  ✔ returns ready_for_review when both ahead commits and existing PR are present
  ✔ returns no_changes when worktree is clean and no ahead commits exist
  ✔ returns has_changes when working tree has modifications
  ✔ returns has_changes even when ahead commits exist if worktree is dirty
✔ resolveNoChangesOutcome
▶ regression: clean+ahead must not be treated as blocked
  ✔ clean worktree with ahead commits must NOT resolve to no_changes
  ✔ no_changes is only returned when there are zero ahead commits AND no existing PR
✔ regression: clean+ahead must not be treated as blocked
▶ resolveNoChangesOutcome preserves expected payload shape
  ✔ ready_for_review result contains commitsAhead and existingPr fields
  ✔ no_changes result contains commitsAhead and existingPr fields
  ✔ has_changes result only contains outcome field
✔ resolveNoChangesOutcome preserves expected payload shape
ℹ tests 11
ℹ suites 3
ℹ pass 11
ℹ fail 0
```

## Rollback note

If this handoff path becomes unstable, disable branch-reuse PR handoff and fall back to manual PR creation while preserving run logs for triage.

## Task contract

- `tasks/P1-01.json`
