import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { dedup, contentHash, clusterLabel, sanitizeMetadata } from "../src/dedup.js";
import { runPipeline, datasetName, runPipelineFromSource } from "../src/pipeline.js";
import type { PipelineRunOptions } from "../src/pipeline.js";
import type { TraceRecord } from "../src/dedup.js";
import {
  classifyFailure,
  isDegenerate,
  runToTraceRecord,
  fetchLangSmithTraces,
  projectNameForEnv,
  defaultTimeWindow,
} from "../src/langsmith-source.js";
import type { LangSmithRun, FetchFn } from "../src/langsmith-source.js";

function makeTrace(overrides: Partial<TraceRecord> = {}): TraceRecord {
  return {
    traceId: `trace-${Math.random().toString(36).slice(2, 8)}`,
    input: "Test prompt",
    output: "Test output",
    profileId: "steer-gemma3-default-v12",
    failureType: "degeneration",
    ...overrides,
  };
}

describe("contentHash", () => {
  it("produces the same hash for identical input+failureType", () => {
    const a = makeTrace({ input: "Hello world", failureType: "degeneration" });
    const b = makeTrace({
      traceId: "different-id",
      input: "Hello world",
      failureType: "degeneration",
      output: "completely different output",
    });
    expect(contentHash(a)).toBe(contentHash(b));
  });

  it("produces the same hash regardless of leading/trailing whitespace", () => {
    const a = makeTrace({ input: "  Hello world  ", failureType: " degeneration " });
    const b = makeTrace({ input: "Hello world", failureType: "degeneration" });
    expect(contentHash(a)).toBe(contentHash(b));
  });

  it("produces the same hash regardless of case", () => {
    const a = makeTrace({ input: "Hello World", failureType: "Degeneration" });
    const b = makeTrace({ input: "hello world", failureType: "degeneration" });
    expect(contentHash(a)).toBe(contentHash(b));
  });

  it("produces different hashes for different inputs", () => {
    const a = makeTrace({ input: "Hello world" });
    const b = makeTrace({ input: "Goodbye world" });
    expect(contentHash(a)).not.toBe(contentHash(b));
  });

  it("produces different hashes for different failure types", () => {
    const a = makeTrace({ failureType: "degeneration" });
    const b = makeTrace({ failureType: "language-shift" });
    expect(contentHash(a)).not.toBe(contentHash(b));
  });
});

describe("clusterLabel", () => {
  it("normalizes failure type to a cluster label", () => {
    expect(clusterLabel("degeneration")).toBe("cluster-degeneration");
    expect(clusterLabel("language-shift")).toBe("cluster-language-shift");
    expect(clusterLabel("empty response")).toBe("cluster-empty-response");
  });

  it("is deterministic for the same input", () => {
    expect(clusterLabel("Degeneration")).toBe(clusterLabel("degeneration"));
    expect(clusterLabel("  language shift ")).toBe(clusterLabel("language-shift"));
  });
});

describe("dedup", () => {
  it("removes exact duplicates (same input + failureType)", () => {
    const traces = [
      makeTrace({ traceId: "t1", input: "prompt A", failureType: "degeneration" }),
      makeTrace({ traceId: "t2", input: "prompt A", failureType: "degeneration" }),
      makeTrace({ traceId: "t3", input: "prompt A", failureType: "degeneration" }),
    ];

    const result = dedup(traces);
    expect(result).toHaveLength(1);
    expect(result[0].sourceTraceIds).toEqual(["t1", "t2", "t3"]);
  });

  it("keeps distinct entries for different inputs", () => {
    const traces = [
      makeTrace({ traceId: "t1", input: "prompt A", failureType: "degeneration" }),
      makeTrace({ traceId: "t2", input: "prompt B", failureType: "degeneration" }),
    ];

    const result = dedup(traces);
    expect(result).toHaveLength(2);
  });

  it("keeps distinct entries for same input but different failure type", () => {
    const traces = [
      makeTrace({ traceId: "t1", input: "prompt A", failureType: "degeneration" }),
      makeTrace({ traceId: "t2", input: "prompt A", failureType: "language-shift" }),
    ];

    const result = dedup(traces);
    expect(result).toHaveLength(2);
  });

  it("assigns correct cluster labels", () => {
    const traces = [
      makeTrace({ failureType: "degeneration" }),
      makeTrace({ input: "other", failureType: "language-shift" }),
    ];

    const result = dedup(traces);
    const clusters = result.map((e) => e.cluster).sort();
    expect(clusters).toEqual(["cluster-degeneration", "cluster-language-shift"]);
  });

  it("returns empty array for empty input", () => {
    expect(dedup([])).toEqual([]);
  });

  it("is order-stable — first trace is canonical", () => {
    const traces = [
      makeTrace({ traceId: "first", input: "same", output: "output-A" }),
      makeTrace({ traceId: "second", input: "same", output: "output-B" }),
    ];

    const result = dedup(traces);
    expect(result).toHaveLength(1);
    expect(result[0].sourceTraceIds[0]).toBe("first");
  });
});

