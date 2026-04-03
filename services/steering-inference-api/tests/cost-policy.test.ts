import { describe, it, expect, beforeEach } from "vitest";
import {
  CostPolicy,
  BudgetExceededError,
  DEFAULT_COST_POLICY_CONFIG,
  type CostPolicyConfig,
  type CostPolicyEvent,
  type PolicyDecision,
  type BudgetLimit,
} from "../src/guardrails/cost-policy.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const BASE_TIME = 1_000_000_000;
const ONE_HOUR = 60 * 60 * 1000;

function collectEvents(policy: CostPolicy): CostPolicyEvent[] {
  const events: CostPolicyEvent[] = [];
  policy.on((e) => events.push(e));
  return events;
}

function makePolicyWithLimits(
  limits: Partial<BudgetLimit> = {},
  configOverrides: Partial<CostPolicyConfig> = {},
): CostPolicy {
  return new CostPolicy({
    defaultLimits: {
      maxTokens: 10_000,
      maxRequests: 100,
      softLimitFraction: 0.8,
      ...limits,
    },
    windowMs: ONE_HOUR,
    ...configOverrides,
  });
}

function seedUsage(
  policy: CostPolicy,
  model: string,
  profileId: string | null,
  count: number,
  tokensPerRequest: number,
  startTime: number,
): void {
  for (let i = 0; i < count; i++) {
    policy.recordUsage({
      tokens: tokensPerRequest,
      timestamp: startTime + i * 1000,
      model,
      profileId,
    });
  }
}

// ---------------------------------------------------------------------------
// Basic policy checks
// ---------------------------------------------------------------------------

