import { describe, it, expect } from "vitest";
import {
  createTracingMiddleware,
  validateMetadata,
  buildTagsWithSuite,
  sanitizeMetadata,
  validateTagSet,
} from "telemetry";
import type { TraceMetadata } from "telemetry";

function fullMetadata(
  overrides?: Partial<TraceMetadata>
): Partial<TraceMetadata> {
  return {
    env: "prod",
    agent: "deepagentsjs",
    base_model: "gemma-3-27b-it",
    base_model_revision: "2026-03-15",
    profile_id: "steer-gemma3-default-v12",
    vector_bundle_id: "vec-bundle-2026-04-01-rc2",
    layers: [23, 29, 35, 41, 47],
    fallback_layer: 41,
    preset: "medium",
    multiplier: 0.22,
    concept: "expense-management",
    request_id: "req_01HV",
    thread_id: "thread_01HV",
    dataset_version: "steer-core-golden-v20260402",
    git_sha: "abc1234",
    judge_bundle: "judge-v4",
    latency_ms: 1720,
    input_tokens: 1034,
    output_tokens: 402,
    degenerate: false,
    language_shift: false,
    ...overrides,
  };
}

describe("tracing integration", () => {
  it("full metadata roundtrip: validate → sanitize → tag → middleware", async () => {
    const meta = fullMetadata();

    const validation = validateMetadata(meta, "prod");
    expect(validation.valid).toBe(true);

    const sanitized = sanitizeMetadata(
      meta as Record<string, unknown>
    );
    expect(sanitized.profile_id).toBe("steer-gemma3-default-v12");

    const tags = buildTagsWithSuite(meta, "core", "champion", "v12");
    expect(tags).toContain("model:gemma-3-27b-it");
    expect(tags).toContain("profile:steer-gemma3-default-v12");
    expect(tags).toContain("preset:medium");
    expect(tags).toContain("suite:core");

    const tagValidation = validateTagSet(tags);
    expect(tagValidation.valid).toBe(true);

    const middleware = createTracingMiddleware({ mode: "prod" });
    const result = await middleware(meta, {
      suite: "core",
      candidate: "champion",
      release: "v12",
    });
    expect(result.allowed).toBe(true);
    expect(result.trace!.project).toBe("steer-prod-prod");
    expect(result.trace!.tags).toContain("suite:core");
    expect(result.trace!.tags).toContain("candidate:champion");
    expect(result.trace!.tags).toContain("release:v12");
  });

  it("eval mode rejects incomplete metadata with correct project prefix", async () => {
    const middleware = createTracingMiddleware({ mode: "eval" });

    const incomplete = await middleware({ env: "staging" });
    expect(incomplete.allowed).toBe(false);

    const complete = await middleware(fullMetadata({ env: "staging" }), {
      suite: "core",
    });
    expect(complete.allowed).toBe(true);
    expect(complete.trace!.project).toBe("steer-evals-staging");
  });

  it("warnOnly mode preserves trace writes even with missing metadata", async () => {
    const traces: Array<Record<string, unknown>> = [];
    const middleware = createTracingMiddleware({
      mode: "prod",
      warnOnly: true,
      onTrace: (t) => {
        traces.push(t as unknown as Record<string, unknown>);
      },
    });

    const result = await middleware({ env: "prod" });
    expect(result.allowed).toBe(true);
    expect(traces).toHaveLength(1);
    expect(result.validation.warnings.length).toBeGreaterThan(0);
  });

  it("secrets are never exposed in trace output", async () => {
    const middleware = createTracingMiddleware({ mode: "prod" });
    const meta = {
      ...fullMetadata(),
      api_key: "sk-proj-secret",
      langsmith_token: "lsv2_pt_secret",
      config: {
        password: "super-secret",
      },
    } as unknown as Partial<TraceMetadata>;

    const result = await middleware(meta);
    expect(result.allowed).toBe(true);
    expect(result.trace!.metadata.api_key).toBe("[REDACTED]");
    expect(result.trace!.metadata.langsmith_token).toBe("[REDACTED]");
    const config = result.trace!.metadata.config as Record<string, unknown>;
    expect(config.password).toBe("[REDACTED]");
  });

  it("tag naming matches feedback-loop.md conventions", async () => {
    const middleware = createTracingMiddleware({ mode: "prod" });
    const result = await middleware(fullMetadata(), {
      suite: "core",
      candidate: "challenger",
      release: "v3",
    });

    const tags = result.trace!.tags;
    expect(tags.filter((t) => t.startsWith("model:")).length).toBe(1);
    expect(tags.filter((t) => t.startsWith("profile:")).length).toBe(1);
    expect(tags.filter((t) => t.startsWith("preset:")).length).toBe(1);
    expect(tags.filter((t) => t.startsWith("suite:")).length).toBe(1);
    expect(tags.filter((t) => t.startsWith("candidate:")).length).toBe(1);
    expect(tags.filter((t) => t.startsWith("concept:")).length).toBe(1);
    expect(tags.filter((t) => t.startsWith("release:")).length).toBe(1);

    for (const tag of tags) {
      expect(tag).toMatch(/^[a-z_]+:.+$/);
    }
  });
});
