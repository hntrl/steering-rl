#!/usr/bin/env node

import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import {
  gh,
  ghJson,
  commentIssue,
  markIssueBlocked,
} from "./lib/github.mjs";
import { emitEvent } from "./lib/events.mjs";
import {
  defaultLogDir,
  defaultStateDir,
  ensureRuntimeDirs,
  releaseTaskLock,
  upsertRun,
} from "./lib/state.mjs";
import { buildDeepAgentsPrompt, readTaskContract } from "./lib/tasks.mjs";
import { runCommand } from "./lib/command.mjs";
import { defaultWorktreeBase, ensureWorktree, hasGitChanges } from "./lib/worktree.mjs";

function parseArgs(argv) {
  const args = {
    repo: process.env.REPO || "",
    taskId: "",
    issueNumber: 0,
    runId: "",
    attempt: 1,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--repo") {
      args.repo = argv[i + 1] || "";
      i += 1;
    } else if (token === "--task-id") {
      args.taskId = argv[i + 1] || "";
      i += 1;
    } else if (token === "--issue-number") {
      args.issueNumber = Number(argv[i + 1] || "0");
      i += 1;
    } else if (token === "--run-id") {
      args.runId = argv[i + 1] || "";
      i += 1;
    } else if (token === "--attempt") {
      args.attempt = Number(argv[i + 1] || "1");
      i += 1;
    }
  }

  return args;
}

function nowIso() {
  return new Date().toISOString();
}

function logStep(message) {
  console.log(`[${nowIso()}] ${message}`);
}

function trimOutput(output, maxLength = 6000) {
  const text = String(output || "").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}\n... [truncated]`;
}

function buildPrBody({ task, taskId, issueNumber, verifyOutput }) {
  return [
    `Closes #${issueNumber}`,
    "",
    "## Goal",
    task.goal,
    "",
    "## Verify command",
    "```bash",
    task.verify_command,
    "```",
    "",
    "## Verify output",
    "```text",
    trimOutput(verifyOutput, 8000) || "(no output)",
    "```",
    "",
    "## Rollback note",
    task.rollback_note,
    "",
    "## Task contract",
    `- \`tasks/${taskId}.json\``,
  ].join("\n");
}

