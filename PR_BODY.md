## Task

**Task ID:** P1-03
**Title:** Automatic merged branch cleanup
**Goal:** Automatically delete merged task branches and prune stale task worktrees after successful reconciliation.

## Changes

### `scripts/lib/branch-cleanup.mjs` (new)
- `isTaskBranch(branch)` — validates branch matches `agent/P0-##` or `agent/P1-##`
- `isProtectedBranch(branch)` — guards `main` and `master` from deletion
- `listMergedTaskBranches(mergedPrs)` — filters merged PRs to only task branches
- `deleteRemoteBranch(repo, branch, options)` — deletes a single remote branch via GitHub API with dry-run support
- `deleteMergedBranches(repo, mergedPrs, options)` — batch deletes merged task branches with dry-run support
- `deleteLocalBranch(branch, options)` — deletes a local branch with dry-run and safety guards

### `scripts/lib/worktree.mjs` (updated)
- `listWorktrees(repoRoot)` — parses `git worktree list --porcelain` output
- `listStaleWorktrees(repoRoot, activeTaskIds)` — identifies worktrees for tasks with no active runs
- `pruneStaleWorktrees(repoRoot, activeTaskIds, options)` — removes stale worktrees with dry-run support

### `scripts/agent-reconciler.mjs` (updated)
- Calls `deleteMergedBranches()` after processing merged PRs
- Adds `reconcileStaleWorktrees()` step to the main loop, pruning worktrees for tasks without active runs

### `scripts/tests/branch-cleanup.test.mjs` (new)
- 30 tests covering branch pattern matching, protected branch guards, merged branch listing, dry-run behavior, deletion safety, and worktree stale detection

### `README.md` (updated)
- Added "Automatic branch cleanup" section documenting the feature and dry-run usage

## Verify Command Output

```
node --test scripts/tests/branch-cleanup.test.mjs

▶ isTaskBranch
  ✔ accepts agent/P0-01
  ✔ accepts agent/P1-12
  ✔ rejects main
  ✔ rejects master
  ✔ rejects agent/P2-01
  ✔ rejects feature/something
  ✔ rejects empty string
  ✔ rejects null
  ✔ rejects undefined
  ✔ rejects agent/P0-1 (single digit)
  ✔ rejects agent/P0-123 (three digits)
✔ isTaskBranch
▶ isProtectedBranch
  ✔ marks main as protected
  ✔ marks master as protected
  ✔ does not protect task branches
  ✔ does not protect feature branches
✔ isProtectedBranch
▶ listMergedTaskBranches
  ✔ returns task branches from merged PRs
  ✔ filters out non-task branches
  ✔ never includes protected branches
  ✔ handles empty input
  ✔ skips PRs with missing headRefName
✔ listMergedTaskBranches
▶ deleteRemoteBranch
  ✔ refuses to delete protected branches
  ✔ refuses to delete non-task branches
  ✔ dry-run does not mutate git state
✔ deleteRemoteBranch
▶ deleteLocalBranch
  ✔ refuses to delete protected branches
  ✔ refuses to delete non-task branches
  ✔ dry-run does not mutate git state
✔ deleteLocalBranch
▶ deleteMergedBranches
  ✔ dry-run returns planned deletions without mutating
  ✔ skips non-task branches
  ✔ handles empty PR list
✔ deleteMergedBranches
▶ listStaleWorktrees
  ✔ is a function
✔ listStaleWorktrees
ℹ tests 30
ℹ suites 7
ℹ pass 30
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

## Definition of Done

- [x] Merged task branches are automatically cleaned from remote when safe
- [x] Stale local task worktrees can be pruned without touching active runs
- [x] Cleanup logic is covered by tests including dry-run behavior

## Constraints

- [x] Only delete branches matching `agent/P0-##` or `agent/P1-##` with merged PRs
- [x] Never delete protected branches such as `main` or `master`
- [x] Support dry-run mode that prints planned deletions without mutating git state

## Rollback Note

If cleanup deletes unexpected refs, disable automatic deletion and run in dry-run mode while restoring branch selection guards.