describe("sanitizeMetadata", () => {
  it("redacts keys matching secret patterns", () => {
    const metadata = {
      env: "prod",
      apiKey: "sk-secret-12345",
      api_key: "another-secret",
      token: "jwt-token",
      password: "hunter2",
      region: "us-east-1",
    };
    const result = sanitizeMetadata(metadata);
    expect(result.env).toBe("prod");
    expect(result.region).toBe("us-east-1");
    expect(result.apiKey).toBe("[REDACTED]");
    expect(result.api_key).toBe("[REDACTED]");
    expect(result.token).toBe("[REDACTED]");
    expect(result.password).toBe("[REDACTED]");
  });

  it("recursively sanitizes nested objects", () => {
    const metadata = {
      config: {
        serviceToken: "secret-value",
        retries: 3,
      },
    };
    const result = sanitizeMetadata(metadata);
    const config = result.config as Record<string, unknown>;
    expect(config.serviceToken).toBe("[REDACTED]");
    expect(config.retries).toBe(3);
  });

  it("returns empty object for empty input", () => {
    expect(sanitizeMetadata({})).toEqual({});
  });
});

describe("datasetName", () => {
  it("follows steer-{suite}-{source}-v{YYYYMMDD} pattern", () => {
    const date = new Date("2026-04-02T12:00:00Z");
    expect(datasetName("core", "prodtrace", date)).toBe("steer-core-prodtrace-v20260402");
  });

  it("pads month and day with zeros", () => {
    const date = new Date("2026-01-05T00:00:00Z");
    expect(datasetName("edge", "golden", date)).toBe("steer-edge-golden-v20260105");
  });
});

describe("runPipeline", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "trace-miner-test-"));
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true });
    }
  });

  const sampleTraces: TraceRecord[] = [
    makeTrace({ traceId: "t1", input: "prompt A", failureType: "degeneration" }),
    makeTrace({ traceId: "t2", input: "prompt A", failureType: "degeneration" }),
    makeTrace({ traceId: "t3", input: "prompt B", failureType: "language-shift" }),
    makeTrace({
      traceId: "t4",
      input: "prompt C",
      failureType: "empty-response",
      metadata: { apiKey: "secret123" },
    }),
  ];

  it("exports dataset artifact and summary changelog", () => {
    const result = runPipeline(sampleTraces, {
      suite: "core",
      source: "prodtrace",
      outputDir: tempDir,
      dryRun: false,
    });

    expect(result.artifacts).not.toBeNull();
    expect(existsSync(result.artifacts!.datasetPath)).toBe(true);
    expect(existsSync(result.artifacts!.changelogPath)).toBe(true);

    const dataset = JSON.parse(readFileSync(result.artifacts!.datasetPath, "utf8"));
    expect(dataset.name).toMatch(/^steer-core-prodtrace-v\d{8}$/);
    expect(dataset.examples).toHaveLength(3);

    const changelog = readFileSync(result.artifacts!.changelogPath, "utf8");
    expect(changelog).toContain("Dataset Changelog");
    expect(changelog).toContain("Deduplicated examples");
    expect(changelog).toContain("cluster-degeneration");
  });

  it("dry run mode works without writing files", () => {
    const result = runPipeline(sampleTraces, {
      suite: "core",
      source: "prodtrace",
      outputDir: tempDir,
      dryRun: true,
    });

    expect(result.artifacts).toBeNull();
    expect(result.examplesCount).toBe(3);
    expect(result.clustersCount).toBe(3);
    expect(result.dedupedFromTotal).toBe(4);
    expect(result.datasetName).toMatch(/^steer-core-prodtrace-v\d{8}$/);
    expect(result.changelog).toContain("Dataset Changelog");

    const files = existsSync(tempDir)
      ? require("node:fs").readdirSync(tempDir)
      : [];
    const datasetFiles = files.filter((f: string) => f.endsWith(".json") || f.endsWith(".md"));
    expect(datasetFiles).toHaveLength(0);
  });

  it("does not include secrets in exported artifacts", () => {
    const tracesWithSecrets: TraceRecord[] = [
      makeTrace({
        traceId: "t1",
        input: "secret test",
        failureType: "degeneration",
        metadata: {
          apiKey: "sk-12345",
          token: "jwt-token",
          env: "prod",
        },
      }),
    ];

    const result = runPipeline(tracesWithSecrets, {
      suite: "core",
      source: "prodtrace",
      outputDir: tempDir,
      dryRun: false,
    });

    const raw = readFileSync(result.artifacts!.datasetPath, "utf8");
    expect(raw).not.toContain("sk-12345");
    expect(raw).not.toContain("jwt-token");
  });

  it("follows dataset naming convention", () => {
    const result = runPipeline([makeTrace()], {
      suite: "degeneracy",
      source: "golden",
      outputDir: tempDir,
      dryRun: false,
    });

    expect(result.datasetName).toMatch(/^steer-degeneracy-golden-v\d{8}$/);
  });
});

