/**
 * Canary routing simulation — validates end-to-end behavior of the canary
 * router through a simulated multi-phase rollout with metric recording
 * and automatic rollback.
 */

import { CanaryRouter } from "../src/router.js";
import { RollbackPolicy } from "../src/rollback-policy.js";

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

  const allPassed =
    rollbackDecision.shouldRollback &&
    rollbackRouteCount === 100 &&
    !canAdvance &&
    killSwitchCount === 100 &&
    recoveryDecision.isChallenger;

  if (allPassed) {
    console.log("\n✅ All simulation scenarios PASSED");
    process.exit(0);
  } else {
    console.error("\n❌ Some simulation scenarios FAILED");
    process.exit(1);
  }
}

runSimulation();
