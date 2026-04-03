import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/chat-completions.test.ts", "tests/guardrails.test.ts"],
    testTimeout: 30_000,
  },
});
