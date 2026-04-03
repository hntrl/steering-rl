import { describe, it, expect, beforeEach } from "vitest";
import { CanaryRouter, CanaryRouterConfig, RolloutPhase } from "../src/router.js";
import {
  RollbackPolicy,
  RollbackPolicyConfig,
  MetricSample,
} from "../src/rollback-policy.js";

// ---------------------------------------------------------------------------
// RollbackPolicy
// ---------------------------------------------------------------------------
describe("RollbackPolicy", () => {
  const windowMs = 30 * 60 * 1000; // 30 min
  const baseTime = 1_000_000_000;

  let policy: RollbackPolicy;

  beforeEach(() => {
    policy = new RollbackPolicy({
      windowMs,
      thresholds: [
        { metric: "degenerate_rate", maxValue: 0.03 },
        { metric: "error_rate", maxValue: 0.05 },
        { metric: "p95_latency_ms", maxValue: 5000 },
      ],
    });
  });

  it("returns no rollback when no samples exist", () => {
    const decision = policy.evaluate(baseTime);
    expect(decision.shouldRollback).toBe(false);
    expect(decision.breachedMetric).toBeNull();
  });

  it("returns no rollback when metrics are within thresholds", () => {
    policy.recordSample({
      metric: "degenerate_rate",
      value: 0.01,
      timestamp: baseTime,
    });
    policy.recordSample({
      metric: "error_rate",
      value: 0.02,
      timestamp: baseTime,
    });
    const decision = policy.evaluate(baseTime);
    expect(decision.shouldRollback).toBe(false);
  });

  it("triggers rollback when degenerate_rate exceeds threshold", () => {
    policy.recordSample({
      metric: "degenerate_rate",
      value: 0.05,
      timestamp: baseTime,
    });
    const decision = policy.evaluate(baseTime);
    expect(decision.shouldRollback).toBe(true);
    expect(decision.breachedMetric).toBe("degenerate_rate");
    expect(decision.breachedValue).toBe(0.05);
    expect(decision.threshold).toBe(0.03);
  });

  it("triggers rollback when error_rate exceeds threshold", () => {
    policy.recordSample({
      metric: "error_rate",
      value: 0.10,
      timestamp: baseTime,
    });
    const decision = policy.evaluate(baseTime);
    expect(decision.shouldRollback).toBe(true);
    expect(decision.breachedMetric).toBe("error_rate");
  });

  it("triggers rollback when p95_latency_ms exceeds threshold", () => {
    policy.recordSample({
      metric: "p95_latency_ms",
      value: 6000,
      timestamp: baseTime,
    });
    const decision = policy.evaluate(baseTime);
    expect(decision.shouldRollback).toBe(true);
    expect(decision.breachedMetric).toBe("p95_latency_ms");
  });

  it("prunes samples outside the rolling window", () => {
    policy.recordSample({
      metric: "degenerate_rate",
      value: 0.10,
      timestamp: baseTime - windowMs - 1000,
    });
    policy.recordSample({
      metric: "degenerate_rate",
      value: 0.01,
      timestamp: baseTime,
    });
    const decision = policy.evaluate(baseTime);
    expect(decision.shouldRollback).toBe(false);
  });

  it("rollback is sticky until reset", () => {
    policy.recordSample({
      metric: "degenerate_rate",
      value: 0.10,
      timestamp: baseTime,
    });
    policy.evaluate(baseTime);
    expect(policy.isRolledBack()).toBe(true);

    // Even after recording good samples, still rolled back
    policy.recordSample({
      metric: "degenerate_rate",
      value: 0.001,
      timestamp: baseTime + 1000,
    });
    const decision2 = policy.evaluate(baseTime + 1000);
    expect(decision2.shouldRollback).toBe(true);

    // Reset clears it
    policy.reset();
    expect(policy.isRolledBack()).toBe(false);
    const decision3 = policy.evaluate(baseTime + 2000);
    expect(decision3.shouldRollback).toBe(false);
  });

  it("averages multiple samples within the window", () => {
    // Two samples: avg = (0.02 + 0.06) / 2 = 0.04 > 0.03
    policy.recordSample({
      metric: "degenerate_rate",
      value: 0.02,
      timestamp: baseTime,
    });
    policy.recordSample({
      metric: "degenerate_rate",
      value: 0.06,
      timestamp: baseTime + 1000,
    });
    const decision = policy.evaluate(baseTime + 1000);
    expect(decision.shouldRollback).toBe(true);
    expect(decision.breachedMetric).toBe("degenerate_rate");
  });

  it("does not trigger when average is within threshold", () => {
    // avg = (0.02 + 0.03) / 2 = 0.025 <= 0.03
    policy.recordSample({
      metric: "degenerate_rate",
      value: 0.02,
      timestamp: baseTime,
    });
    policy.recordSample({
      metric: "degenerate_rate",
      value: 0.03,
      timestamp: baseTime + 1000,
    });
    const decision = policy.evaluate(baseTime + 1000);
    expect(decision.shouldRollback).toBe(false);
  });

  it("recordSamples batch works", () => {
    policy.recordSamples([
      { metric: "error_rate", value: 0.10, timestamp: baseTime },
      { metric: "error_rate", value: 0.08, timestamp: baseTime + 1000 },
    ]);
    const decision = policy.evaluate(baseTime + 1000);
    expect(decision.shouldRollback).toBe(true);
    expect(decision.breachedMetric).toBe("error_rate");
  });

  it("updateConfig changes thresholds at runtime", () => {
    policy.recordSample({
      metric: "degenerate_rate",
      value: 0.05,
      timestamp: baseTime,
    });
    // With default 0.03 threshold, this triggers
    expect(policy.evaluate(baseTime).shouldRollback).toBe(true);

    policy.reset();
    policy.updateConfig({
      thresholds: [{ metric: "degenerate_rate", maxValue: 0.10 }],
    });
    policy.recordSample({
      metric: "degenerate_rate",
      value: 0.05,
      timestamp: baseTime,
    });
    expect(policy.evaluate(baseTime).shouldRollback).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CanaryRouter
// ---------------------------------------------------------------------------
describe("CanaryRouter", () => {
  const baseTime = 1_000_000_000;

  describe("rollout phases (10/50/100)", () => {
    it("defaults to first phase (10%)", () => {
      const router = new CanaryRouter({
        championProfileId: "champ-v1",
        challengerProfileId: "chall-v2",
      });
      expect(router.getCurrentPhase()).toBe(10);
    });

    it("supports all three default phases", () => {
      const router = new CanaryRouter();
      expect(router.getCurrentPhase()).toBe(10);
      expect(router.advancePhase()).toBe(true);
      expect(router.getCurrentPhase()).toBe(50);
      expect(router.advancePhase()).toBe(true);
      expect(router.getCurrentPhase()).toBe(100);
      expect(router.advancePhase()).toBe(false); // already at final
    });

    it("routes to challenger at 10% phase with low random value", () => {
      const router = new CanaryRouter({
        championProfileId: "champ-v1",
        challengerProfileId: "chall-v2",
      });
      // random 0.05 -> 5% < 10% -> challenger
      const decision = router.route(0.05);
      expect(decision.isChallenger).toBe(true);
      expect(decision.profileId).toBe("chall-v2");
      expect(decision.canaryPercent).toBe(10);
      expect(decision.steeringEnabled).toBe(true);
    });

    it("routes to champion at 10% phase with high random value", () => {
      const router = new CanaryRouter({
        championProfileId: "champ-v1",
        challengerProfileId: "chall-v2",
      });
      // random 0.50 -> 50% >= 10% -> champion
      const decision = router.route(0.50);
      expect(decision.isChallenger).toBe(false);
      expect(decision.profileId).toBe("champ-v1");
    });

    it("routes more traffic to challenger at 50% phase", () => {
      const router = new CanaryRouter({
        championProfileId: "champ-v1",
        challengerProfileId: "chall-v2",
      });
      router.advancePhase(); // now at 50%
      // random 0.30 -> 30% < 50% -> challenger
      const decision = router.route(0.30);
      expect(decision.isChallenger).toBe(true);
      expect(decision.canaryPercent).toBe(50);
    });

    it("routes all traffic to challenger at 100% phase", () => {
      const router = new CanaryRouter({
        championProfileId: "champ-v1",
        challengerProfileId: "chall-v2",
      });
      router.advancePhase(); // 50%
      router.advancePhase(); // 100%
      // Even high random value routes to challenger
      const decision = router.route(0.99);
      expect(decision.isChallenger).toBe(true);
      expect(decision.profileId).toBe("chall-v2");
      expect(decision.canaryPercent).toBe(100);
    });

    it("supports custom phases via config", () => {
      const router = new CanaryRouter({
        phases: [10, 50, 100] as RolloutPhase[],
        currentPhaseIndex: 1,
      });
      expect(router.getCurrentPhase()).toBe(50);
    });
  });

  describe("statistical traffic distribution", () => {
    it("distributes ~10% traffic to challenger at phase 10", () => {
      const router = new CanaryRouter({
        championProfileId: "champ",
        challengerProfileId: "chall",
      });
      let challengerCount = 0;
      const total = 10_000;
      for (let i = 0; i < total; i++) {
        const decision = router.route(i / total);
        if (decision.isChallenger) challengerCount++;
      }
      const pct = challengerCount / total;
      expect(pct).toBeGreaterThan(0.08);
      expect(pct).toBeLessThan(0.12);
    });

    it("distributes ~50% traffic to challenger at phase 50", () => {
      const router = new CanaryRouter({
        championProfileId: "champ",
        challengerProfileId: "chall",
      });
      router.advancePhase();
      let challengerCount = 0;
      const total = 10_000;
      for (let i = 0; i < total; i++) {
        const decision = router.route(i / total);
        if (decision.isChallenger) challengerCount++;
      }
      const pct = challengerCount / total;
      expect(pct).toBeGreaterThan(0.48);
      expect(pct).toBeLessThan(0.52);
    });
  });

  describe("kill switch", () => {
    it("disables steering when kill switch is active", () => {
      const router = new CanaryRouter({
        championProfileId: "champ-v1",
        challengerProfileId: "chall-v2",
        killSwitch: true,
      });
      const decision = router.route(0.05);
      expect(decision.steeringEnabled).toBe(false);
      expect(decision.profileId).toBeNull();
      expect(decision.isChallenger).toBe(false);
    });

    it("can toggle kill switch at runtime", () => {
      const router = new CanaryRouter({
        championProfileId: "champ-v1",
        challengerProfileId: "chall-v2",
      });

      router.enableKillSwitch();
      expect(router.isKillSwitchActive()).toBe(true);
      let decision = router.route(0.05);
      expect(decision.steeringEnabled).toBe(false);
      expect(decision.profileId).toBeNull();

      router.disableKillSwitch();
      expect(router.isKillSwitchActive()).toBe(false);
      decision = router.route(0.05);
      expect(decision.steeringEnabled).toBe(true);
      expect(decision.profileId).toBe("chall-v2");
    });

    it("kill switch forces baseline no-steering for all random values", () => {
      const router = new CanaryRouter({ killSwitch: true });
      for (let i = 0; i < 100; i++) {
        const decision = router.route(i / 100);
        expect(decision.steeringEnabled).toBe(false);
        expect(decision.profileId).toBeNull();
      }
    });
  });

  describe("auto rollback", () => {
    it("routes to champion when rollback triggers", () => {
      const router = new CanaryRouter({
        championProfileId: "champ-v1",
        challengerProfileId: "chall-v2",
        rollbackPolicy: {
          windowMs: 30 * 60 * 1000,
          thresholds: [{ metric: "degenerate_rate", maxValue: 0.03 }],
        },
      });

      router.recordMetric({
        metric: "degenerate_rate",
        value: 0.10,
        timestamp: baseTime,
      });

      const decision = router.route(0.05, baseTime); // would be challenger normally
      expect(decision.rolledBack).toBe(true);
      expect(decision.isChallenger).toBe(false);
      expect(decision.profileId).toBe("champ-v1");
      expect(decision.steeringEnabled).toBe(true);
    });

    it("prevents phase advance when rolled back", () => {
      const router = new CanaryRouter({
        rollbackPolicy: {
          windowMs: 30 * 60 * 1000,
          thresholds: [{ metric: "error_rate", maxValue: 0.05 }],
        },
      });

      router.recordMetric({
        metric: "error_rate",
        value: 0.20,
        timestamp: baseTime,
      });
      router.evaluateRollback(baseTime);

      expect(router.advancePhase()).toBe(false);
      expect(router.getCurrentPhase()).toBe(10);
    });

    it("can recover from rollback after reset", () => {
      const router = new CanaryRouter({
        championProfileId: "champ-v1",
        challengerProfileId: "chall-v2",
        rollbackPolicy: {
          windowMs: 30 * 60 * 1000,
          thresholds: [{ metric: "degenerate_rate", maxValue: 0.03 }],
        },
      });

      router.recordMetric({
        metric: "degenerate_rate",
        value: 0.10,
        timestamp: baseTime,
      });
      router.route(0.05, baseTime);
      expect(router.isRolledBack()).toBe(true);

      router.resetRollback();
      expect(router.isRolledBack()).toBe(false);
      expect(router.getCurrentPhase()).toBe(10); // reset to first phase

      const decision = router.route(0.05);
      expect(decision.rolledBack).toBe(false);
      expect(decision.isChallenger).toBe(true);
    });

    it("rollback triggers on p95 latency breach", () => {
      const router = new CanaryRouter({
        championProfileId: "champ-v1",
        challengerProfileId: "chall-v2",
        rollbackPolicy: {
          windowMs: 30 * 60 * 1000,
          thresholds: [{ metric: "p95_latency_ms", maxValue: 5000 }],
        },
      });

      router.recordMetric({
        metric: "p95_latency_ms",
        value: 7000,
        timestamp: baseTime,
      });

      const decision = router.route(0.05, baseTime);
      expect(decision.rolledBack).toBe(true);
      expect(decision.profileId).toBe("champ-v1");
    });
  });

  describe("config management", () => {
    it("returns config snapshot", () => {
      const router = new CanaryRouter({
        championProfileId: "champ-v1",
        challengerProfileId: "chall-v2",
      });
      const cfg = router.getConfig();
      expect(cfg.championProfileId).toBe("champ-v1");
      expect(cfg.challengerProfileId).toBe("chall-v2");
      expect(cfg.phases).toEqual([10, 50, 100]);
    });

    it("can update config at runtime", () => {
      const router = new CanaryRouter();
      router.updateConfig({ championProfileId: "new-champ" });
      expect(router.getConfig().championProfileId).toBe("new-champ");
    });
  });

  describe("integration: full canary lifecycle", () => {
    it("progresses through all phases and completes rollout", () => {
      const router = new CanaryRouter({
        championProfileId: "champ-v1",
        challengerProfileId: "chall-v2",
        rollbackPolicy: {
          windowMs: 30 * 60 * 1000,
          thresholds: [{ metric: "degenerate_rate", maxValue: 0.03 }],
        },
      });

      // Phase 1: 10%
      expect(router.getCurrentPhase()).toBe(10);
      router.recordMetric({
        metric: "degenerate_rate",
        value: 0.01,
        timestamp: baseTime,
      });
      expect(router.evaluateRollback(baseTime).shouldRollback).toBe(false);

      // Advance to 50%
      expect(router.advancePhase()).toBe(true);
      expect(router.getCurrentPhase()).toBe(50);
      router.recordMetric({
        metric: "degenerate_rate",
        value: 0.02,
        timestamp: baseTime + 60000,
      });
      expect(router.evaluateRollback(baseTime + 60000).shouldRollback).toBe(false);

      // Advance to 100%
      expect(router.advancePhase()).toBe(true);
      expect(router.getCurrentPhase()).toBe(100);

      // All traffic to challenger
      const decision = router.route(0.99);
      expect(decision.isChallenger).toBe(true);
      expect(decision.profileId).toBe("chall-v2");
      expect(decision.canaryPercent).toBe(100);
    });

    it("rolls back mid-rollout and recovers", () => {
      const router = new CanaryRouter({
        championProfileId: "champ-v1",
        challengerProfileId: "chall-v2",
        rollbackPolicy: {
          windowMs: 30 * 60 * 1000,
          thresholds: [{ metric: "degenerate_rate", maxValue: 0.03 }],
        },
      });

      // Advance to 50%
      router.advancePhase();
      expect(router.getCurrentPhase()).toBe(50);

      // Degeneration spike triggers rollback
      router.recordMetric({
        metric: "degenerate_rate",
        value: 0.08,
        timestamp: baseTime,
      });

      const decision = router.route(0.01, baseTime);
      expect(decision.rolledBack).toBe(true);
      expect(decision.profileId).toBe("champ-v1");
      expect(decision.steeringEnabled).toBe(true);

      // Cannot advance
      expect(router.advancePhase()).toBe(false);

      // Reset and re-deploy
      router.resetRollback();
      expect(router.getCurrentPhase()).toBe(10); // reset to first phase
      expect(router.isRolledBack()).toBe(false);

      // Can route normally again
      const decision2 = router.route(0.05);
      expect(decision2.isChallenger).toBe(true);
      expect(decision2.rolledBack).toBe(false);
    });
  });
});
