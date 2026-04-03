/**
 * Live canary rollout controller.
 *
 * Orchestrates phase progression (10 → 50 → 100) with:
 *   - Runtime-configurable phase thresholds and rollback policy (no redeploy).
 *   - Automatic rollback on degenerate_rate, p95_latency_ms, and error_rate breaches.
 *   - Kill switch that routes all traffic to baseline (no-steering).
 *   - Machine-readable event emission for phase changes and rollback actions.
 */

import {
  CanaryRouter,
  CanaryRouterConfig,
  RoutingDecision,
  RolloutPhase,
  DEFAULT_CANARY_CONFIG,
} from "./router.js";

import {
  MetricSample,
  RollbackDecision,
  RollbackPolicyConfig,
} from "./rollback-policy.js";

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export type ControllerEventType =
  | "phase_advance"
  | "phase_set"
  | "rollback_triggered"
  | "rollback_reset"
  | "kill_switch_enabled"
  | "kill_switch_disabled"
  | "config_updated"
  | "rollout_complete";

export interface ControllerEvent {
  type: ControllerEventType;
  timestamp: number;
  phase: RolloutPhase;
  phaseIndex: number;
  detail: Record<string, unknown>;
}

export type ControllerEventListener = (event: ControllerEvent) => void;

// ---------------------------------------------------------------------------
// Controller config
// ---------------------------------------------------------------------------

export interface CanaryControllerConfig {
  router: Partial<CanaryRouterConfig>;
  /** Minimum observation window (ms) before auto-advancing to next phase */
  minPhaseObservationMs: number;
  /** Whether automatic phase advancement is enabled */
  autoAdvance: boolean;
}

