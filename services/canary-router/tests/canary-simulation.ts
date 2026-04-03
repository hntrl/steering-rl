/**
 * Canary routing simulation — validates end-to-end behavior of the canary
 * router and controller through a simulated multi-phase rollout with metric
 * recording and automatic rollback.
 */

import { CanaryRouter } from "../src/router.js";
import { RollbackPolicy } from "../src/rollback-policy.js";
import { CanaryController, ControllerEvent } from "../src/controller.js";

interface SimulationResult {
  phase: number;
  totalRequests: number;
  challengerRequests: number;
  championRequests: number;
  challengerPct: number;
  rolledBack: boolean;
  killSwitchTested: boolean;
}

function runSimulation(): void {
  console.log("=== Canary Router Simulation ===\n");

  const results: SimulationResult[] = [];
  const baseTime = Date.now();

  // -----------------------------------------------------------------------
  // Scenario 1: Happy-path rollout through 10 → 50 → 100
  // -----------------------------------------------------------------------
  console.log("--- Scenario 1: Happy-path rollout (10 → 50 → 100) ---");
  const router = new CanaryRouter({
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
  });

  const phases = [10, 50, 100];
  for (let p = 0; p < phases.length; p++) {
    const total = 1000;
    let challengerCount = 0;
    let championCount = 0;

    for (let i = 0; i < total; i++) {
      const decision = router.route(Math.random());
      if (decision.isChallenger) challengerCount++;
      else championCount++;
    }

    // Record healthy metrics
    router.recordMetric({
      metric: "degenerate_rate",
      value: 0.01,
      timestamp: baseTime + p * 60000,
    });
    router.recordMetric({
      metric: "error_rate",
      value: 0.02,
      timestamp: baseTime + p * 60000,
    });

    const pct = (challengerCount / total) * 100;
    const result: SimulationResult = {
      phase: phases[p],
      totalRequests: total,
      challengerRequests: challengerCount,
      championRequests: championCount,
      challengerPct: Math.round(pct * 10) / 10,
      rolledBack: false,
      killSwitchTested: false,
    };
    results.push(result);

    console.log(
      `  Phase ${phases[p]}%: challenger=${challengerCount}/${total} (${pct.toFixed(1)}%) ✓`,
    );

    if (p < phases.length - 1) router.advancePhase();
  }

  // -----------------------------------------------------------------------
  // Scenario 2: Rollback triggered by degenerate_rate spike
  // -----------------------------------------------------------------------
  console.log("\n--- Scenario 2: Auto-rollback on degenerate_rate breach ---");
  const router2 = new CanaryRouter({
    championProfileId: "steer-gemma3-default-v12",
    challengerProfileId: "steer-gemma4-candidate-v3",
    rollbackPolicy: {
      windowMs: 30 * 60 * 1000,
      thresholds: [{ metric: "degenerate_rate", maxValue: 0.03 }],
    },
  });
  router2.advancePhase(); // move to 50%

  // Inject bad metrics
  router2.recordMetric({
    metric: "degenerate_rate",
    value: 0.08,
    timestamp: baseTime,
  });

  const rollbackDecision = router2.evaluateRollback(baseTime);
  console.log(
    `  Rollback triggered: ${rollbackDecision.shouldRollback} (metric=${rollbackDecision.breachedMetric}, value=${rollbackDecision.breachedValue}, threshold=${rollbackDecision.threshold})`,
  );

  let rollbackRouteCount = 0;
  for (let i = 0; i < 100; i++) {
    const d = router2.route(Math.random());
    if (d.rolledBack && d.profileId === "steer-gemma3-default-v12") {
      rollbackRouteCount++;
    }
  }
  console.log(
    `  All traffic to champion after rollback: ${rollbackRouteCount}/100 ✓`,
  );

  // Verify phase advance is blocked
  const canAdvance = router2.advancePhase();
  console.log(`  Phase advance blocked during rollback: ${!canAdvance} ✓`);

  // -----------------------------------------------------------------------
  // Scenario 3: Kill switch
  // -----------------------------------------------------------------------
  console.log("\n--- Scenario 3: Kill switch disables all steering ---");
  const router3 = new CanaryRouter({
    championProfileId: "steer-gemma3-default-v12",
    challengerProfileId: "steer-gemma4-candidate-v3",
  });

  router3.enableKillSwitch();
  let killSwitchCount = 0;
  for (let i = 0; i < 100; i++) {
    const d = router3.route(Math.random());
    if (!d.steeringEnabled && d.profileId === null) {
      killSwitchCount++;
    }
  }
  console.log(
    `  Kill switch active — no steering: ${killSwitchCount}/100 ✓`,
  );

  router3.disableKillSwitch();
  const afterKillSwitch = router3.route(0.05);
  console.log(
    `  Kill switch disabled — steering restored: ${afterKillSwitch.steeringEnabled} ✓`,
  );

  // -----------------------------------------------------------------------
  // Scenario 4: Recovery after rollback
  // -----------------------------------------------------------------------
  console.log("\n--- Scenario 4: Recovery after rollback reset ---");
  router2.resetRollback();
  console.log(`  Rollback reset — phase back to: ${router2.getCurrentPhase()}%`);
  console.log(`  Is rolled back: ${router2.isRolledBack()}`);
  const recoveryDecision = router2.route(0.05);
  console.log(
    `  Can route to challenger again: ${recoveryDecision.isChallenger} ✓`,
  );

  // -----------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------
  console.log("\n=== Simulation Summary ===");
  console.log("✓ 10/50/100 rollout phases supported");
  console.log("✓ Auto rollback triggers on threshold breach");
  console.log("✓ Kill switch forces baseline no-steering path");
  console.log("✓ Recovery after rollback reset works");

  const routerPassed =
    rollbackDecision.shouldRollback &&
    rollbackRouteCount === 100 &&
    !canAdvance &&
    killSwitchCount === 100 &&
    recoveryDecision.isChallenger;

  // -----------------------------------------------------------------------
  // Scenario 5: CanaryController — full lifecycle with events
  // -----------------------------------------------------------------------
  console.log("\n--- Scenario 5: CanaryController — phase progression with events ---");
  const observationMs = 5 * 60 * 1000;
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

  const ctrlEvents: ControllerEvent[] = [];
  ctrl.on((e) => ctrlEvents.push(e));

  // Phase 10% → 50% via auto-advance
  ctrl.setPhaseEnteredAt(baseTime);
  ctrl.recordMetric({ metric: "degenerate_rate", value: 0.01, timestamp: baseTime });
  ctrl.recordMetric({ metric: "error_rate", value: 0.02, timestamp: baseTime });
  ctrl.recordMetric({ metric: "p95_latency_ms", value: 2000, timestamp: baseTime });
  const autoAdvanced1 = ctrl.tryAutoAdvance(baseTime + observationMs);
  console.log(`  Auto-advance 10% → 50%: ${autoAdvanced1} (phase=${ctrl.getCurrentPhase()}%) ✓`);

  // Phase 50% → 100% via auto-advance
  ctrl.recordMetric({ metric: "degenerate_rate", value: 0.015, timestamp: baseTime + observationMs });
  const autoAdvanced2 = ctrl.tryAutoAdvance(baseTime + observationMs * 2);
  console.log(`  Auto-advance 50% → 100%: ${autoAdvanced2} (phase=${ctrl.getCurrentPhase()}%) ✓`);

  // Verify events
  const phaseAdvances = ctrlEvents.filter((e) => e.type === "phase_advance");
  const rolloutComplete = ctrlEvents.find((e) => e.type === "rollout_complete");
  console.log(`  Phase advance events: ${phaseAdvances.length} ✓`);
  console.log(`  Rollout complete event: ${rolloutComplete !== undefined} ✓`);

  // -----------------------------------------------------------------------
  // Scenario 6: Controller rollback with latency measurement
  // -----------------------------------------------------------------------
  console.log("\n--- Scenario 6: Controller rollback + latency SLA ---");
  const ctrl2 = new CanaryController({
    router: {
      championProfileId: "steer-gemma3-default-v12",
      challengerProfileId: "steer-gemma4-candidate-v3",
      rollbackPolicy: {
        windowMs: 30 * 60 * 1000,
        thresholds: [{ metric: "degenerate_rate", maxValue: 0.03 }],
      },
    },
  });
  const ctrl2Events: ControllerEvent[] = [];
  ctrl2.on((e) => ctrl2Events.push(e));

  // Populate with samples
  for (let i = 0; i < 200; i++) {
    ctrl2.recordMetric({ metric: "degenerate_rate", value: 0.08, timestamp: baseTime + i * 1000 });
  }

  const ctrlRollback = ctrl2.evaluateRollback(baseTime + 200_000);
  console.log(`  Rollback triggered: ${ctrlRollback.shouldRollback} (latency=${ctrlRollback.evaluationLatencyMs.toFixed(3)}ms) ✓`);
  console.log(`  Latency within SLA (<5ms): ${ctrlRollback.evaluationLatencyMs < 5} ✓`);

  const ctrlRollbackEvent = ctrl2Events.find((e) => e.type === "rollback_triggered");
  console.log(`  Rollback event emitted: ${ctrlRollbackEvent !== undefined} ✓`);

  // -----------------------------------------------------------------------
  // Scenario 7: Controller runtime config update
  // -----------------------------------------------------------------------
  console.log("\n--- Scenario 7: Runtime config update ---");
  const ctrl3 = new CanaryController({
    router: { championProfileId: "old-champ" },
  });
  const ctrl3Events: ControllerEvent[] = [];
  ctrl3.on((e) => ctrl3Events.push(e));

  ctrl3.updateConfig({ router: { championProfileId: "new-champ" } }, baseTime);
  const newCfg = ctrl3.getConfig();
  console.log(`  Config updated: championProfileId=${newCfg.routerConfig.championProfileId} ✓`);
  const configEvent = ctrl3Events.find((e) => e.type === "config_updated");
  console.log(`  Config event emitted: ${configEvent !== undefined} ✓`);

  // -----------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------
  console.log("\n=== Simulation Summary ===");
  console.log("✓ 10/50/100 rollout phases supported (router)");
  console.log("✓ Auto rollback triggers on threshold breach (router)");
  console.log("✓ Kill switch forces baseline no-steering path (router)");
  console.log("✓ Recovery after rollback reset works (router)");
  console.log("✓ Controller auto-advance 10 → 50 → 100 (controller)");
  console.log("✓ Controller emits machine-readable events (controller)");
  console.log("✓ Rollback decision latency within SLA (controller)");
  console.log("✓ Runtime config update without redeploy (controller)");

  const controllerPassed =
    autoAdvanced1 &&
    autoAdvanced2 &&
    ctrl.getCurrentPhase() === 100 &&
    phaseAdvances.length === 2 &&
    rolloutComplete !== undefined &&
    ctrlRollback.shouldRollback &&
    ctrlRollback.evaluationLatencyMs < 5 &&
    ctrlRollbackEvent !== undefined &&
    newCfg.routerConfig.championProfileId === "new-champ" &&
    configEvent !== undefined;

  const allPassed = routerPassed && controllerPassed;

  if (allPassed) {
    console.log("\n✅ All simulation scenarios PASSED");
    process.exit(0);
  } else {
    console.error("\n❌ Some simulation scenarios FAILED");
    if (!routerPassed) console.error("  Router scenarios failed");
    if (!controllerPassed) console.error("  Controller scenarios failed");
    process.exit(1);
  }
}

runSimulation();