describe("CostPolicy — basic checks", () => {
  it("allows requests under budget", () => {
    const policy = makePolicyWithLimits();
    const decision = policy.check("gemma-3-27b-it", null, 100, BASE_TIME);

    expect(decision.verdict).toBe("allow");
    expect(decision.breachedLimit).toBeNull();
    expect(decision.retryAfterSeconds).toBeNull();
  });

  it("returns current usage counters in decision", () => {
    const policy = makePolicyWithLimits();
    seedUsage(policy, "gemma-3-27b-it", null, 5, 100, BASE_TIME);

    const decision = policy.check("gemma-3-27b-it", null, 100, BASE_TIME + 10_000);

    expect(decision.currentTokens).toBe(500);
    expect(decision.currentRequests).toBe(5);
  });

  it("prunes records outside the rolling window", () => {
    const policy = makePolicyWithLimits();
    policy.recordUsage({
      tokens: 5000,
      timestamp: BASE_TIME,
      model: "gemma-3-27b-it",
      profileId: null,
    });

    const afterWindow = BASE_TIME + ONE_HOUR + 1;
    const decision = policy.check("gemma-3-27b-it", null, 100, afterWindow);

    expect(decision.currentTokens).toBe(0);
    expect(decision.currentRequests).toBe(0);
    expect(decision.verdict).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// Soft-limit warnings
// ---------------------------------------------------------------------------

describe("CostPolicy — soft-limit warnings", () => {
  it("emits soft_limit when token usage exceeds soft threshold", () => {
    const policy = makePolicyWithLimits({ maxTokens: 10_000, softLimitFraction: 0.8 });
    const events = collectEvents(policy);

    seedUsage(policy, "gemma-3-27b-it", null, 1, 7500, BASE_TIME);

    const decision = policy.check("gemma-3-27b-it", null, 1500, BASE_TIME + 5000);

    expect(decision.verdict).toBe("soft_limit");
    expect(decision.breachedLimit).toBe("tokens");
    expect(decision.retryAfterSeconds).toBeNull();

    const softEvents = events.filter((e) => e.type === "budget_soft_limit");
    expect(softEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("emits soft_limit when request count exceeds soft threshold", () => {
    const policy = makePolicyWithLimits({ maxRequests: 100, softLimitFraction: 0.8 });
    const events = collectEvents(policy);

    seedUsage(policy, "gemma-3-27b-it", null, 80, 10, BASE_TIME);

    const decision = policy.check("gemma-3-27b-it", null, 10, BASE_TIME + 100_000);

    expect(decision.verdict).toBe("soft_limit");
    expect(decision.breachedLimit).toBe("requests");
  });

  it("does not reject on soft limit (request proceeds)", () => {
    const policy = makePolicyWithLimits({ maxTokens: 10_000, softLimitFraction: 0.8 });
    seedUsage(policy, "gemma-3-27b-it", null, 1, 8500, BASE_TIME);

    const decision = policy.enforce("gemma-3-27b-it", null, 500, BASE_TIME + 5000);
    expect(decision.verdict).toBe("soft_limit");
  });
});

// ---------------------------------------------------------------------------
// Hard-limit rejections
// ---------------------------------------------------------------------------

describe("CostPolicy — hard-limit rejections", () => {
  it("rejects request when token budget is exceeded", () => {
    const policy = makePolicyWithLimits({ maxTokens: 10_000 });
    seedUsage(policy, "gemma-3-27b-it", null, 1, 9500, BASE_TIME);

    const decision = policy.check("gemma-3-27b-it", null, 1000, BASE_TIME + 5000);

    expect(decision.verdict).toBe("hard_limit");
    expect(decision.breachedLimit).toBe("tokens");
    expect(decision.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("rejects request when request quota is exceeded", () => {
    const policy = makePolicyWithLimits({ maxRequests: 100 });
    seedUsage(policy, "gemma-3-27b-it", null, 100, 10, BASE_TIME);

    const decision = policy.check("gemma-3-27b-it", null, 10, BASE_TIME + 200_000);

    expect(decision.verdict).toBe("hard_limit");
    expect(decision.breachedLimit).toBe("requests");
    expect(decision.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("enforce() throws BudgetExceededError on hard limit", () => {
    const policy = makePolicyWithLimits({ maxTokens: 10_000 });
    seedUsage(policy, "gemma-3-27b-it", null, 1, 9500, BASE_TIME);

    expect(() => {
      policy.enforce("gemma-3-27b-it", null, 1000, BASE_TIME + 5000);
    }).toThrow(BudgetExceededError);

    try {
      policy.enforce("gemma-3-27b-it", null, 1000, BASE_TIME + 5000);
    } catch (err) {
      expect(err).toBeInstanceOf(BudgetExceededError);
      const budgetErr = err as BudgetExceededError;
      expect(budgetErr.statusCode).toBe(429);
      expect(budgetErr.code).toBe("budget_exceeded");
      expect(budgetErr.retryAfterSeconds).toBeGreaterThan(0);
      expect(budgetErr.breachedLimit).toBe("tokens");
    }
  });

  it("emits hard_limit telemetry event on rejection", () => {
    const policy = makePolicyWithLimits({ maxTokens: 10_000 });
    const events = collectEvents(policy);

    seedUsage(policy, "gemma-3-27b-it", null, 1, 9500, BASE_TIME);
    policy.check("gemma-3-27b-it", null, 1000, BASE_TIME + 5000);

    const hardEvents = events.filter((e) => e.type === "budget_hard_limit");
    expect(hardEvents.length).toBeGreaterThanOrEqual(1);
    expect(hardEvents[0].model).toBe("gemma-3-27b-it");
    expect(hardEvents[0].decision.verdict).toBe("hard_limit");
  });

  it("returns deterministic retry-after guidance", () => {
    const policy = makePolicyWithLimits({ maxTokens: 10_000 });
    policy.recordUsage({
      tokens: 9500,
      timestamp: BASE_TIME + 1000,
      model: "gemma-3-27b-it",
      profileId: null,
    });

    const d1 = policy.check("gemma-3-27b-it", null, 1000, BASE_TIME + 2000);
    const d2 = policy.check("gemma-3-27b-it", null, 1000, BASE_TIME + 2000);

    expect(d1.retryAfterSeconds).toBe(d2.retryAfterSeconds);
    expect(d1.retryAfterSeconds).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Hard limits disabled (warning-only mode)
// ---------------------------------------------------------------------------

describe("CostPolicy — warning-only mode", () => {
  it("emits soft_limit instead of hard_limit when hardLimitsEnabled is false", () => {
    const policy = makePolicyWithLimits(
      { maxTokens: 10_000 },
      { hardLimitsEnabled: false },
    );
    const events = collectEvents(policy);

    seedUsage(policy, "gemma-3-27b-it", null, 1, 9500, BASE_TIME);
    const decision = policy.check("gemma-3-27b-it", null, 1000, BASE_TIME + 5000);

    expect(decision.verdict).toBe("soft_limit");
    expect(decision.retryAfterSeconds).toBeNull();

    const hardEvents = events.filter((e) => e.type === "budget_hard_limit");
    expect(hardEvents).toHaveLength(0);

    const softEvents = events.filter((e) => e.type === "budget_soft_limit");
    expect(softEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("enforce() does not throw when hardLimitsEnabled is false", () => {
    const policy = makePolicyWithLimits(
      { maxTokens: 10_000 },
      { hardLimitsEnabled: false },
    );
    seedUsage(policy, "gemma-3-27b-it", null, 1, 9500, BASE_TIME);

    const decision = policy.enforce("gemma-3-27b-it", null, 1000, BASE_TIME + 5000);
    expect(decision.verdict).toBe("soft_limit");
  });
});

// ---------------------------------------------------------------------------
// Per-model and per-profile overrides
// ---------------------------------------------------------------------------

describe("CostPolicy — budget overrides", () => {
  it("applies per-model override", () => {
    const policy = new CostPolicy({
      defaultLimits: { maxTokens: 10_000, maxRequests: 100, softLimitFraction: 0.8 },
      windowMs: ONE_HOUR,
      overrides: [
        { model: "gemma-3-27b-it", limits: { maxTokens: 50_000 } },
      ],
      hardLimitsEnabled: true,
    });

    const limits = policy.resolveLimits("gemma-3-27b-it", null);
    expect(limits.maxTokens).toBe(50_000);
    expect(limits.maxRequests).toBe(100);

    const otherLimits = policy.resolveLimits("llama-3-8b", null);
    expect(otherLimits.maxTokens).toBe(10_000);
  });

  it("applies per-profile override", () => {
    const policy = new CostPolicy({
      defaultLimits: { maxTokens: 10_000, maxRequests: 100, softLimitFraction: 0.8 },
      windowMs: ONE_HOUR,
      overrides: [
        { profileId: "steer-gemma3-default-v12", limits: { maxRequests: 500 } },
      ],
      hardLimitsEnabled: true,
    });

    const limits = policy.resolveLimits("gemma-3-27b-it", "steer-gemma3-default-v12");
    expect(limits.maxRequests).toBe(500);
    expect(limits.maxTokens).toBe(10_000);
  });

  it("applies combined model+profile override with highest specificity", () => {
    const policy = new CostPolicy({
      defaultLimits: { maxTokens: 10_000, maxRequests: 100, softLimitFraction: 0.8 },
      windowMs: ONE_HOUR,
      overrides: [
        { model: "gemma-3-27b-it", limits: { maxTokens: 50_000 } },
        { model: "gemma-3-27b-it", profileId: "premium", limits: { maxTokens: 200_000, maxRequests: 1000 } },
      ],
      hardLimitsEnabled: true,
    });

    const specificLimits = policy.resolveLimits("gemma-3-27b-it", "premium");
    expect(specificLimits.maxTokens).toBe(200_000);
    expect(specificLimits.maxRequests).toBe(1000);

    const modelOnlyLimits = policy.resolveLimits("gemma-3-27b-it", "other-profile");
    expect(modelOnlyLimits.maxTokens).toBe(50_000);
    expect(modelOnlyLimits.maxRequests).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Telemetry events
// ---------------------------------------------------------------------------

describe("CostPolicy — telemetry", () => {
  it("emits budget_check event for allowed requests", () => {
    const policy = makePolicyWithLimits();
    const events = collectEvents(policy);

    policy.check("gemma-3-27b-it", "profile-a", 100, BASE_TIME);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("budget_check");
    expect(events[0].model).toBe("gemma-3-27b-it");
    expect(events[0].profileId).toBe("profile-a");
    expect(events[0].timestamp).toBe(BASE_TIME);
  });

  it("emits budget_usage_recorded on recordUsage", () => {
    const policy = makePolicyWithLimits();
    const events = collectEvents(policy);

    policy.recordUsage({
      tokens: 500,
      timestamp: BASE_TIME,
      model: "gemma-3-27b-it",
      profileId: "profile-a",
    });

    const usageEvents = events.filter((e) => e.type === "budget_usage_recorded");
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0].detail.recordedTokens).toBe(500);
  });

  it("all events include model, profileId, and decision", () => {
    const policy = makePolicyWithLimits({ maxTokens: 1000 });
    const events = collectEvents(policy);

    seedUsage(policy, "gemma-3-27b-it", "p1", 1, 900, BASE_TIME);
    policy.check("gemma-3-27b-it", "p1", 200, BASE_TIME + 5000);

    for (const event of events) {
      expect(event).toHaveProperty("type");
      expect(event).toHaveProperty("timestamp");
      expect(event).toHaveProperty("model");
      expect(event).toHaveProperty("profileId");
      expect(event).toHaveProperty("decision");
      expect(event.decision).toHaveProperty("verdict");
      expect(event.decision).toHaveProperty("currentTokens");
      expect(event.decision).toHaveProperty("maxTokens");
    }
  });
});

// ---------------------------------------------------------------------------
// Runtime configuration
// ---------------------------------------------------------------------------

describe("CostPolicy — runtime config", () => {
  it("updateConfig changes limits at runtime", () => {
    const policy = makePolicyWithLimits({ maxTokens: 10_000 });
    seedUsage(policy, "gemma-3-27b-it", null, 1, 9500, BASE_TIME);

    let decision = policy.check("gemma-3-27b-it", null, 1000, BASE_TIME + 5000);
    expect(decision.verdict).toBe("hard_limit");

    policy.updateConfig({ defaultLimits: { maxTokens: 20_000, maxRequests: 100, softLimitFraction: 0.8 } });
    decision = policy.check("gemma-3-27b-it", null, 1000, BASE_TIME + 5000);
    expect(decision.verdict).toBe("allow");
  });

  it("can disable hard limits at runtime", () => {
    const policy = makePolicyWithLimits({ maxTokens: 10_000 });
    seedUsage(policy, "gemma-3-27b-it", null, 1, 9500, BASE_TIME);

    let decision = policy.check("gemma-3-27b-it", null, 1000, BASE_TIME + 5000);
    expect(decision.verdict).toBe("hard_limit");

    policy.updateConfig({ hardLimitsEnabled: false });
    decision = policy.check("gemma-3-27b-it", null, 1000, BASE_TIME + 5000);
    expect(decision.verdict).toBe("soft_limit");
  });

  it("getConfig returns current configuration", () => {
    const policy = makePolicyWithLimits({ maxTokens: 5000 });
    const config = policy.getConfig();
    expect(config.defaultLimits.maxTokens).toBe(5000);
    expect(config.hardLimitsEnabled).toBe(true);
  });

  it("getUsage returns current usage snapshot", () => {
    const policy = makePolicyWithLimits({ maxTokens: 10_000 });
    seedUsage(policy, "gemma-3-27b-it", "p1", 3, 100, BASE_TIME);

    const usage = policy.getUsage("gemma-3-27b-it", "p1", BASE_TIME + 10_000);
    expect(usage.tokens).toBe(300);
    expect(usage.requests).toBe(3);
    expect(usage.limits.maxTokens).toBe(10_000);
  });
});
