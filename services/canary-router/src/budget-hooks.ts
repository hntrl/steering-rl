/**
 * Budget hooks for the canary rollout controller.
 *
 * Receives budget breach signals from the inference path and translates them
 * into rollout controller actions — halting phase progression and optionally
 * triggering rollback when cost envelopes are exceeded.
 *
 * All policy decisions are emitted as telemetry events for auditing.
 */

import {
  CanaryController,
  type ControllerEvent,
  type ControllerEventType,
} from "./controller.js";

// ---------------------------------------------------------------------------
// Budget signal types
// ---------------------------------------------------------------------------

export type BudgetSeverity = "warning" | "breach";

export interface BudgetSignal {
  severity: BudgetSeverity;
  model: string;
  profileId: string | null;
  breachedLimit: "tokens" | "requests";
  currentValue: number;
  maxValue: number;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Budget hook events
// ---------------------------------------------------------------------------

export type BudgetHookEventType =
  | "budget_warning_received"
  | "budget_breach_received"
  | "budget_freeze_applied"
  | "budget_rollback_applied"
  | "budget_hook_reset";

export interface BudgetHookEvent {
  type: BudgetHookEventType;
  timestamp: number;
  signal: BudgetSignal | null;
  detail: Record<string, unknown>;
}

export type BudgetHookEventListener = (event: BudgetHookEvent) => void;

// ---------------------------------------------------------------------------
// Hook configuration
// ---------------------------------------------------------------------------

export interface BudgetHookConfig {
  /** Whether to freeze the controller on budget breach (halt phase progression) */
  freezeOnBreach: boolean;
  /** Whether to trigger rollback on budget breach */
  rollbackOnBreach: boolean;
  /** Number of consecutive breach signals before taking action */
  breachCountThreshold: number;
}

export const DEFAULT_BUDGET_HOOK_CONFIG: BudgetHookConfig = {
  freezeOnBreach: true,
  rollbackOnBreach: false,
  breachCountThreshold: 1,
};

// ---------------------------------------------------------------------------
// BudgetHooks implementation
// ---------------------------------------------------------------------------

export class BudgetHooks {
  private controller: CanaryController;
  private config: BudgetHookConfig;
  private listeners: BudgetHookEventListener[] = [];
  private consecutiveBreaches = 0;
  private warnings: BudgetSignal[] = [];
  private breaches: BudgetSignal[] = [];

  constructor(controller: CanaryController, config: Partial<BudgetHookConfig> = {}) {
    this.controller = controller;
    this.config = { ...DEFAULT_BUDGET_HOOK_CONFIG, ...config };
  }

  // -------------------------------------------------------------------------
  // Event system
  // -------------------------------------------------------------------------

  on(listener: BudgetHookEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private emit(
    type: BudgetHookEventType,
    signal: BudgetSignal | null,
    detail: Record<string, unknown> = {},
    now?: number,
  ): BudgetHookEvent {
    const event: BudgetHookEvent = {
      type,
      timestamp: now ?? Date.now(),
      signal,
      detail,
    };
    for (const listener of this.listeners) {
      listener(event);
    }
    return event;
  }

  // -------------------------------------------------------------------------
  // Signal processing
  // -------------------------------------------------------------------------

  /**
   * Process a budget signal from the inference path.
   *
   * - Warning signals are recorded and emitted as telemetry.
   * - Breach signals increment consecutive breach counter and may
   *   freeze the controller or trigger rollback.
   */
  processSignal(signal: BudgetSignal): void {
    if (signal.severity === "warning") {
      this.warnings.push(signal);
      this.consecutiveBreaches = 0;
      this.emit("budget_warning_received", signal, {
        totalWarnings: this.warnings.length,
      }, signal.timestamp);
      return;
    }

    this.breaches.push(signal);
    this.consecutiveBreaches++;

    this.emit("budget_breach_received", signal, {
      consecutiveBreaches: this.consecutiveBreaches,
      totalBreaches: this.breaches.length,
      threshold: this.config.breachCountThreshold,
    }, signal.timestamp);

    if (this.consecutiveBreaches >= this.config.breachCountThreshold) {
      this.applyBreachActions(signal);
    }
  }

  private applyBreachActions(signal: BudgetSignal): void {
    if (this.config.freezeOnBreach && !this.controller.isFrozen()) {
      this.controller.freeze(signal.timestamp);
      this.emit("budget_freeze_applied", signal, {
        controllerFrozen: true,
        phase: this.controller.getCurrentPhase(),
      }, signal.timestamp);
    }

    if (this.config.rollbackOnBreach && !this.controller.isRolledBack()) {
      const decision = this.controller.evaluateRollback(signal.timestamp);
      this.emit("budget_rollback_applied", signal, {
        rollbackTriggered: decision.shouldRollback,
        phase: this.controller.getCurrentPhase(),
      }, signal.timestamp);
    }
  }

  // -------------------------------------------------------------------------
  // State management
  // -------------------------------------------------------------------------

  /**
   * Reset breach counter and optionally unfreeze the controller.
   */
  reset(unfreeze: boolean = true, now?: number): void {
    const ts = now ?? Date.now();
    this.consecutiveBreaches = 0;
    this.warnings = [];
    this.breaches = [];

    if (unfreeze && this.controller.isFrozen()) {
      this.controller.unfreeze(ts);
    }

    this.emit("budget_hook_reset", null, { unfreeze }, ts);
  }

  getConsecutiveBreaches(): number {
    return this.consecutiveBreaches;
  }

  getTotalWarnings(): number {
    return this.warnings.length;
  }

  getTotalBreaches(): number {
    return this.breaches.length;
  }

  /** Update hook configuration at runtime. */
  updateConfig(update: Partial<BudgetHookConfig>): void {
    if (update.freezeOnBreach !== undefined) {
      this.config.freezeOnBreach = update.freezeOnBreach;
    }
    if (update.rollbackOnBreach !== undefined) {
      this.config.rollbackOnBreach = update.rollbackOnBreach;
    }
    if (update.breachCountThreshold !== undefined) {
      this.config.breachCountThreshold = update.breachCountThreshold;
    }
  }

  getConfig(): BudgetHookConfig {
    return { ...this.config };
  }
}
