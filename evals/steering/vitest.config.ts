import { defineConfig } from "vitest/config";

/**
 * Vitest configuration for the steering eval suite.
 *
 * Environment variables:
 *   EVAL_RUNNER        – identifier for the eval runner (e.g. "local", "ci", "nightly")
 *   LANGSMITH_PROJECT  – override LangSmith project (default: steer-evals-{EVAL_ENV})
 *   EVAL_ENV           – environment tag (default: "dev")
 */
export default defineConfig({
  test: {
    include: ["index.test.ts"],
    testTimeout: 30_000,
    env: {
      EVAL_RUNNER: process.env.EVAL_RUNNER ?? "local",
      EVAL_ENV: process.env.EVAL_ENV ?? "dev",
      LANGSMITH_PROJECT:
        process.env.LANGSMITH_PROJECT ??
        `steer-evals-${process.env.EVAL_ENV ?? "dev"}`,
    },
  },
});
