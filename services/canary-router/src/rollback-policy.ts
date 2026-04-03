/**
 * Time-window based rollback policy for canary deployments.
 *
 * Monitors metric samples within a rolling window and triggers rollback
 * when configured threshold breaches are detected.
 */

export interface ThresholdConfig {
  /** Metric name (e.g. "degenerate_rate", "error_rate", "p95_latency_ms") */
  metric: string;
  /** Maximum allowed value — breach above this triggers rollback */
  maxValue: number;
}

export interface RollbackPolicyConfig {
  /** Rolling window duration in milliseconds */
  windowMs: number;
  /** Threshold definitions — any breach triggers rollback */
  thresholds: ThresholdConfig[];
}

export interface MetricSample {
  metric: string;
  value: number;
  timestamp: number;
}

export interface RollbackDecision {
  shouldRollback: boolean;
  breachedMetric: string | null;
  breachedValue: number | null;
  threshold: number | null;
  windowSamples: number;
}

export const DEFAULT_ROLLBACK_CONFIG: RollbackPolicyConfig = {
  windowMs: 30 * 60 * 1000, // 30 minutes
  thresholds: [
    { metric: "degenerate_rate", maxValue: 0.03 },
    { metric: "error_rate", maxValue: 0.05 },
    { metric: "p95_latency_ms", maxValue: 5000 },
  ],
};

export class RollbackPolicy {
  private config: RollbackPolicyConfig;
  private samples: MetricSample[] = [];
  private rolledBack = false;

  constructor(config: RollbackPolicyConfig = DEFAULT_ROLLBACK_CONFIG) {
    this.config = config;
  }

  /** Record a metric observation. */
  recordSample(sample: MetricSample): void {
    this.samples.push(sample);
    this.pruneOldSamples(sample.timestamp);
  }

  /** Record multiple samples at once. */
  recordSamples(samples: MetricSample[]): void {
    for (const s of samples) {
      this.samples.push(s);
    }
    if (samples.length > 0) {
      const latest = Math.max(...samples.map((s) => s.timestamp));
      this.pruneOldSamples(latest);
    }
  }

  /** Evaluate whether a rollback should be triggered based on current window. */
  evaluate(now?: number): RollbackDecision {
    const currentTime = now ?? Date.now();
    this.pruneOldSamples(currentTime);

    if (this.rolledBack) {
      return {
        shouldRollback: true,
        breachedMetric: null,
        breachedValue: null,
        threshold: null,
        windowSamples: this.samples.length,
      };
    }

    for (const threshold of this.config.thresholds) {
      const metricSamples = this.samples.filter(
        (s) => s.metric === threshold.metric,
      );
      if (metricSamples.length === 0) continue;

      const avg =
        metricSamples.reduce((sum, s) => sum + s.value, 0) /
        metricSamples.length;

      if (avg > threshold.maxValue) {
        this.rolledBack = true;
        return {
          shouldRollback: true,
          breachedMetric: threshold.metric,
          breachedValue: avg,
          threshold: threshold.maxValue,
          windowSamples: metricSamples.length,
        };
      }
    }

    return {
      shouldRollback: false,
      breachedMetric: null,
      breachedValue: null,
      threshold: null,
      windowSamples: this.samples.length,
    };
  }

  /** Reset the policy state (e.g. after a new deployment). */
  reset(): void {
    this.samples = [];
    this.rolledBack = false;
  }

  /** Check if a rollback has been triggered (sticky until reset). */
  isRolledBack(): boolean {
    return this.rolledBack;
  }

  /** Get current config. */
  getConfig(): RollbackPolicyConfig {
    return { ...this.config };
  }

  /** Update config at runtime. */
  updateConfig(config: Partial<RollbackPolicyConfig>): void {
    this.config = { ...this.config, ...config };
  }

  private pruneOldSamples(now: number): void {
    const cutoff = now - this.config.windowMs;
    this.samples = this.samples.filter((s) => s.timestamp >= cutoff);
  }
}
