import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const TASKS_DIR = path.join(ROOT, "tasks");

function parseArgs(argv) {
  const args = { repo: "", dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--repo") {
      args.repo = argv[i + 1] || "";
      i += 1;
    } else if (token === "--dry-run") {
      args.dryRun = true;
    }
  }
  return args;
}

function runGh(args, options = {}) {
  const result = spawnSync("gh", args, {
    stdio: "pipe",
    encoding: "utf8",
    ...options,
  });

  if (result.status !== 0) {
    const stderr = result.stderr || "Unknown gh error";
    throw new Error(stderr.trim());
  }

  return result.stdout;
}

function toTaskBody(task) {
  const lines = [];
  lines.push(`## Goal`);
  lines.push(task.goal);
  lines.push("");
  lines.push("## Inputs");
  for (const input of task.inputs) lines.push(`- \`${input}\``);
  lines.push("");
  lines.push("## Expected outputs");
  for (const output of task.expected_outputs) lines.push(`- \`${output}\``);
  lines.push("");
  lines.push("## Constraints");
  for (const constraint of task.constraints) lines.push(`- ${constraint}`);
  lines.push("");
  lines.push("## Verify command");
  lines.push("```bash");
  lines.push(task.verify_command);
  lines.push("```");
  lines.push("");
  lines.push("## Definition of done");
  for (const item of task.definition_of_done) lines.push(`- [ ] ${item}`);
  lines.push("");
  lines.push("## Rollback note");
  lines.push(task.rollback_note);
  lines.push("");
  if (task.dependencies && task.dependencies.length > 0) {
    lines.push("## Dependencies");
    for (const dep of task.dependencies) lines.push(`- \`${dep}\``);
    lines.push("");
  }
  return lines.join("\n");
}

async function loadTasks() {
  const entries = await readdir(TASKS_DIR, { withFileTypes: true });
  const taskFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();

  const tasks = [];
  for (const fileName of taskFiles) {
    const raw = await readFile(path.join(TASKS_DIR, fileName), "utf8");
    const task = JSON.parse(raw);
    tasks.push(task);
  }
  return tasks;
}

function issueExists(repo, taskId) {
  const stdout = runGh([
    "issue",
    "list",
    "--repo",
    repo,
    "--search",
    `in:title [${taskId}]`,
    "--state",
    "all",
    "--json",
    "number,title",
  ]);
  const issues = JSON.parse(stdout);
  return issues.some((issue) => issue.title.includes(`[${taskId}]`));
}

function createIssue(repo, task, dryRun) {
  const title = `[${task.task_id}] ${task.title}`;
  const labels = [
    `priority:${task.priority}`,
    `track:${task.track}`,
    `risk:${task.risk_level}`,
    "status:todo",
    "agent-ready",
  ];
  const body = toTaskBody(task);

  if (dryRun) {
    console.log(`DRY RUN: would create ${title}`);
    return;
  }

  runGh([
    "issue",
    "create",
    "--repo",
    repo,
    "--title",
    title,
    "--body",
    body,
    "--label",
    labels.join(","),
  ]);
  console.log(`Created issue: ${title}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.repo) {
    throw new Error("Usage: node scripts/create-gh-issues.mjs --repo owner/repo [--dry-run]");
  }

  const tasks = await loadTasks();
  for (const task of tasks) {
    if (issueExists(args.repo, task.task_id)) {
      console.log(`Skipping existing issue: [${task.task_id}]`);
      continue;
    }
    createIssue(args.repo, task, args.dryRun);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