export const DEFAULT_CONTROLLER_CONFIG: CanaryControllerConfig = {
  router: {},
  minPhaseObservationMs: 5 * 60 * 1000, // 5 minutes
  autoAdvance: true,
};

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export class CanaryController {
  private router: CanaryRouter;
  private config: CanaryControllerConfig;
  private listeners: ControllerEventListener[] = [];
  private phaseEnteredAt: number;
  private frozen = false;

  constructor(config: Partial<CanaryControllerConfig> = {}) {
    this.config = { ...DEFAULT_CONTROLLER_CONFIG, ...config };
    this.router = new CanaryRouter(this.config.router);
    this.phaseEnteredAt = Date.now();
  }

  // -------------------------------------------------------------------------
  // Event system
  // -------------------------------------------------------------------------

  on(listener: ControllerEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private emit(
    type: ControllerEventType,
    detail: Record<string, unknown> = {},
    now?: number,
  ): ControllerEvent {
    const event: ControllerEvent = {
      type,
      timestamp: now ?? Date.now(),
      phase: this.router.getCurrentPhase(),
      phaseIndex: this.router.getCurrentPhaseIndex(),
      detail,
    };
    for (const listener of this.listeners) {
      listener(event);
    }
    return event;
  }

  // -------------------------------------------------------------------------
  // Routing
  // -------------------------------------------------------------------------

  route(randomValue?: number, now?: number): RoutingDecision {
    return this.router.route(randomValue, now);
  }

  // -------------------------------------------------------------------------
  // Phase management
  // -------------------------------------------------------------------------

  getCurrentPhase(): RolloutPhase {
    return this.router.getCurrentPhase();
  }

  getCurrentPhaseIndex(): number {
    return this.router.getCurrentPhaseIndex();
  }

  /**
   * Manually advance to the next rollout phase.
   * Returns false if already at final phase, rolled back, or frozen.
   */
  advancePhase(now?: number): boolean {
    if (this.frozen) return false;
    if (this.router.isRolledBack()) return false;

    const prevPhase = this.router.getCurrentPhase();
    const advanced = this.router.advancePhase();
    if (advanced) {
      const ts = now ?? Date.now();
      this.phaseEnteredAt = ts;
      const newPhase = this.router.getCurrentPhase();
      this.emit("phase_advance", { from: prevPhase, to: newPhase }, ts);

      if (newPhase === this.router.getConfig().phases[this.router.getConfig().phases.length - 1]) {
        this.emit("rollout_complete", { finalPhase: newPhase }, ts);
      }
    }
    return advanced;
  }

  /**
   * Attempt automatic phase advancement if conditions are met:
   *   - autoAdvance is enabled
   *   - Not frozen
   *   - Not rolled back
   *   - Minimum observation window has elapsed
   *   - Metrics are healthy (no pending rollback)
   *
   * Returns true if phase was advanced.
   */
  tryAutoAdvance(now?: number): boolean {
    const ts = now ?? Date.now();
    if (!this.config.autoAdvance) return false;
    if (this.frozen) return false;
    if (this.router.isRolledBack()) return false;

    const elapsed = ts - this.phaseEnteredAt;
    if (elapsed < this.config.minPhaseObservationMs) return false;

    const rollbackDecision = this.router.evaluateRollback(ts);
    if (rollbackDecision.shouldRollback) return false;

    return this.advancePhase(ts);
  }

  // -------------------------------------------------------------------------
  // Metric recording & rollback
  // -------------------------------------------------------------------------

  recordMetric(sample: MetricSample): void {
    this.router.recordMetric(sample);
  }

  recordMetrics(samples: MetricSample[]): void {
    this.router.recordMetrics(samples);
  }

  /**
   * Evaluate rollback policy against current metrics.
   * If rollback is triggered, emits a rollback_triggered event.
   * Returns the rollback decision with evaluation latency.
   */
  evaluateRollback(now?: number): RollbackDecision & { evaluationLatencyMs: number } {
    const start = performance.now();
    const decision = this.router.evaluateRollback(now);
    const evaluationLatencyMs = performance.now() - start;

    if (decision.shouldRollback && decision.breachedMetric !== null) {
      this.emit(
        "rollback_triggered",
        {
          breachedMetric: decision.breachedMetric,
          breachedValue: decision.breachedValue,
          threshold: decision.threshold,
          windowSamples: decision.windowSamples,
          evaluationLatencyMs,
        },
        now,
      );
    }

    return { ...decision, evaluationLatencyMs };
  }

  /**
   * Evaluate and route in one call — checks rollback before routing.
   * Emits rollback_triggered if a new breach is detected.
   */
  evaluateAndRoute(randomValue?: number, now?: number): RoutingDecision & { evaluationLatencyMs: number } {
    const evaluation = this.evaluateRollback(now);
    const routing = this.route(randomValue, now);
    return { ...routing, evaluationLatencyMs: evaluation.evaluationLatencyMs };
  }

  isRolledBack(): boolean {
    return this.router.isRolledBack();
  }

  resetRollback(resetPhase?: boolean, now?: number): void {
    this.router.resetRollback(resetPhase);
    const ts = now ?? Date.now();
    this.phaseEnteredAt = ts;
    this.emit("rollback_reset", { resetPhase: resetPhase ?? true }, ts);
  }

  // -------------------------------------------------------------------------
  // Kill switch
  // -------------------------------------------------------------------------

  enableKillSwitch(now?: number): void {
    this.router.enableKillSwitch();
    this.emit("kill_switch_enabled", {}, now);
  }

  disableKillSwitch(now?: number): void {
    this.router.disableKillSwitch();
    this.emit("kill_switch_disabled", {}, now);
  }

  isKillSwitchActive(): boolean {
    return this.router.isKillSwitchActive();
  }

  // -------------------------------------------------------------------------
  // Freeze (safety mechanism)
  // -------------------------------------------------------------------------

  /**
   * Freeze the controller — disables automatic phase advancement and manual advance.
   * Traffic continues routing to champion only.
   */
  freeze(now?: number): void {
    this.frozen = true;
    this.config.autoAdvance = false;
    this.emit("config_updated", { frozen: true, autoAdvance: false }, now);
  }

  isFrozen(): boolean {
    return this.frozen;
  }

  unfreeze(now?: number): void {
    this.frozen = false;
    this.emit("config_updated", { frozen: false }, now);
  }

  // -------------------------------------------------------------------------
  // Runtime config
  // -------------------------------------------------------------------------

  /**
   * Update controller configuration at runtime (no redeploy).
   * Supports updating router config, observation window, and auto-advance toggle.
   */
  updateConfig(update: Partial<CanaryControllerConfig>, now?: number): void {
    if (update.router !== undefined) {
      this.router.updateConfig(update.router);
    }
    if (update.minPhaseObservationMs !== undefined) {
      this.config.minPhaseObservationMs = update.minPhaseObservationMs;
    }
    if (update.autoAdvance !== undefined) {
      this.config.autoAdvance = update.autoAdvance;
    }
    this.emit("config_updated", { update }, now);
  }

  getConfig(): CanaryControllerConfig & { routerConfig: CanaryRouterConfig } {
    return {
      ...this.config,
      routerConfig: this.router.getConfig(),
    };
  }

  /**
   * Set phase directly (for config-driven updates without redeploy).
   * Only allows setting to a valid phase index.
   */
  setPhase(phaseIndex: number, now?: number): boolean {
    const phases = this.router.getConfig().phases;
    if (phaseIndex < 0 || phaseIndex >= phases.length) return false;
    if (this.router.isRolledBack()) return false;
    if (this.frozen) return false;

    const prevPhase = this.router.getCurrentPhase();
    this.router.updateConfig({ currentPhaseIndex: phaseIndex });
    const ts = now ?? Date.now();
    this.phaseEnteredAt = ts;
    this.emit("phase_set", { from: prevPhase, to: phases[phaseIndex], phaseIndex }, ts);
    return true;
  }

  /** Get time spent in current phase (ms). */
  getPhaseElapsedMs(now?: number): number {
    return (now ?? Date.now()) - this.phaseEnteredAt;
  }

  /** Override the phase-entered timestamp (for testing or config reload). */
  setPhaseEnteredAt(timestamp: number): void {
    this.phaseEnteredAt = timestamp;
  }
}
