import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { dedup, sanitizeMetadata } from "./dedup.js";
import type { TraceRecord, EvalExample } from "./dedup.js";
import {
  fetchLangSmithTraces,
  projectNameForEnv,
  defaultTimeWindow,
} from "./langsmith-source.js";
import type { LangSmithFetchOptions, FetchFn } from "./langsmith-source.js";

/**
 * Supported trace source types.
 */
export type TraceSource = "inline" | "langsmith";

/**
 * Configuration for the trace-mining pipeline.
 */
export interface PipelineConfig {
  suite: string;
  source: string;
  outputDir: string;
  dryRun: boolean;
}

/**
 * Extended pipeline config supporting LangSmith source.
 */
export interface PipelineRunOptions extends PipelineConfig {
  traceSource?: TraceSource;
  environment?: string;
  startTime?: string;
  endTime?: string;
  pageSize?: number;
  maxTraces?: number;
  langsmithApiUrl?: string;
  langsmithApiKey?: string;
  fetchFn?: FetchFn;
}

/**
 * Result returned after a pipeline run.
 */
export interface PipelineResult {
  datasetName: string;
  examplesCount: number;
  clustersCount: number;
  dedupedFromTotal: number;
  changelog: string;
  artifacts: { datasetPath: string; changelogPath: string } | null;
}

/**
 * Generates a dataset name following the convention:
 *   steer-{suite}-{source}-v{YYYYMMDD}
 */
export function datasetName(suite: string, source: string, date?: Date): string {
  const d = date ?? new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `steer-${suite}-${source}-v${yyyy}${mm}${dd}`;
}

/**
 * Builds a human-readable changelog summarizing what the pipeline produced.
 */
function buildChangelog(
  name: string,
  totalTraces: number,
  examples: EvalExample[]
): string {
  const clusters = new Map<string, number>();
  for (const ex of examples) {
    clusters.set(ex.cluster, (clusters.get(ex.cluster) ?? 0) + 1);
  }

  const lines: string[] = [
    `# Dataset Changelog: ${name}`,
    "",
    `- **Total input traces**: ${totalTraces}`,
    `- **Deduplicated examples**: ${examples.length}`,
    `- **Clusters**: ${clusters.size}`,
    "",
    "## Cluster breakdown",
    "",
  ];

  for (const [cluster, count] of [...clusters.entries()].sort()) {
    lines.push(`- \`${cluster}\`: ${count} example(s)`);
  }

  lines.push("");
  lines.push("## Notes");
  lines.push("");
  lines.push("- Dedup strategy: SHA-256 over normalized(input + failureType).");
  lines.push("- Clustering: deterministic label derived from failureType.");
  lines.push("- No secrets present in exported artifacts.");
  lines.push("");

  return lines.join("\n");
}

/**
 * Sanitize all trace records to remove secrets from metadata before export.
 */
function sanitizeTraces(traces: TraceRecord[]): TraceRecord[] {
  return traces.map((t) => ({
    ...t,
    metadata: t.metadata ? sanitizeMetadata(t.metadata) : undefined,
  }));
}

/**
 * Runs the trace-mining pipeline.
 *
 * Steps:
 * 1. Sanitize incoming traces (strip secrets from metadata).
 * 2. Deduplicate using deterministic content hashing.
 * 3. Build dataset artifact (JSON) and changelog (Markdown).
 * 4. In dry-run mode: compute everything but skip writing to disk.
 *    In normal mode: write dataset JSON + changelog to outputDir.
 */
