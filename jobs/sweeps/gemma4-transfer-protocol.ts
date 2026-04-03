/**
 * Gemma 4 Transfer Protocol (P3-06)
 *
 * Defines a controlled Gemma 4 transfer protocol that reuses Gemma 3
 * methodology artifacts without changing defaults until transfer gates pass.
 *
 * Constraints:
 *   - Gemma 4 transfer runs are tagged experimental and non-default.
 *   - Transfer gate thresholds are at least as strict as Gemma 3 parity acceptance gates.
 *   - Includes rollback-to-Gemma-3 methodology path if transfer fails.
 *
 * Inputs:
 *   artifacts/sweeps/gemma3-acceptance-gates.json
 *   artifacts/sweeps/gemma4-transfer-gates.json
 *
 * Outputs:
 *   Transfer gate evaluation result (pass/fail with per-gate detail)
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TransferGateDef {
  description: string;
  threshold: number;
  gemma3_threshold: number;
  direction: "gte" | "lte";
  metric_key: string;
}

export interface TransferGatesArtifact {
  task_id: string;
  title: string;
  description: string;
  source_model: string;
  target_model: string;
  gemma3_acceptance_gates_ref: string;
  created_at: string;
  transfer_gates: Record<string, TransferGateDef>;
  decision_logic: {
    pass: string;
    fail: string;
    overall_rule: string;
  };
  rollback_policy: {
    trigger: string;
    action: string;
    gemma4_status_on_rollback: string;
    gemma3_status_on_rollback: string;
  };
  tagging: {
    gemma4_run_tag: string;
    gemma4_is_default: boolean;
    rationale: string;
  };
}

export interface Gemma3AcceptanceGates {
  task_id: string;
  model: string;
  acceptance_gates: Record<
    string,
    { threshold: number; gate_pass: boolean }
  >;
  methodology_decision: {
    gemma3_parity_status: string;
    gemma4_transfer_ready: boolean;
    rationale: string;
    conditions_for_gemma4: string[];
    rollback_note: string;
  };
}

export interface TransferMetrics {
  coherence: number;
  degenerate_rate: number;
  concept_adherence: number;
  language_stability: number;
  correctness: number;
}

export interface GateEvalResult {
  gate_name: string;
  metric_key: string;
  value: number;
  threshold: number;
  direction: "gte" | "lte";
  passed: boolean;
  reason: string;
}

export interface TransferEvaluation {
  overall_pass: boolean;
  gate_results: GateEvalResult[];
  decision: "proceed" | "rollback";
  gemma4_tag: "experimental";
  gemma4_is_default: false;
  rollback_action: string;
  evaluated_at: string;
}

export interface PrerequisiteCheckResult {
  check: string;
  passed: boolean;
  reason: string;
}

export interface PrerequisiteEvaluation {
  all_passed: boolean;
  checks: PrerequisiteCheckResult[];
}

// ---------------------------------------------------------------------------
// Gate evaluation
// ---------------------------------------------------------------------------

export function evaluateTransferGate(
  gateName: string,
  gateDef: TransferGateDef,
  metrics: TransferMetrics,
): GateEvalResult {
  const value = metrics[gateDef.metric_key as keyof TransferMetrics];
  if (value === undefined || value === null || Number.isNaN(value)) {
    return {
      gate_name: gateName,
      metric_key: gateDef.metric_key,
      value: NaN,
      threshold: gateDef.threshold,
      direction: gateDef.direction,
      passed: false,
      reason: `Missing or invalid metric: ${gateDef.metric_key}`,
    };
  }

  let passed: boolean;
  if (gateDef.direction === "gte") {
    passed = value >= gateDef.threshold;
  } else {
    passed = value <= gateDef.threshold;
  }

  const dirLabel = gateDef.direction === "gte" ? ">=" : "<=";
  const reason = passed
    ? `${gateDef.metric_key} ${value} ${dirLabel} ${gateDef.threshold}`
    : `${gateDef.metric_key} ${value} failed ${dirLabel} ${gateDef.threshold}`;

  return {
    gate_name: gateName,
    metric_key: gateDef.metric_key,
    value,
    threshold: gateDef.threshold,
    direction: gateDef.direction,
    passed,
    reason,
  };
}

export function evaluateAllTransferGates(
  gates: TransferGatesArtifact,
  metrics: TransferMetrics,
): TransferEvaluation {
  const gateResults: GateEvalResult[] = [];

  for (const [gateName, gateDef] of Object.entries(gates.transfer_gates)) {
    gateResults.push(evaluateTransferGate(gateName, gateDef, metrics));
  }

  const overallPass = gateResults.every((r) => r.passed);

  return {
    overall_pass: overallPass,
    gate_results: gateResults,
    decision: overallPass ? "proceed" : "rollback",
    gemma4_tag: "experimental",
    gemma4_is_default: false,
    rollback_action: gates.rollback_policy.action,
    evaluated_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Prerequisite validation
// ---------------------------------------------------------------------------

export function checkPrerequisites(
  gemma3Gates: Gemma3AcceptanceGates,
  transferGates: TransferGatesArtifact,
): PrerequisiteEvaluation {
  const checks: PrerequisiteCheckResult[] = [];

  checks.push({
    check: "gemma3_parity_status_pass",
    passed: gemma3Gates.methodology_decision.gemma3_parity_status === "pass",
    reason:
      gemma3Gates.methodology_decision.gemma3_parity_status === "pass"
        ? "Gemma 3 parity status is pass"
        : `Gemma 3 parity status is '${gemma3Gates.methodology_decision.gemma3_parity_status}', expected 'pass'`,
  });

  checks.push({
    check: "gemma4_transfer_ready",
    passed: gemma3Gates.methodology_decision.gemma4_transfer_ready === true,
    reason: gemma3Gates.methodology_decision.gemma4_transfer_ready
      ? "Gemma 4 transfer is ready per Gemma 3 acceptance gates"
      : "Gemma 4 transfer not ready per Gemma 3 acceptance gates",
  });

  const allGemma3Pass = Object.values(gemma3Gates.acceptance_gates).every(
    (g) => g.gate_pass === true,
  );
  checks.push({
    check: "all_gemma3_acceptance_gates_pass",
    passed: allGemma3Pass,
    reason: allGemma3Pass
      ? "All Gemma 3 acceptance gates pass"
      : "One or more Gemma 3 acceptance gates failed",
  });

  const gemma3ThresholdMap: Record<string, { threshold: number; direction: "gte" | "lte" }> = {
    coherence: { threshold: 0.80, direction: "gte" },
    degeneration: { threshold: 0.03, direction: "lte" },
    adherence: { threshold: 0.60, direction: "gte" },
  };

  let thresholdsAtLeastAsStrict = true;
  for (const [gateName, g3] of Object.entries(gemma3ThresholdMap)) {
    const transferGate = Object.values(transferGates.transfer_gates).find(
      (tg) => tg.gemma3_threshold === g3.threshold && tg.direction === g3.direction,
    );
    if (transferGate) {
      if (g3.direction === "gte" && transferGate.threshold < g3.threshold) {
        thresholdsAtLeastAsStrict = false;
      }
      if (g3.direction === "lte" && transferGate.threshold > g3.threshold) {
        thresholdsAtLeastAsStrict = false;
      }
    }
  }

  checks.push({
    check: "transfer_thresholds_at_least_as_strict",
    passed: thresholdsAtLeastAsStrict,
    reason: thresholdsAtLeastAsStrict
      ? "Transfer gate thresholds are at least as strict as Gemma 3 acceptance gates"
      : "Transfer gate thresholds are less strict than Gemma 3 acceptance gates",
  });

  checks.push({
    check: "gemma4_tagged_experimental",
    passed: transferGates.tagging.gemma4_run_tag === "experimental",
    reason:
      transferGates.tagging.gemma4_run_tag === "experimental"
        ? "Gemma 4 runs are tagged experimental"
        : `Gemma 4 run tag is '${transferGates.tagging.gemma4_run_tag}', expected 'experimental'`,
  });

  checks.push({
    check: "gemma4_not_default",
    passed: transferGates.tagging.gemma4_is_default === false,
    reason: transferGates.tagging.gemma4_is_default === false
      ? "Gemma 4 is not set as default"
      : "Gemma 4 must not be default until transfer gates pass",
  });

  checks.push({
    check: "rollback_policy_defined",
    passed:
      typeof transferGates.rollback_policy.action === "string" &&
      transferGates.rollback_policy.action.length > 0,
    reason:
      transferGates.rollback_policy.action.length > 0
        ? "Rollback policy is defined"
        : "Rollback policy action is missing",
  });

  return {
    all_passed: checks.every((c) => c.passed),
    checks,
  };
}

// ---------------------------------------------------------------------------
// Artifact loaders
// ---------------------------------------------------------------------------

export function loadTransferGates(rootDir: string): TransferGatesArtifact {
  const filePath = path.join(rootDir, "artifacts", "sweeps", "gemma4-transfer-gates.json");
  if (!existsSync(filePath)) {
    throw new Error(`Transfer gates artifact not found: ${filePath}`);
  }
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

export function loadGemma3AcceptanceGates(rootDir: string): Gemma3AcceptanceGates {
  const filePath = path.join(rootDir, "artifacts", "sweeps", "gemma3-acceptance-gates.json");
  if (!existsSync(filePath)) {
    throw new Error(`Gemma 3 acceptance gates artifact not found: ${filePath}`);
  }
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const isMain = process.argv[1] === __filename;

if (isMain) {
  const rootDir = path.resolve(path.dirname(__filename), "..", "..");

  console.log("[Transfer Protocol] Loading artifacts...");
  const gemma3Gates = loadGemma3AcceptanceGates(rootDir);
  const transferGates = loadTransferGates(rootDir);

  console.log("[Transfer Protocol] Checking prerequisites...");
  const prereqs = checkPrerequisites(gemma3Gates, transferGates);
  for (const check of prereqs.checks) {
    const icon = check.passed ? "✓" : "✗";
    console.log(`  ${icon} ${check.check}: ${check.reason}`);
  }

  if (!prereqs.all_passed) {
    console.log("\n[Transfer Protocol] Prerequisites NOT met. Cannot proceed with transfer.");
    process.exit(1);
  }

  console.log("\n[Transfer Protocol] All prerequisites passed.");
  console.log("[Transfer Protocol] Gemma 4 runs will be tagged: experimental (non-default).");
  console.log(
    "[Transfer Protocol] Rollback policy: " + transferGates.rollback_policy.action,
  );
}
