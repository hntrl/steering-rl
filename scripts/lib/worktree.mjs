import os from "node:os";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { runCommand } from "./command.mjs";
import { isTaskBranch, isProtectedBranch } from "./branch-cleanup.mjs";

export const MAX_CONFLICT_RETRIES = 3;

export function defaultWorktreeBase() {
  return process.env.WORKTREE_BASE || path.join(os.homedir(), "worktrees", "steering-rl");
}

function branchExists(repoRoot, branch) {
  const result = runCommand(
    "git",
    ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    {
      cwd: repoRoot,
      allowFailure: true,
    },
  );
  return result.status === 0;
}

export async function ensureWorktree(repoRoot, taskId, branch, worktreeBase) {
  await mkdir(worktreeBase, { recursive: true });
  const worktreeDir = path.join(worktreeBase, taskId);

  const listResult = runCommand("git", ["worktree", "list", "--porcelain"], {
    cwd: repoRoot,
  });
  const alreadyExists = listResult.stdout.includes(`${worktreeDir}\n`);

  if (!alreadyExists) {
    if (branchExists(repoRoot, branch)) {
      runCommand("git", ["worktree", "add", worktreeDir, branch], {
        cwd: repoRoot,
        capture: false,
      });
    } else {
      runCommand("git", ["worktree", "add", worktreeDir, "-b", branch], {
        cwd: repoRoot,
        capture: false,
      });
    }
  }

  runCommand("git", ["-C", worktreeDir, "checkout", branch], {
    allowFailure: true,
  });

  runCommand("git", ["-C", worktreeDir, "fetch", "origin", branch], {
    allowFailure: true,
  });

  runCommand("git", ["-C", worktreeDir, "pull", "--rebase", "origin", branch], {
    allowFailure: true,
  });

  return worktreeDir;
}

export function hasGitChanges(worktreeDir) {
  const result = runCommand("git", ["-C", worktreeDir, "status", "--porcelain"]);
  return result.stdout.trim().length > 0;
}

export function listWorktrees(repoRoot) {
  const result = runCommand("git", ["worktree", "list", "--porcelain"], {
    cwd: repoRoot,
  });

  const entries = [];
  let current = {};
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length) };
    } else if (line.startsWith("branch refs/heads/")) {
      current.branch = line.slice("branch refs/heads/".length);
    } else if (line === "bare") {
      current.bare = true;
    } else if (line === "") {
      if (current.path) entries.push(current);
      current = {};
    }
  }
  if (current.path) entries.push(current);

  return entries;
}

export function listStaleWorktrees(repoRoot, activeTaskIds) {
  const activeSet = new Set(Array.isArray(activeTaskIds) ? activeTaskIds : []);
  const worktrees = listWorktrees(repoRoot);
  const stale = [];

  for (const wt of worktrees) {
    if (wt.bare) continue;
    if (!wt.branch) continue;
    if (!isTaskBranch(wt.branch)) continue;
    if (isProtectedBranch(wt.branch)) continue;

    const taskId = wt.branch.replace("agent/", "");
    if (activeSet.has(taskId)) continue;

    stale.push({
      path: wt.path,
      branch: wt.branch,
      taskId,
    });
  }

  return stale;
}

export function pruneStaleWorktrees(repoRoot, activeTaskIds, options = {}) {
  const { dryRun = false } = options;
  const stale = listStaleWorktrees(repoRoot, activeTaskIds);
  const results = [];

  for (const wt of stale) {
    if (dryRun) {
      console.log(`[dry-run] Would prune worktree ${wt.path} (branch ${wt.branch})`);
      results.push({ pruned: false, dryRun: true, ...wt });
      continue;
    }

    const result = runCommand(
      "git",
      ["worktree", "remove", "--force", wt.path],
      { cwd: repoRoot, allowFailure: true },
    );

    const success = result.status === 0;
    if (success) {
      console.log(`Pruned worktree ${wt.path} (branch ${wt.branch})`);
    } else {
      console.warn(`Failed to prune worktree ${wt.path}: ${result.stderr}`);
    }
    results.push({ pruned: success, dryRun: false, ...wt });
  }

  return results;
}

export function hasConflictMarkers(worktreeDir) {
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

export function isOnlyLockfileConflict(files) {
  return (
    files.length > 0 &&
    files.every((f) => f === "pnpm-lock.yaml" || f === "pnpm-lock.yml")
  );
}

export function resolveLockfileConflict(worktreeDir, gitEnv) {
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

export function syncBranch(worktreeDir, baseBranch, gitEnv) {
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

  const { conflicted, files } = hasConflictMarkers(worktreeDir);
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
    const resolution = resolveLockfileConflict(worktreeDir, gitEnv);
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
