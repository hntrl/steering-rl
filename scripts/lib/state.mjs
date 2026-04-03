import os from "node:os";
import path from "node:path";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";

function homePath(...parts) {
  return path.join(os.homedir(), ...parts);
}

export function defaultStateDir() {
  return process.env.AGENT_STATE_DIR || homePath(".agentd", "state");
}

export function defaultLogDir() {
  return process.env.AGENT_LOG_DIR || homePath(".agentd", "logs");
}

export function runsFilePath(stateDir) {
  return path.join(stateDir, "runs.json");
}

export function lockDirPath(stateDir) {
  return path.join(stateDir, "locks");
}

export function lockPath(stateDir, taskId) {
  return path.join(lockDirPath(stateDir), `${taskId}.lock`);
}

export async function ensureRuntimeDirs(stateDir, logDir) {
  await mkdir(stateDir, { recursive: true });
  await mkdir(logDir, { recursive: true });
  await mkdir(lockDirPath(stateDir), { recursive: true });

  const filePath = runsFilePath(stateDir);
  try {
    await readFile(filePath, "utf8");
  } catch {
    await writeFile(filePath, "[]\n", "utf8");
  }
}

export async function readRuns(stateDir) {
  const raw = await readFile(runsFilePath(stateDir), "utf8");
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

export async function writeRuns(stateDir, runs) {
  await writeFile(runsFilePath(stateDir), `${JSON.stringify(runs, null, 2)}\n`, "utf8");
}

export async function upsertRun(stateDir, update) {
  const runs = await readRuns(stateDir);
  const index = runs.findIndex((run) => run.run_id === update.run_id);
  const nextRun = {
    ...(index >= 0 ? runs[index] : {}),
    ...update,
    updated_at: new Date().toISOString(),
  };

  if (index >= 0) {
    runs[index] = nextRun;
  } else {
    runs.push({
      ...nextRun,
      created_at: new Date().toISOString(),
    });
  }

  await writeRuns(stateDir, runs);
  return nextRun;
}

export async function acquireTaskLock(stateDir, taskId) {
  const lock = lockPath(stateDir, taskId);
  try {
    await mkdir(lock);
    return true;
  } catch {
    return false;
  }
}

export async function releaseTaskLock(stateDir, taskId) {
  await rm(lockPath(stateDir, taskId), { recursive: true, force: true });
}

export async function hasTaskLock(stateDir, taskId) {
  const lock = lockPath(stateDir, taskId);
  let lockExists = false;

  try {
    await access(lock);
    lockExists = true;
  } catch {
    lockExists = false;
  }

  try {
    const runs = await readRuns(stateDir);
    const hasActiveRun = runs.some((run) => {
      if (run.task_id !== taskId) {
        return false;
      }

      if (run.status === "running") {
        return isPidAlive(run.pid);
      }

      return run.status === "dispatched";
    });

    if (!hasActiveRun && lockExists) {
      await rm(lock, { recursive: true, force: true });
      return false;
    }

    return hasActiveRun || lockExists;
  } catch {
    return lockExists;
  }
}

export function isPidAlive(pid) {
  if (!pid || Number.isNaN(Number(pid))) {
    return false;
  }

  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

export function canonicalizeRuns(runs) {
  const taskGroups = new Map();
  for (const run of runs) {
    const key = run.task_id;
    if (!key) continue;
    if (!taskGroups.has(key)) {
      taskGroups.set(key, []);
    }
    taskGroups.get(key).push(run);
  }

  const result = [];
  for (const [taskId, group] of taskGroups.entries()) {
    const mergedRuns = group.filter((r) => r.status === "merged");
    if (mergedRuns.length === 0) {
      result.push(...group);
      continue;
    }

    const sorted = mergedRuns.sort((a, b) =>
      String(b.updated_at || "").localeCompare(String(a.updated_at || "")),
    );
    const canonical = { ...sorted[0] };

    for (const stale of sorted.slice(1)) {
      if (!canonical.merged_at && stale.merged_at) {
        canonical.merged_at = stale.merged_at;
      }
    }

    const kept = [];
    for (const run of group) {
      if (run.status === "merged") continue;
      if (run.status === "ready_for_review" || run.status === "dispatched") continue;
      kept.push(run);
    }

    result.push(canonical, ...kept);
  }

  return result;
}

export async function writeCanonicalizedRuns(stateDir) {
  const runs = await readRuns(stateDir);
  const canonicalized = canonicalizeRuns(runs);
  await writeRuns(stateDir, canonicalized);
  return canonicalized;
}

export async function markStaleRunningRuns(stateDir) {
  const runs = await readRuns(stateDir);
  let changed = false;

  for (const run of runs) {
    if (run.status === "running" && !isPidAlive(run.pid)) {
      run.status = "failed";
      run.failure_reason = "worker_process_exited";
      run.updated_at = new Date().toISOString();
      await rm(lockPath(stateDir, run.task_id), { recursive: true, force: true });
      changed = true;
    }
  }

  if (changed) {
    await writeRuns(stateDir, runs);
  }

  return runs;
}
