import os from "node:os";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { runCommand } from "./command.mjs";

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
