import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveNoChangesOutcome } from "../agent-worker.mjs";

// ---------------------------------------------------------------------------
// resolveNoChangesOutcome – unit tests
// ---------------------------------------------------------------------------

describe("resolveNoChangesOutcome", () => {
  // ----- clean worktree WITH ahead commits → ready_for_review -----

  it("returns ready_for_review when worktree is clean and branch has ahead commits", () => {
    const result = resolveNoChangesOutcome({
      hasChanges: false,
      commitsAhead: 3,
      existingPr: null,
    });
    assert.equal(result.outcome, "ready_for_review");
    assert.equal(result.commitsAhead, 3);
  });

  it("returns ready_for_review when worktree is clean and an existing PR exists", () => {
    const result = resolveNoChangesOutcome({
      hasChanges: false,
      commitsAhead: 0,
      existingPr: { number: 42, url: "https://github.com/test/repo/pull/42" },
    });
    assert.equal(result.outcome, "ready_for_review");
    assert.deepEqual(result.existingPr, {
      number: 42,
      url: "https://github.com/test/repo/pull/42",
    });
  });

  it("returns ready_for_review when both ahead commits and existing PR are present", () => {
    const result = resolveNoChangesOutcome({
      hasChanges: false,
      commitsAhead: 5,
      existingPr: { number: 10, url: "https://github.com/test/repo/pull/10" },
    });
    assert.equal(result.outcome, "ready_for_review");
    assert.equal(result.commitsAhead, 5);
    assert.equal(result.existingPr.number, 10);
  });

  // ----- clean worktree with NO ahead commits → no_changes -----

  it("returns no_changes when worktree is clean and no ahead commits exist", () => {
    const result = resolveNoChangesOutcome({
      hasChanges: false,
      commitsAhead: 0,
      existingPr: null,
    });
    assert.equal(result.outcome, "no_changes");
    assert.equal(result.commitsAhead, 0);
    assert.equal(result.existingPr, null);
  });

  // ----- dirty worktree → has_changes (normal commit flow) -----

  it("returns has_changes when working tree has modifications", () => {
    const result = resolveNoChangesOutcome({
      hasChanges: true,
      commitsAhead: 0,
      existingPr: null,
    });
    assert.equal(result.outcome, "has_changes");
  });

  it("returns has_changes even when ahead commits exist if worktree is dirty", () => {
    const result = resolveNoChangesOutcome({
      hasChanges: true,
      commitsAhead: 2,
      existingPr: { number: 7, url: "https://github.com/test/repo/pull/7" },
    });
    assert.equal(result.outcome, "has_changes");
  });
});

// ---------------------------------------------------------------------------
// Regression: previous behavior would have blocked clean+ahead worktrees
// ---------------------------------------------------------------------------

describe("regression: clean+ahead must not be treated as blocked", () => {
  it("clean worktree with ahead commits must NOT resolve to no_changes", () => {
    const result = resolveNoChangesOutcome({
      hasChanges: false,
      commitsAhead: 1,
      existingPr: null,
    });
    assert.notEqual(
      result.outcome,
      "no_changes",
      "Bug regression: clean worktree with ahead commits was previously blocked instead of review-ready",
    );
    assert.equal(result.outcome, "ready_for_review");
  });

  it("no_changes is only returned when there are zero ahead commits AND no existing PR", () => {
    const noChanges = resolveNoChangesOutcome({
      hasChanges: false,
      commitsAhead: 0,
      existingPr: null,
    });
    assert.equal(noChanges.outcome, "no_changes");

    const withCommits = resolveNoChangesOutcome({
      hasChanges: false,
      commitsAhead: 1,
      existingPr: null,
    });
    assert.equal(
      withCommits.outcome,
      "ready_for_review",
      "Any ahead commits should trigger ready_for_review, not no_changes",
    );

    const withPr = resolveNoChangesOutcome({
      hasChanges: false,
      commitsAhead: 0,
      existingPr: { number: 99, url: "https://github.com/test/repo/pull/99" },
    });
    assert.equal(
      withPr.outcome,
      "ready_for_review",
      "An existing PR should trigger ready_for_review, not no_changes",
    );
  });
});

// ---------------------------------------------------------------------------
// Event payload shape preservation
// ---------------------------------------------------------------------------

describe("resolveNoChangesOutcome preserves expected payload shape", () => {
  it("ready_for_review result contains commitsAhead and existingPr fields", () => {
    const result = resolveNoChangesOutcome({
      hasChanges: false,
      commitsAhead: 4,
      existingPr: { number: 15, url: "https://github.com/test/repo/pull/15" },
    });
    assert.ok("outcome" in result);
    assert.ok("commitsAhead" in result);
    assert.ok("existingPr" in result);
    assert.equal(typeof result.commitsAhead, "number");
    assert.equal(typeof result.existingPr, "object");
  });

  it("no_changes result contains commitsAhead and existingPr fields", () => {
    const result = resolveNoChangesOutcome({
      hasChanges: false,
      commitsAhead: 0,
      existingPr: null,
    });
    assert.ok("outcome" in result);
    assert.ok("commitsAhead" in result);
    assert.ok("existingPr" in result);
    assert.equal(result.commitsAhead, 0);
    assert.equal(result.existingPr, null);
  });

  it("has_changes result only contains outcome field", () => {
    const result = resolveNoChangesOutcome({
      hasChanges: true,
      commitsAhead: 0,
      existingPr: null,
    });
    assert.ok("outcome" in result);
    assert.ok(!("commitsAhead" in result));
    assert.ok(!("existingPr" in result));
  });
});
