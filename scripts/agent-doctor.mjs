#!/usr/bin/env node

import path from "node:path";
import { access, readdir, readFile } from "node:fs/promises";
import { runCommand } from "./lib/command.mjs";
import { ghJson, issueTaskIdFromTitle } from "./lib/github.mjs";
import {
  defaultLogDir,
  defaultStateDir,
  isPidAlive,
  lockDirPath,
  readRuns,
  runsFilePath,
} from "./lib/state.mjs";

function parseArgs(argv) {
  const args = {
    repo: process.env.REPO || "hntrl/steering-rl",
    strict: false,
    smoke: false,
    format: "text",
    failThreshold: 1,
    warnThreshold: -1,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--repo") {
      args.repo = argv[i + 1] || args.repo;
      i += 1;
    } else if (token === "--strict") {
      args.strict = true;
    } else if (token === "--smoke") {
      args.smoke = true;
    } else if (token === "--format") {
      args.format = argv[i + 1] || args.format;
      i += 1;
    } else if (token === "--fail-threshold") {
      args.failThreshold = parseInt(argv[i + 1], 10);
      i += 1;
    } else if (token === "--warn-threshold") {
      args.warnThreshold = parseInt(argv[i + 1], 10);
      i += 1;
    }
  }

  return args;
}

function addResult(results, level, title, message, remediation) {
  const entry = { level, title, message };
  if (remediation) entry.remediation = remediation;
  results.push(entry);
}

const SECRET_ENV_NAMES = new Set([
  "EXECUTOR_BOT_TOKEN",
  "LANGSMITH_API_KEY",
  "LANGCHAIN_API_KEY",
  "GH_TOKEN",
  "GITHUB_TOKEN",
]);

function redactSecrets(value) {
  if (typeof value !== "string") return value;
  let redacted = value;
  for (const name of SECRET_ENV_NAMES) {
    const secret = process.env[name];
    if (secret && secret.length >= 4) {
      while (redacted.includes(secret)) {
        redacted = redacted.replace(secret, "***REDACTED***");
      }
    }
  }
  return redacted;
}

function redactResult(item) {
  return {
    ...item,
    message: redactSecrets(item.message),
    ...(item.remediation ? { remediation: redactSecrets(item.remediation) } : {}),
  };
}

function levelTag(level) {
  if (level === "ok") return "[OK]";
  if (level === "warn") return "[WARN]";
  return "[FAIL]";
}

