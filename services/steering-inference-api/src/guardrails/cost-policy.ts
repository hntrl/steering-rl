/**
 * Cost and quota guardrails for the inference path.
 *
 * Enforces per-route token budgets and request quotas so production traffic
 * cannot exceed cost or safety envelopes. Supports per-model and per-profile
 * budget overrides.
 *
 * Policy decisions are emitted as telemetry events for auditing.
 * Over-budget requests return deterministic errors with retry guidance.
 */

// ---------------------------------------------------------------------------
// Budget configuration
// ---------------------------------------------------------------------------

export interface BudgetLimit {
  /** Maximum tokens allowed within the window */
  maxTokens: number;
  /** Maximum requests allowed within the window */
  maxRequests: number;
  /** Soft-limit threshold as a fraction (0–1) of max — emits warning when exceeded */
  softLimitFraction: number;
}

export interface BudgetOverride {
  /** Override keyed by model name */
  model?: string;
  /** Override keyed by profile ID */
  profileId?: string;
  /** Budget limits for this override */
  limits: Partial<BudgetLimit>;
}

export interface CostPolicyConfig {
  /** Default budget limits for all routes */
  defaultLimits: BudgetLimit;
  /** Rolling window duration in milliseconds */
  windowMs: number;
  /** Per-model or per-profile overrides */
  overrides: BudgetOverride[];
  /** When true, hard limits reject requests; when false, only emit warnings */
  hardLimitsEnabled: boolean;
}

export const DEFAULT_BUDGET_LIMITS: BudgetLimit = {
  maxTokens: 1_000_000,
  maxRequests: 10_000,
  softLimitFraction: 0.8,
};

export const DEFAULT_COST_POLICY_CONFIG: CostPolicyConfig = {
  defaultLimits: DEFAULT_BUDGET_LIMITS,
  windowMs: 60 * 60 * 1000, // 1 hour
  overrides: [],
  hardLimitsEnabled: true,
};

// ---------------------------------------------------------------------------
// Usage tracking
// ---------------------------------------------------------------------------

export interface UsageRecord {
  tokens: number;
  timestamp: number;
  model: string;
  profileId: string | null;
}

// ---------------------------------------------------------------------------
// Policy decision types
// ---------------------------------------------------------------------------

export type PolicyVerdict = "allow" | "soft_limit" | "hard_limit";

export interface PolicyDecision {
  verdict: PolicyVerdict;
  currentTokens: number;
  currentRequests: number;
  maxTokens: number;
  maxRequests: number;
  /** Which limit was breached (if any) */
  breachedLimit: "tokens" | "requests" | null;
  /** Retry-After guidance in seconds (null when allowed) */
  retryAfterSeconds: number | null;
}

// ---------------------------------------------------------------------------
// Telemetry events
// ---------------------------------------------------------------------------

export type CostPolicyEventType =
  | "budget_check"
  | "budget_soft_limit"
  | "budget_hard_limit"
  | "budget_usage_recorded";

export interface CostPolicyEvent {
  type: CostPolicyEventType;
  timestamp: number;
  model: string;
  profileId: string | null;
  decision: PolicyDecision;
  detail: Record<string, unknown>;
}

export type CostPolicyEventListener = (event: CostPolicyEvent) => void;

// ---------------------------------------------------------------------------
// Deterministic error for over-budget rejections
// ---------------------------------------------------------------------------

export class BudgetExceededError extends Error {
  public readonly statusCode: number;
  public readonly retryAfterSeconds: number;
  public readonly code: string;
  public readonly breachedLimit: "tokens" | "requests";

  constructor(decision: PolicyDecision) {
    const limitType = decision.breachedLimit ?? "tokens";
    const message =
      `Budget exceeded: ${limitType} limit reached ` +
      `(${limitType === "tokens" ? decision.currentTokens : decision.currentRequests}` +
      `/${limitType === "tokens" ? decision.maxTokens : decision.maxRequests}). ` +
      `Retry after ${decision.retryAfterSeconds}s.`;

    super(message);
    this.name = "BudgetExceededError";
    this.statusCode = 429;
    this.retryAfterSeconds = decision.retryAfterSeconds ?? 60;
    this.code = "budget_exceeded";
    this.breachedLimit = limitType;
  }
}