export function runPipeline(
  traces: TraceRecord[],
  config: PipelineConfig
): PipelineResult {
  const sanitized = sanitizeTraces(traces);
  const examples = dedup(sanitized);
  const name = datasetName(config.suite, config.source);
  const changelog = buildChangelog(name, traces.length, examples);

  const clusters = new Set(examples.map((e) => e.cluster));

  if (config.dryRun) {
    console.log(`[dry-run] Pipeline would produce dataset: ${name}`);
    console.log(`[dry-run] ${examples.length} examples in ${clusters.size} clusters (from ${traces.length} traces)`);
    console.log(`[dry-run] No files written.`);

    return {
      datasetName: name,
      examplesCount: examples.length,
      clustersCount: clusters.size,
      dedupedFromTotal: traces.length,
      changelog,
      artifacts: null,
    };
  }

  if (!existsSync(config.outputDir)) {
    mkdirSync(config.outputDir, { recursive: true });
  }

  const datasetPath = join(config.outputDir, `${name}.json`);
  const changelogPath = join(config.outputDir, `${name}.changelog.md`);

  const artifact = {
    name,
    version: name,
    createdAt: new Date().toISOString(),
    examples: examples.map((ex) => ({
      id: ex.id,
      input: ex.input,
      expectedFailureType: ex.expectedFailureType,
      profileId: ex.profileId,
      cluster: ex.cluster,
      sourceTraceCount: ex.sourceTraceIds.length,
    })),
  };

  writeFileSync(datasetPath, JSON.stringify(artifact, null, 2), "utf8");
  writeFileSync(changelogPath, changelog, "utf8");

  console.log(`Pipeline exported dataset: ${name}`);
  console.log(`  -> ${datasetPath}`);
  console.log(`  -> ${changelogPath}`);

  return {
    datasetName: name,
    examplesCount: examples.length,
    clustersCount: clusters.size,
    dedupedFromTotal: traces.length,
    changelog,
    artifacts: { datasetPath, changelogPath },
  };
}

/**
 * Runs the pipeline with source selection.
 *
 * When traceSource is "langsmith", fetches traces from a LangSmith project
 * using bounded time windows and pagination. Otherwise falls back to
 * the provided inline traces array.
 */
export async function runPipelineFromSource(
  options: PipelineRunOptions,
  inlineTraces?: TraceRecord[]
): Promise<PipelineResult> {
  const source = options.traceSource ?? "inline";

  if (source === "langsmith") {
    const env = options.environment ?? "prod";
    const tw = defaultTimeWindow();
    const fetchOptions: LangSmithFetchOptions = {
      project: projectNameForEnv(env),
      environment: env,
      startTime: options.startTime ?? tw.startTime,
      endTime: options.endTime ?? tw.endTime,
      pageSize: options.pageSize,
      maxTraces: options.maxTraces,
      apiUrl: options.langsmithApiUrl,
      apiKey: options.langsmithApiKey,
    };

    console.log(`[langsmith] Fetching traces from project: ${fetchOptions.project}`);
    console.log(`[langsmith] Time window: ${fetchOptions.startTime} → ${fetchOptions.endTime}`);

    let result;
    try {
      result = await fetchLangSmithTraces(fetchOptions, options.fetchFn);
    } catch (err) {
      if (options.dryRun) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`[langsmith] [dry-run] Could not fetch traces: ${msg}`);
        console.log("[langsmith] [dry-run] Pipeline validation complete — no mutations performed.");
        return {
          datasetName: datasetName(options.suite, options.source),
          examplesCount: 0,
          clustersCount: 0,
          dedupedFromTotal: 0,
          changelog: `Dry run — could not fetch traces: ${msg}`,
          artifacts: null,
        };
      }
      throw err;
    }

    console.log(`[langsmith] Fetched ${result.totalFetched} failure traces (${result.pagesRead} pages, truncated: ${result.truncated})`);

    if (result.traces.length === 0) {
      console.log("[langsmith] No failure traces found in time window.");
      return {
        datasetName: datasetName(options.suite, options.source),
        examplesCount: 0,
        clustersCount: 0,
        dedupedFromTotal: 0,
        changelog: "No traces found in the specified time window.",
        artifacts: null,
      };
    }

    return runPipeline(result.traces, {
      suite: options.suite,
      source: options.source,
      outputDir: options.outputDir,
      dryRun: options.dryRun,
    });
  }

  if (!inlineTraces || inlineTraces.length === 0) {
    throw new Error("No inline traces provided. Use --source langsmith to fetch from LangSmith.");
  }

  return runPipeline(inlineTraces, {
    suite: options.suite,
    source: options.source,
    outputDir: options.outputDir,
    dryRun: options.dryRun,
  });
}
