import { runPipelineFromSource } from "./pipeline.js";
import type { TraceSource } from "./pipeline.js";
import type { TraceRecord } from "./dedup.js";

interface CliArgs {
  dryRun: boolean;
  source: TraceSource;
  environment: string;
  suite: string;
  outputDir: string;
  startTime?: string;
  endTime?: string;
  pageSize?: number;
  maxTraces?: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    dryRun: false,
    source: "inline",
    environment: "prod",
    suite: "core",
    outputDir: "./output",
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--source":
        args.source = argv[++i] as TraceSource;
        break;
      case "--env":
      case "--environment":
        args.environment = argv[++i];
        break;
      case "--suite":
        args.suite = argv[++i];
        break;
      case "--output-dir":
        args.outputDir = argv[++i];
        break;
      case "--start-time":
        args.startTime = argv[++i];
        break;
      case "--end-time":
        args.endTime = argv[++i];
        break;
      case "--page-size":
        args.pageSize = parseInt(argv[++i], 10);
        break;
      case "--max-traces":
        args.maxTraces = parseInt(argv[++i], 10);
        break;
      case "--help":
        printUsage();
        process.exit(0);
        break;
    }
  }

  return args;
}

function printUsage(): void {
  console.log(`
trace-miner CLI — Mine production failure traces into eval datasets.

Usage:
  node --import tsx src/cli.ts [options]

Options:
  --dry-run              Compute pipeline without writing files or mutating remote datasets
  --source <type>        Trace source: "inline" (default) or "langsmith"
  --env <environment>    Environment filter (default: "prod")
  --suite <name>         Dataset suite name (default: "core")
  --output-dir <path>    Output directory for artifacts (default: "./output")
  --start-time <iso>     Start of time window (ISO 8601). Default: 24h ago
  --end-time <iso>       End of time window (ISO 8601). Default: now
  --page-size <n>        Traces per API page (default: 100)
  --max-traces <n>       Max total traces to fetch (default: 1000)
  --help                 Show this help message

Environment Variables:
  LANGSMITH_API_KEY      API key for LangSmith (required for --source langsmith)
  LANGSMITH_API_URL      LangSmith API base URL (optional)

Examples:
  # Dry run with sample inline data
  pnpm run dry-run

  # Dry run fetching from LangSmith production
  pnpm run dry-run -- --source langsmith --env prod

  # Nightly job: fetch last 24h of staging failures
  node --import tsx src/cli.ts --source langsmith --env staging

  # Custom time window
  node --import tsx src/cli.ts --source langsmith --env prod \\
    --start-time 2026-04-01T00:00:00Z --end-time 2026-04-02T00:00:00Z
`);
}

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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log(`trace-miner starting (source: ${args.source}, dry-run: ${args.dryRun})`);

  const sourceLabel = args.source === "langsmith" ? "langsmith" : "prodtrace";

  const result = await runPipelineFromSource(
    {
      suite: args.suite,
      source: sourceLabel,
      outputDir: args.outputDir,
      dryRun: args.dryRun,
      traceSource: args.source,
      environment: args.environment,
      startTime: args.startTime,
      endTime: args.endTime,
      pageSize: args.pageSize,
      maxTraces: args.maxTraces,
    },
    args.source === "inline" ? sampleTraces : undefined
  );

  console.log(`\nResult: ${result.examplesCount} examples, ${result.clustersCount} clusters`);
  if (args.dryRun) {
    console.log("Dry run completed — no remote datasets or local artifacts mutated.");
  }
}

main().catch((err) => {
  console.error("trace-miner failed:", err);
  process.exit(1);
});
