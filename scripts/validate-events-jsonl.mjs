#!/usr/bin/env node

import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { validateEvent } from "./lib/events.mjs";

function defaultPath() {
  return process.env.AGENT_EVENTS_FILE || path.join(os.homedir(), ".agentd", "logs", "events.jsonl");
}

async function main() {
  const filePath = process.argv[2] || defaultPath();
  const raw = await readFile(filePath, "utf8");
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  let errors = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    try {
      const event = JSON.parse(line);
      validateEvent(event);
    } catch (error) {
      errors += 1;
      console.error(`Line ${i + 1}: ${(error && error.message) || error}`);
    }
  }

  if (errors > 0) {
    throw new Error(`Event validation failed: ${errors} invalid event(s)`);
  }

  console.log(`Validated ${lines.length} event(s) in ${filePath}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