function formatList(items, limit = 5) {
  if (items.length === 0) return "none";
  const shown = items.slice(0, limit).join(", ");
  if (items.length <= limit) return shown;
  return `${shown} ... (+${items.length - limit} more)`;
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractProjectNames(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) {
    return payload
      .map((item) => (item && typeof item === "object" ? item.name : null))
      .filter((name) => typeof name === "string" && name.length > 0);
  }
  if (Array.isArray(payload.data)) return extractProjectNames(payload.data);
  if (Array.isArray(payload.projects)) return extractProjectNames(payload.projects);
  return [];
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function loadTaskContract(repoRoot, taskId) {
  const taskPath = path.join(repoRoot, "tasks", `${taskId}.json`);
  const raw = await readFile(taskPath, "utf8");
  return JSON.parse(raw);
}

async function checkCommands(results) {
  const commands = ["gh", "deepagents", "langsmith", "node", "pnpm"];
  for (const command of commands) {
    const res = runCommand("which", [command], { allowFailure: true });
    if (res.status === 0) {
      addResult(results, "ok", `Command ${command}`, res.stdout.trim());
    } else {
      addResult(results, "fail", `Command ${command}`, "not found in PATH", `Install ${command} and ensure it is on your PATH`);
    }
  }
}

function checkDeepAgentsConfig(results) {
  const agent = process.env.DEEPAGENTS_AGENT || "build (default)";
  const model = process.env.DEEPAGENTS_MODEL || "(default)";
  const defaultAllowList =
    "cd,git,pnpm,npm,node,npx,python3,bash,sh,ls,cat,head,tail,grep,pwd,which,cp,mv,rm,mkdir,touch";
  const allowList = process.env.DEEPAGENTS_SHELL_ALLOW_LIST || defaultAllowList;

  addResult(results, "ok", "DeepAgents agent", agent);
  addResult(results, "ok", "DeepAgents model", model);

  const normalized = allowList.trim().toLowerCase();
  const commands = new Set(
    normalized
      .replace(/\s+/g, "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );

  if (normalized === "all") {
    addResult(
      results,
      "warn",
      "DeepAgents shell allow list",
      "'all' behaves as a literal allow-list entry and can block normal commands; use an explicit command list",
      "Set DEEPAGENTS_SHELL_ALLOW_LIST to an explicit comma-separated command list",
    );
    return;
  }

  if (commands.has("recommended")) {
    addResult(
      results,
      "warn",
      "DeepAgents shell allow list",
      "'recommended' is often read-only and may block pnpm/git commands needed for coding tasks",
      "Set DEEPAGENTS_SHELL_ALLOW_LIST to an explicit comma-separated command list",
    );
    return;
  }

  const required = ["cd", "git", "pnpm", "node", "bash"];
  const missing = required.filter((command) => !commands.has(command));
  if (missing.length > 0) {
    addResult(
      results,
      "warn",
      "DeepAgents shell allow list",
      `missing coding commands: ${missing.join(",")}`,
      `Add missing commands to DEEPAGENTS_SHELL_ALLOW_LIST: ${missing.join(",")}`,
    );
    return;
  }

  addResult(results, "ok", "DeepAgents shell allow list", allowList);
}

async function checkGithub(results, args, token) {
  if (!token) {
    addResult(results, "fail", "EXECUTOR_BOT_TOKEN", "missing", "Set EXECUTOR_BOT_TOKEN environment variable with a valid GitHub token");
    return;
  }

  let login = "";
  try {
    login = runCommand("gh", ["api", "user", "-q", ".login"], {
      env: { GH_TOKEN: token, GH_PROMPT_DISABLED: "1", GH_PAGER: "cat" },
    }).stdout.trim();
    addResult(results, "ok", "Executor identity", login);
  } catch (error) {
    addResult(results, "fail", "Executor identity", error.message || String(error), "Verify EXECUTOR_BOT_TOKEN is valid and gh CLI is authenticated");
    return;
  }

  try {
    const repoData = ghJson(["repo", "view", args.repo, "--json", "nameWithOwner,defaultBranchRef"], {
      token,
    });
    const branch = repoData?.defaultBranchRef?.name || "main";
    addResult(results, "ok", "Repo access", `${repoData.nameWithOwner} (default ${branch})`);
  } catch (error) {
    addResult(results, "fail", "Repo access", error.message || String(error), `Ensure the token has access to ${args.repo}`);
    return;
  }

  try {
    const protection = ghJson(["api", `repos/${args.repo}/branches/main/protection`], { token });
    const checks = protection?.required_status_checks?.contexts || [];
    const hasVerify = checks.includes("verify");
    addResult(
      results,
      hasVerify ? "ok" : "warn",
      "Branch protection",
      `required checks: ${formatList(checks, 10)}`,
    );
  } catch (error) {
    addResult(results, "warn", "Branch protection", error.message || String(error));
  }
}

async function checkIssueQueue(results, args, repoRoot, token) {
  if (!token) return;

  let openIssues = [];
  let closedIssues = [];
  try {
    openIssues =
      ghJson(
        [
          "issue",
          "list",
          "--repo",
          args.repo,
          "--state",
          "open",
          "--limit",
          "200",
          "--json",
          "number,title,labels",
        ],
        { token },
      ) || [];
    closedIssues =
      ghJson(
        [
          "issue",
          "list",
          "--repo",
          args.repo,
          "--state",
          "closed",
          "--limit",
          "500",
          "--json",
          "title",
        ],
        { token },
      ) || [];
  } catch (error) {
    addResult(results, "warn", "Issue queue", error.message || String(error));
    return;
  }

  const todo = [];
  const blocked = [];
  const inProgress = [];
  const inReview = [];
  const statusByTaskId = new Map();
  for (const issue of openIssues) {
    const names = (issue.labels || []).map((label) => label.name);
    const taskId = issueTaskIdFromTitle(issue.title || "");
    if (!taskId) continue;
    const status = names.includes("status:blocked")
      ? "blocked"
      : names.includes("status:in-progress")
        ? "in-progress"
        : names.includes("status:in-review")
          ? "in-review"
          : names.includes("status:todo")
            ? "todo"
            : "unknown";

    statusByTaskId.set(taskId, { status, issueNumber: issue.number });

    if (status === "todo") todo.push(taskId);
    if (status === "blocked") blocked.push(taskId);
    if (status === "in-progress") inProgress.push(taskId);
    if (status === "in-review") inReview.push(taskId);
  }

  addResult(
    results,
    "ok",
    "Issue status counts",
    `todo=${todo.length}, in-progress=${inProgress.length}, in-review=${inReview.length}, blocked=${blocked.length}`,
  );

  const closedTaskIds = new Set();
  for (const issue of closedIssues) {
    const taskId = issueTaskIdFromTitle(issue.title || "");
    if (taskId) closedTaskIds.add(taskId);
  }

  const ready = [];
  const blockedDeps = [];
  for (const taskId of todo) {
    try {
      const task = await loadTaskContract(repoRoot, taskId);
      const deps = Array.isArray(task.dependencies) ? task.dependencies : [];
      const missing = deps.filter((dep) => !closedTaskIds.has(dep));
      if (missing.length === 0) {
        ready.push(taskId);
      } else {
        blockedDeps.push(`${taskId} (missing: ${missing.join(",")})`);
      }
    } catch {
      blockedDeps.push(`${taskId} (missing local contract)`);
    }
  }

  addResult(results, ready.length > 0 ? "ok" : "warn", "Dependency-ready tasks", formatList(ready, 8));
  if (blockedDeps.length > 0) {
    addResult(results, "warn", "Tasks blocked by dependencies", formatList(blockedDeps, 8));
  }

  const rootBlockedActions = [];
  for (const [taskId, meta] of statusByTaskId.entries()) {
    if (meta.status !== "blocked") {
      continue;
    }

    try {
      const task = await loadTaskContract(repoRoot, taskId);
      const deps = Array.isArray(task.dependencies) ? task.dependencies : [];
      if (deps.length === 0) {
        rootBlockedActions.push(
          `#${meta.issueNumber} (${taskId}) -> gh issue edit ${meta.issueNumber} --repo ${args.repo} --add-label status:todo --remove-label status:blocked`,
        );
      }
    } catch {
      // Ignore missing contracts here; already reported elsewhere.
    }
  }

  if (rootBlockedActions.length > 0) {
    addResult(
      results,
      "warn",
      "Root tasks blocked",
      `Unblock and retry: ${formatList(rootBlockedActions, 3)}`,
    );
  }
}

async function checkRuntimeState(results) {
  const stateDir = defaultStateDir();
  const logDir = defaultLogDir();
  const runsPath = runsFilePath(stateDir);
  const locksPath = lockDirPath(stateDir);

  addResult(results, "ok", "State dir", stateDir);
  addResult(results, "ok", "Log dir", logDir);

  if (!(await fileExists(runsPath))) {
    addResult(results, "warn", "Run state file", `${runsPath} not found`);
    return;
  }

  let runs = [];
  try {
    runs = await readRuns(stateDir);
  } catch (error) {
    addResult(results, "fail", "Run state file", error.message || String(error));
    return;
  }

  if (runs.length === 0) {
    addResult(results, "warn", "Run history", "no runs recorded");
  } else {
    addResult(results, "ok", "Run history", `${runs.length} total runs`);
  }

  const running = runs.filter((run) => run.status === "running");
  const failed = runs.filter((run) => run.status === "failed" || run.status === "verify_failed");
  const ready = runs.filter((run) => run.status === "ready_for_review");
  addResult(
    results,
    "ok",
    "Run status summary",
    `running=${running.length}, failed=${failed.length}, ready_for_review=${ready.length}`,
  );

  if (running.length > 0) {
    for (const run of running.slice(0, 5)) {
      const alive = isPidAlive(run.pid);
      addResult(
        results,
        alive ? "ok" : "warn",
        `Running ${run.task_id}`,
        `run_id=${run.run_id}, pid=${run.pid}, alive=${alive}, log=${run.log_path || "n/a"}`,
      );
    }
  }

  if (failed.length > 0) {
    const latest = failed[failed.length - 1];
    const reason = String(latest.failure_reason || "unknown").replace(/\s+/g, " ").slice(0, 180);
    addResult(
      results,
      "warn",
      "Latest failed run",
      `${latest.run_id} (${latest.task_id}) reason=${reason}${reason.length === 180 ? "..." : ""}`,
    );
    if (latest.log_path) {
      addResult(results, "warn", "Latest failed log path", latest.log_path);
    }
  }

  if (await fileExists(locksPath)) {
    const locks = (await readdir(locksPath)).filter(Boolean);
    addResult(
      results,
      locks.length === 0 ? "ok" : "warn",
      "Task locks",
      locks.length === 0 ? "none" : formatList(locks, 10),
    );
  }
}

async function checkLangSmith(results) {
  const apiKey = process.env.LANGSMITH_API_KEY || process.env.LANGCHAIN_API_KEY || "";
  const desired =
    process.env.DEEPAGENTS_LANGSMITH_PROJECT ||
    process.env.LANGSMITH_PROJECT ||
    process.env.LANGCHAIN_PROJECT ||
    "";

  if (!apiKey) {
    addResult(results, "warn", "LangSmith API key", "missing (LANGSMITH_API_KEY or LANGCHAIN_API_KEY)", "Set LANGSMITH_API_KEY or LANGCHAIN_API_KEY environment variable");
    return;
  }

  const probe = runCommand(
    "langsmith",
    ["project", "list", "--limit", "200", "--format", "json"],
    { allowFailure: true },
  );
  if (probe.status !== 0) {
    addResult(results, "warn", "LangSmith project list", probe.stderr.trim() || "command failed");
    return;
  }

  const payload = safeJsonParse(probe.stdout);
  const names = extractProjectNames(payload);
  addResult(results, "ok", "LangSmith visible projects", `${names.length}`);

  if (desired) {
    if (names.includes(desired)) {
      addResult(results, "ok", "Configured LangSmith project", `${desired} exists`);
    } else {
      const fallback = names[0] || "none";
      addResult(
        results,
        "warn",
        "Configured LangSmith project",
        `${desired} not found; worker will fallback to ${fallback}`,
      );
    }
  } else {
    addResult(results, "warn", "Configured LangSmith project", "none set in env", "Set DEEPAGENTS_LANGSMITH_PROJECT environment variable");
  }
}

async function runSmokeCheck(results) {
  const smoke = runCommand(
    "deepagents",
    [
      "-n",
      "Reply with exactly: OK",
      "--agent",
      process.env.DEEPAGENTS_AGENT || "build",
      "--auto-approve",
      "--shell-allow-list",
      "recommended",
    ],
    {
      allowFailure: true,
      timeoutMs: 30000,
    },
  );

  if (smoke.status === 0) {
    addResult(results, "ok", "DeepAgents smoke check", "non-interactive invocation succeeded");
    return;
  }

  const detail = (smoke.stderr || smoke.stdout || "failed").trim().split("\n").slice(-1)[0];
  addResult(results, "warn", "DeepAgents smoke check", detail);
}

function printTextSummary(results) {
  const okCount = results.filter((item) => item.level === "ok").length;
  const warnCount = results.filter((item) => item.level === "warn").length;
  const failCount = results.filter((item) => item.level === "fail").length;

  console.log("Agent Doctor Report");
  console.log(`- Timestamp: ${new Date().toISOString()}`);
  console.log(`- Results: ok=${okCount}, warn=${warnCount}, fail=${failCount}`);
  console.log("");

  for (const item of results) {
    const redacted = redactResult(item);
    const parts = [`${levelTag(redacted.level)} ${redacted.title}: ${redacted.message}`];
    if (redacted.remediation) {
      parts.push(`  -> ${redacted.remediation}`);
    }
    console.log(parts.join("\n"));
  }
}

function printJsonSummary(results) {
  const okCount = results.filter((item) => item.level === "ok").length;
  const warnCount = results.filter((item) => item.level === "warn").length;
  const failCount = results.filter((item) => item.level === "fail").length;

  const report = {
    schema_version: 1,
    timestamp: new Date().toISOString(),
    summary: {
      ok: okCount,
      warn: warnCount,
      fail: failCount,
      total: results.length,
    },
    checks: results.map(redactResult),
  };

  console.log(JSON.stringify(report, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const token = process.env.EXECUTOR_BOT_TOKEN || "";
  const results = [];

  addResult(results, "ok", "Repo", args.repo);
  await checkCommands(results);
  checkDeepAgentsConfig(results);
  await checkGithub(results, args, token);
  await checkIssueQueue(results, args, repoRoot, token);
  await checkRuntimeState(results);
  await checkLangSmith(results);

  if (args.smoke) {
    await runSmokeCheck(results);
  }

  if (args.format === "json") {
    printJsonSummary(results);
  } else {
    printTextSummary(results);
  }

  const failCount = results.filter((item) => item.level === "fail").length;
  const warnCount = results.filter((item) => item.level === "warn").length;
  if (args.strict) {
    const failThreshold = args.failThreshold >= 0 ? args.failThreshold : 1;
    const warnThreshold = args.warnThreshold >= 0 ? args.warnThreshold : -1;
    if (failCount >= failThreshold || (warnThreshold >= 0 && warnCount >= warnThreshold)) {
      process.exit(1);
    }
  } else if (failCount > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
