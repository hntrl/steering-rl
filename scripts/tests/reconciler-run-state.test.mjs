import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalizeRuns } from "../lib/state.mjs";

describe("canonicalizeRuns", () => {
  it("collapses duplicate merged runs into one canonical entry per task", () => {
    const runs = [
      {
        run_id: "P1-01-run-1",
        task_id: "P1-01",
        status: "merged",
        merged_at: "2025-01-01T00:00:00Z",
        updated_at: "2025-01-01T00:00:00Z",
      },
      {
        run_id: "P1-01-run-2",
        task_id: "P1-01",
        status: "merged",
        merged_at: "2025-01-02T00:00:00Z",
        updated_at: "2025-01-02T00:00:00Z",
      },
    ];

    const result = canonicalizeRuns(runs);
    const merged = result.filter((r) => r.task_id === "P1-01" && r.status === "merged");
    assert.equal(merged.length, 1, "should have exactly one canonical merged run");
    assert.equal(merged[0].run_id, "P1-01-run-2", "canonical run should be the latest");
  });

  it("converts stale ready_for_review to merged when a merged run exists", () => {
    const runs = [
      {
        run_id: "P1-02-run-1",
        task_id: "P1-02",
        status: "ready_for_review",
        updated_at: "2025-01-01T00:00:00Z",
      },
      {
        run_id: "P1-02-run-2",
        task_id: "P1-02",
        status: "merged",
        merged_at: "2025-01-03T00:00:00Z",
        updated_at: "2025-01-03T00:00:00Z",
      },
    ];

    const result = canonicalizeRuns(runs);
    const readyForReview = result.filter((r) => r.status === "ready_for_review");
    assert.equal(readyForReview.length, 0, "no ready_for_review runs should remain");

    const mergedRuns = result.filter((r) => r.task_id === "P1-02" && r.status === "merged");
    assert.ok(mergedRuns.length >= 1, "merged runs should exist");
  });

  it("reports ready_for_review as zero for fully merged queues", () => {
    const runs = [
      {
        run_id: "P1-01-run-1",
        task_id: "P1-01",
        status: "ready_for_review",
        updated_at: "2025-01-01T00:00:00Z",
      },
      {
        run_id: "P1-01-run-2",
        task_id: "P1-01",
        status: "merged",
        merged_at: "2025-01-02T00:00:00Z",
        updated_at: "2025-01-02T00:00:00Z",
      },
      {
        run_id: "P1-02-run-1",
        task_id: "P1-02",
        status: "ready_for_review",
        updated_at: "2025-01-01T00:00:00Z",
      },
      {
        run_id: "P1-02-run-2",
        task_id: "P1-02",
        status: "merged",
        merged_at: "2025-01-03T00:00:00Z",
        updated_at: "2025-01-03T00:00:00Z",
      },
    ];

    const result = canonicalizeRuns(runs);
    const readyCount = result.filter((r) => r.status === "ready_for_review").length;
    assert.equal(readyCount, 0, "ready_for_review should be zero after canonicalization");
  });

  it("is idempotent across repeated runs", () => {
    const runs = [
      {
        run_id: "P1-01-run-1",
        task_id: "P1-01",
        status: "ready_for_review",
        updated_at: "2025-01-01T00:00:00Z",
      },
      {
        run_id: "P1-01-run-2",
        task_id: "P1-01",
        status: "merged",
        merged_at: "2025-01-02T00:00:00Z",
        updated_at: "2025-01-02T00:00:00Z",
      },
    ];

    const first = canonicalizeRuns(structuredClone(runs));
    const second = canonicalizeRuns(structuredClone(first));

    assert.equal(first.length, second.length, "length should be stable");
    for (let i = 0; i < first.length; i++) {
      assert.equal(first[i].run_id, second[i].run_id);
      assert.equal(first[i].status, second[i].status);
      assert.equal(first[i].merged_at, second[i].merged_at);
    }
  });

  it("does not mutate unrelated task history entries", () => {
    const runs = [
      {
        run_id: "P1-01-run-1",
        task_id: "P1-01",
        status: "merged",
        merged_at: "2025-01-02T00:00:00Z",
        updated_at: "2025-01-02T00:00:00Z",
      },
      {
        run_id: "P1-03-run-1",
        task_id: "P1-03",
        status: "running",
        pid: 12345,
        updated_at: "2025-01-01T00:00:00Z",
      },
      {
        run_id: "P1-04-run-1",
        task_id: "P1-04",
        status: "failed",
        failure_reason: "verify_failed",
        updated_at: "2025-01-01T00:00:00Z",
      },
    ];

    const result = canonicalizeRuns(runs);
    const p1_03 = result.find((r) => r.task_id === "P1-03");
    const p1_04 = result.find((r) => r.task_id === "P1-04");

    assert.equal(p1_03.status, "running", "unrelated running task unchanged");
    assert.equal(p1_03.pid, 12345, "unrelated running task pid unchanged");
    assert.equal(p1_04.status, "failed", "unrelated failed task unchanged");
    assert.equal(p1_04.failure_reason, "verify_failed", "unrelated failed task reason unchanged");
  });

  it("prefers merged PR metadata when normalizing merged_at", () => {
    const runs = [
      {
        run_id: "P1-01-run-1",
        task_id: "P1-01",
        status: "merged",
        merged_at: null,
        updated_at: "2025-01-01T00:00:00Z",
      },
      {
        run_id: "P1-01-run-2",
        task_id: "P1-01",
        status: "merged",
        merged_at: "2025-01-05T12:00:00Z",
        updated_at: "2025-01-05T00:00:00Z",
      },
    ];

    const result = canonicalizeRuns(runs);
    const canonical = result.find((r) => r.task_id === "P1-01" && r.status === "merged");
    assert.equal(
      canonical.merged_at,
      "2025-01-05T12:00:00Z",
      "canonical should use merged PR metadata for merged_at",
    );
  });

  it("converts stale dispatched runs to merged when a merged run exists", () => {
    const runs = [
      {
        run_id: "P1-01-run-1",
        task_id: "P1-01",
        status: "dispatched",
        updated_at: "2025-01-01T00:00:00Z",
      },
      {
        run_id: "P1-01-run-2",
        task_id: "P1-01",
        status: "merged",
        merged_at: "2025-01-02T00:00:00Z",
        updated_at: "2025-01-02T00:00:00Z",
      },
    ];

    const result = canonicalizeRuns(runs);
    const dispatched = result.filter((r) => r.status === "dispatched");
    assert.equal(dispatched.length, 0, "no dispatched runs should remain for merged tasks");
  });

  it("preserves tasks with no merged runs unchanged", () => {
    const runs = [
      {
        run_id: "P1-05-run-1",
        task_id: "P1-05",
        status: "ready_for_review",
        updated_at: "2025-01-01T00:00:00Z",
      },
      {
        run_id: "P1-05-run-2",
        task_id: "P1-05",
        status: "running",
        pid: 9999,
        updated_at: "2025-01-02T00:00:00Z",
      },
    ];

    const result = canonicalizeRuns(runs);
    assert.equal(result.length, 2, "all runs preserved when no merged run exists");
    assert.equal(result.filter((r) => r.status === "ready_for_review").length, 1);
    assert.equal(result.filter((r) => r.status === "running").length, 1);
  });

  it("handles empty runs array", () => {
    const result = canonicalizeRuns([]);
    assert.deepEqual(result, []);
  });
});