function deepAgentsCommandArgs(prompt) {
  const defaultAllowList = [
    "cd",
    "ls",
    "cat",
    "head",
    "tail",
    "grep",
    "wc",
    "strings",
    "cut",
    "tr",
    "diff",
    "md5sum",
    "sha256sum",
    "pwd",
    "which",
    "uname",
    "hostname",
    "whoami",
    "id",
    "groups",
    "uptime",
    "nproc",
    "lscpu",
    "lsmem",
    "ps",
    "git",
    "pnpm",
    "npm",
    "node",
    "npx",
    "python3",
    "bash",
    "sh",
    "mkdir",
    "cp",
    "mv",
    "rm",
    "touch",
  ].join(",");

  const args = [
    "-n",
    prompt,
    "--agent",
    process.env.DEEPAGENTS_AGENT || "build",
    "--auto-approve",
    "--shell-allow-list",
    process.env.DEEPAGENTS_SHELL_ALLOW_LIST || defaultAllowList,
  ];

  if (process.env.DEEPAGENTS_MODEL) {
    args.push("-M", process.env.DEEPAGENTS_MODEL);
  }

  return args;
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractProjectNames(payload) {
  if (!payload) {
    return [];
  }

  if (Array.isArray(payload)) {
    return payload
      .map((item) => (item && typeof item === "object" ? item.name : null))
      .filter((name) => typeof name === "string" && name.length > 0);
  }

  if (Array.isArray(payload.data)) {
    return extractProjectNames(payload.data);
  }

  if (Array.isArray(payload.projects)) {
    return extractProjectNames(payload.projects);
  }

  return [];
}

function resolveDeepAgentsEnv() {
  const env = { ...process.env };
  const configuredDeepAgentsProject = process.env.DEEPAGENTS_LANGSMITH_PROJECT || "";
  const configuredLangSmithProject =
    process.env.LANGSMITH_PROJECT || process.env.LANGCHAIN_PROJECT || "";
  const desiredProject = configuredDeepAgentsProject || configuredLangSmithProject || "";
  const desiredSource = configuredDeepAgentsProject
    ? "DEEPAGENTS_LANGSMITH_PROJECT"
    : configuredLangSmithProject
      ? "LANGSMITH_PROJECT"
      : "default";
  const hasLangSmithKey = Boolean(process.env.LANGSMITH_API_KEY || process.env.LANGCHAIN_API_KEY);
  const clearConflictingProjectVars = () => {
    delete env.DEEPAGENTS_LANGSMITH_PROJECT;
    delete env.LANGSMITH_PROJECT;
    delete env.LANGCHAIN_PROJECT;
  };

  if (!hasLangSmithKey) {
    clearConflictingProjectVars();
    delete env.DEEPAGENTS_LANGSMITH_PROJECT;
    return {
      env,
      tracing_mode: "disabled_no_api_key",
      tracing_project: null,
      note: "LANGSMITH_API_KEY or LANGCHAIN_API_KEY not configured",
    };
  }

  if (!desiredProject) {
    return {
      env,
      tracing_mode: "default",
      tracing_project: null,
      note: "No explicit LangSmith project configured; using CLI defaults",
    };
  }

  const projectProbe = runCommand(
    "langsmith",
    ["project", "list", "--limit", "200", "--format", "json"],
    {
      allowFailure: true,
    },
  );

  if (projectProbe.status !== 0) {
    clearConflictingProjectVars();
    delete env.DEEPAGENTS_LANGSMITH_PROJECT;
    return {
      env,
      tracing_mode: "fallback_default",
      tracing_project: null,
      note: `Could not validate project '${desiredProject}' from ${desiredSource}: ${trimOutput(projectProbe.stderr, 240)}`,
    };
  }

  const projectPayload = safeJsonParse(projectProbe.stdout);
  const projectNames = extractProjectNames(projectPayload);

  if (projectNames.includes(desiredProject)) {
    env.DEEPAGENTS_LANGSMITH_PROJECT = desiredProject;
    env.LANGSMITH_PROJECT = desiredProject;
    env.LANGCHAIN_PROJECT = desiredProject;
    return {
      env,
      tracing_mode: "explicit",
      tracing_project: desiredProject,
      note: `Using configured project '${desiredProject}' from ${desiredSource}`,
    };
  }

  if (projectNames.length > 0) {
    env.DEEPAGENTS_LANGSMITH_PROJECT = projectNames[0];
    env.LANGSMITH_PROJECT = projectNames[0];
    env.LANGCHAIN_PROJECT = projectNames[0];
    return {
      env,
      tracing_mode: "fallback_existing_project",
      tracing_project: projectNames[0],
      note: `Configured project '${desiredProject}' from ${desiredSource} not found; using '${projectNames[0]}'`,
    };
  }

  delete env.DEEPAGENTS_LANGSMITH_PROJECT;
  clearConflictingProjectVars();
  return {
    env,
    tracing_mode: "fallback_default",
    tracing_project: null,
    note: `Configured project '${desiredProject}' not found and no projects were returned by LangSmith`,
  };
}

async function writeRunLog(logDir, runId, content) {
  const runLogPath = path.join(logDir, "runs", `${runId}.log`);
  await mkdir(path.dirname(runLogPath), { recursive: true });
  await writeFile(runLogPath, content, "utf8");
  return runLogPath;
}

function ensureGitIdentityEnv() {
  const name = process.env.AGENT_GIT_NAME || "steering-agent-executor";
  const email =
    process.env.AGENT_GIT_EMAIL || "steering-agent-executor@users.noreply.github.com";

  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  };
}

