/**
 * Canary router for staged traffic splitting between champion and challenger
 * steering profiles.
 *
 * Supports:
 * - Config-driven rollout phases (10/50/100)
 * - Automatic rollback via RollbackPolicy integration
 * - Kill switch to disable steering entirely (baseline no-steering path)
 */

import {
  RollbackPolicy,
  RollbackPolicyConfig,
  MetricSample,
  RollbackDecision,
  DEFAULT_ROLLBACK_CONFIG,
} from "./rollback-policy.js";

export type RolloutPhase = 10 | 50 | 100;

export interface CanaryRouterConfig {
  /** Ordered rollout phases — traffic percentage sent to challenger */
  phases: RolloutPhase[];
  /** Currently active phase index (into phases array) */
  currentPhaseIndex: number;
  /** Champion profile ID */
  championProfileId: string;
  /** Challenger profile ID */
  challengerProfileId: string;
  /** Kill switch — when true, all traffic uses baseline (no steering) */
  killSwitch: boolean;
  /** Rollback policy config */
  rollbackPolicy: RollbackPolicyConfig;
}

export interface RoutingDecision {
  /** Which profile to use */
  profileId: string | null;
  /** Whether steering is active (false when kill switch is on) */
  steeringEnabled: boolean;
  /** Whether this request was routed to the challenger */
  isChallenger: boolean;
  /** Current canary percentage for challenger */
  canaryPercent: number;
  /** Current rollout phase */
  phase: RolloutPhase;
  /** Whether the system is in rollback state */
  rolledBack: boolean;
}

export const DEFAULT_CANARY_CONFIG: CanaryRouterConfig = {
  phases: [10, 50, 100],
  currentPhaseIndex: 0,
  championProfileId: "champion",
  challengerProfileId: "challenger",
  killSwitch: false,
  rollbackPolicy: DEFAULT_ROLLBACK_CONFIG,
};

export class CanaryRouter {
  private config: CanaryRouterConfig;
  private rollbackPolicy: RollbackPolicy;

  constructor(config: Partial<CanaryRouterConfig> = {}) {
    this.config = { ...DEFAULT_CANARY_CONFIG, ...config };
    this.rollbackPolicy = new RollbackPolicy(this.config.rollbackPolicy);
  }

  /** Route a request to champion or challenger based on current phase and rollback state. */
  route(randomValue?: number, now?: number): RoutingDecision {
    const rand = randomValue ?? Math.random();

    if (this.config.killSwitch) {
      return {
        profileId: null,
        steeringEnabled: false,
        isChallenger: false,
        canaryPercent: 0,
        phase: this.getCurrentPhase(),
        rolledBack: false,
      };
    }

    const rollbackDecision = this.rollbackPolicy.evaluate(now);
    if (rollbackDecision.shouldRollback) {
      return {
        profileId: this.config.championProfileId,
        steeringEnabled: true,
        isChallenger: false,
        canaryPercent: 0,
        phase: this.getCurrentPhase(),
        rolledBack: true,
      };
    }

    const canaryPercent = this.getCurrentPhase();
    const isChallenger = rand * 100 < canaryPercent;

    return {
      profileId: isChallenger
        ? this.config.challengerProfileId
        : this.config.championProfileId,
      steeringEnabled: true,
      isChallenger,
      canaryPercent,
      phase: canaryPercent,
      rolledBack: false,
    };
  }

  /** Advance to the next rollout phase. Returns false if already at final phase. */
  advancePhase(): boolean {
    if (this.rollbackPolicy.isRolledBack()) {
      return false;
    }

    if (this.config.currentPhaseIndex < this.config.phases.length - 1) {
      this.config.currentPhaseIndex++;
      return true;
    }
    return false;
  }

  /** Get the current rollout phase percentage. */
  getCurrentPhase(): RolloutPhase {
    return this.config.phases[this.config.currentPhaseIndex];
  }

  /** Get the current phase index. */
  getCurrentPhaseIndex(): number {
    return this.config.currentPhaseIndex;
  }

  /** Enable the kill switch — routes all traffic to baseline (no steering). */
  enableKillSwitch(): void {
    this.config.killSwitch = true;
  }

  /** Disable the kill switch — resumes normal canary routing. */
  disableKillSwitch(): void {
    this.config.killSwitch = false;
  }

  /** Check if kill switch is active. */
  isKillSwitchActive(): boolean {
    return this.config.killSwitch;
  }

  /** Record a metric sample for rollback evaluation. */
  recordMetric(sample: MetricSample): void {
    this.rollbackPolicy.recordSample(sample);
  }

  /** Record multiple metric samples. */
  recordMetrics(samples: MetricSample[]): void {
    this.rollbackPolicy.recordSamples(samples);
  }

  /** Manually evaluate rollback without routing. */
  evaluateRollback(now?: number): RollbackDecision {
    return this.rollbackPolicy.evaluate(now);
  }

  /** Check if the system is in rollback state. */
  isRolledBack(): boolean {
    return this.rollbackPolicy.isRolledBack();
  }

  /** Reset rollback state and optionally reset to first phase. */
  resetRollback(resetPhase = true): void {
    this.rollbackPolicy.reset();
    if (resetPhase) {
      this.config.currentPhaseIndex = 0;
    }
  }

  /** Get current full config snapshot. */
  getConfig(): CanaryRouterConfig {
    return {
      ...this.config,
      rollbackPolicy: this.rollbackPolicy.getConfig(),
    };
  }

  /** Update config at runtime. */
  updateConfig(config: Partial<CanaryRouterConfig>): void {
    if (config.rollbackPolicy) {
      this.rollbackPolicy.updateConfig(config.rollbackPolicy);
    }
    this.config = {
      ...this.config,
      ...config,
      rollbackPolicy: this.rollbackPolicy.getConfig(),
    };
  }
}
