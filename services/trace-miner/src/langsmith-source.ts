import { sanitizeMetadata } from "./dedup.js";
import type { TraceRecord } from "./dedup.js";

/**
 * Options for fetching traces from a LangSmith project.
 */
export interface LangSmithFetchOptions {
  /** LangSmith API base URL (defaults to LANGSMITH_API_URL env or https://api.smith.langchain.com) */
  apiUrl?: string;
  /** LangSmith API key (defaults to LANGSMITH_API_KEY env) */
  apiKey?: string;
  /** Project name following steer-prod-{env} convention */
  project: string;
  /** Environment filter (e.g. "prod", "staging", "dev") */
  environment: string;
  /** Inclusive start of the time window (ISO 8601) */
  startTime: string;
  /** Exclusive end of the time window (ISO 8601) */
  endTime: string;
  /** Max traces per page (default 100) */
  pageSize?: number;
  /** Max total traces to fetch across all pages (default 1000) */
  maxTraces?: number;
}

/**
 * A single raw run record returned by the LangSmith list-runs API.
 */
export interface LangSmithRun {
  id: string;
  name?: string;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  error?: string | null;
  status?: string;
  extra?: Record<string, unknown>;
  tags?: string[];
  start_time?: string;
  end_time?: string;
  [key: string]: unknown;
}

/**
 * Result of a LangSmith fetch operation.
 */
export interface LangSmithFetchResult {
  traces: TraceRecord[];
  totalFetched: number;
  pagesRead: number;
  truncated: boolean;
}

/**
 * Determines the failure type from a LangSmith run.
 * Returns null if the run is not considered a failure candidate.
 */
export function classifyFailure(run: LangSmithRun): string | null {
  if (run.error) {
    return "error";
  }

  const outputText = extractOutputText(run);

  if (outputText !== null && outputText.trim() === "") {
    return "empty-response";
  }

  if (outputText !== null && isDegenerate(outputText)) {
    return "degeneration";
  }

  if (run.status === "error") {
    return "error";
  }

  const tags = run.tags ?? [];
  for (const tag of tags) {
    const lower = tag.toLowerCase();
    if (lower.includes("failure") || lower.includes("weak") || lower.includes("bad")) {
      return tagToFailureType(tag);
    }
  }

  return null;
}

/**
 * Extracts the text output from a run's outputs object.
 */
function extractOutputText(run: LangSmithRun): string | null {
  if (!run.outputs) return null;
  if (typeof run.outputs.output === "string") return run.outputs.output;
  if (typeof run.outputs.text === "string") return run.outputs.text;
  if (typeof run.outputs.result === "string") return run.outputs.result;
  return null;
}

/**
 * Extracts the input text from a run's inputs object.
 */
function extractInputText(run: LangSmithRun): string {
  if (!run.inputs) return "";
  if (typeof run.inputs.input === "string") return run.inputs.input;
  if (typeof run.inputs.text === "string") return run.inputs.text;
  if (typeof run.inputs.prompt === "string") return run.inputs.prompt;
  if (typeof run.inputs.question === "string") return run.inputs.question;
  return JSON.stringify(run.inputs);
}

/**
 * Heuristic: detects repetitive / degenerate output.
 * A response is degenerate if any 4+ word sequence repeats 3+ times.
 */
export function isDegenerate(text: string): boolean {
  const words = text.split(/\s+/);
  if (words.length < 12) return false;

  const seen = new Map<string, number>();
  const windowSize = 4;
  for (let i = 0; i <= words.length - windowSize; i++) {
    const ngram = words.slice(i, i + windowSize).join(" ").toLowerCase();
    const count = (seen.get(ngram) ?? 0) + 1;
    seen.set(ngram, count);
    if (count >= 3) return true;
  }
  return false;
}

/**
 * Converts a tag string into a normalized failure type slug.
 */
