import { openSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";

export function runCommand(command, args, options = {}) {
  const {
    cwd,
    env,
    allowFailure = false,
    capture = true,
    timeoutMs,
  } = options;

  const stdio = capture ? ["ignore", "pipe", "pipe"] : "inherit";
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio,
    timeout: timeoutMs,
  });

  const stdout = capture ? (result.stdout || "") : "";
  const stderr = capture ? (result.stderr || "") : "";

  if (result.error) {
    if (result.error.code === "ETIMEDOUT") {
      throw new Error(
        `${command} ${args.join(" ")} timed out after ${Number(timeoutMs || 0)}ms`,
      );
    }
    throw result.error;
  }

  if (!allowFailure && result.status !== 0) {
    const message = [
      `${command} ${args.join(" ")} failed with exit code ${result.status}`,
      stderr.trim(),
    ]
      .filter(Boolean)
      .join("\n");
    throw new Error(message);
  }

  return {
    status: result.status ?? 0,
    stdout,
    stderr,
  };
}

export function spawnDetached(command, args, options = {}) {
  const { cwd, env, logFilePath } = options;

  const logFd = openSync(logFilePath, "a");
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });

  child.unref();
  return child.pid;
}
