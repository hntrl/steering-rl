import { runPipeline } from "./pipeline.js";
import type { TraceRecord } from "./dedup.js";

const isDryRun = process.argv.includes("--dry-run");

const sampleTraces: TraceRecord[] = [
  {
    traceId: "trace-001",
    input: "Explain quantum computing in simple terms",
    output: "Quantum quantum quantum quantum...",
    profileId: "steer-gemma3-default-v12",
    failureType: "degeneration",
    metadata: { env: "prod", region: "us-east-1" },
  },
  {
    traceId: "trace-002",
    input: "Explain quantum computing in simple terms",
    output: "Repeat repeat repeat...",
    profileId: "steer-gemma3-default-v12",
    failureType: "degeneration",
    metadata: { env: "prod", region: "eu-west-1" },
  },
  {
    traceId: "trace-003",
    input: "Translate this to French: Hello world",
    output: "Hola mundo (wrong language)",
    profileId: "steer-gemma3-default-v12",
    failureType: "language-shift",
    metadata: { env: "prod", apiKey: "sk-secret-12345" },
  },
  {
    traceId: "trace-004",
    input: "Write a haiku about cats",
    output: "",
    profileId: "steer-gemma3-default-v12",
    failureType: "empty-response",
    metadata: { env: "staging" },
  },
];

const result = runPipeline(sampleTraces, {
  suite: "core",
  source: "prodtrace",
  outputDir: "./output",
  dryRun: isDryRun,
});

console.log(`\nResult: ${result.examplesCount} examples, ${result.clustersCount} clusters`);
if (isDryRun) {
  console.log("Dry run completed — no remote datasets mutated.");
}
