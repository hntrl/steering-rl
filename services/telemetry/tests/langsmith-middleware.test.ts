import { describe, it, expect, vi } from "vitest";
import {
  validateMetadata,
  sanitizeMetadata,
  buildTags,
  buildTagsWithSuite,
  validateTagSet,
} from "../src/metadata-validator.js";
import { createTracingMiddleware } from "../src/langsmith-middleware.js";
import type { TraceMetadata } from "../src/metadata-validator.js";

function validMetadata(
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
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// metadata-validator: validateMetadata
// ---------------------------------------------------------------------------

describe("validateMetadata", () => {
  it("accepts valid metadata in prod mode", () => {
    const result = validateMetadata(validMetadata(), "prod");
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts valid metadata in eval mode", () => {
    const result = validateMetadata(validMetadata(), "eval");
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects missing profile_id in prod mode", () => {
    const result = validateMetadata(
      validMetadata({ profile_id: undefined }),
      "prod"
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining("profile_id")
    );
  });

  it("rejects missing vector_bundle_id in eval mode", () => {
    const result = validateMetadata(
      validMetadata({ vector_bundle_id: undefined }),
      "eval"
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining("vector_bundle_id")
    );
  });

  it("rejects missing base_model in prod mode", () => {
    const result = validateMetadata(
      validMetadata({ base_model: undefined }),
      "prod"
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining("base_model")
    );
  });

  it("rejects missing preset in prod mode", () => {
    const result = validateMetadata(
      validMetadata({ preset: undefined }),
      "prod"
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.stringContaining("preset"));
  });

  it("rejects missing layers in prod mode", () => {
    const result = validateMetadata(
      validMetadata({ layers: undefined }),
      "prod"
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.stringContaining("layers"));
  });

  it("rejects missing env in prod mode", () => {
    const result = validateMetadata(validMetadata({ env: undefined }), "prod");
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.stringContaining("env"));
  });

  it("warns but does not reject missing fields in dev mode", () => {
    const result = validateMetadata({}, "dev");
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("rejects all required fields when missing in eval mode", () => {
    const result = validateMetadata({}, "eval");
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBe(6);
  });

  it("rejects empty-string profile_id in prod mode", () => {
    const result = validateMetadata(
      validMetadata({ profile_id: "" }),
      "prod"
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining("profile_id")
    );
  });

  it("warns on non-standard preset value", () => {
    const result = validateMetadata(
      validMetadata({ preset: "turbo" }),
      "prod"
    );
    expect(result.warnings).toContainEqual(
      expect.stringContaining("turbo")
    );
  });

  it("rejects non-array layers", () => {
    const meta = validMetadata();
    (meta as Record<string, unknown>).layers = "not-an-array";
    const result = validateMetadata(meta as Partial<TraceMetadata>, "prod");
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining("layers")
    );
  });

  it("rejects layers with non-number elements", () => {
    const meta = validMetadata();
    (meta as Record<string, unknown>).layers = [23, "foo", 41];
    const result = validateMetadata(meta as Partial<TraceMetadata>, "prod");
    expect(result.errors).toContainEqual(
      expect.stringContaining("numbers")
    );
  });
});

// ---------------------------------------------------------------------------
// metadata-validator: sanitizeMetadata (secret filtering)
// ---------------------------------------------------------------------------

describe("sanitizeMetadata", () => {
  it("redacts keys matching secret patterns", () => {
    const result = sanitizeMetadata({
      profile_id: "steer-v1",
      api_key: "sk-secret123",
      langsmith_token: "lsv2_abc",
    });
    expect(result.profile_id).toBe("steer-v1");
    expect(result.api_key).toBe("[REDACTED]");
    expect(result.langsmith_token).toBe("[REDACTED]");
  });

  it("redacts values that look like API keys even with safe key names", () => {
    const result = sanitizeMetadata({
      some_field: "sk-proj-abcdef1234567890",
      another: "lsv2_pt_abcdef123456",
    });
    expect(result.some_field).toBe("[REDACTED]");
    expect(result.another).toBe("[REDACTED]");
  });

  it("redacts nested secret keys", () => {
    const result = sanitizeMetadata({
      config: {
        api_key: "real-secret",
        name: "safe-value",
      },
    });
    const config = result.config as Record<string, unknown>;
    expect(config.api_key).toBe("[REDACTED]");
    expect(config.name).toBe("safe-value");
  });

  it("preserves non-secret values", () => {
    const input = {
      profile_id: "steer-gemma3-v12",
      base_model: "gemma-3-27b-it",
      layers: [23, 29, 35],
      preset: "medium",
    };
    const result = sanitizeMetadata(input);
    expect(result).toEqual(input);
  });

  it("redacts JWT-like values", () => {
    const result = sanitizeMetadata({
      header: "eyJhbGciOiJIUzI1NiJ9.payload.signature",
    });
    expect(result.header).toBe("[REDACTED]");
  });
});

// ---------------------------------------------------------------------------
// metadata-validator: buildTags / buildTagsWithSuite
// ---------------------------------------------------------------------------

describe("buildTags", () => {
  it("builds tags with model, profile, preset from metadata", () => {
    const tags = buildTags(validMetadata());
    expect(tags).toContain("model:gemma-3-27b-it");
    expect(tags).toContain("profile:steer-gemma3-default-v12");
    expect(tags).toContain("preset:medium");
  });

  it("includes concept tag when present", () => {
    const tags = buildTags(validMetadata());
    expect(tags).toContain("concept:expense-management");
  });

  it("omits concept tag when not provided", () => {
    const tags = buildTags(validMetadata({ concept: undefined }));
    expect(tags).not.toContainEqual(expect.stringContaining("concept:"));
  });
});

describe("buildTagsWithSuite", () => {
  it("appends suite, candidate, and release tags", () => {
    const tags = buildTagsWithSuite(validMetadata(), "core", "champion", "v12");
    expect(tags).toContain("suite:core");
    expect(tags).toContain("candidate:champion");
    expect(tags).toContain("release:v12");
  });

  it("omits suite/candidate/release when not provided", () => {
    const tags = buildTagsWithSuite(validMetadata());
    expect(tags).not.toContainEqual(expect.stringContaining("suite:"));
    expect(tags).not.toContainEqual(expect.stringContaining("candidate:"));
    expect(tags).not.toContainEqual(expect.stringContaining("release:"));
  });
});

// ---------------------------------------------------------------------------
// metadata-validator: validateTagSet
// ---------------------------------------------------------------------------

describe("validateTagSet", () => {
  it("validates a complete tag set", () => {
    const tags = [
      "model:gemma-3-27b-it",
      "profile:steer-v12",
      "preset:medium",
      "suite:core",
    ];
    const result = validateTagSet(tags);
    expect(result.valid).toBe(true);
  });

  it("rejects missing model tag", () => {
    const result = validateTagSet(["profile:steer-v12", "preset:medium"]);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.stringContaining("model:"));
  });

  it("rejects missing profile tag", () => {
    const result = validateTagSet(["model:gemma-3-27b", "preset:medium"]);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.stringContaining("profile:"));
  });

  it("rejects missing preset tag", () => {
    const result = validateTagSet(["model:gemma-3-27b", "profile:steer-v12"]);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.stringContaining("preset:"));
  });

  it("warns on unknown tag prefixes", () => {
    const result = validateTagSet([
      "model:gemma-3-27b",
      "profile:steer-v12",
      "preset:medium",
      "unknown:value",
    ]);
    expect(result.valid).toBe(true);
    expect(result.warnings).toContainEqual(
      expect.stringContaining("unknown:value")
    );
  });
});

