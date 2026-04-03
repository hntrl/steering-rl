import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  isTaskBranch,
  isProtectedBranch,
  listMergedTaskBranches,
  deleteMergedBranches,
  deleteRemoteBranch,
  deleteLocalBranch,
} from "../lib/branch-cleanup.mjs";
import {
  listStaleWorktrees,
} from "../lib/worktree.mjs";

describe("isTaskBranch", () => {
  it("accepts agent/P0-01", () => {
    assert.equal(isTaskBranch("agent/P0-01"), true);
  });

  it("accepts agent/P1-12", () => {
    assert.equal(isTaskBranch("agent/P1-12"), true);
  });

  it("rejects main", () => {
    assert.equal(isTaskBranch("main"), false);
  });

  it("rejects master", () => {
    assert.equal(isTaskBranch("master"), false);
  });

  it("accepts agent/P2-01", () => {
    assert.equal(isTaskBranch("agent/P2-01"), true);
  });

  it("accepts agent/P3-01", () => {
    assert.equal(isTaskBranch("agent/P3-01"), true);
  });

  it("rejects agent/P4-01", () => {
    assert.equal(isTaskBranch("agent/P4-01"), false);
  });

  it("rejects feature/something", () => {
    assert.equal(isTaskBranch("feature/something"), false);
  });

  it("rejects empty string", () => {
    assert.equal(isTaskBranch(""), false);
  });

  it("rejects null", () => {
    assert.equal(isTaskBranch(null), false);
  });

  it("rejects undefined", () => {
    assert.equal(isTaskBranch(undefined), false);
  });

  it("rejects agent/P0-1 (single digit)", () => {
    assert.equal(isTaskBranch("agent/P0-1"), false);
  });

  it("rejects agent/P0-123 (three digits)", () => {
    assert.equal(isTaskBranch("agent/P0-123"), false);
  });
});

describe("isProtectedBranch", () => {
  it("marks main as protected", () => {
    assert.equal(isProtectedBranch("main"), true);
  });

  it("marks master as protected", () => {
    assert.equal(isProtectedBranch("master"), true);
  });

  it("does not protect task branches", () => {
    assert.equal(isProtectedBranch("agent/P0-01"), false);
  });

  it("does not protect feature branches", () => {
    assert.equal(isProtectedBranch("feature/x"), false);
  });
});

describe("listMergedTaskBranches", () => {
  it("returns task branches from merged PRs", () => {
    const prs = [
      { headRefName: "agent/P0-01", number: 10, mergedAt: "2024-01-01T00:00:00Z" },
      { headRefName: "agent/P1-05", number: 20, mergedAt: "2024-01-02T00:00:00Z" },
      { headRefName: "agent/P2-03", number: 30, mergedAt: "2024-01-03T00:00:00Z" },
      { headRefName: "agent/P3-04", number: 40, mergedAt: "2024-01-04T00:00:00Z" },
    ];
    const result = listMergedTaskBranches(prs);
    assert.equal(result.length, 4);
    assert.equal(result[0].branch, "agent/P0-01");
    assert.equal(result[0].prNumber, 10);
    assert.equal(result[1].branch, "agent/P1-05");
    assert.equal(result[1].prNumber, 20);
    assert.equal(result[2].branch, "agent/P2-03");
    assert.equal(result[2].prNumber, 30);
    assert.equal(result[3].branch, "agent/P3-04");
    assert.equal(result[3].prNumber, 40);
  });

  it("filters out non-task branches", () => {
    const prs = [
      { headRefName: "agent/P0-01", number: 10, mergedAt: "2024-01-01T00:00:00Z" },
      { headRefName: "feature/foo", number: 11, mergedAt: "2024-01-01T00:00:00Z" },
      { headRefName: "main", number: 12, mergedAt: "2024-01-01T00:00:00Z" },
    ];
    const result = listMergedTaskBranches(prs);
    assert.equal(result.length, 1);
    assert.equal(result[0].branch, "agent/P0-01");
  });

  it("never includes protected branches", () => {
    const prs = [
      { headRefName: "main", number: 1, mergedAt: "2024-01-01T00:00:00Z" },
      { headRefName: "master", number: 2, mergedAt: "2024-01-01T00:00:00Z" },
    ];
    const result = listMergedTaskBranches(prs);
    assert.equal(result.length, 0);
  });

  it("handles empty input", () => {
    assert.deepEqual(listMergedTaskBranches([]), []);
    assert.deepEqual(listMergedTaskBranches(null), []);
    assert.deepEqual(listMergedTaskBranches(undefined), []);
  });

  it("skips PRs with missing headRefName", () => {
    const prs = [
      { number: 10, mergedAt: "2024-01-01T00:00:00Z" },
      { headRefName: "", number: 11, mergedAt: "2024-01-01T00:00:00Z" },
    ];
    const result = listMergedTaskBranches(prs);
    assert.equal(result.length, 0);
  });
});

