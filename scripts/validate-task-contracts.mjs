import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const TASKS_DIR = path.join(ROOT, "tasks");

const REQUIRED_STRING_FIELDS = [
  "task_id",
  "title",
  "goal",
  "verify_command",
  "rollback_note",
  "phase",
  "priority",
  "track",
  "risk_level",
];

const REQUIRED_ARRAY_FIELDS = [
  "inputs",
  "expected_outputs",
  "constraints",
  "definition_of_done",
];

const PHASES = new Set(["foundation", "hardening", "methodology", "rollout"]);
const PRIORITIES = new Set(["high", "medium", "low"]);
const RISK_LEVELS = new Set(["low", "medium", "high"]);

const TRACKS = new Set([
  "runtime",
  "control-plane",
  "evaluation",
  "feedback-loop",
  "rollout",
]);

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function validateTask(task, fileName) {
  const errors = [];

  for (const field of REQUIRED_STRING_FIELDS) {
    if (!isNonEmptyString(task[field])) {
      errors.push(`${field} must be a non-empty string`);
    }
  }

  for (const field of REQUIRED_ARRAY_FIELDS) {
    if (!isStringArray(task[field])) {
      errors.push(`${field} must be an array of strings`);
    } else if (task[field].length === 0) {
      errors.push(`${field} must not be empty`);
    }
  }

  if (task.phase && !PHASES.has(task.phase)) {
    errors.push("phase must be one of: foundation, hardening, methodology, rollout");
  }

  if (task.priority && !PRIORITIES.has(task.priority)) {
    errors.push("priority must be one of: high, medium, low");
  }

  if (task.track && !TRACKS.has(task.track)) {
    errors.push("track must be one of: runtime, control-plane, evaluation, feedback-loop, rollout");
  }

  if (task.risk_level && !RISK_LEVELS.has(task.risk_level)) {
    errors.push("risk_level must be one of: low, medium, high");
  }

  if (task.task_id && !/^P[0-3]-\d{2}$/.test(task.task_id)) {
    errors.push("task_id must match pattern P0-00, P1-00, P2-00, or P3-00");
  }

  const expectedFileName = `${task.task_id}.json`;
  if (task.task_id && fileName !== expectedFileName) {
    errors.push(`file name must match task_id (${expectedFileName})`);
  }

  if (task.dependencies && !isStringArray(task.dependencies)) {
    errors.push("dependencies must be an array of strings if provided");
  }

  return errors;
}

async function main() {
  const entries = await readdir(TASKS_DIR, { withFileTypes: true });
  const taskFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .filter((entry) => entry.name !== "task-contract.schema.json")
    .map((entry) => entry.name)
    .sort();

  if (taskFiles.length === 0) {
    throw new Error("No task contract files found in tasks/");
  }

  const seenTaskIds = new Set();
  const allErrors = [];

  for (const fileName of taskFiles) {
    const filePath = path.join(TASKS_DIR, fileName);
    const raw = await readFile(filePath, "utf8");
    let task;

    try {
      task = JSON.parse(raw);
    } catch (error) {
      allErrors.push(`${fileName}: invalid JSON (${error.message})`);
      continue;
    }

    const errors = validateTask(task, fileName);
    for (const error of errors) {
      allErrors.push(`${fileName}: ${error}`);
    }

    if (task.task_id) {
      if (seenTaskIds.has(task.task_id)) {
        allErrors.push(`${fileName}: duplicate task_id ${task.task_id}`);
      }
      seenTaskIds.add(task.task_id);
    }
  }

  if (allErrors.length > 0) {
    console.error("Task validation failed:\n");
    for (const error of allErrors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log(`Validated ${taskFiles.length} task contracts successfully.`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
