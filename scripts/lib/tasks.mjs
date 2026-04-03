import path from "node:path";
import { readFile } from "node:fs/promises";

export function taskIdFromTitle(title) {
  const match = String(title).match(/\[(P[0-2]-\d{2})\]/);
  return match ? match[1] : null;
}

export async function readTaskContract(repoRoot, taskId) {
  const taskPath = path.join(repoRoot, "tasks", `${taskId}.json`);
  const raw = await readFile(taskPath, "utf8");
  return JSON.parse(raw);
}

export function dependenciesSatisfied(task, closedTaskIds) {
  const dependencies = Array.isArray(task.dependencies) ? task.dependencies : [];
  return dependencies.every((dependency) => closedTaskIds.has(dependency));
}

export function sanitizeTaskText(text) {
  return String(text || "").replace(/\r\n/g, "\n").trim();
}

export function buildDeepAgentsPrompt({
  task,
  taskId,
  issueNumber,
  runId,
  branch,
}) {
  const goal = sanitizeTaskText(task.goal);
  const constraints = Array.isArray(task.constraints) ? task.constraints : [];
  const definitionOfDone = Array.isArray(task.definition_of_done)
    ? task.definition_of_done
    : [];

  const lines = [];
  lines.push(
    `RUN_CONTEXT task_id=${taskId} run_id=${runId} issue=${issueNumber} branch=${branch}`,
  );
  lines.push(`Implement exactly one task contract: tasks/${taskId}.json.`);
  lines.push("Follow AGENTS.md strictly.");
  lines.push(`Task goal: ${goal}`);
  lines.push("Constraints:");
  for (const constraint of constraints) {
    lines.push(`- ${sanitizeTaskText(constraint)}`);
  }
  lines.push(`Run verify command exactly: ${sanitizeTaskText(task.verify_command)}`);
  lines.push("Definition of done:");
  for (const item of definitionOfDone) {
    lines.push(`- ${sanitizeTaskText(item)}`);
  }
  lines.push(
    "When done, prepare changes for a PR and include verify output summary and rollback note in the PR body.",
  );
  lines.push(`Rollback note: ${sanitizeTaskText(task.rollback_note)}`);
  lines.push("Do not do unrelated refactors.");

  return lines.join("\n");
}