// ---------------------------------------------------------------------------
// CostPolicy implementation
// ---------------------------------------------------------------------------

export class CostPolicy {
  private config: CostPolicyConfig;
  private usageRecords: UsageRecord[] = [];
  private listeners: CostPolicyEventListener[] = [];

  constructor(config: Partial<CostPolicyConfig> = {}) {
    this.config = { ...DEFAULT_COST_POLICY_CONFIG, ...config };
  }

  // -------------------------------------------------------------------------
  // Event system
  // -------------------------------------------------------------------------

  on(listener: CostPolicyEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private emit(
    type: CostPolicyEventType,
    model: string,
    profileId: string | null,
    decision: PolicyDecision,
    detail: Record<string, unknown> = {},
    now?: number,
  ): CostPolicyEvent {
    const event: CostPolicyEvent = {
      type,
      timestamp: now ?? Date.now(),
      model,
      profileId,
      decision,
      detail,
    };
    for (const listener of this.listeners) {
      listener(event);
    }
    return event;
  }

  // -------------------------------------------------------------------------
  // Budget resolution
  // -------------------------------------------------------------------------

  /**
   * Resolve effective budget limits for a model+profile pair.
   * More specific overrides (profile+model) take priority over model-only or profile-only.
   */
  resolveLimits(model: string, profileId: string | null): BudgetLimit {
    const base = { ...this.config.defaultLimits };

    for (const override of this.config.overrides) {
      const matchesModel = override.model === model;
      const matchesProfile = override.profileId != null && override.profileId === profileId;

      if (override.model && override.profileId) {
        if (matchesModel && matchesProfile) {
          return { ...base, ...override.limits };
        }
      } else if (override.model && !override.profileId) {
        if (matchesModel) {
          Object.assign(base, override.limits);
        }
      } else if (!override.model && override.profileId) {
        if (matchesProfile) {
          Object.assign(base, override.limits);
        }
      }
    }

    return base;
  }

  // -------------------------------------------------------------------------
  // Window management
  // -------------------------------------------------------------------------

  private pruneOldRecords(now: number): void {
    const cutoff = now - this.config.windowMs;
    this.usageRecords = this.usageRecords.filter((r) => r.timestamp > cutoff);
  }

  private getWindowUsage(
    model: string,
    profileId: string | null,
    now: number,
  ): { tokens: number; requests: number } {
    this.pruneOldRecords(now);

    let tokens = 0;
    let requests = 0;

    for (const record of this.usageRecords) {
      if (record.model === model) {
        if (profileId === null || record.profileId === profileId || record.profileId === null) {
          tokens += record.tokens;
          requests += 1;
        }
      }
    }

    return { tokens, requests };
  }

  // -------------------------------------------------------------------------
  // Core policy check
  // -------------------------------------------------------------------------

  /**
   * Check whether a request is within budget.
   * Emits telemetry events for all decisions (allow, soft_limit, hard_limit).
   *
   * @param estimatedTokens - Estimated token count for the pending request
   *   (e.g. prompt tokens + max_tokens).
   */
  check(
    model: string,
    profileId: string | null,
    estimatedTokens: number,
    now?: number,
  ): PolicyDecision {
    const ts = now ?? Date.now();
    const limits = this.resolveLimits(model, profileId);
    const usage = this.getWindowUsage(model, profileId, ts);

    const projectedTokens = usage.tokens + estimatedTokens;
    const projectedRequests = usage.requests + 1;

    const softTokenThreshold = limits.maxTokens * limits.softLimitFraction;
    const softRequestThreshold = limits.maxRequests * limits.softLimitFraction;

    const oldestRecord = this.getOldestRecordTimestamp(model, profileId, ts);
    const retryAfterSeconds = oldestRecord !== null
      ? Math.max(1, Math.ceil((oldestRecord + this.config.windowMs - ts) / 1000))
      : 60;

    let verdict: PolicyVerdict = "allow";
    let breachedLimit: "tokens" | "requests" | null = null;

    if (projectedTokens > limits.maxTokens) {
      verdict = this.config.hardLimitsEnabled ? "hard_limit" : "soft_limit";
      breachedLimit = "tokens";
    } else if (projectedRequests > limits.maxRequests) {
      verdict = this.config.hardLimitsEnabled ? "hard_limit" : "soft_limit";
      breachedLimit = "requests";
    } else if (projectedTokens > softTokenThreshold) {
      verdict = "soft_limit";
      breachedLimit = "tokens";
    } else if (projectedRequests > softRequestThreshold) {
      verdict = "soft_limit";
      breachedLimit = "requests";
    }

    const decision: PolicyDecision = {
      verdict,
      currentTokens: usage.tokens,
      currentRequests: usage.requests,
      maxTokens: limits.maxTokens,
      maxRequests: limits.maxRequests,
      breachedLimit,
      retryAfterSeconds: verdict === "hard_limit" ? retryAfterSeconds : null,
    };

    if (verdict === "hard_limit") {
      this.emit("budget_hard_limit", model, profileId, decision, {
        estimatedTokens,
        projectedTokens,
        projectedRequests,
      }, ts);
    } else if (verdict === "soft_limit") {
      this.emit("budget_soft_limit", model, profileId, decision, {
        estimatedTokens,
        projectedTokens,
        projectedRequests,
      }, ts);
    } else {
      this.emit("budget_check", model, profileId, decision, {
        estimatedTokens,
        projectedTokens,
        projectedRequests,
      }, ts);
    }

    return decision;
  }

  /**
   * Enforce budget: check and throw BudgetExceededError if hard limit is breached.
   * Returns the decision for soft-limit or allow verdicts.
   */
  enforce(
    model: string,
    profileId: string | null,
    estimatedTokens: number,
    now?: number,
  ): PolicyDecision {
    const decision = this.check(model, profileId, estimatedTokens, now);

    if (decision.verdict === "hard_limit") {
      throw new BudgetExceededError(decision);
    }

    return decision;
  }

  // -------------------------------------------------------------------------
  // Usage recording
  // -------------------------------------------------------------------------

  /**
   * Record actual token usage after a request completes.
   */
  recordUsage(record: UsageRecord): void {
    this.usageRecords.push(record);

    const limits = this.resolveLimits(record.model, record.profileId);
    const usage = this.getWindowUsage(record.model, record.profileId, record.timestamp);

    const decision: PolicyDecision = {
      verdict: "allow",
      currentTokens: usage.tokens,
      currentRequests: usage.requests,
      maxTokens: limits.maxTokens,
      maxRequests: limits.maxRequests,
      breachedLimit: null,
      retryAfterSeconds: null,
    };

    this.emit("budget_usage_recorded", record.model, record.profileId, decision, {
      recordedTokens: record.tokens,
    }, record.timestamp);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private getOldestRecordTimestamp(
    model: string,
    profileId: string | null,
    now: number,
  ): number | null {
    this.pruneOldRecords(now);
    let oldest: number | null = null;

    for (const record of this.usageRecords) {
      if (record.model === model) {
        if (profileId === null || record.profileId === profileId || record.profileId === null) {
          if (oldest === null || record.timestamp < oldest) {
            oldest = record.timestamp;
          }
        }
      }
    }

    return oldest;
  }

  /** Get current usage snapshot (for monitoring/debugging). */
  getUsage(
    model: string,
    profileId: string | null,
    now?: number,
  ): { tokens: number; requests: number; limits: BudgetLimit } {
    const ts = now ?? Date.now();
    const usage = this.getWindowUsage(model, profileId, ts);
    const limits = this.resolveLimits(model, profileId);
    return { ...usage, limits };
  }

  /** Update policy configuration at runtime (no redeploy). */
  updateConfig(update: Partial<CostPolicyConfig>): void {
    if (update.defaultLimits !== undefined) {
      this.config.defaultLimits = { ...this.config.defaultLimits, ...update.defaultLimits };
    }
    if (update.windowMs !== undefined) {
      this.config.windowMs = update.windowMs;
    }
    if (update.overrides !== undefined) {
      this.config.overrides = update.overrides;
    }
    if (update.hardLimitsEnabled !== undefined) {
      this.config.hardLimitsEnabled = update.hardLimitsEnabled;
    }
  }

  /** Get current configuration. */
  getConfig(): CostPolicyConfig {
    return { ...this.config };
  }
}