// ---------------------------------------------------------------------------
// langsmith-middleware: createTracingMiddleware
// ---------------------------------------------------------------------------

describe("createTracingMiddleware", () => {
  it("allows valid trace in prod mode", async () => {
    const middleware = createTracingMiddleware({ mode: "prod" });
    const result = await middleware(validMetadata(), { suite: "core" });
    expect(result.allowed).toBe(true);
    expect(result.trace).not.toBeNull();
    expect(result.trace!.tags).toContain("model:gemma-3-27b-it");
    expect(result.trace!.tags).toContain("profile:steer-gemma3-default-v12");
    expect(result.trace!.tags).toContain("preset:medium");
    expect(result.trace!.tags).toContain("suite:core");
  });

  it("rejects trace with missing metadata in prod mode", async () => {
    const onError = vi.fn();
    const middleware = createTracingMiddleware({
      mode: "prod",
      onValidationError: onError,
    });
    const result = await middleware({});
    expect(result.allowed).toBe(false);
    expect(result.trace).toBeNull();
    expect(onError).toHaveBeenCalled();
  });

  it("rejects trace with missing metadata in eval mode", async () => {
    const middleware = createTracingMiddleware({ mode: "eval" });
    const result = await middleware({});
    expect(result.allowed).toBe(false);
    expect(result.trace).toBeNull();
  });

  it("allows trace with missing metadata in dev mode (warn only)", async () => {
    const middleware = createTracingMiddleware({ mode: "dev" });
    const result = await middleware({});
    expect(result.allowed).toBe(true);
    expect(result.validation.warnings.length).toBeGreaterThan(0);
  });

  it("allows trace with missing metadata in prod when warnOnly is true", async () => {
    const middleware = createTracingMiddleware({
      mode: "prod",
      warnOnly: true,
    });
    const result = await middleware({});
    expect(result.allowed).toBe(true);
  });

  it("sanitizes secrets in metadata before emitting trace", async () => {
    const traces: Array<{ metadata: Record<string, unknown> }> = [];
    const middleware = createTracingMiddleware({
      mode: "prod",
      onTrace: (t) => {
        traces.push(t);
      },
    });
    const meta = {
      ...validMetadata(),
      api_key: "sk-secret123",
    } as Partial<TraceMetadata>;
    const result = await middleware(meta);
    expect(result.allowed).toBe(true);
    expect(result.trace!.metadata.api_key).toBe("[REDACTED]");
  });

  it("calls onTrace callback with sanitized trace", async () => {
    const onTrace = vi.fn();
    const middleware = createTracingMiddleware({
      mode: "prod",
      onTrace,
    });
    await middleware(validMetadata(), { suite: "core" });
    expect(onTrace).toHaveBeenCalledTimes(1);
    const trace = onTrace.mock.calls[0][0];
    expect(trace.metadata.profile_id).toBe("steer-gemma3-default-v12");
    expect(trace.tags).toContain("suite:core");
  });

  it("sets project name based on mode and env", async () => {
    const evalMiddleware = createTracingMiddleware({ mode: "eval" });
    const prodMiddleware = createTracingMiddleware({ mode: "prod" });

    const evalResult = await evalMiddleware(
      validMetadata({ env: "staging" })
    );
    const prodResult = await prodMiddleware(validMetadata({ env: "prod" }));

    expect(evalResult.trace!.project).toBe("steer-evals-staging");
    expect(prodResult.trace!.project).toBe("steer-prod-prod");
  });

  it("includes required profile and vector fields in trace metadata", async () => {
    const middleware = createTracingMiddleware({ mode: "prod" });
    const result = await middleware(validMetadata());
    expect(result.trace!.metadata.profile_id).toBe(
      "steer-gemma3-default-v12"
    );
    expect(result.trace!.metadata.vector_bundle_id).toBe(
      "vec-bundle-2026-04-01-rc2"
    );
    expect(result.trace!.metadata.layers).toEqual([23, 29, 35, 41, 47]);
  });

  it("rejects when tag validation fails (missing model from metadata)", async () => {
    const middleware = createTracingMiddleware({ mode: "prod" });
    const meta = validMetadata({ base_model: undefined });
    const result = await middleware(meta);
    expect(result.allowed).toBe(false);
  });

  it("handles concurrent traces independently", async () => {
    const middleware = createTracingMiddleware({ mode: "prod" });
    const [r1, r2] = await Promise.all([
      middleware(validMetadata({ preset: "low" })),
      middleware(validMetadata({ preset: "strong" })),
    ]);
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
    expect(r1.trace!.tags).toContain("preset:low");
    expect(r2.trace!.tags).toContain("preset:strong");
  });
});
