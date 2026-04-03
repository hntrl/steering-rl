#!/usr/bin/env node

import { gh, ghJson, issueTaskIdFromTitle } from "./lib/github.mjs";
import { emitEvent } from "./lib/events.mjs";
import {
  defaultLogDir,
  defaultStateDir,
  ensureRuntimeDirs,
  readRuns,
  releaseTaskLock,
  upsertRun,
  isPidAlive,
  writeCanonicalizedRuns,
} from "./lib/state.mjs";
import { deleteMergedBranches } from "./lib/branch-cleanup.mjs";
import { defaultWorktreeBase, pruneStaleWorktrees } from "./lib/worktree.mjs";

function parseArgs(argv) {
  const args = {
    repo: process.env.REPO || "",
    pollIntervalSeconds: Number(process.env.POLL_INTERVAL_SECONDS || "60"),
    once: false,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--repo") {
      args.repo = argv[i + 1] || "";
      i += 1;
    } else if (token === "--poll-interval-seconds") {
      args.pollIntervalSeconds = Number(argv[i + 1] || args.pollIntervalSeconds);
      i += 1;
    } else if (token === "--once") {
      args.once = true;
    } else if (token === "--dry-run") {
      args.dryRun = true;
    }
  }

  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function taskIdFromBranch(branch) {
  const match = String(branch || "").match(/^agent\/(P[0-3]-\d{2})$/);
  return match ? match[1] : null;
}

function findOpenIssueForTask(repo, taskId, token) {
  const issues = ghJson(
    [
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--search",
      `in:title [${taskId}]`,
      "--limit",
      "1",
      "--json",
      "number,title",
    ],
    { token },
  );

  if (!Array.isArray(issues) || issues.length === 0) {
    return null;
  }
  return issues[0];
}

async function reconcileMergedPrs(args, token, logDir, langsmithProject, stateDir) {
  const mergedPrs = ghJson(
    [
      "pr",
      "list",
      "--repo",
      args.repo,
      "--state",
      "merged",
      "--search",
      "head:agent/",
      "--limit",
      "200",
      "--json",
      "number,title,headRefName,url,mergedAt",
    ],
    { token },
  );

  for (const pr of Array.isArray(mergedPrs) ? mergedPrs : []) {
    const taskId =
      taskIdFromBranch(pr.headRefName) || issueTaskIdFromTitle(pr.title || "");
    if (!taskId) {
      continue;
    }

    const issue = findOpenIssueForTask(args.repo, taskId, token);
    if (issue) {
      if (!args.dryRun) {
        gh(
          [
            "issue",
            "close",
            String(issue.number),
            "--repo",
            args.repo,
            "--comment",
            `Closed automatically: merged in PR #${pr.number} (${pr.url})`,
          ],
          { token },
        );
      }

      await emitEvent(logDir, {
        source: "reconciler",
        event_type: "run_completed",
        repo: args.repo,
        task_id: taskId,
        issue_number: issue.number,
        run_id: `reconciler-${taskId}-${pr.number}`,
        branch: pr.headRefName,
        status: args.dryRun ? "skipped" : "ok",
        data: {
          pr_number: pr.number,
          pr_url: pr.url,
          merged_at: pr.mergedAt,
          dry_run: args.dryRun,
        },
        langsmith: {
          project: langsmithProject || "unknown",
          correlation_key: `${taskId}:pr-${pr.number}`,
        },
      });
    }

    const runs = await readRuns(stateDir);
    const activeForTask = runs
      .filter((run) => run.task_id === taskId)
      .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
    if (activeForTask.length > 0) {
      await upsertRun(stateDir, {
        ...activeForTask[0],
        status: "merged",
        merged_at: pr.mergedAt,
      });
    }
  }

  deleteMergedBranches(args.repo, Array.isArray(mergedPrs) ? mergedPrs : [], {
    dryRun: args.dryRun,
    token,
  });
}

async function reconcileStaleWorktrees(args, stateDir) {
  const runs = await readRuns(stateDir);
  const activeTaskIds = runs
    .filter((run) => run.status === "running")
    .map((run) => run.task_id);

  const repoRoot = process.env.REPO_ROOT || process.cwd();
  pruneStaleWorktrees(repoRoot, activeTaskIds, { dryRun: args.dryRun });
}

async function reconcileDeadWorkers(args, token, logDir, langsmithProject, stateDir) {
  const runs = await readRuns(stateDir);
  for (const run of runs) {
    if (run.status !== "running") {
      continue;
    }

    if (isPidAlive(run.pid)) {
      continue;
    }

    const issue = findOpenIssueForTask(args.repo, run.task_id, token);
    if (issue && !args.dryRun) {
      gh(
        [
          "issue",
          "edit",
          String(issue.number),
          "--repo",
          args.repo,
          "--add-label",
          "status:blocked",
          "--remove-label",
          "status:in-progress",
        ],
        { token },
      );

      gh(
        [
          "issue",
          "comment",
          String(issue.number),
          "--repo",
          args.repo,
          "--body",
          `Worker exited unexpectedly for ${run.task_id} (run ${run.run_id}).`,
        ],
        { token },
      );
    }

    await upsertRun(stateDir, {
      ...run,
      status: "failed",
      failure_reason: "worker_process_exited",
    });

    await releaseTaskLock(stateDir, run.task_id);

    await emitEvent(logDir, {
      source: "reconciler",
      event_type: "run_failed",
      repo: args.repo,
      task_id: run.task_id,
      issue_number: run.issue_number,
      run_id: run.run_id,
      attempt: run.attempt,
      branch: run.branch,
      worktree: run.worktree,
      status: args.dryRun ? "skipped" : "failed",
      data: {
        reason: "worker_process_exited",
        pid: run.pid,
        dry_run: args.dryRun,
      },
      langsmith: {
        project: langsmithProject || "unknown",
        correlation_key: `${run.task_id}:${run.run_id}`,
      },
    });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.EXECUTOR_BOT_TOKEN || "";
  const stateDir = defaultStateDir();
  const logDir = defaultLogDir();
  const langsmithProject =
    process.env.DEEPAGENTS_LANGSMITH_PROJECT || process.env.LANGSMITH_PROJECT || "";

  if (!args.repo) {
    throw new Error("Missing --repo and REPO env var");
  }
  if (!token && !args.dryRun) {
    throw new Error("Missing EXECUTOR_BOT_TOKEN env var");
  }

  await ensureRuntimeDirs(stateDir, logDir);

  while (true) {
    await reconcileMergedPrs(args, token, logDir, langsmithProject, stateDir);
    await reconcileDeadWorkers(args, token, logDir, langsmithProject, stateDir);
    await reconcileStaleWorktrees(args, stateDir);
    await writeCanonicalizedRuns(stateDir);
    await reconcileStaleWorktrees(args, stateDir);

    if (args.once) {
      break;
    }

    await sleep(args.pollIntervalSeconds * 1000);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
