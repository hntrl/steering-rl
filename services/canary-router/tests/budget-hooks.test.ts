import { describe, it, expect, beforeEach } from "vitest";
import { CanaryController } from "../src/controller.js";
import {
  BudgetHooks,
  DEFAULT_BUDGET_HOOK_CONFIG,
  type BudgetHookConfig,
  type BudgetHookEvent,
  type BudgetSignal,
} from "../src/budget-hooks.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const BASE_TIME = 1_000_000_000;

function collectEvents(hooks: BudgetHooks): BudgetHookEvent[] {
  const events: BudgetHookEvent[] = [];
  hooks.on((e) => events.push(e));
  return events;
}

function makeWarningSignal(overrides: Partial<BudgetSignal> = {}): BudgetSignal {
  return {
    severity: "warning",
    model: "gemma-3-27b-it",
    profileId: null,
    breachedLimit: "tokens",
    currentValue: 8500,
    maxValue: 10_000,
    timestamp: BASE_TIME,
    ...overrides,
  };
}

function makeBreachSignal(overrides: Partial<BudgetSignal> = {}): BudgetSignal {
  return {
    severity: "breach",
    model: "gemma-3-27b-it",
    profileId: null,
    breachedLimit: "tokens",
    currentValue: 11_000,
    maxValue: 10_000,
    timestamp: BASE_TIME,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Warning signals
// ---------------------------------------------------------------------------

describe("BudgetHooks — warning signals", () => {
  it("records warning and emits event", () => {
    const ctrl = new CanaryController();
    const hooks = new BudgetHooks(ctrl);
    const events = collectEvents(hooks);

    hooks.processSignal(makeWarningSignal());

    expect(hooks.getTotalWarnings()).toBe(1);
    expect(hooks.getTotalBreaches()).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("budget_warning_received");
    expect(events[0].signal!.severity).toBe("warning");
  });

  it("does not freeze controller on warning", () => {
    const ctrl = new CanaryController();
    const hooks = new BudgetHooks(ctrl);

    hooks.processSignal(makeWarningSignal());

    expect(ctrl.isFrozen()).toBe(false);
  });

  it("resets consecutive breach counter on warning", () => {
    const ctrl = new CanaryController();
    const hooks = new BudgetHooks(ctrl, { breachCountThreshold: 3 });

    hooks.processSignal(makeBreachSignal({ timestamp: BASE_TIME }));
    hooks.processSignal(makeBreachSignal({ timestamp: BASE_TIME + 1000 }));
    expect(hooks.getConsecutiveBreaches()).toBe(2);

    hooks.processSignal(makeWarningSignal({ timestamp: BASE_TIME + 2000 }));
    expect(hooks.getConsecutiveBreaches()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Breach signals — freeze behavior
// ---------------------------------------------------------------------------

describe("BudgetHooks — breach freeze", () => {
  it("freezes controller on single breach (default threshold=1)", () => {
    const ctrl = new CanaryController();
    const hooks = new BudgetHooks(ctrl);
    const events = collectEvents(hooks);

    hooks.processSignal(makeBreachSignal());

    expect(ctrl.isFrozen()).toBe(true);
    expect(hooks.getConsecutiveBreaches()).toBe(1);

    const freezeEvents = events.filter((e) => e.type === "budget_freeze_applied");
    expect(freezeEvents).toHaveLength(1);
    expect(freezeEvents[0].detail.controllerFrozen).toBe(true);
  });

  it("halts phase progression when frozen by breach", () => {
    const ctrl = new CanaryController();
    const hooks = new BudgetHooks(ctrl);

    expect(ctrl.getCurrentPhase()).toBe(10);
    hooks.processSignal(makeBreachSignal());

    expect(ctrl.advancePhase(BASE_TIME)).toBe(false);
    expect(ctrl.getCurrentPhase()).toBe(10);
  });

  it("respects breachCountThreshold before freezing", () => {
    const ctrl = new CanaryController();
    const hooks = new BudgetHooks(ctrl, { breachCountThreshold: 3 });

    hooks.processSignal(makeBreachSignal({ timestamp: BASE_TIME }));
    expect(ctrl.isFrozen()).toBe(false);

    hooks.processSignal(makeBreachSignal({ timestamp: BASE_TIME + 1000 }));
    expect(ctrl.isFrozen()).toBe(false);

    hooks.processSignal(makeBreachSignal({ timestamp: BASE_TIME + 2000 }));
    expect(ctrl.isFrozen()).toBe(true);
    expect(hooks.getConsecutiveBreaches()).toBe(3);
  });

  it("does not double-freeze on repeated breaches", () => {
    const ctrl = new CanaryController();
    const hooks = new BudgetHooks(ctrl);
    const events = collectEvents(hooks);

    hooks.processSignal(makeBreachSignal({ timestamp: BASE_TIME }));
    hooks.processSignal(makeBreachSignal({ timestamp: BASE_TIME + 1000 }));

    const freezeEvents = events.filter((e) => e.type === "budget_freeze_applied");
    expect(freezeEvents).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Breach signals — rollback behavior
// ---------------------------------------------------------------------------

describe("BudgetHooks — breach rollback", () => {
  it("triggers rollback evaluation on breach when rollbackOnBreach is enabled", () => {
    const ctrl = new CanaryController({
      router: {
        rollbackPolicy: {
          windowMs: 60_000,
          thresholds: [{ metric: "degenerate_rate", maxValue: 0.03 }],
        },
      },
    });
    const hooks = new BudgetHooks(ctrl, {
      rollbackOnBreach: true,
      freezeOnBreach: true,
    });
    const events = collectEvents(hooks);

    hooks.processSignal(makeBreachSignal());

    const rollbackEvents = events.filter((e) => e.type === "budget_rollback_applied");
    expect(rollbackEvents).toHaveLength(1);
  });

  it("does not trigger rollback when rollbackOnBreach is disabled", () => {
    const ctrl = new CanaryController();
    const hooks = new BudgetHooks(ctrl, {
      rollbackOnBreach: false,
      freezeOnBreach: true,
    });
    const events = collectEvents(hooks);

    hooks.processSignal(makeBreachSignal());

    const rollbackEvents = events.filter((e) => e.type === "budget_rollback_applied");
    expect(rollbackEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

describe("BudgetHooks — reset", () => {
  it("resets breach counter and unfreezes controller", () => {
    const ctrl = new CanaryController();
    const hooks = new BudgetHooks(ctrl);

    hooks.processSignal(makeBreachSignal());
    expect(ctrl.isFrozen()).toBe(true);
    expect(hooks.getConsecutiveBreaches()).toBe(1);

    hooks.reset(true, BASE_TIME + 5000);

    expect(ctrl.isFrozen()).toBe(false);
    expect(hooks.getConsecutiveBreaches()).toBe(0);
    expect(hooks.getTotalWarnings()).toBe(0);
    expect(hooks.getTotalBreaches()).toBe(0);
  });

  it("emits reset event", () => {
    const ctrl = new CanaryController();
    const hooks = new BudgetHooks(ctrl);
    const events = collectEvents(hooks);

    hooks.processSignal(makeBreachSignal());
    hooks.reset(true, BASE_TIME + 5000);

    const resetEvents = events.filter((e) => e.type === "budget_hook_reset");
    expect(resetEvents).toHaveLength(1);
    expect(resetEvents[0].detail.unfreeze).toBe(true);
  });

  it("reset without unfreeze keeps controller frozen", () => {
    const ctrl = new CanaryController();
    const hooks = new BudgetHooks(ctrl);

    hooks.processSignal(makeBreachSignal());
    hooks.reset(false, BASE_TIME + 5000);

    expect(ctrl.isFrozen()).toBe(true);
    expect(hooks.getConsecutiveBreaches()).toBe(0);
  });

  it("allows phase progression after reset and unfreeze", () => {
    const ctrl = new CanaryController();
    const hooks = new BudgetHooks(ctrl);

    hooks.processSignal(makeBreachSignal());
    expect(ctrl.advancePhase(BASE_TIME)).toBe(false);

    hooks.reset(true, BASE_TIME + 5000);
    ctrl.unfreeze(BASE_TIME + 5000);

    expect(ctrl.advancePhase(BASE_TIME + 6000)).toBe(true);
    expect(ctrl.getCurrentPhase()).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// Telemetry events
// ---------------------------------------------------------------------------

describe("BudgetHooks — telemetry", () => {
  it("all events include type, timestamp, and signal", () => {
    const ctrl = new CanaryController();
    const hooks = new BudgetHooks(ctrl);
    const events = collectEvents(hooks);

    hooks.processSignal(makeWarningSignal({ timestamp: BASE_TIME }));
    hooks.processSignal(makeBreachSignal({ timestamp: BASE_TIME + 1000 }));

    for (const event of events) {
      expect(event).toHaveProperty("type");
      expect(event).toHaveProperty("timestamp");
    }
  });

  it("breach events include consecutive breach count", () => {
    const ctrl = new CanaryController({ });
    const hooks = new BudgetHooks(ctrl, { breachCountThreshold: 5 });
    const events = collectEvents(hooks);

    hooks.processSignal(makeBreachSignal({ timestamp: BASE_TIME }));

    const breachEvents = events.filter((e) => e.type === "budget_breach_received");
    expect(breachEvents).toHaveLength(1);
    expect(breachEvents[0].detail.consecutiveBreaches).toBe(1);
    expect(breachEvents[0].detail.threshold).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Runtime config
// ---------------------------------------------------------------------------

describe("BudgetHooks — runtime config", () => {
  it("updateConfig changes behavior at runtime", () => {
    const ctrl = new CanaryController();
    const hooks = new BudgetHooks(ctrl, { breachCountThreshold: 3 });

    hooks.processSignal(makeBreachSignal({ timestamp: BASE_TIME }));
    expect(ctrl.isFrozen()).toBe(false);

    hooks.updateConfig({ breachCountThreshold: 1 });

    hooks.processSignal(makeBreachSignal({ timestamp: BASE_TIME + 1000 }));
    expect(ctrl.isFrozen()).toBe(true);
  });

  it("getConfig returns current configuration", () => {
    const ctrl = new CanaryController();
    const hooks = new BudgetHooks(ctrl, { breachCountThreshold: 5 });
    const config = hooks.getConfig();
    expect(config.breachCountThreshold).toBe(5);
    expect(config.freezeOnBreach).toBe(true);
  });

  it("can disable freeze at runtime", () => {
    const ctrl = new CanaryController();
    const hooks = new BudgetHooks(ctrl, { freezeOnBreach: true });

    hooks.updateConfig({ freezeOnBreach: false });
    hooks.processSignal(makeBreachSignal());

    expect(ctrl.isFrozen()).toBe(false);
  });
});