// ─── LangSmith Source Tests ───────────────────────────────────────────────────

function makeRun(overrides: Partial<LangSmithRun> = {}): LangSmithRun {
  return {
    id: `run-${Math.random().toString(36).slice(2, 8)}`,
    name: "test-run",
    inputs: { input: "Test prompt" },
    outputs: { output: "Test output" },
    status: "success",
    extra: { profile_id: "steer-gemma3-default-v12" },
    tags: [],
    start_time: "2026-04-01T00:00:00Z",
    end_time: "2026-04-01T00:01:00Z",
    ...overrides,
  };
}

describe("classifyFailure", () => {
  it("classifies runs with error field as 'error'", () => {
    const run = makeRun({ error: "Something went wrong" });
    expect(classifyFailure(run)).toBe("error");
  });

  it("classifies empty output as 'empty-response'", () => {
    const run = makeRun({ outputs: { output: "" }, error: null });
    expect(classifyFailure(run)).toBe("empty-response");
  });

  it("classifies whitespace-only output as 'empty-response'", () => {
    const run = makeRun({ outputs: { output: "   " }, error: null });
    expect(classifyFailure(run)).toBe("empty-response");
  });

  it("classifies degenerate output as 'degeneration'", () => {
    const repeated = Array(20).fill("quantum computing is great").join(" ");
    const run = makeRun({ outputs: { output: repeated }, error: null });
    expect(classifyFailure(run)).toBe("degeneration");
  });

  it("classifies error status runs as 'error'", () => {
    const run = makeRun({ status: "error", outputs: { output: "partial" }, error: null });
    expect(classifyFailure(run)).toBe("error");
  });

  it("classifies runs with failure tags", () => {
    const run = makeRun({
      tags: ["weak-response"],
      outputs: { output: "normal output" },
      error: null,
    });
    expect(classifyFailure(run)).toBe("weak-response");
  });

  it("returns null for successful runs", () => {
    const run = makeRun({ error: null, status: "success" });
    expect(classifyFailure(run)).toBeNull();
  });
});

describe("isDegenerate", () => {
  it("detects repetitive text", () => {
    const text = Array(20).fill("the cat sat on").join(" ");
    expect(isDegenerate(text)).toBe(true);
  });

  it("returns false for short text", () => {
    expect(isDegenerate("short text")).toBe(false);
  });

  it("returns false for diverse text", () => {
    const text = "The quick brown fox jumps over the lazy dog. A completely different sentence follows here with no repetition whatsoever.";
    expect(isDegenerate(text)).toBe(false);
  });
});

