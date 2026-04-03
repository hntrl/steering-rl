import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  CanaryController,
  CanaryControllerConfig,
  ControllerEvent,
  ControllerEventType,
} from "../src/controller.js";
import { RolloutPhase } from "../src/router.js";

function collectEvents(controller: CanaryController): ControllerEvent[] {
  const events: ControllerEvent[] = [];
  controller.on((e) => events.push(e));
  return events;
}

// ---------------------------------------------------------------------------
// Phase progression
// ---------------------------------------------------------------------------
describe("CanaryController — phase progression", () => {
  const baseTime = 1_000_000_000;

  it("starts at first phase (10%)", () => {
    const ctrl = new CanaryController();
    expect(ctrl.getCurrentPhase()).toBe(10);
    expect(ctrl.getCurrentPhaseIndex()).toBe(0);
  });

  it("advances through 10 → 50 → 100", () => {
    const ctrl = new CanaryController();
    expect(ctrl.advancePhase(baseTime)).toBe(true);
    expect(ctrl.getCurrentPhase()).toBe(50);
    expect(ctrl.advancePhase(baseTime + 1000)).toBe(true);
    expect(ctrl.getCurrentPhase()).toBe(100);
    expect(ctrl.advancePhase(baseTime + 2000)).toBe(false);
  });

  it("emits phase_advance events", () => {
    const ctrl = new CanaryController();
    const events = collectEvents(ctrl);

    ctrl.advancePhase(baseTime);
    ctrl.advancePhase(baseTime + 1000);

    expect(events).toHaveLength(3); // 2 phase_advance + 1 rollout_complete
    expect(events[0].type).toBe("phase_advance");
    expect(events[0].detail.from).toBe(10);
    expect(events[0].detail.to).toBe(50);
    expect(events[0].timestamp).toBe(baseTime);

    expect(events[1].type).toBe("phase_advance");
    expect(events[1].detail.from).toBe(50);
    expect(events[1].detail.to).toBe(100);
  });

  it("emits rollout_complete when reaching final phase", () => {
    const ctrl = new CanaryController();
    const events = collectEvents(ctrl);

    ctrl.advancePhase(baseTime);
    ctrl.advancePhase(baseTime + 1000);

    const complete = events.find((e) => e.type === "rollout_complete");
    expect(complete).toBeDefined();
    expect(complete!.detail.finalPhase).toBe(100);
  });

  it("setPhase jumps directly to a valid phase", () => {
    const ctrl = new CanaryController();
    const events = collectEvents(ctrl);

    expect(ctrl.setPhase(2, baseTime)).toBe(true);
    expect(ctrl.getCurrentPhase()).toBe(100);
    expect(events[0].type).toBe("phase_set");
    expect(events[0].detail.from).toBe(10);
    expect(events[0].detail.to).toBe(100);
  });

  it("setPhase rejects invalid indices", () => {
    const ctrl = new CanaryController();
    expect(ctrl.setPhase(-1)).toBe(false);
    expect(ctrl.setPhase(99)).toBe(false);
  });

  it("setPhase rejected when frozen", () => {
    const ctrl = new CanaryController();
    ctrl.freeze(baseTime);
    expect(ctrl.setPhase(1, baseTime)).toBe(false);
  });

  it("setPhase rejected when rolled back", () => {
    const ctrl = new CanaryController({
      router: {
        rollbackPolicy: {
          windowMs: 60_000,
          thresholds: [{ metric: "error_rate", maxValue: 0.05 }],
        },
      },
    });
    ctrl.recordMetric({ metric: "error_rate", value: 0.10, timestamp: baseTime });
    ctrl.evaluateRollback(baseTime);
    expect(ctrl.setPhase(2, baseTime)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Auto-advance
// ---------------------------------------------------------------------------
describe("CanaryController — auto-advance", () => {
  const baseTime = 1_000_000_000;
  const observationMs = 5 * 60 * 1000;

  it("auto-advances after observation window elapses", () => {
    const ctrl = new CanaryController({ minPhaseObservationMs: observationMs });
    ctrl.setPhaseEnteredAt(baseTime);

    expect(ctrl.tryAutoAdvance(baseTime + observationMs - 1)).toBe(false);
    expect(ctrl.getCurrentPhase()).toBe(10);

    expect(ctrl.tryAutoAdvance(baseTime + observationMs)).toBe(true);
    expect(ctrl.getCurrentPhase()).toBe(50);
  });

  it("does not auto-advance when disabled", () => {
    const ctrl = new CanaryController({
      minPhaseObservationMs: observationMs,
      autoAdvance: false,
    });
    ctrl.setPhaseEnteredAt(baseTime);
    expect(ctrl.tryAutoAdvance(baseTime + observationMs + 1)).toBe(false);
  });

  it("does not auto-advance when frozen", () => {
    const ctrl = new CanaryController({ minPhaseObservationMs: observationMs });
    ctrl.setPhaseEnteredAt(baseTime);
    ctrl.freeze(baseTime);
    expect(ctrl.tryAutoAdvance(baseTime + observationMs + 1)).toBe(false);
  });

  it("does not auto-advance when metrics trigger rollback", () => {
    const ctrl = new CanaryController({
      minPhaseObservationMs: observationMs,
      router: {
        rollbackPolicy: {
          windowMs: 60_000,
          thresholds: [{ metric: "error_rate", maxValue: 0.05 }],
        },
      },
    });
    ctrl.setPhaseEnteredAt(baseTime);
    ctrl.recordMetric({ metric: "error_rate", value: 0.10, timestamp: baseTime + observationMs });
    expect(ctrl.tryAutoAdvance(baseTime + observationMs)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------
describe("CanaryController — rollback", () => {
  const baseTime = 1_000_000_000;

  it("triggers rollback on degenerate_rate breach and emits event", () => {
    const ctrl = new CanaryController({
      router: {
        rollbackPolicy: {
          windowMs: 60_000,
          thresholds: [{ metric: "degenerate_rate", maxValue: 0.03 }],
        },
      },
    });
    const events = collectEvents(ctrl);

    ctrl.recordMetric({ metric: "degenerate_rate", value: 0.08, timestamp: baseTime });
    const decision = ctrl.evaluateRollback(baseTime);

    expect(decision.shouldRollback).toBe(true);
    expect(decision.breachedMetric).toBe("degenerate_rate");
    expect(decision.evaluationLatencyMs).toBeDefined();
    expect(typeof decision.evaluationLatencyMs).toBe("number");

    const rollbackEvent = events.find((e) => e.type === "rollback_triggered");
    expect(rollbackEvent).toBeDefined();
    expect(rollbackEvent!.detail.breachedMetric).toBe("degenerate_rate");
    expect(rollbackEvent!.detail.evaluationLatencyMs).toBeDefined();
  });

  it("triggers rollback on p95_latency_ms breach", () => {
    const ctrl = new CanaryController({
      router: {
        rollbackPolicy: {
          windowMs: 60_000,
          thresholds: [{ metric: "p95_latency_ms", maxValue: 5000 }],
        },
      },
    });

    ctrl.recordMetric({ metric: "p95_latency_ms", value: 7000, timestamp: baseTime });
    const decision = ctrl.evaluateRollback(baseTime);

    expect(decision.shouldRollback).toBe(true);
    expect(decision.breachedMetric).toBe("p95_latency_ms");
  });

  it("triggers rollback on error_rate breach", () => {
    const ctrl = new CanaryController({
      router: {
        rollbackPolicy: {
          windowMs: 60_000,
          thresholds: [{ metric: "error_rate", maxValue: 0.05 }],
        },
      },
    });

    ctrl.recordMetric({ metric: "error_rate", value: 0.15, timestamp: baseTime });
    const decision = ctrl.evaluateRollback(baseTime);

    expect(decision.shouldRollback).toBe(true);
    expect(decision.breachedMetric).toBe("error_rate");
  });

  it("blocks phase advance when rolled back", () => {
    const ctrl = new CanaryController({
      router: {
        rollbackPolicy: {
          windowMs: 60_000,
          thresholds: [{ metric: "degenerate_rate", maxValue: 0.03 }],
        },
      },
    });
    ctrl.recordMetric({ metric: "degenerate_rate", value: 0.08, timestamp: baseTime });
    ctrl.evaluateRollback(baseTime);

    expect(ctrl.advancePhase(baseTime)).toBe(false);
  });

  it("routes to champion during rollback", () => {
    const ctrl = new CanaryController({
      router: {
        championProfileId: "champ-v1",
        challengerProfileId: "chall-v2",
        rollbackPolicy: {
          windowMs: 60_000,
          thresholds: [{ metric: "degenerate_rate", maxValue: 0.03 }],
        },
      },
    });
    ctrl.recordMetric({ metric: "degenerate_rate", value: 0.08, timestamp: baseTime });

    const decision = ctrl.evaluateAndRoute(0.05, baseTime);
    expect(decision.rolledBack).toBe(true);
    expect(decision.profileId).toBe("champ-v1");
    expect(decision.steeringEnabled).toBe(true);
  });

  it("resets rollback and emits event", () => {
    const ctrl = new CanaryController({
      router: {
        rollbackPolicy: {
          windowMs: 60_000,
          thresholds: [{ metric: "degenerate_rate", maxValue: 0.03 }],
        },
      },
    });
    ctrl.recordMetric({ metric: "degenerate_rate", value: 0.08, timestamp: baseTime });
    ctrl.evaluateRollback(baseTime);
    expect(ctrl.isRolledBack()).toBe(true);

    const events = collectEvents(ctrl);
    ctrl.resetRollback(true, baseTime + 1000);

    expect(ctrl.isRolledBack()).toBe(false);
    expect(ctrl.getCurrentPhase()).toBe(10);
    const resetEvent = events.find((e) => e.type === "rollback_reset");
    expect(resetEvent).toBeDefined();
    expect(resetEvent!.detail.resetPhase).toBe(true);
  });

  it("does not emit rollback event for sticky (already rolled back) evaluations", () => {
    const ctrl = new CanaryController({
      router: {
        rollbackPolicy: {
          windowMs: 60_000,
          thresholds: [{ metric: "degenerate_rate", maxValue: 0.03 }],
        },
      },
    });
    ctrl.recordMetric({ metric: "degenerate_rate", value: 0.08, timestamp: baseTime });
    ctrl.evaluateRollback(baseTime);

    const events = collectEvents(ctrl);
    ctrl.evaluateRollback(baseTime + 100);
    const rollbackEvents = events.filter((e) => e.type === "rollback_triggered");
    expect(rollbackEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------
describe("CanaryController — kill switch", () => {
  const baseTime = 1_000_000_000;

  it("routes to baseline when kill switch is enabled", () => {
    const ctrl = new CanaryController({
      router: {
        championProfileId: "champ-v1",
        challengerProfileId: "chall-v2",
      },
    });
    ctrl.enableKillSwitch(baseTime);

    expect(ctrl.isKillSwitchActive()).toBe(true);
    const decision = ctrl.route(0.05);
    expect(decision.steeringEnabled).toBe(false);
    expect(decision.profileId).toBeNull();
  });

  it("emits kill_switch_enabled and kill_switch_disabled events", () => {
    const ctrl = new CanaryController();
    const events = collectEvents(ctrl);

    ctrl.enableKillSwitch(baseTime);
    ctrl.disableKillSwitch(baseTime + 1000);

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("kill_switch_enabled");
    expect(events[1].type).toBe("kill_switch_disabled");
  });

  it("kill switch overrides all routing for every random value", () => {
    const ctrl = new CanaryController();
    ctrl.enableKillSwitch();

    for (let i = 0; i < 100; i++) {
      const d = ctrl.route(i / 100);
      expect(d.steeringEnabled).toBe(false);
      expect(d.profileId).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Runtime config
// ---------------------------------------------------------------------------
describe("CanaryController — runtime config", () => {
  const baseTime = 1_000_000_000;

  it("updates router config without redeploy", () => {
    const ctrl = new CanaryController({
      router: { championProfileId: "old-champ" },
    });
    const events = collectEvents(ctrl);

    ctrl.updateConfig(
      { router: { championProfileId: "new-champ" } },
      baseTime,
    );

    const cfg = ctrl.getConfig();
    expect(cfg.routerConfig.championProfileId).toBe("new-champ");
    expect(events[0].type).toBe("config_updated");
  });

  it("updates observation window at runtime", () => {
    const ctrl = new CanaryController({ minPhaseObservationMs: 60_000 });
    ctrl.updateConfig({ minPhaseObservationMs: 1000 }, baseTime);
    expect(ctrl.getConfig().minPhaseObservationMs).toBe(1000);
  });

  it("toggles autoAdvance at runtime", () => {
    const ctrl = new CanaryController({ autoAdvance: true });
    ctrl.updateConfig({ autoAdvance: false }, baseTime);
    expect(ctrl.getConfig().autoAdvance).toBe(false);
  });

  it("updateConfig emits config_updated event", () => {
    const ctrl = new CanaryController();
    const events = collectEvents(ctrl);
    ctrl.updateConfig({ autoAdvance: false }, baseTime);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("config_updated");
  });
});

// ---------------------------------------------------------------------------
// Freeze / unfreeze
// ---------------------------------------------------------------------------
describe("CanaryController — freeze", () => {
  const baseTime = 1_000_000_000;

  it("blocks advance when frozen", () => {
    const ctrl = new CanaryController();
    ctrl.freeze(baseTime);
    expect(ctrl.isFrozen()).toBe(true);
    expect(ctrl.advancePhase(baseTime)).toBe(false);
  });

  it("disables autoAdvance when frozen", () => {
    const ctrl = new CanaryController({
      autoAdvance: true,
      minPhaseObservationMs: 100,
    });
    ctrl.setPhaseEnteredAt(baseTime);
    ctrl.freeze(baseTime);
    expect(ctrl.tryAutoAdvance(baseTime + 200)).toBe(false);
  });

  it("unfreeze re-enables manual advance", () => {
    const ctrl = new CanaryController();
    ctrl.freeze(baseTime);
    ctrl.unfreeze(baseTime + 1000);
    expect(ctrl.isFrozen()).toBe(false);
    expect(ctrl.advancePhase(baseTime + 1000)).toBe(true);
  });

  it("emits config_updated events for freeze/unfreeze", () => {
    const ctrl = new CanaryController();
    const events = collectEvents(ctrl);
    ctrl.freeze(baseTime);
    ctrl.unfreeze(baseTime + 1000);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("config_updated");
    expect(events[0].detail.frozen).toBe(true);
    expect(events[1].detail.frozen).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Event listener management
// ---------------------------------------------------------------------------
describe("CanaryController — event listeners", () => {
  it("unsubscribe removes listener", () => {
    const ctrl = new CanaryController();
    const events: ControllerEvent[] = [];
    const unsub = ctrl.on((e) => events.push(e));

    ctrl.advancePhase();
    expect(events).toHaveLength(1);

    unsub();
    ctrl.advancePhase();
    expect(events).toHaveLength(1);
  });

  it("supports multiple listeners", () => {
    const ctrl = new CanaryController();
    const a: ControllerEvent[] = [];
    const b: ControllerEvent[] = [];
    ctrl.on((e) => a.push(e));
    ctrl.on((e) => b.push(e));

    ctrl.advancePhase();
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// evaluateAndRoute
// ---------------------------------------------------------------------------
describe("CanaryController — evaluateAndRoute", () => {
  const baseTime = 1_000_000_000;

  it("includes evaluation latency in route result", () => {
    const ctrl = new CanaryController({
      router: {
        championProfileId: "champ-v1",
        challengerProfileId: "chall-v2",
      },
    });
    const result = ctrl.evaluateAndRoute(0.05, baseTime);
    expect(result.evaluationLatencyMs).toBeGreaterThanOrEqual(0);
    expect(result.isChallenger).toBe(true);
    expect(result.profileId).toBe("chall-v2");
  });
});

// ---------------------------------------------------------------------------
// Integration: full lifecycle
// ---------------------------------------------------------------------------
describe("CanaryController — full lifecycle", () => {
  const baseTime = 1_000_000_000;
  const observationMs = 5 * 60 * 1000;

  it("completes 10 → 50 → 100 with auto-advance and healthy metrics", () => {
    const ctrl = new CanaryController({
      minPhaseObservationMs: observationMs,
      autoAdvance: true,
      router: {
        championProfileId: "champ-v1",
        challengerProfileId: "chall-v2",
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
    const events = collectEvents(ctrl);

    // Phase 1: 10%
    ctrl.setPhaseEnteredAt(baseTime);
    ctrl.recordMetric({ metric: "degenerate_rate", value: 0.01, timestamp: baseTime });
    ctrl.recordMetric({ metric: "error_rate", value: 0.02, timestamp: baseTime });
    ctrl.recordMetric({ metric: "p95_latency_ms", value: 2000, timestamp: baseTime });
    expect(ctrl.tryAutoAdvance(baseTime + observationMs - 1)).toBe(false);
    expect(ctrl.tryAutoAdvance(baseTime + observationMs)).toBe(true);
    expect(ctrl.getCurrentPhase()).toBe(50);

    // Phase 2: 50%
    ctrl.recordMetric({ metric: "degenerate_rate", value: 0.015, timestamp: baseTime + observationMs });
    ctrl.recordMetric({ metric: "error_rate", value: 0.03, timestamp: baseTime + observationMs });
    ctrl.recordMetric({ metric: "p95_latency_ms", value: 3000, timestamp: baseTime + observationMs });
    expect(ctrl.tryAutoAdvance(baseTime + observationMs * 2)).toBe(true);
    expect(ctrl.getCurrentPhase()).toBe(100);

    // Phase 3: 100% — no further advance
    expect(ctrl.tryAutoAdvance(baseTime + observationMs * 3)).toBe(false);

    // Verify events
    const phaseAdvances = events.filter((e) => e.type === "phase_advance");
    expect(phaseAdvances).toHaveLength(2);
    const complete = events.find((e) => e.type === "rollout_complete");
    expect(complete).toBeDefined();
  });

  it("auto-advance interrupted by rollback, then recovers", () => {
    const ctrl = new CanaryController({
      minPhaseObservationMs: observationMs,
      autoAdvance: true,
      router: {
        championProfileId: "champ-v1",
        challengerProfileId: "chall-v2",
        rollbackPolicy: {
          windowMs: 30 * 60 * 1000,
          thresholds: [{ metric: "degenerate_rate", maxValue: 0.03 }],
        },
      },
    });
    const events = collectEvents(ctrl);

    // Advance to 50%
    ctrl.setPhaseEnteredAt(baseTime);
    ctrl.recordMetric({ metric: "degenerate_rate", value: 0.01, timestamp: baseTime });
    expect(ctrl.tryAutoAdvance(baseTime + observationMs)).toBe(true);
    expect(ctrl.getCurrentPhase()).toBe(50);

    // Spike triggers rollback
    ctrl.recordMetric({ metric: "degenerate_rate", value: 0.08, timestamp: baseTime + observationMs + 1000 });
    const rollbackResult = ctrl.evaluateRollback(baseTime + observationMs + 1000);
    expect(rollbackResult.shouldRollback).toBe(true);

    // Auto-advance blocked
    expect(ctrl.tryAutoAdvance(baseTime + observationMs * 2 + 1000)).toBe(false);

    // All traffic to champion
    const decision = ctrl.route(0.01, baseTime + observationMs + 1000);
    expect(decision.rolledBack).toBe(true);
    expect(decision.profileId).toBe("champ-v1");

    // Reset and recover
    ctrl.resetRollback(true, baseTime + observationMs * 2);
    expect(ctrl.getCurrentPhase()).toBe(10);
    ctrl.recordMetric({ metric: "degenerate_rate", value: 0.01, timestamp: baseTime + observationMs * 2 });
    expect(ctrl.tryAutoAdvance(baseTime + observationMs * 3)).toBe(true);
    expect(ctrl.getCurrentPhase()).toBe(50);

    const rollbackEvents = events.filter((e) => e.type === "rollback_triggered");
    expect(rollbackEvents).toHaveLength(1);
    expect(rollbackEvents[0].detail.breachedMetric).toBe("degenerate_rate");
  });
});
