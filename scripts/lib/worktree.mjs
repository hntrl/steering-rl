import os from "node:os";
import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { runCommand } from "./command.mjs";
import { isTaskBranch, isProtectedBranch } from "./branch-cleanup.mjs";

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
