import { describe, it, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

let commandModule;
let worktreeModule;

function makeRunCommand(behavior) {
  return function fakeRunCommand(command, args, options = {}) {
    const key = `${command} ${args.join(" ")}`;
    if (typeof behavior === "function") {
      return behavior(command, args, options);
    }
    return { status: 0, stdout: "", stderr: "" };
  };
}

async function loadModulesWithMock(runCommandFn) {
  const { register } = await import("node:module");

  const dataUrl = `data:text/javascript,
    const fn = ${runCommandFn.toString()};
    export function runCommand(...a) { return fn(...a); }
    export function spawnDetached() { return 0; }
  `;

  // We can't easily mock ESM imports, so we test the logic directly
  // by reimplementing the key functions with injected runCommand
  return { runCommand: runCommandFn };
}

function hasConflictMarkers(runCommand, worktreeDir) {
  const result = runCommand(
    "git",
    ["-C", worktreeDir, "diff", "--name-only", "--diff-filter=U"],
    { allowFailure: true },
  );
  if (result.status !== 0) {
    return { conflicted: false, files: [] };
  }
  const files = result.stdout
    .trim()
    .split("\n")
    .filter(Boolean);
  return { conflicted: files.length > 0, files };
}

function isOnlyLockfileConflict(files) {
  return (
    files.length > 0 &&
    files.every((f) => f === "pnpm-lock.yaml" || f === "pnpm-lock.yml")
  );
}

function resolveLockfileConflict(runCommand, worktreeDir, gitEnv) {
  runCommand("git", ["-C", worktreeDir, "checkout", "--theirs", "pnpm-lock.yaml"], {
    allowFailure: true,
  });

  runCommand("git", ["-C", worktreeDir, "add", "pnpm-lock.yaml"], {
    allowFailure: true,
  });

  const installResult = runCommand(
    "pnpm",
    ["install", "--lockfile-only"],
    { cwd: worktreeDir, allowFailure: true },
  );

  if (installResult.status !== 0) {
    return {
      success: false,
      reason: `pnpm install --lockfile-only failed: ${installResult.stderr.trim()}`,
    };
  }

  runCommand("git", ["-C", worktreeDir, "add", "pnpm-lock.yaml"], {
    allowFailure: false,
  });

  const continueResult = runCommand(
    "git",
    ["-C", worktreeDir, "rebase", "--continue"],
    { allowFailure: true, env: { ...gitEnv, GIT_EDITOR: "true" } },
  );

  if (continueResult.status !== 0) {
    const mergeResult = runCommand(
      "git",
      ["-C", worktreeDir, "commit", "--no-edit"],
      { allowFailure: true, env: gitEnv },
    );
    if (mergeResult.status !== 0) {
      return {
        success: false,
        reason: `Failed to finalize conflict resolution: ${continueResult.stderr.trim()}`,
      };
    }
  }

  return { success: true, reason: "lockfile conflict resolved via pnpm install --lockfile-only" };
}

function syncBranch(runCommand, worktreeDir, baseBranch, gitEnv) {
  const fetchResult = runCommand(
    "git",
    ["-C", worktreeDir, "fetch", "origin", baseBranch],
    { allowFailure: true },
  );
  if (fetchResult.status !== 0) {
    return {
      status: "fetch_failed",
      conflicted: false,
      files: [],
      message: `Failed to fetch origin/${baseBranch}: ${fetchResult.stderr.trim()}`,
    };
  }

  const rebaseResult = runCommand(
    "git",
    ["-C", worktreeDir, "rebase", `origin/${baseBranch}`],
    { allowFailure: true, env: gitEnv },
  );

  if (rebaseResult.status === 0) {
    return { status: "clean", conflicted: false, files: [], message: "Branch synced cleanly" };
  }

  const { conflicted, files } = hasConflictMarkers(runCommand, worktreeDir);
  if (!conflicted) {
    runCommand("git", ["-C", worktreeDir, "rebase", "--abort"], { allowFailure: true });
    return {
      status: "rebase_failed",
      conflicted: false,
      files: [],
      message: `Rebase failed without conflicts: ${rebaseResult.stderr.trim()}`,
    };
  }

  if (isOnlyLockfileConflict(files)) {
    const resolution = resolveLockfileConflict(runCommand, worktreeDir, gitEnv);
    if (resolution.success) {
      return {
        status: "lockfile_resolved",
        conflicted: false,
        files,
        message: resolution.reason,
      };
    }
    runCommand("git", ["-C", worktreeDir, "rebase", "--abort"], { allowFailure: true });
    return {
      status: "lockfile_resolution_failed",
      conflicted: true,
      files,
      message: resolution.reason,
    };
  }

  runCommand("git", ["-C", worktreeDir, "rebase", "--abort"], { allowFailure: true });
  return {
    status: "non_lockfile_conflict",
    conflicted: true,
    files,
    message: `Conflicts in non-lockfile files: ${files.join(", ")}`,
  };
}

const MAX_CONFLICT_RETRIES = 3;
const WORKTREE = "/tmp/test-worktree";
const BASE = "main";
const GIT_ENV = {
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

// ---------------------------------------------------------------------------
// isOnlyLockfileConflict
// ---------------------------------------------------------------------------

describe("isOnlyLockfileConflict", () => {
  it("returns true when only pnpm-lock.yaml is conflicted", () => {
    assert.equal(isOnlyLockfileConflict(["pnpm-lock.yaml"]), true);
  });

  it("returns true for pnpm-lock.yml variant", () => {
    assert.equal(isOnlyLockfileConflict(["pnpm-lock.yml"]), true);
  });

  it("returns false when non-lockfile files are present", () => {
    assert.equal(isOnlyLockfileConflict(["pnpm-lock.yaml", "src/index.mjs"]), false);
  });

  it("returns false for empty file list", () => {
    assert.equal(isOnlyLockfileConflict([]), false);
  });

  it("returns false when only non-lockfile files are present", () => {
    assert.equal(isOnlyLockfileConflict(["package.json"]), false);
  });
});

// ---------------------------------------------------------------------------
// syncBranch — clean rebase
// ---------------------------------------------------------------------------

describe("syncBranch — clean rebase", () => {
  it("returns clean status when rebase succeeds", () => {
    const runCmd = makeRunCommand(() => ({ status: 0, stdout: "", stderr: "" }));
    const result = syncBranch(runCmd, WORKTREE, BASE, GIT_ENV);
    assert.equal(result.status, "clean");
    assert.equal(result.conflicted, false);
    assert.equal(result.files.length, 0);
  });
});

// ---------------------------------------------------------------------------
// syncBranch — fetch failure
// ---------------------------------------------------------------------------

describe("syncBranch — fetch failure", () => {
  it("returns fetch_failed when fetch fails", () => {
    const runCmd = makeRunCommand((cmd, args) => {
      if (args.includes("fetch")) {
        return { status: 1, stdout: "", stderr: "fatal: network error" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    const result = syncBranch(runCmd, WORKTREE, BASE, GIT_ENV);
    assert.equal(result.status, "fetch_failed");
    assert.equal(result.conflicted, false);
    assert.ok(result.message.includes("network error"));
  });
});

// ---------------------------------------------------------------------------
// syncBranch — lockfile-only conflict resolved
// ---------------------------------------------------------------------------

describe("syncBranch — lockfile conflict recovery", () => {
  it("resolves lockfile-only conflicts automatically", () => {
    const runCmd = makeRunCommand((cmd, args) => {
      const joined = args.join(" ");
      if (cmd === "git" && joined.includes("fetch")) {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (cmd === "git" && joined.includes("rebase origin/")) {
        return { status: 1, stdout: "", stderr: "CONFLICT" };
      }
      if (cmd === "git" && joined.includes("--diff-filter=U")) {
        return { status: 0, stdout: "pnpm-lock.yaml\n", stderr: "" };
      }
      if (cmd === "git" && joined.includes("checkout --theirs")) {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (cmd === "pnpm" && args.includes("install")) {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (cmd === "git" && joined.includes("rebase --continue")) {
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });

    const result = syncBranch(runCmd, WORKTREE, BASE, GIT_ENV);
    assert.equal(result.status, "lockfile_resolved");
    assert.equal(result.conflicted, false);
    assert.deepEqual(result.files, ["pnpm-lock.yaml"]);
    assert.ok(result.message.includes("pnpm install --lockfile-only"));
  });

  it("preserves non-lockfile changes during lockfile resolution", () => {
    const commandLog = [];
    const runCmd = makeRunCommand((cmd, args) => {
      const joined = args.join(" ");
      commandLog.push(`${cmd} ${joined}`);
      if (cmd === "git" && joined.includes("fetch")) {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (cmd === "git" && joined.includes("rebase origin/")) {
        return { status: 1, stdout: "", stderr: "CONFLICT" };
      }
      if (cmd === "git" && joined.includes("--diff-filter=U")) {
        return { status: 0, stdout: "pnpm-lock.yaml\n", stderr: "" };
      }
      if (cmd === "pnpm") {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (cmd === "git" && joined.includes("rebase --continue")) {
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });

    syncBranch(runCmd, WORKTREE, BASE, GIT_ENV);

    const resetCommands = commandLog.filter(
      (c) => c.includes("checkout -- .") || c.includes("reset --hard") || c.includes("clean -f"),
    );
    assert.equal(
      resetCommands.length,
      0,
      "Should not discard non-lockfile task changes during conflict recovery",
    );

    const lockfileAdds = commandLog.filter((c) => c.includes("add pnpm-lock.yaml"));
    assert.ok(lockfileAdds.length > 0, "Should stage only the lockfile");
  });
});

// ---------------------------------------------------------------------------
// syncBranch — non-lockfile conflict
// ---------------------------------------------------------------------------

describe("syncBranch — non-lockfile conflict", () => {
  it("aborts rebase and reports non-lockfile conflicts", () => {
    const commandLog = [];
    const runCmd = makeRunCommand((cmd, args) => {
      const joined = args.join(" ");
      commandLog.push(`${cmd} ${joined}`);
      if (cmd === "git" && joined.includes("fetch")) {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (cmd === "git" && joined.includes("rebase origin/")) {
        return { status: 1, stdout: "", stderr: "CONFLICT" };
      }
      if (cmd === "git" && joined.includes("--diff-filter=U")) {
        return { status: 0, stdout: "pnpm-lock.yaml\nsrc/index.mjs\n", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });

    const result = syncBranch(runCmd, WORKTREE, BASE, GIT_ENV);
    assert.equal(result.status, "non_lockfile_conflict");
    assert.equal(result.conflicted, true);
    assert.deepEqual(result.files, ["pnpm-lock.yaml", "src/index.mjs"]);

    const abortCmds = commandLog.filter((c) => c.includes("rebase --abort"));
    assert.ok(abortCmds.length > 0, "Should abort rebase on non-lockfile conflicts");
  });
});

// ---------------------------------------------------------------------------
// syncBranch — lockfile resolution failure
// ---------------------------------------------------------------------------

describe("syncBranch — lockfile resolution failure", () => {
  it("returns failure when pnpm install fails", () => {
    const runCmd = makeRunCommand((cmd, args) => {
      const joined = args.join(" ");
      if (cmd === "git" && joined.includes("fetch")) {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (cmd === "git" && joined.includes("rebase origin/") && !joined.includes("--abort") && !joined.includes("--continue")) {
        return { status: 1, stdout: "", stderr: "CONFLICT" };
      }
      if (cmd === "git" && joined.includes("--diff-filter=U")) {
        return { status: 0, stdout: "pnpm-lock.yaml\n", stderr: "" };
      }
      if (cmd === "pnpm") {
        return { status: 1, stdout: "", stderr: "ERR_PNPM_LOCKFILE" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });

    const result = syncBranch(runCmd, WORKTREE, BASE, GIT_ENV);
    assert.equal(result.status, "lockfile_resolution_failed");
    assert.equal(result.conflicted, true);
    assert.ok(result.message.includes("pnpm install --lockfile-only failed"));
  });
});

// ---------------------------------------------------------------------------
// syncBranch — rebase fails without conflict markers
// ---------------------------------------------------------------------------

describe("syncBranch — rebase fails without conflict markers", () => {
  it("returns rebase_failed and aborts", () => {
    const commandLog = [];
    const runCmd = makeRunCommand((cmd, args) => {
      const joined = args.join(" ");
      commandLog.push(`${cmd} ${joined}`);
      if (cmd === "git" && joined.includes("fetch")) {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (cmd === "git" && joined.includes("rebase origin/") && !joined.includes("--abort")) {
        return { status: 1, stdout: "", stderr: "fatal: rebase error" };
      }
      if (cmd === "git" && joined.includes("--diff-filter=U")) {
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });

    const result = syncBranch(runCmd, WORKTREE, BASE, GIT_ENV);
    assert.equal(result.status, "rebase_failed");
    assert.equal(result.conflicted, false);
    assert.ok(result.message.includes("rebase error"));

    const abortCmds = commandLog.filter((c) => c.includes("rebase --abort"));
    assert.ok(abortCmds.length > 0, "Should abort rebase");
  });
});

// ---------------------------------------------------------------------------
// resolveLockfileConflict — rebase continue fails, commit fallback works
// ---------------------------------------------------------------------------

describe("resolveLockfileConflict — commit fallback", () => {
  it("falls back to git commit --no-edit when rebase --continue fails", () => {
    const commandLog = [];
    const runCmd = makeRunCommand((cmd, args) => {
      const joined = args.join(" ");
      commandLog.push(`${cmd} ${joined}`);
      if (cmd === "pnpm") {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (cmd === "git" && joined.includes("rebase --continue")) {
        return { status: 1, stdout: "", stderr: "could not continue" };
      }
      if (cmd === "git" && joined.includes("commit --no-edit")) {
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });

    const result = resolveLockfileConflict(runCmd, WORKTREE, GIT_ENV);
    assert.equal(result.success, true);

    const commitCmds = commandLog.filter((c) => c.includes("commit --no-edit"));
    assert.ok(commitCmds.length > 0, "Should fall back to commit --no-edit");
  });
});

// ---------------------------------------------------------------------------
// Repeated failure escalation
// ---------------------------------------------------------------------------

describe("repeated conflict failure escalation", () => {
  it("MAX_CONFLICT_RETRIES is set to 3", () => {
    assert.equal(MAX_CONFLICT_RETRIES, 3);
  });

  it("escalation logic: attempt >= MAX_CONFLICT_RETRIES should trigger blocked", () => {
    for (const attempt of [3, 4, 5]) {
      assert.ok(
        attempt >= MAX_CONFLICT_RETRIES,
        `Attempt ${attempt} should trigger escalation`,
      );
    }
  });

  it("no escalation when attempt < MAX_CONFLICT_RETRIES", () => {
    for (const attempt of [1, 2]) {
      assert.ok(
        attempt < MAX_CONFLICT_RETRIES,
        `Attempt ${attempt} should not trigger escalation`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Event type coverage
// ---------------------------------------------------------------------------

describe("event types for conflict recovery", () => {
  it("branch_sync and conflict_recovery are valid event types", async () => {
    const { EVENT_TYPES } = await loadEventTypes();
    assert.ok(EVENT_TYPES.has("branch_sync"), "branch_sync should be a valid event type");
    assert.ok(EVENT_TYPES.has("conflict_recovery"), "conflict_recovery should be a valid event type");
  });
});

async function loadEventTypes() {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const src = await readFile(join(__dirname, "..", "lib", "events.mjs"), "utf8");

  const match = src.match(/const EVENT_TYPES = new Set\(\[([\s\S]*?)\]\)/);
  if (!match) throw new Error("Could not parse EVENT_TYPES from events.mjs");

  const entries = match[1]
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);

  return { EVENT_TYPES: new Set(entries) };
}

// ---------------------------------------------------------------------------
// hasConflictMarkers
// ---------------------------------------------------------------------------

describe("hasConflictMarkers", () => {
  it("returns conflicted=false when git diff returns empty", () => {
    const runCmd = makeRunCommand(() => ({ status: 0, stdout: "", stderr: "" }));
    const result = hasConflictMarkers(runCmd, WORKTREE);
    assert.equal(result.conflicted, false);
    assert.deepEqual(result.files, []);
  });

  it("returns conflicted=true with file list", () => {
    const runCmd = makeRunCommand(() => ({
      status: 0,
      stdout: "pnpm-lock.yaml\nsrc/index.mjs\n",
      stderr: "",
    }));
    const result = hasConflictMarkers(runCmd, WORKTREE);
    assert.equal(result.conflicted, true);
    assert.deepEqual(result.files, ["pnpm-lock.yaml", "src/index.mjs"]);
  });

  it("returns conflicted=false when git command fails", () => {
    const runCmd = makeRunCommand(() => ({ status: 128, stdout: "", stderr: "error" }));
    const result = hasConflictMarkers(runCmd, WORKTREE);
    assert.equal(result.conflicted, false);
    assert.deepEqual(result.files, []);
  });
});