function findTaskPr(repo, branch, token) {
  const prs = ghJson(
    [
      "pr",
      "list",
      "--repo",
      repo,
      "--head",
      branch,
      "--state",
      "open",
      "--limit",
      "1",
      "--json",
      "number,url",
    ],
    { token },
  );

  if (!Array.isArray(prs) || prs.length === 0) {
    return null;
  }
  return prs[0];
}

function createPr(repo, branch, title, body, token, baseBranch) {
  const result = gh(
    [
      "pr",
      "create",
      "--repo",
      repo,
      "--base",
      baseBranch,
      "--head",
      branch,
      "--title",
      title,
      "--body",
      body,
    ],
    { token },
  );

  return result.stdout.trim();
}

function countCommitsAheadOfBase(worktreeDir, branch, baseBranch) {
  runCommand("git", ["-C", worktreeDir, "fetch", "origin", baseBranch], {
    allowFailure: true,
  });

  const remoteBaseRef = `origin/${baseBranch}`;
  const remoteBaseExists = runCommand(
    "git",
    ["-C", worktreeDir, "rev-parse", "--verify", "--quiet", remoteBaseRef],
    {
      allowFailure: true,
    },
  ).status === 0;

  const baseRef = remoteBaseExists ? remoteBaseRef : baseBranch;
  const result = runCommand(
    "git",
    ["-C", worktreeDir, "rev-list", "--count", `${baseRef}..${branch}`],
    {
      allowFailure: true,
    },
  );

  if (result.status !== 0) {
    return 0;
  }

  const count = Number.parseInt(result.stdout.trim(), 10);
  if (!Number.isFinite(count) || count < 0) {
    return 0;
  }
  return count;
}

function upsertTaskPr({ repo, branch, token, task, taskId, issueNumber, verifyOutput, baseBranch }) {
  const body = buildPrBody({
    task,
    taskId,
    issueNumber,
    verifyOutput,
  });
  const existingPr = findTaskPr(repo, branch, token);

  if (existingPr) {
    gh(
      [
        "pr",
        "edit",
        String(existingPr.number),
        "--repo",
        repo,
        "--body",
        body,
      ],
      { token },
    );
    return existingPr.url;
  }

  return createPr(repo, branch, `[${taskId}] ${task.title}`, body, token, baseBranch);
}

