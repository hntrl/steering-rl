import path from "node:path";
import { appendFile } from "node:fs/promises";

const EVENT_TYPES = new Set([
  "task_selected",
  "dispatch_started",
  "agent_started",
  "agent_finished",
  "verify_started",
  "verify_finished",
  "pr_opened",
  "issue_labeled",
  "run_failed",
  "run_completed",
  "branch_sync",
  "conflict_recovery",
]);

const SOURCES = new Set(["supervisor", "worker", "reconciler"]);
const STATUSES = new Set(["ok", "failed", "skipped"]);

function randomSuffix() {
  return Math.random().toString(36).slice(2, 8);
}

export function createRunId(taskId) {
  return `${taskId.toLowerCase()}-${Date.now()}-${randomSuffix()}`;
}

export function validateEvent(event) {
  const required = [
    "schema_version",
    "event_id",
    "timestamp",
    "source",
    "event_type",
    "repo",
    "task_id",
    "run_id",
    "status",
    "data",
  ];

  for (const field of required) {
    if (!(field in event)) {
      throw new Error(`event missing required field: ${field}`);
    }
  }

  if (event.schema_version !== 1) {
    throw new Error("event schema_version must be 1");
  }

  if (!SOURCES.has(event.source)) {
    throw new Error(`event source is invalid: ${event.source}`);
  }

  if (!EVENT_TYPES.has(event.event_type)) {
    throw new Error(`event_type is invalid: ${event.event_type}`);
  }

  if (!STATUSES.has(event.status)) {
    throw new Error(`event status is invalid: ${event.status}`);
  }

  if (typeof event.data !== "object" || event.data === null) {
    throw new Error("event data must be an object");
  }

  if (!/^P[01]-\d{2}$/.test(String(event.task_id))) {
    throw new Error(`event task_id is invalid: ${event.task_id}`);
  }
}

export async function emitEvent(logDir, input) {
  const event = {
    schema_version: 1,
    event_id: input.event_id || `evt_${Date.now()}_${randomSuffix()}`,
    timestamp: input.timestamp || new Date().toISOString(),
    ...input,
  };

  validateEvent(event);

  const eventPath = path.join(logDir, "events.jsonl");
  await appendFile(eventPath, `${JSON.stringify(event)}\n`, "utf8");
  return event;
}
