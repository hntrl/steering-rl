import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { dedup, contentHash, clusterLabel, sanitizeMetadata } from "../src/dedup.js";
import { runPipeline, datasetName } from "../src/pipeline.js";
import type { TraceRecord } from "../src/dedup.js";

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