function tagToFailureType(tag: string): string {
  return tag
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Extracts the profile ID from run metadata/extra, if present.
 */
function extractProfileId(run: LangSmithRun): string {
  const extra = run.extra ?? {};
  if (typeof extra.profile_id === "string") return extra.profile_id;
  if (typeof extra.profileId === "string") return extra.profileId;
  const metadata = (extra.metadata ?? {}) as Record<string, unknown>;
  if (typeof metadata.profile_id === "string") return metadata.profile_id;
  if (typeof metadata.profileId === "string") return metadata.profileId;
  return "unknown";
}

/**
 * Builds metadata from a LangSmith run, pre-sanitized.
 */
function buildMetadata(run: LangSmithRun, environment: string): Record<string, unknown> {
  const raw: Record<string, unknown> = {
    env: environment,
    runName: run.name ?? "unknown",
    status: run.status ?? "unknown",
    startTime: run.start_time ?? null,
    endTime: run.end_time ?? null,
  };

  if (run.tags && run.tags.length > 0) {
    raw.tags = run.tags;
  }

  return sanitizeMetadata(raw);
}

/**
 * Converts a LangSmith run into a TraceRecord if it represents a failure candidate.
 * Returns null for non-failure runs.
 */
export function runToTraceRecord(run: LangSmithRun, environment: string): TraceRecord | null {
  const failureType = classifyFailure(run);
  if (!failureType) return null;

  return {
    traceId: run.id,
    input: extractInputText(run),
    output: extractOutputText(run) ?? "",
    profileId: extractProfileId(run),
    failureType,
    metadata: buildMetadata(run, environment),
  };
}

/**
 * Type definition for a fetch function, allowing dependency injection for testing.
 */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Fetches failure traces from a LangSmith project with pagination and time-window bounds.
 *
 * Uses the POST /runs/query endpoint to list runs within a time window, filtering
 * for failures. Paginates using cursor-based pagination until exhausted or maxTraces reached.
 */
export async function fetchLangSmithTraces(
  options: LangSmithFetchOptions,
  fetchFn?: FetchFn
): Promise<LangSmithFetchResult> {
  const apiUrl = options.apiUrl ?? process.env.LANGSMITH_API_URL ?? "https://api.smith.langchain.com";
  const apiKey = options.apiKey ?? process.env.LANGSMITH_API_KEY ?? "";
  const pageSize = options.pageSize ?? 100;
  const maxTraces = options.maxTraces ?? 1000;
  const doFetch = fetchFn ?? globalThis.fetch;

  if (!apiKey) {
    throw new Error(
      "LANGSMITH_API_KEY is required. Set it as an environment variable or pass apiKey in options."
    );
  }

  const traces: TraceRecord[] = [];
  let pagesRead = 0;
  let cursor: string | undefined;
  let truncated = false;

  while (traces.length < maxTraces) {
    const body: Record<string, unknown> = {
      session: [options.project],
      start_time: options.startTime,
      end_time: options.endTime,
      limit: Math.min(pageSize, maxTraces - traces.length),
      is_root: true,
    };

    if (cursor) {
      body.cursor = cursor;
    }

    const response = await doFetch(`${apiUrl}/api/v1/runs/query`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `LangSmith API error (${response.status}): ${text}`
      );
    }

    const data = (await response.json()) as {
      runs: LangSmithRun[];
      cursors?: { next?: string };
    };

    pagesRead++;

    for (const run of data.runs) {
      const record = runToTraceRecord(run, options.environment);
      if (record) {
        traces.push(record);
        if (traces.length >= maxTraces) {
          truncated = !!data.cursors?.next;
          break;
        }
      }
    }

    cursor = data.cursors?.next;
    if (!cursor || data.runs.length === 0) {
      break;
    }

    if (traces.length >= maxTraces) {
      truncated = true;
      break;
    }
  }

  return {
    traces,
    totalFetched: traces.length,
    pagesRead,
    truncated,
  };
}

/**
 * Convenience: builds the standard project name from an environment.
 */
export function projectNameForEnv(env: string): string {
  return `steer-prod-${env}`;
}

/**
 * Builds default time window for nightly runs:
 * from 24 hours ago to now.
 */
export function defaultTimeWindow(): { startTime: string; endTime: string } {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return {
    startTime: yesterday.toISOString(),
    endTime: now.toISOString(),
  };
}
