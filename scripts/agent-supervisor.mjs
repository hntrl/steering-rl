#!/usr/bin/env node

import path from "node:path";
import { mkdir } from "node:fs/promises";
import { ghJson, issueTaskIdFromTitle, ensureIssueInProgress } from "./lib/github.mjs";
import { emitEvent, createRunId } from "./lib/events.mjs";
import {
  defaultLogDir,
  defaultStateDir,
  ensureRuntimeDirs,
  acquireTaskLock,
  hasTaskLock,
  markStaleRunningRuns,
  releaseTaskLock,
  upsertRun,
} from "./lib/state.mjs";
import { dependenciesSatisfied, readTaskContract } from "./lib/tasks.mjs";
import { spawnDetached } from "./lib/command.mjs";

function parseArgs(argv) {
  const args = {
    repo: process.env.REPO || "",
    maxParallel: Number(process.env.MAX_PARALLEL || "2"),
    pollIntervalSeconds: Number(process.env.POLL_INTERVAL_SECONDS || "60"),
    once: false,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--repo") {
      args.repo = argv[i + 1] || "";
      i += 1;
    } else if (token === "--max-parallel") {
      args.maxParallel = Number(argv[i + 1] || args.maxParallel);
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

function countRunningRuns(runs) {
  return runs.filter((run) => run.status === "running").length;
}

function nextAttempt(taskId, runs) {
  const attempts = runs
    .filter((run) => run.task_id === taskId)
    .map((run) => Number(run.attempt || 1));
  if (attempts.length === 0) {
    return 1;
  }
  return Math.max(...attempts) + 1;
}

async function listTodoIssues(repo, token) {
  const payload = ghJson(
    [
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--limit",
      "200",
      "--json",
      "number,title,url,labels",
    ],
    { token },
  );
  if (!Array.isArray(payload)) {
    return [];
  }

  return payload.filter((issue) => {
    const labels = Array.isArray(issue.labels) ? issue.labels.map((label) => label.name) : [];
    return labels.includes("agent-ready") && labels.includes("status:todo");
  });
}

async function listClosedTaskIds(repo, token) {
  const payload = ghJson(
    [
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      "closed",
      "--limit",
      "500",
      "--json",
      "title",
    ],
    { token },
  );

  const closed = new Set();
  for (const issue of Array.isArray(payload) ? payload : []) {
    const taskId = issueTaskIdFromTitle(issue.title || "");
    if (taskId) {
      closed.add(taskId);
    }
  }
  return closed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const stateDir = defaultStateDir();
  const logDir = defaultLogDir();
  const token = process.env.EXECUTOR_BOT_TOKEN || "";
  const debug = process.env.AGENT_DEBUG === "1";
  const langsmithProject =
    process.env.DEEPAGENTS_LANGSMITH_PROJECT || process.env.LANGSMITH_PROJECT || "";

  if (!args.repo) {
    throw new Error("Missing --repo and REPO env var");
  }
  if (!token && !args.dryRun) {
    throw new Error("Missing EXECUTOR_BOT_TOKEN env var");
  }

  await ensureRuntimeDirs(stateDir, logDir);
  await mkdir(path.join(logDir, "workers"), { recursive: true });

  const workerScriptPath = path.join(repoRoot, "scripts", "agent-worker.mjs");

  while (true) {
    const runs = await markStaleRunningRuns(stateDir);
    const runningCount = countRunningRuns(runs);
    const capacity = Math.max(0, args.maxParallel - runningCount);

    if (capacity > 0) {
      const [todoIssues, closedTaskIds] = await Promise.all([
        listTodoIssues(args.repo, token),
        listClosedTaskIds(args.repo, token),
      ]);

      let dispatched = 0;
      for (const issue of todoIssues) {
        if (dispatched >= capacity) {
          break;
        }

        const taskId = issueTaskIdFromTitle(issue.title || "");
        if (!taskId) {
          if (debug) {
            console.log(`skip issue #${issue.number}: could not parse task id from title '${issue.title}'`);
          }
          continue;
        }

        if (await hasTaskLock(stateDir, taskId)) {
          if (debug) {
            console.log(`skip ${taskId}: task lock or active run present`);
          }
          continue;
        }

        let task;
        try {
          task = await readTaskContract(repoRoot, taskId);
        } catch {
          if (debug) {
            console.log(`skip ${taskId}: unable to read tasks/${taskId}.json`);
          }
          continue;
        }

        if (!dependenciesSatisfied(task, closedTaskIds)) {
          if (debug) {
            const missing = (task.dependencies || []).filter((dep) => !closedTaskIds.has(dep));
            console.log(`skip ${taskId}: missing dependencies ${missing.join(",")}`);
          }
          continue;
        }

        const runId = createRunId(taskId);
        const attempt = nextAttempt(taskId, runs);
        const branch = `agent/${taskId}`;

        await emitEvent(logDir, {
          source: "supervisor",
          event_type: "task_selected",
          repo: args.repo,
          task_id: taskId,
          issue_number: issue.number,
          run_id: runId,
          attempt,
          branch,
          status: "ok",
          data: {
            issue_url: issue.url,
            dependencies: task.dependencies || [],
          },
          langsmith: {
            project: langsmithProject || "unknown",
            correlation_key: `${taskId}:${runId}`,
          },
        });

        if (!(await acquireTaskLock(stateDir, taskId))) {
          continue;
        }

        try {
          if (!args.dryRun) {
            ensureIssueInProgress(args.repo, issue.number, token);

            await emitEvent(logDir, {
              source: "supervisor",
              event_type: "issue_labeled",
              repo: args.repo,
              task_id: taskId,
              issue_number: issue.number,
              run_id: runId,
              attempt,
              branch,
              status: "ok",
              data: {
                add_labels: ["status:in-progress"],
                remove_labels: ["status:todo"],
              },
              langsmith: {
                project: langsmithProject || "unknown",
                correlation_key: `${taskId}:${runId}`,
              },
            });
          }

          const workerLogPath = path.join(logDir, "workers", `${runId}.log`);
          const workerArgs = [
            workerScriptPath,
            "--repo",
            args.repo,
            "--task-id",
            taskId,
            "--issue-number",
            String(issue.number),
            "--run-id",
            runId,
            "--attempt",
            String(attempt),
          ];

          let pid = 0;
          if (!args.dryRun) {
            pid = spawnDetached(process.execPath, workerArgs, {
              cwd: repoRoot,
              env: process.env,
              logFilePath: workerLogPath,
            });
          }

          await upsertRun(stateDir, {
            run_id: runId,
            task_id: taskId,
            issue_number: issue.number,
            attempt,
            branch,
            status: args.dryRun ? "skipped" : "running",
            pid,
            log_path: workerLogPath,
          });

          await emitEvent(logDir, {
            source: "supervisor",
            event_type: "dispatch_started",
            repo: args.repo,
            task_id: taskId,
            issue_number: issue.number,
            run_id: runId,
            attempt,
            branch,
            status: args.dryRun ? "skipped" : "ok",
            data: {
              pid,
              dry_run: args.dryRun,
              worker_log_path: workerLogPath,
            },
            langsmith: {
              project: langsmithProject || "unknown",
              correlation_key: `${taskId}:${runId}`,
            },
          });

          if (args.dryRun) {
            await releaseTaskLock(stateDir, taskId);
            console.log(`[dry-run] would dispatch ${taskId} from issue #${issue.number}`);
          } else {
            console.log(
              `dispatched ${taskId} -> issue #${issue.number} (run ${runId}, log ${workerLogPath})`,
            );
          }

          dispatched += 1;
        } catch (error) {
          await releaseTaskLock(stateDir, taskId);
          console.error(`failed to dispatch ${taskId}: ${error.message || error}`);

          await emitEvent(logDir, {
            source: "supervisor",
            event_type: "run_failed",
            repo: args.repo,
            task_id: taskId,
            issue_number: issue.number,
            run_id: runId,
            attempt,
            branch,
            status: "failed",
            data: {
              reason: `dispatch_failed: ${error.message || error}`,
            },
            langsmith: {
              project: langsmithProject || "unknown",
              correlation_key: `${taskId}:${runId}`,
            },
          });
        }
      }

      if (dispatched === 0) {
        const runningTasks = [...new Set(
          runs
            .filter((run) => run.status === "running")
            .map((run) => run.task_id),
        )];

        if (runningTasks.length > 0) {
          console.log(
            `no dependency-ready tasks to dispatch (waiting on running task(s): ${runningTasks.join(", ")})`,
          );
        } else {
          console.log("no dependency-ready tasks to dispatch");
        }
      }
    }

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