describe("deleteRemoteBranch", () => {
  it("refuses to delete protected branches", () => {
    assert.throws(
      () => deleteRemoteBranch("owner/repo", "main"),
      /Refusing to delete protected branch/,
    );
    assert.throws(
      () => deleteRemoteBranch("owner/repo", "master"),
      /Refusing to delete protected branch/,
    );
  });

  it("refuses to delete non-task branches", () => {
    assert.throws(
      () => deleteRemoteBranch("owner/repo", "feature/foo"),
      /Refusing to delete non-task branch/,
    );
  });

  it("dry-run does not mutate git state", () => {
    const result = deleteRemoteBranch("owner/repo", "agent/P0-01", { dryRun: true });
    assert.equal(result.deleted, false);
    assert.equal(result.dryRun, true);
    assert.equal(result.branch, "agent/P0-01");
  });
});

describe("deleteLocalBranch", () => {
  it("refuses to delete protected branches", () => {
    assert.throws(
      () => deleteLocalBranch("main"),
      /Refusing to delete protected branch/,
    );
  });

  it("refuses to delete non-task branches", () => {
    assert.throws(
      () => deleteLocalBranch("feature/bar"),
      /Refusing to delete non-task branch/,
    );
  });

  it("dry-run does not mutate git state", () => {
    const result = deleteLocalBranch("agent/P1-03", { dryRun: true });
    assert.equal(result.deleted, false);
    assert.equal(result.dryRun, true);
    assert.equal(result.branch, "agent/P1-03");
  });
});

describe("deleteMergedBranches", () => {
  it("dry-run returns planned deletions without mutating", () => {
    const prs = [
      { headRefName: "agent/P0-01", number: 10, mergedAt: "2024-01-01T00:00:00Z" },
      { headRefName: "agent/P1-05", number: 20, mergedAt: "2024-01-02T00:00:00Z" },
      { headRefName: "agent/P2-03", number: 21, mergedAt: "2024-01-02T12:00:00Z" },
      { headRefName: "agent/P3-04", number: 22, mergedAt: "2024-01-02T13:00:00Z" },
      { headRefName: "feature/skip", number: 30, mergedAt: "2024-01-03T00:00:00Z" },
    ];
    const results = deleteMergedBranches("owner/repo", prs, { dryRun: true });
    assert.equal(results.length, 4);
    for (const r of results) {
      assert.equal(r.deleted, false);
      assert.equal(r.dryRun, true);
    }
    assert.equal(results[0].branch, "agent/P0-01");
    assert.equal(results[0].prNumber, 10);
    assert.equal(results[1].branch, "agent/P1-05");
    assert.equal(results[1].prNumber, 20);
    assert.equal(results[2].branch, "agent/P2-03");
    assert.equal(results[2].prNumber, 21);
    assert.equal(results[3].branch, "agent/P3-04");
    assert.equal(results[3].prNumber, 22);
  });

  it("skips non-task branches", () => {
    const prs = [
      { headRefName: "main", number: 1, mergedAt: "2024-01-01T00:00:00Z" },
    ];
    const results = deleteMergedBranches("owner/repo", prs, { dryRun: true });
    assert.equal(results.length, 0);
  });

  it("handles empty PR list", () => {
    const results = deleteMergedBranches("owner/repo", [], { dryRun: true });
    assert.equal(results.length, 0);
  });
});

describe("listStaleWorktrees", () => {
  it("is a function", () => {
    assert.equal(typeof listStaleWorktrees, "function");
  });
});