describe("runToTraceRecord", () => {
  it("converts a failure run to a TraceRecord", () => {
    const run = makeRun({ id: "run-123", error: "timeout", inputs: { input: "Hello" } });
    const record = runToTraceRecord(run, "prod");
    expect(record).not.toBeNull();
    expect(record!.traceId).toBe("run-123");
    expect(record!.input).toBe("Hello");
    expect(record!.failureType).toBe("error");
    expect(record!.metadata).toBeDefined();
    expect(record!.metadata!.env).toBe("prod");
  });

  it("returns null for successful runs", () => {
    const run = makeRun({ error: null, status: "success" });
    expect(runToTraceRecord(run, "prod")).toBeNull();
  });

  it("sanitizes metadata in the trace record", () => {
    const run = makeRun({
      error: "fail",
      extra: { profile_id: "test", apiKey: "secret" },
    });
    const record = runToTraceRecord(run, "prod");
    expect(record).not.toBeNull();
    expect(record!.metadata).not.toContain("secret");
  });

  it("extracts profile ID from extra.metadata", () => {
    const run = makeRun({
      error: "fail",
      extra: { metadata: { profile_id: "steer-v42" } },
    });
    const record = runToTraceRecord(run, "prod");
    expect(record!.profileId).toBe("steer-v42");
  });
});

describe("projectNameForEnv", () => {
  it("builds standard project name", () => {
    expect(projectNameForEnv("prod")).toBe("steer-prod-prod");
    expect(projectNameForEnv("staging")).toBe("steer-prod-staging");
    expect(projectNameForEnv("dev")).toBe("steer-prod-dev");
  });
});

describe("defaultTimeWindow", () => {
  it("returns a 24h window ending approximately now", () => {
    const { startTime, endTime } = defaultTimeWindow();
    const start = new Date(startTime).getTime();
    const end = new Date(endTime).getTime();
    const diff = end - start;
    expect(diff).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(diff).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 1000);
  });
});