async function finalizeReadyForReview({
  args,
  token,
  stateDir,
  logDir,
  eventProject,
  branch,
  worktreeDir,
  prUrl,
  runLogPath = "",
  note = "",
}) {
  const reviewLabelResult = gh(
    [
      "issue",
      "edit",
      String(args.issueNumber),
      "--repo",
      args.repo,
      "--add-label",
      "status:in-review",
      "--remove-label",
      "status:in-progress",
      "--remove-label",
      "status:blocked",
    ],
    { token, allowFailure: true },
  );

  await emitEvent(logDir, {
    source: "worker",
    event_type: "issue_labeled",
    repo: args.repo,
    task_id: args.taskId,
    issue_number: args.issueNumber,
    run_id: args.runId,
    attempt: args.attempt,
    branch,
    worktree: worktreeDir,
    status: reviewLabelResult.status === 0 ? "ok" : "skipped",
    data: {
      add_labels: ["status:in-review"],
      remove_labels: ["status:in-progress", "status:blocked"],
      exit_code: reviewLabelResult.status,
      stderr: trimOutput(reviewLabelResult.stderr, 500),
    },
    langsmith: {
      project: eventProject,
      correlation_key: `${args.taskId}:${args.runId}`,
    },
  });

  const commentLines = [`PR ready for review: ${prUrl}`];
  if (note) {
    commentLines.push("", note);
  }
  commentLines.push("", `Run ID: ${args.runId}`);
  if (runLogPath) {
    commentLines.push(`Log file: ${runLogPath}`);
  }

  commentIssue(args.repo, args.issueNumber, commentLines.join("\n"), token);

  const runUpdate = {
    run_id: args.runId,
    status: "ready_for_review",
    finished_at: nowIso(),
    pr_url: prUrl,
  };
  if (runLogPath) {
    runUpdate.log_path = runLogPath;
  }
  await upsertRun(stateDir, runUpdate);

  await emitEvent(logDir, {
    source: "worker",
    event_type: "pr_opened",
    repo: args.repo,
    task_id: args.taskId,
    issue_number: args.issueNumber,
    run_id: args.runId,
    attempt: args.attempt,
    branch,
    worktree: worktreeDir,
    status: "ok",
    data: {
      pr_url: prUrl,
    },
    langsmith: {
      project: eventProject,
      correlation_key: `${args.taskId}:${args.runId}`,
    },
  });

  await emitEvent(logDir, {
    source: "worker",
    event_type: "run_completed",
    repo: args.repo,
    task_id: args.taskId,
    issue_number: args.issueNumber,
    run_id: args.runId,
    attempt: args.attempt,
    branch,
    worktree: worktreeDir,
    status: "ok",
    data: {
      pr_url: prUrl,
    },
    langsmith: {
      project: eventProject,
      correlation_key: `${args.taskId}:${args.runId}`,
    },
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.EXECUTOR_BOT_TOKEN || "";
  const repoRoot = process.cwd();
  const stateDir = defaultStateDir();
  const logDir = defaultLogDir();
  const baseBranch = process.env.BASE_BRANCH || "main";
  const langsmithProject =
    process.env.DEEPAGENTS_LANGSMITH_PROJECT || process.env.LANGSMITH_PROJECT || "";
  const tracingConfig = resolveDeepAgentsEnv();
  const eventProject = tracingConfig.tracing_project || langsmithProject || "unknown";
  const maxAgentRuntimeMinutes = Number(process.env.MAX_AGENT_RUNTIME_MINUTES || "20");
  const maxAgentRuntimeMs = Math.max(1, maxAgentRuntimeMinutes) * 60 * 1000;

  logStep(
    `worker start task=${args.taskId} run=${args.runId} issue=${args.issueNumber} timeout=${maxAgentRuntimeMinutes}m`,
  );

  if (!args.repo || !args.taskId || !args.issueNumber || !args.runId) {
    throw new Error("Missing required args: --repo, --task-id, --issue-number, --run-id");
  }
  if (!token) {
    throw new Error("Missing EXECUTOR_BOT_TOKEN env var");
  }

  await ensureRuntimeDirs(stateDir, logDir);

  const branch = `agent/${args.taskId}`;
  const task = await readTaskContract(repoRoot, args.taskId);
  logStep(`loading task contract tasks/${args.taskId}.json`);
  const worktreeDir = await ensureWorktree(
    repoRoot,
    args.taskId,
    branch,
    defaultWorktreeBase(),
  );
  logStep(`using worktree ${worktreeDir}`);

  await upsertRun(stateDir, {
    run_id: args.runId,
    task_id: args.taskId,
    issue_number: args.issueNumber,
    branch,
    attempt: args.attempt,
    status: "running",
    started_at: nowIso(),
    worktree: worktreeDir,
  });

  await emitEvent(logDir, {
    source: "worker",
    event_type: "agent_started",
    repo: args.repo,
    task_id: args.taskId,
    issue_number: args.issueNumber,
    run_id: args.runId,
    attempt: args.attempt,
    branch,
    worktree: worktreeDir,
    status: "ok",
    data: {
      command: "deepagents -n <prompt>",
      agent: process.env.DEEPAGENTS_AGENT || "build",
      timeout_minutes: maxAgentRuntimeMinutes,
      tracing_mode: tracingConfig.tracing_mode,
      tracing_project: tracingConfig.tracing_project,
      tracing_note: tracingConfig.note,
    },
    langsmith: {
      project: eventProject,
      correlation_key: `${args.taskId}:${args.runId}`,
    },
  });

  commentIssue(
    args.repo,
    args.issueNumber,
    [
      `Run started: ${args.runId}`,
      `Branch: ${branch}`,
      `Tracing mode: ${tracingConfig.tracing_mode}`,
      `Tracing project: ${tracingConfig.tracing_project || "(default)"}`,
      `Max runtime: ${maxAgentRuntimeMinutes} minute(s)`,
    ].join("\n"),
    token,
  );

  let deepagentsOutput = "";
  let verifyOutput = "";
  let prUrl = "";

  try {
    const prompt = buildDeepAgentsPrompt({
      task,
      taskId: args.taskId,
      issueNumber: args.issueNumber,
      runId: args.runId,
      branch,
    });

    logStep(
      `starting deepagents run (agent=${process.env.DEEPAGENTS_AGENT || "build"}, tracing=${tracingConfig.tracing_mode}, project=${tracingConfig.tracing_project || "default"})`,
    );

    const deepagentsResult = runCommand(
      "deepagents",
      deepAgentsCommandArgs(prompt),
      {
        cwd: worktreeDir,
        env: tracingConfig.env,
        timeoutMs: maxAgentRuntimeMs,
        capture: false,
        allowFailure: true,
      },
    );
    deepagentsOutput = "(streamed live to worker log)";
    logStep(`deepagents completed exit=${deepagentsResult.status}`);

    if (deepagentsResult.status !== 0) {
      throw new Error(`deepagents exited with code ${deepagentsResult.status}`);
    }

    await emitEvent(logDir, {
      source: "worker",
      event_type: "agent_finished",
      repo: args.repo,
      task_id: args.taskId,
      issue_number: args.issueNumber,
      run_id: args.runId,
      attempt: args.attempt,
      branch,
      worktree: worktreeDir,
      status: "ok",
      data: {
        exit_code: deepagentsResult.status,
      },
      langsmith: {
        project: eventProject,
        correlation_key: `${args.taskId}:${args.runId}`,
      },
    });

    await emitEvent(logDir, {
      source: "worker",
      event_type: "verify_started",
      repo: args.repo,
      task_id: args.taskId,
      issue_number: args.issueNumber,
      run_id: args.runId,
      attempt: args.attempt,
      branch,
      worktree: worktreeDir,
      status: "ok",
      data: {
        verify_command: task.verify_command,
      },
      langsmith: {
        project: eventProject,
        correlation_key: `${args.taskId}:${args.runId}`,
      },
    });

    const verifyResult = runCommand("bash", ["-lc", task.verify_command], {
      cwd: worktreeDir,
      allowFailure: true,
    });
    verifyOutput = `${verifyResult.stdout}\n${verifyResult.stderr}`.trim();
    logStep(`verify completed exit=${verifyResult.status}`);

    await emitEvent(logDir, {
      source: "worker",
      event_type: "verify_finished",
      repo: args.repo,
      task_id: args.taskId,
      issue_number: args.issueNumber,
      run_id: args.runId,
      attempt: args.attempt,
      branch,
      worktree: worktreeDir,
      status: verifyResult.status === 0 ? "ok" : "failed",
      data: {
        verify_command: task.verify_command,
        exit_code: verifyResult.status,
      },
      langsmith: {
        project: eventProject,
        correlation_key: `${args.taskId}:${args.runId}`,
      },
    });

    const runLog = [
      "=== tracing config ===",
      `mode: ${tracingConfig.tracing_mode}`,
      `project: ${tracingConfig.tracing_project || "(default)"}`,
      `note: ${tracingConfig.note}`,
      "",
      "=== deepagents output ===",
      deepagentsOutput,
      "",
      "=== verify output ===",
      verifyOutput,
    ].join("\n");
    const runLogPath = await writeRunLog(logDir, args.runId, `${runLog}\n`);

    if (verifyResult.status !== 0) {
      markIssueBlocked(args.repo, args.issueNumber, token);

      await emitEvent(logDir, {
        source: "worker",
        event_type: "issue_labeled",
        repo: args.repo,
        task_id: args.taskId,
        issue_number: args.issueNumber,
        run_id: args.runId,
        attempt: args.attempt,
        branch,
        worktree: worktreeDir,
        status: "ok",
        data: {
          add_labels: ["status:blocked"],
          remove_labels: ["status:in-progress"],
        },
        langsmith: {
          project: eventProject,
          correlation_key: `${args.taskId}:${args.runId}`,
        },
      });

      commentIssue(
        args.repo,
        args.issueNumber,
        [
          `Task ${args.taskId} failed verify command.`,
          "",
          `Run ID: ${args.runId}`,
          `Log file: ${runLogPath}`,
        ].join("\n"),
        token,
      );

      await upsertRun(stateDir, {
        run_id: args.runId,
        status: "verify_failed",
        finished_at: nowIso(),
        log_path: runLogPath,
      });

      await emitEvent(logDir, {
        source: "worker",
        event_type: "run_failed",
        repo: args.repo,
        task_id: args.taskId,
        issue_number: args.issueNumber,
        run_id: args.runId,
        attempt: args.attempt,
        branch,
        worktree: worktreeDir,
        status: "failed",
        data: {
          reason: "verify_failed",
          log_path: runLogPath,
        },
        langsmith: {
          project: eventProject,
          correlation_key: `${args.taskId}:${args.runId}`,
        },
      });

      return;
    }

    if (!hasGitChanges(worktreeDir)) {
      const commitsAhead = countCommitsAheadOfBase(worktreeDir, branch, baseBranch);
      const hasBranchCommits = commitsAhead > 0;
      const existingPr = findTaskPr(args.repo, branch, token);

      if (hasBranchCommits || existingPr) {
        logStep(
          `no working tree changes; reusing branch state (ahead=${commitsAhead}, existing_pr=${existingPr ? String(existingPr.number) : "none"})`,
        );

        if (hasBranchCommits) {
          runCommand("git", ["-C", worktreeDir, "push", "-u", "origin", branch], {
            capture: false,
          });
          logStep(`pushed existing branch commits for ${branch}`);
        }

        prUrl = upsertTaskPr({
          repo: args.repo,
          branch,
          token,
          task,
          taskId: args.taskId,
          issueNumber: args.issueNumber,
          verifyOutput,
          baseBranch,
        });

        await finalizeReadyForReview({
          args,
          token,
          stateDir,
          logDir,
          eventProject,
          branch,
          worktreeDir,
          prUrl,
          runLogPath,
          note: "No new working tree edits were produced in this run; reused existing committed branch changes.",
        });

        logStep(`run completed from existing branch commits pr=${prUrl}`);
        return;
      }

      markIssueBlocked(args.repo, args.issueNumber, token);

      await emitEvent(logDir, {
        source: "worker",
        event_type: "issue_labeled",
        repo: args.repo,
        task_id: args.taskId,
        issue_number: args.issueNumber,
        run_id: args.runId,
        attempt: args.attempt,
        branch,
        worktree: worktreeDir,
        status: "ok",
        data: {
          add_labels: ["status:blocked"],
          remove_labels: ["status:in-progress"],
        },
        langsmith: {
          project: eventProject,
          correlation_key: `${args.taskId}:${args.runId}`,
        },
      });

      commentIssue(
        args.repo,
        args.issueNumber,
        `Task ${args.taskId} completed without file changes or ahead branch commits. Run ID: ${args.runId}`,
        token,
      );

      await upsertRun(stateDir, {
        run_id: args.runId,
        status: "no_changes",
        finished_at: nowIso(),
        log_path: runLogPath,
      });

      await emitEvent(logDir, {
        source: "worker",
        event_type: "run_failed",
        repo: args.repo,
        task_id: args.taskId,
        issue_number: args.issueNumber,
        run_id: args.runId,
        attempt: args.attempt,
        branch,
        worktree: worktreeDir,
        status: "failed",
        data: {
          reason: "no_changes",
          log_path: runLogPath,
          commits_ahead: commitsAhead,
        },
        langsmith: {
          project: eventProject,
          correlation_key: `${args.taskId}:${args.runId}`,
        },
      });

      return;
    }

    const gitEnv = ensureGitIdentityEnv();
    logStep("staging and committing changes");
    runCommand("git", ["-C", worktreeDir, "add", "."], { capture: false });
    runCommand(
      "git",
      [
        "-C",
        worktreeDir,
        "commit",
        "-m",
        `feat(${args.taskId}): ${task.title}`,
      ],
      { capture: false, env: gitEnv },
    );
    runCommand("git", ["-C", worktreeDir, "push", "-u", "origin", branch], {
      capture: false,
    });
    logStep(`pushed branch ${branch}`);

    prUrl = upsertTaskPr({
      repo: args.repo,
      branch,
      token,
      task,
      taskId: args.taskId,
      issueNumber: args.issueNumber,
      verifyOutput,
      baseBranch,
    });

    await finalizeReadyForReview({
      args,
      token,
      stateDir,
      logDir,
      eventProject,
      branch,
      worktreeDir,
      prUrl,
      runLogPath,
    });

    logStep(`run completed successfully pr=${prUrl}`);
  } catch (error) {
    const message = error.message || String(error);
    logStep(`run failed: ${message}`);
    const runLog = [
      "=== tracing config ===",
      `mode: ${tracingConfig.tracing_mode}`,
      `project: ${tracingConfig.tracing_project || "(default)"}`,
      `note: ${tracingConfig.note}`,
      "",
      "=== deepagents output ===",
      deepagentsOutput,
      "",
      "=== verify output ===",
      verifyOutput,
      "",
      "=== error ===",
      message,
    ].join("\n");
    const runLogPath = await writeRunLog(logDir, args.runId, `${runLog}\n`);

    markIssueBlocked(args.repo, args.issueNumber, token);

    await emitEvent(logDir, {
      source: "worker",
      event_type: "issue_labeled",
      repo: args.repo,
      task_id: args.taskId,
      issue_number: args.issueNumber,
      run_id: args.runId,
      attempt: args.attempt,
      branch,
      worktree: worktreeDir,
      status: "ok",
      data: {
        add_labels: ["status:blocked"],
        remove_labels: ["status:in-progress", "status:in-review"],
      },
      langsmith: {
        project: eventProject,
        correlation_key: `${args.taskId}:${args.runId}`,
      },
    });

    commentIssue(
      args.repo,
      args.issueNumber,
      [
        `Task ${args.taskId} failed.`,
        "",
        `Run ID: ${args.runId}`,
        `Error: ${message}`,
        `Log file: ${runLogPath}`,
      ].join("\n"),
      token,
    );

    await upsertRun(stateDir, {
      run_id: args.runId,
      status: "failed",
      finished_at: nowIso(),
      failure_reason: message,
      pr_url: prUrl,
      log_path: runLogPath,
    });

    await emitEvent(logDir, {
      source: "worker",
      event_type: "run_failed",
      repo: args.repo,
      task_id: args.taskId,
      issue_number: args.issueNumber,
      run_id: args.runId,
      attempt: args.attempt,
      branch,
      worktree: worktreeDir,
      status: "failed",
      data: {
        reason: message,
        pr_url: prUrl,
      },
      langsmith: {
        project: eventProject,
        correlation_key: `${args.taskId}:${args.runId}`,
      },
    });

    process.exitCode = 1;
  } finally {
    await releaseTaskLock(stateDir, args.taskId);
    logStep(`released lock for ${args.taskId}`);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
