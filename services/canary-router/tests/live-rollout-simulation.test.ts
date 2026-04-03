import { describe, it, expect } from "vitest";
import {
  CanaryController,
  ControllerEvent,
} from "../src/controller.js";

/**
 * Live rollout simulation tests.
 *
 * Validates:
 *   - Full 10 → 50 → 100 phase progression under simulated load
 *   - Rollback decision latency meets SLA (< 5ms per evaluation)
 *   - Automatic rollback on threshold breaches
 *   - Kill switch forces baseline routing
 *   - Machine-readable event emission throughout lifecycle
 */

const ROLLBACK_LATENCY_SLA_MS = 5;

function simulateRequests(
  ctrl: CanaryController,
  count: number,
  now: number,
): { challenger: number; champion: number; baseline: number } {
  let challenger = 0;
  let champion = 0;
  let baseline = 0;
  for (let i = 0; i < count; i++) {
    const d = ctrl.route(Math.random(), now);
    if (!d.steeringEnabled) baseline++;
    else if (d.isChallenger) challenger++;
    else champion++;
  }
  return { challenger, champion, baseline };
}

// ---------------------------------------------------------------------------
// Simulation: happy-path 10 → 50 → 100
// ---------------------------------------------------------------------------
describe("Live rollout simulation — happy path", () => {
  const baseTime = 1_000_000_000;
  const observationMs = 5 * 60 * 1000;

  it("completes full rollout with correct traffic distribution per phase", () => {
    const ctrl = new CanaryController({
      minPhaseObservationMs: observationMs,
      autoAdvance: true,
      router: {
        championProfileId: "steer-gemma3-default-v12",
        challengerProfileId: "steer-gemma4-candidate-v3",
        rollbackPolicy: {
          windowMs: 30 * 60 * 1000,
          thresholds: [
            { metric: "degenerate_rate", maxValue: 0.03 },
            { metric: "error_rate", maxValue: 0.05 },
            { metric: "p95_latency_ms", maxValue: 5000 },
          ],
        },
      },
    });
    const events: ControllerEvent[] = [];
    ctrl.on((e) => events.push(e));

    const phases = [10, 50, 100];
    const requestsPerPhase = 5000;
    const results: Array<{ phase: number; challengerPct: number }> = [];

    ctrl.setPhaseEnteredAt(baseTime);

    for (let p = 0; p < phases.length; p++) {
      const phaseTime = baseTime + observationMs * p;

      // Inject healthy metrics
      ctrl.recordMetric({ metric: "degenerate_rate", value: 0.01, timestamp: phaseTime });
      ctrl.recordMetric({ metric: "error_rate", value: 0.02, timestamp: phaseTime });
      ctrl.recordMetric({ metric: "p95_latency_ms", value: 2000, timestamp: phaseTime });

      expect(ctrl.getCurrentPhase()).toBe(phases[p]);

      // Simulate traffic
      const dist = simulateRequests(ctrl, requestsPerPhase, phaseTime);
      const challengerPct = (dist.challenger / requestsPerPhase) * 100;
      results.push({ phase: phases[p], challengerPct });

      // Auto-advance to next phase (if not at final)
      if (p < phases.length - 1) {
        const advanced = ctrl.tryAutoAdvance(phaseTime + observationMs);
        expect(advanced).toBe(true);
      }
    }

    // Verify traffic distribution within statistical tolerance
    expect(results[0].challengerPct).toBeGreaterThan(5);
    expect(results[0].challengerPct).toBeLessThan(15);
    expect(results[1].challengerPct).toBeGreaterThan(44);
    expect(results[1].challengerPct).toBeLessThan(56);
    expect(results[2].challengerPct).toBeGreaterThan(98);

    // Verify events
    const phaseAdvances = events.filter((e) => e.type === "phase_advance");
    expect(phaseAdvances).toHaveLength(2);
    const complete = events.find((e) => e.type === "rollout_complete");
    expect(complete).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Simulation: rollback decision latency SLA
// ---------------------------------------------------------------------------
describe("Live rollout simulation — rollback latency SLA", () => {
  const baseTime = 1_000_000_000;

  it("rollback evaluation completes within SLA under load", () => {
    const ctrl = new CanaryController({
      router: {
        rollbackPolicy: {
          windowMs: 30 * 60 * 1000,
          thresholds: [
            { metric: "degenerate_rate", maxValue: 0.03 },
            { metric: "error_rate", maxValue: 0.05 },
            { metric: "p95_latency_ms", maxValue: 5000 },
          ],
        },
      },
    });

    // Populate window with realistic sample volume
    for (let i = 0; i < 500; i++) {
      ctrl.recordMetric({
        metric: "degenerate_rate",
        value: 0.01 + Math.random() * 0.005,
        timestamp: baseTime + i * 1000,
      });
      ctrl.recordMetric({
        metric: "error_rate",
        value: 0.02 + Math.random() * 0.01,
        timestamp: baseTime + i * 1000,
      });
      ctrl.recordMetric({
        metric: "p95_latency_ms",
        value: 2000 + Math.random() * 500,
        timestamp: baseTime + i * 1000,
      });
    }

    // Run many evaluations and measure latency
    const latencies: number[] = [];
    const evalCount = 200;
    for (let i = 0; i < evalCount; i++) {
      const result = ctrl.evaluateRollback(baseTime + 500_000 + i);
      latencies.push(result.evaluationLatencyMs);
      expect(result.shouldRollback).toBe(false);
    }

    // Compute p95 latency
    latencies.sort((a, b) => a - b);
    const p95Index = Math.floor(latencies.length * 0.95);
    const p95Latency = latencies[p95Index];

    expect(p95Latency).toBeLessThan(ROLLBACK_LATENCY_SLA_MS);
  });

  it("rollback evaluation latency stays within SLA even when rollback fires", () => {
    const ctrl = new CanaryController({
      router: {
        rollbackPolicy: {
          windowMs: 30 * 60 * 1000,
          thresholds: [
            { metric: "degenerate_rate", maxValue: 0.03 },
            { metric: "error_rate", maxValue: 0.05 },
            { metric: "p95_latency_ms", maxValue: 5000 },
          ],
        },
      },
    });

    // Populate with metrics that will trigger rollback
    for (let i = 0; i < 200; i++) {
      ctrl.recordMetric({
        metric: "degenerate_rate",
        value: 0.08,
        timestamp: baseTime + i * 1000,
      });
    }

    const result = ctrl.evaluateRollback(baseTime + 200_000);
    expect(result.shouldRollback).toBe(true);
    expect(result.evaluationLatencyMs).toBeLessThan(ROLLBACK_LATENCY_SLA_MS);
  });
});

// ---------------------------------------------------------------------------
// Simulation: automatic rollback on metric breach
// ---------------------------------------------------------------------------
describe("Live rollout simulation — automatic rollback", () => {
  const baseTime = 1_000_000_000;
  const observationMs = 5 * 60 * 1000;

  it("rolls back at 50% phase when degenerate_rate spikes", () => {
    const ctrl = new CanaryController({
      minPhaseObservationMs: observationMs,
      autoAdvance: true,
      router: {
        championProfileId: "steer-gemma3-default-v12",
        challengerProfileId: "steer-gemma4-candidate-v3",
        rollbackPolicy: {
          windowMs: 30 * 60 * 1000,
          thresholds: [{ metric: "degenerate_rate", maxValue: 0.03 }],
        },
      },
    });
    const events: ControllerEvent[] = [];
    ctrl.on((e) => events.push(e));

    // Advance to 50%
    ctrl.setPhaseEnteredAt(baseTime);
    ctrl.recordMetric({ metric: "degenerate_rate", value: 0.01, timestamp: baseTime });
    ctrl.tryAutoAdvance(baseTime + observationMs);
    expect(ctrl.getCurrentPhase()).toBe(50);

    // Inject bad metrics
    ctrl.recordMetric({ metric: "degenerate_rate", value: 0.08, timestamp: baseTime + observationMs + 1000 });

    const result = ctrl.evaluateRollback(baseTime + observationMs + 1000);
    expect(result.shouldRollback).toBe(true);
    expect(result.breachedMetric).toBe("degenerate_rate");

    // All 1000 requests go to champion
    const dist = simulateRequests(ctrl, 1000, baseTime + observationMs + 2000);
    expect(dist.champion).toBe(1000);
    expect(dist.challenger).toBe(0);

    // Auto-advance blocked
    expect(ctrl.tryAutoAdvance(baseTime + observationMs * 3)).toBe(false);

    // Verify rollback event emitted
    const rollbackEvents = events.filter((e) => e.type === "rollback_triggered");
    expect(rollbackEvents).toHaveLength(1);
    expect(rollbackEvents[0].detail.breachedMetric).toBe("degenerate_rate");
  });

  it("rolls back when p95 latency exceeds threshold", () => {
    const ctrl = new CanaryController({
      router: {
        championProfileId: "champ",
        challengerProfileId: "chall",
        rollbackPolicy: {
          windowMs: 60_000,
          thresholds: [{ metric: "p95_latency_ms", maxValue: 5000 }],
        },
      },
    });
    const events: ControllerEvent[] = [];
    ctrl.on((e) => events.push(e));

    ctrl.recordMetric({ metric: "p95_latency_ms", value: 7500, timestamp: baseTime });
    const result = ctrl.evaluateRollback(baseTime);
    expect(result.shouldRollback).toBe(true);

    const dist = simulateRequests(ctrl, 500, baseTime);
    expect(dist.champion).toBe(500);
    expect(dist.challenger).toBe(0);
  });

  it("rolls back when error_rate exceeds threshold", () => {
    const ctrl = new CanaryController({
      router: {
        championProfileId: "champ",
        challengerProfileId: "chall",
        rollbackPolicy: {
          windowMs: 60_000,
          thresholds: [{ metric: "error_rate", maxValue: 0.05 }],
        },
      },
    });

    ctrl.recordMetric({ metric: "error_rate", value: 0.15, timestamp: baseTime });
    const result = ctrl.evaluateRollback(baseTime);
    expect(result.shouldRollback).toBe(true);

    const dist = simulateRequests(ctrl, 500, baseTime);
    expect(dist.champion).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Simulation: kill switch
// ---------------------------------------------------------------------------
describe("Live rollout simulation — kill switch", () => {
  const baseTime = 1_000_000_000;

  it("kill switch forces all traffic to baseline (no steering)", () => {
    const ctrl = new CanaryController({
      router: {
        championProfileId: "steer-gemma3-default-v12",
        challengerProfileId: "steer-gemma4-candidate-v3",
      },
    });
    const events: ControllerEvent[] = [];
    ctrl.on((e) => events.push(e));

    ctrl.enableKillSwitch(baseTime);

    const dist = simulateRequests(ctrl, 1000, baseTime);
    expect(dist.baseline).toBe(1000);
    expect(dist.challenger).toBe(0);
    expect(dist.champion).toBe(0);

    const ksEvents = events.filter((e) => e.type === "kill_switch_enabled");
    expect(ksEvents).toHaveLength(1);
  });

  it("restores routing after kill switch is disabled", () => {
    const ctrl = new CanaryController({
      router: {
        championProfileId: "steer-gemma3-default-v12",
        challengerProfileId: "steer-gemma4-candidate-v3",
      },
    });

    ctrl.enableKillSwitch(baseTime);
    const dist1 = simulateRequests(ctrl, 100, baseTime);
    expect(dist1.baseline).toBe(100);

    ctrl.disableKillSwitch(baseTime + 1000);
    const dist2 = simulateRequests(ctrl, 1000, baseTime + 1000);
    expect(dist2.challenger + dist2.champion).toBe(1000);
    expect(dist2.baseline).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Simulation: event traceability
// ---------------------------------------------------------------------------
describe("Live rollout simulation — event traceability", () => {
  const baseTime = 1_000_000_000;
  const observationMs = 5 * 60 * 1000;

  it("emits a complete audit trail for full lifecycle", () => {
    const ctrl = new CanaryController({
      minPhaseObservationMs: observationMs,
      autoAdvance: true,
      router: {
        championProfileId: "champ",
        challengerProfileId: "chall",
        rollbackPolicy: {
          windowMs: 30 * 60 * 1000,
          thresholds: [
            { metric: "degenerate_rate", maxValue: 0.03 },
            { metric: "error_rate", maxValue: 0.05 },
            { metric: "p95_latency_ms", maxValue: 5000 },
          ],
        },
      },
    });
    const events: ControllerEvent[] = [];
    ctrl.on((e) => events.push(e));

    // Phase 1 → 2
    ctrl.setPhaseEnteredAt(baseTime);
    ctrl.recordMetric({ metric: "degenerate_rate", value: 0.01, timestamp: baseTime });
    ctrl.tryAutoAdvance(baseTime + observationMs);

    // Rollback at phase 2
    ctrl.recordMetric({ metric: "degenerate_rate", value: 0.08, timestamp: baseTime + observationMs + 1000 });
    ctrl.evaluateRollback(baseTime + observationMs + 1000);

    // Reset
    ctrl.resetRollback(true, baseTime + observationMs * 2);

    // Kill switch
    ctrl.enableKillSwitch(baseTime + observationMs * 3);
    ctrl.disableKillSwitch(baseTime + observationMs * 3 + 1000);

    // Config update
    ctrl.updateConfig({ minPhaseObservationMs: 1000 }, baseTime + observationMs * 4);

    // Verify all event types are machine-readable
    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain("phase_advance");
    expect(eventTypes).toContain("rollback_triggered");
    expect(eventTypes).toContain("rollback_reset");
    expect(eventTypes).toContain("kill_switch_enabled");
    expect(eventTypes).toContain("kill_switch_disabled");
    expect(eventTypes).toContain("config_updated");

    // Every event has required fields
    for (const event of events) {
      expect(event.type).toBeDefined();
      expect(typeof event.timestamp).toBe("number");
      expect(typeof event.phase).toBe("number");
      expect(typeof event.phaseIndex).toBe("number");
      expect(event.detail).toBeDefined();
    }

    // Events are JSON-serializable (machine-readable)
    const serialized = JSON.stringify(events);
    const parsed = JSON.parse(serialized);
    expect(parsed).toHaveLength(events.length);
  });
});