describe("fetchLangSmithTraces", () => {
  function createMockFetch(pages: LangSmithRun[][], statusCode = 200): FetchFn {
    let callCount = 0;
    return async (_url: string, _init?: RequestInit): Promise<Response> => {
      const pageIndex = callCount++;
      const runs = pages[pageIndex] ?? [];
      const hasNext = pageIndex < pages.length - 1;
      const body = JSON.stringify({
        runs,
        cursors: hasNext ? { next: `cursor-${pageIndex + 1}` } : {},
      });
      return new Response(body, {
        status: statusCode,
        headers: { "Content-Type": "application/json" },
      });
    };
  }

  it("fetches traces from a single page", async () => {
    const runs: LangSmithRun[] = [
      makeRun({ id: "r1", error: "fail", inputs: { input: "prompt 1" } }),
      makeRun({ id: "r2", error: "fail", inputs: { input: "prompt 2" } }),
    ];

    const result = await fetchLangSmithTraces(
      {
        project: "steer-prod-prod",
        environment: "prod",
        startTime: "2026-04-01T00:00:00Z",
        endTime: "2026-04-02T00:00:00Z",
        apiKey: "test-key",
      },
      createMockFetch([runs])
    );

    expect(result.traces).toHaveLength(2);
    expect(result.pagesRead).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it("paginates across multiple pages", async () => {
    const page1: LangSmithRun[] = [
      makeRun({ id: "r1", error: "fail" }),
      makeRun({ id: "r2", error: "fail" }),
    ];
    const page2: LangSmithRun[] = [
      makeRun({ id: "r3", error: "fail" }),
    ];

    const result = await fetchLangSmithTraces(
      {
        project: "steer-prod-prod",
        environment: "prod",
        startTime: "2026-04-01T00:00:00Z",
        endTime: "2026-04-02T00:00:00Z",
        apiKey: "test-key",
        pageSize: 2,
      },
      createMockFetch([page1, page2])
    );

    expect(result.traces).toHaveLength(3);
    expect(result.pagesRead).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it("respects maxTraces limit", async () => {
    const runs: LangSmithRun[] = Array.from({ length: 10 }, (_, i) =>
      makeRun({ id: `r${i}`, error: "fail" })
    );

    const result = await fetchLangSmithTraces(
      {
        project: "steer-prod-prod",
        environment: "prod",
        startTime: "2026-04-01T00:00:00Z",
        endTime: "2026-04-02T00:00:00Z",
        apiKey: "test-key",
        maxTraces: 3,
      },
      createMockFetch([runs])
    );

    expect(result.traces).toHaveLength(3);
    expect(result.truncated).toBe(false);
  });

  it("skips non-failure runs", async () => {
    const runs: LangSmithRun[] = [
      makeRun({ id: "r1", error: "fail" }),
      makeRun({ id: "r2", error: null, status: "success" }),
      makeRun({ id: "r3", error: "another fail" }),
    ];

    const result = await fetchLangSmithTraces(
      {
        project: "steer-prod-prod",
        environment: "prod",
        startTime: "2026-04-01T00:00:00Z",
        endTime: "2026-04-02T00:00:00Z",
        apiKey: "test-key",
      },
      createMockFetch([runs])
    );

    expect(result.traces).toHaveLength(2);
    expect(result.traces.map((t) => t.traceId)).toEqual(["r1", "r3"]);
  });

  it("throws when API key is missing", async () => {
    const origKey = process.env.LANGSMITH_API_KEY;
    delete process.env.LANGSMITH_API_KEY;

    await expect(
      fetchLangSmithTraces({
        project: "steer-prod-prod",
        environment: "prod",
        startTime: "2026-04-01T00:00:00Z",
        endTime: "2026-04-02T00:00:00Z",
        apiKey: "",
      })
    ).rejects.toThrow("LANGSMITH_API_KEY is required");

    if (origKey !== undefined) {
      process.env.LANGSMITH_API_KEY = origKey;
    }
  });

  it("throws on API error responses", async () => {
    const mockFetch: FetchFn = async () =>
      new Response("Unauthorized", { status: 401 });

    await expect(
      fetchLangSmithTraces(
        {
          project: "steer-prod-prod",
          environment: "prod",
          startTime: "2026-04-01T00:00:00Z",
          endTime: "2026-04-02T00:00:00Z",
          apiKey: "bad-key",
        },
        mockFetch
      )
    ).rejects.toThrow("LangSmith API error (401)");
  });

  it("returns empty result when no runs match", async () => {
    const result = await fetchLangSmithTraces(
      {
        project: "steer-prod-prod",
        environment: "prod",
        startTime: "2026-04-01T00:00:00Z",
        endTime: "2026-04-02T00:00:00Z",
        apiKey: "test-key",
      },
      createMockFetch([[]])
    );

    expect(result.traces).toHaveLength(0);
    expect(result.pagesRead).toBe(1);
  });
});

describe("runPipelineFromSource", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "trace-miner-source-test-"));
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true });
    }
  });

  it("runs with inline source and provided traces", async () => {
    const traces: TraceRecord[] = [
      makeTrace({ traceId: "t1", input: "prompt A", failureType: "degeneration" }),
      makeTrace({ traceId: "t2", input: "prompt B", failureType: "language-shift" }),
    ];

    const result = await runPipelineFromSource(
      {
        suite: "core",
        source: "prodtrace",
        outputDir: tempDir,
        dryRun: true,
        traceSource: "inline",
      },
      traces
    );

    expect(result.examplesCount).toBe(2);
    expect(result.artifacts).toBeNull();
  });

  it("runs with langsmith source using mock fetch", async () => {
    const runs: LangSmithRun[] = [
      makeRun({ id: "r1", error: "fail", inputs: { input: "prompt X" } }),
      makeRun({ id: "r2", error: "fail", inputs: { input: "prompt Y" } }),
    ];

    const mockFetch: FetchFn = async () =>
      new Response(
        JSON.stringify({ runs, cursors: {} }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );

    const result = await runPipelineFromSource({
      suite: "core",
      source: "langsmith",
      outputDir: tempDir,
      dryRun: true,
      traceSource: "langsmith",
      environment: "prod",
      startTime: "2026-04-01T00:00:00Z",
      endTime: "2026-04-02T00:00:00Z",
      langsmithApiKey: "test-key",
      fetchFn: mockFetch,
    });

    expect(result.examplesCount).toBe(2);
    expect(result.datasetName).toMatch(/^steer-core-langsmith-v\d{8}$/);
    expect(result.artifacts).toBeNull();
  });

  it("langsmith source dry-run does not write files", async () => {
    const runs: LangSmithRun[] = [
      makeRun({ id: "r1", error: "fail", inputs: { input: "prompt" } }),
    ];

    const mockFetch: FetchFn = async () =>
      new Response(
        JSON.stringify({ runs, cursors: {} }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );

    await runPipelineFromSource({
      suite: "core",
      source: "langsmith",
      outputDir: tempDir,
      dryRun: true,
      traceSource: "langsmith",
      environment: "staging",
      startTime: "2026-04-01T00:00:00Z",
      endTime: "2026-04-02T00:00:00Z",
      langsmithApiKey: "test-key",
      fetchFn: mockFetch,
    });

    const files = existsSync(tempDir) ? readdirSync(tempDir) : [];
    expect(files.filter((f: string) => f.endsWith(".json") || f.endsWith(".md"))).toHaveLength(0);
  });

  it("langsmith source normal run writes artifacts", async () => {
    const runs: LangSmithRun[] = [
      makeRun({ id: "r1", error: "fail", inputs: { input: "prompt A" } }),
      makeRun({ id: "r2", error: "timeout", inputs: { input: "prompt B" } }),
    ];

    const mockFetch: FetchFn = async () =>
      new Response(
        JSON.stringify({ runs, cursors: {} }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );

    const result = await runPipelineFromSource({
      suite: "core",
      source: "langsmith",
      outputDir: tempDir,
      dryRun: false,
      traceSource: "langsmith",
      environment: "prod",
      startTime: "2026-04-01T00:00:00Z",
      endTime: "2026-04-02T00:00:00Z",
      langsmithApiKey: "test-key",
      fetchFn: mockFetch,
    });

    expect(result.artifacts).not.toBeNull();
    expect(existsSync(result.artifacts!.datasetPath)).toBe(true);
    expect(existsSync(result.artifacts!.changelogPath)).toBe(true);

    const dataset = JSON.parse(readFileSync(result.artifacts!.datasetPath, "utf8"));
    expect(dataset.examples.length).toBe(2);
  });

  it("returns empty result when langsmith returns no failures", async () => {
    const mockFetch: FetchFn = async () =>
      new Response(
        JSON.stringify({ runs: [], cursors: {} }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );

    const result = await runPipelineFromSource({
      suite: "core",
      source: "langsmith",
      outputDir: tempDir,
      dryRun: true,
      traceSource: "langsmith",
      environment: "prod",
      startTime: "2026-04-01T00:00:00Z",
      endTime: "2026-04-02T00:00:00Z",
      langsmithApiKey: "test-key",
      fetchFn: mockFetch,
    });

    expect(result.examplesCount).toBe(0);
    expect(result.artifacts).toBeNull();
  });

  it("throws when inline source has no traces", async () => {
    await expect(
      runPipelineFromSource({
        suite: "core",
        source: "prodtrace",
        outputDir: tempDir,
        dryRun: true,
        traceSource: "inline",
      })
    ).rejects.toThrow("No inline traces provided");
  });

  it("deduplicates langsmith traces deterministically", async () => {
    const runs: LangSmithRun[] = [
      makeRun({ id: "r1", error: "fail", inputs: { input: "same prompt" } }),
      makeRun({ id: "r2", error: "fail", inputs: { input: "same prompt" } }),
      makeRun({ id: "r3", error: "fail", inputs: { input: "different prompt" } }),
    ];

    const mockFetch: FetchFn = async () =>
      new Response(
        JSON.stringify({ runs, cursors: {} }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );

    const result = await runPipelineFromSource({
      suite: "core",
      source: "langsmith",
      outputDir: tempDir,
      dryRun: true,
      traceSource: "langsmith",
      environment: "prod",
      startTime: "2026-04-01T00:00:00Z",
      endTime: "2026-04-02T00:00:00Z",
      langsmithApiKey: "test-key",
      fetchFn: mockFetch,
    });

    expect(result.examplesCount).toBe(2);
    expect(result.dedupedFromTotal).toBe(3);
  });

  it("sanitizes sensitive metadata from langsmith traces", async () => {
    const runs: LangSmithRun[] = [
      makeRun({
        id: "r1",
        error: "fail",
        inputs: { input: "test" },
        extra: { profile_id: "steer-v1", apiKey: "sk-secret-key" },
      }),
    ];

    const mockFetch: FetchFn = async () =>
      new Response(
        JSON.stringify({ runs, cursors: {} }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );

    const result = await runPipelineFromSource({
      suite: "core",
      source: "langsmith",
      outputDir: tempDir,
      dryRun: false,
      traceSource: "langsmith",
      environment: "prod",
      startTime: "2026-04-01T00:00:00Z",
      endTime: "2026-04-02T00:00:00Z",
      langsmithApiKey: "test-key",
      fetchFn: mockFetch,
    });

    const raw = readFileSync(result.artifacts!.datasetPath, "utf8");
    expect(raw).not.toContain("sk-secret-key");
  });
});
