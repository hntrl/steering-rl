/**
 * Tests for Gemma 4 Transfer Protocol (P3-06).
 *
 * Validates:
 *   - Transfer gate artifact exists and encodes pass/fail thresholds
 *   - Transfer gate thresholds are at least as strict as Gemma 3 acceptance gates
 *   - Gate evaluation logic correctly determines pass/fail per metric
 *   - Overall decision is "rollback" when any gate fails
 *   - Overall decision is "proceed" when all gates pass
 *   - Gemma 4 runs are always tagged experimental and non-default
 *   - Prerequisite checks validate Gemma 3 parity readiness
 *   - Fallback-to-Gemma-3 behavior triggers on gate failure
 *   - Transfer checklist artifact exists
 *   - Rollback policy is defined and actionable
 */

import { strict as assert } from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  evaluateTransferGate,
  evaluateAllTransferGates,
  checkPrerequisites,
  loadTransferGates,
  loadGemma3AcceptanceGates,
} from "../gemma4-transfer-protocol.ts";

import type {
  TransferGateDef,
  TransferGatesArtifact,
  TransferMetrics,
  Gemma3AcceptanceGates,
} from "../gemma4-transfer-protocol.ts";

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(__filename), "..", "..", "..");
const artifactsDir = path.join(rootDir, "artifacts", "sweeps");

// ===========================================================================
// Helpers
// ===========================================================================

function loadJSON(filename: string): any {
  const filePath = path.join(artifactsDir, filename);
  assert.ok(existsSync(filePath), `Artifact file must exist: ${filename}`);
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

function makePassingMetrics(): TransferMetrics {
  return {
    coherence: 0.92,
    degenerate_rate: 0.0,
    concept_adherence: 0.72,
    language_stability: 1.0,
    correctness: 0.91,
  };
}

function makeFailingMetrics(): TransferMetrics {
  return {
    coherence: 0.65,
    degenerate_rate: 0.10,
    concept_adherence: 0.40,
    language_stability: 0.85,
    correctness: 0.70,
  };
}

// ===========================================================================
// Artifact existence
// ===========================================================================

describe("Gemma 4 Transfer Protocol — Artifact existence", () => {
  it("transfer gates JSON artifact exists", () => {
    const filePath = path.join(artifactsDir, "gemma4-transfer-gates.json");
    assert.ok(existsSync(filePath), "gemma4-transfer-gates.json must exist");
  });

  it("transfer checklist markdown exists", () => {
    const filePath = path.join(artifactsDir, "gemma4-transfer-checklist.md");
    assert.ok(existsSync(filePath), "gemma4-transfer-checklist.md must exist");
  });

  it("transfer gates JSON is valid and parseable", () => {
    const gates = loadJSON("gemma4-transfer-gates.json");
    assert.equal(typeof gates, "object");
    assert.equal(gates.task_id, "P3-06");
  });

  it("Gemma 3 acceptance gates artifact exists (dependency)", () => {
    const filePath = path.join(artifactsDir, "gemma3-acceptance-gates.json");
    assert.ok(existsSync(filePath), "gemma3-acceptance-gates.json must exist");
  });
});

// ===========================================================================
// Transfer gate structure and thresholds
// ===========================================================================

describe("Gemma 4 Transfer Protocol — Gate structure", () => {
  it("transfer gates include coherence gate", () => {
    const gates = loadJSON("gemma4-transfer-gates.json");
    const coherence = gates.transfer_gates.coherence;
    assert.ok(coherence, "coherence gate must exist");
    assert.equal(typeof coherence.threshold, "number");
    assert.equal(coherence.direction, "gte");
    assert.equal(coherence.metric_key, "coherence");
  });

  it("transfer gates include degeneration gate", () => {
    const gates = loadJSON("gemma4-transfer-gates.json");
    const degen = gates.transfer_gates.degeneration;
    assert.ok(degen, "degeneration gate must exist");
    assert.equal(typeof degen.threshold, "number");
    assert.equal(degen.direction, "lte");
    assert.equal(degen.metric_key, "degenerate_rate");
  });

  it("transfer gates include adherence gate", () => {
    const gates = loadJSON("gemma4-transfer-gates.json");
    const adherence = gates.transfer_gates.adherence;
    assert.ok(adherence, "adherence gate must exist");
    assert.equal(typeof adherence.threshold, "number");
    assert.equal(adherence.direction, "gte");
    assert.equal(adherence.metric_key, "concept_adherence");
  });

  it("transfer gates include language stability gate", () => {
    const gates = loadJSON("gemma4-transfer-gates.json");
    const lang = gates.transfer_gates.language_stability;
    assert.ok(lang, "language_stability gate must exist");
    assert.equal(typeof lang.threshold, "number");
    assert.equal(lang.direction, "gte");
  });

  it("transfer gates include correctness gate", () => {
    const gates = loadJSON("gemma4-transfer-gates.json");
    const corr = gates.transfer_gates.correctness;
    assert.ok(corr, "correctness gate must exist");
    assert.equal(typeof corr.threshold, "number");
    assert.equal(corr.direction, "gte");
  });

  it("each gate records gemma3_threshold for traceability", () => {
    const gates = loadJSON("gemma4-transfer-gates.json");
    for (const [name, gate] of Object.entries(gates.transfer_gates) as [string, any][]) {
      assert.equal(
        typeof gate.gemma3_threshold,
        "number",
        `${name} must record gemma3_threshold`,
      );
    }
  });
});

// ===========================================================================
// Threshold strictness — at least as strict as Gemma 3
// ===========================================================================

describe("Gemma 4 Transfer Protocol — Threshold strictness", () => {
  it("coherence threshold is at least as strict as Gemma 3 (>= 0.80)", () => {
    const gates = loadJSON("gemma4-transfer-gates.json");
    assert.ok(
      gates.transfer_gates.coherence.threshold >= 0.80,
      `coherence threshold ${gates.transfer_gates.coherence.threshold} must be >= 0.80`,
    );
  });

  it("degeneration threshold is at least as strict as Gemma 3 (<= 0.03)", () => {
    const gates = loadJSON("gemma4-transfer-gates.json");
    assert.ok(
      gates.transfer_gates.degeneration.threshold <= 0.03,
      `degeneration threshold ${gates.transfer_gates.degeneration.threshold} must be <= 0.03`,
    );
  });

  it("adherence threshold is at least as strict as Gemma 3 (>= 0.60)", () => {
    const gates = loadJSON("gemma4-transfer-gates.json");
    assert.ok(
      gates.transfer_gates.adherence.threshold >= 0.60,
      `adherence threshold ${gates.transfer_gates.adherence.threshold} must be >= 0.60`,
    );
  });

  it("language stability threshold is at least 0.99", () => {
    const gates = loadJSON("gemma4-transfer-gates.json");
    assert.ok(
      gates.transfer_gates.language_stability.threshold >= 0.99,
      `language_stability threshold must be >= 0.99`,
    );
  });
});

// ===========================================================================
// Gate evaluation logic
// ===========================================================================

describe("Gemma 4 Transfer Protocol — Gate evaluation", () => {
  it("evaluateTransferGate passes a gte gate when value meets threshold", () => {
    const gateDef: TransferGateDef = {
      description: "test",
      threshold: 0.80,
      gemma3_threshold: 0.80,
      direction: "gte",
      metric_key: "coherence",
    };
    const metrics = makePassingMetrics();
    const result = evaluateTransferGate("coherence", gateDef, metrics);
    assert.equal(result.passed, true);
    assert.equal(result.gate_name, "coherence");
    assert.equal(result.value, 0.92);
  });

  it("evaluateTransferGate fails a gte gate when value is below threshold", () => {
    const gateDef: TransferGateDef = {
      description: "test",
      threshold: 0.80,
      gemma3_threshold: 0.80,
      direction: "gte",
      metric_key: "coherence",
    };
    const metrics: TransferMetrics = { ...makePassingMetrics(), coherence: 0.75 };
    const result = evaluateTransferGate("coherence", gateDef, metrics);
    assert.equal(result.passed, false);
  });

  it("evaluateTransferGate passes a lte gate when value is below threshold", () => {
    const gateDef: TransferGateDef = {
      description: "test",
      threshold: 0.03,
      gemma3_threshold: 0.03,
      direction: "lte",
      metric_key: "degenerate_rate",
    };
    const metrics = makePassingMetrics();
    const result = evaluateTransferGate("degeneration", gateDef, metrics);
    assert.equal(result.passed, true);
    assert.equal(result.value, 0.0);
  });

  it("evaluateTransferGate fails a lte gate when value exceeds threshold", () => {
    const gateDef: TransferGateDef = {
      description: "test",
      threshold: 0.03,
      gemma3_threshold: 0.03,
      direction: "lte",
      metric_key: "degenerate_rate",
    };
    const metrics: TransferMetrics = { ...makePassingMetrics(), degenerate_rate: 0.10 };
    const result = evaluateTransferGate("degeneration", gateDef, metrics);
    assert.equal(result.passed, false);
  });

  it("evaluateTransferGate fails closed on missing metric", () => {
    const gateDef: TransferGateDef = {
      description: "test",
      threshold: 0.80,
      gemma3_threshold: 0.80,
      direction: "gte",
      metric_key: "coherence",
    };
    const metrics = { degenerate_rate: 0.0 } as unknown as TransferMetrics;
    const result = evaluateTransferGate("coherence", gateDef, metrics);
    assert.equal(result.passed, false);
    assert.ok(result.reason.includes("Missing"));
  });
});

// ===========================================================================
// Overall transfer evaluation — proceed vs rollback
// ===========================================================================

describe("Gemma 4 Transfer Protocol — Overall evaluation", () => {
  it("evaluateAllTransferGates returns proceed when all gates pass", () => {
    const gates = loadTransferGates(rootDir);
    const metrics = makePassingMetrics();
    const result = evaluateAllTransferGates(gates, metrics);
    assert.equal(result.overall_pass, true);
    assert.equal(result.decision, "proceed");
    assert.equal(result.gemma4_tag, "experimental");
    assert.equal(result.gemma4_is_default, false);
    assert.ok(result.gate_results.length >= 3);
    assert.ok(result.gate_results.every((r) => r.passed));
  });

  it("evaluateAllTransferGates returns rollback when any gate fails", () => {
    const gates = loadTransferGates(rootDir);
    const metrics = makeFailingMetrics();
    const result = evaluateAllTransferGates(gates, metrics);
    assert.equal(result.overall_pass, false);
    assert.equal(result.decision, "rollback");
    assert.ok(result.gate_results.some((r) => !r.passed));
  });

  it("rollback decision includes rollback action", () => {
    const gates = loadTransferGates(rootDir);
    const metrics = makeFailingMetrics();
    const result = evaluateAllTransferGates(gates, metrics);
    assert.equal(result.decision, "rollback");
    assert.ok(
      result.rollback_action.length > 0,
      "rollback action must be non-empty",
    );
    assert.ok(
      result.rollback_action.toLowerCase().includes("gemma 3"),
      "rollback action must reference Gemma 3",
    );
  });

  it("single gate failure triggers rollback even if others pass", () => {
    const gates = loadTransferGates(rootDir);
    const metrics: TransferMetrics = {
      ...makePassingMetrics(),
      degenerate_rate: 0.10,
    };
    const result = evaluateAllTransferGates(gates, metrics);
    assert.equal(result.overall_pass, false);
    assert.equal(result.decision, "rollback");
    const degenResult = result.gate_results.find(
      (r) => r.metric_key === "degenerate_rate",
    );
    assert.ok(degenResult);
    assert.equal(degenResult.passed, false);
  });

  it("gemma4 is always tagged experimental in evaluation results", () => {
    const gates = loadTransferGates(rootDir);

    const passResult = evaluateAllTransferGates(gates, makePassingMetrics());
    assert.equal(passResult.gemma4_tag, "experimental");
    assert.equal(passResult.gemma4_is_default, false);

    const failResult = evaluateAllTransferGates(gates, makeFailingMetrics());
    assert.equal(failResult.gemma4_tag, "experimental");
    assert.equal(failResult.gemma4_is_default, false);
  });
});

// ===========================================================================
// Fallback-to-Gemma-3 behavior
// ===========================================================================

describe("Gemma 4 Transfer Protocol — Fallback to Gemma 3", () => {
  it("rollback policy specifies gemma3 as default on rollback", () => {
    const gates = loadJSON("gemma4-transfer-gates.json");
    assert.equal(gates.rollback_policy.gemma3_status_on_rollback, "default");
  });

  it("rollback policy specifies gemma4 as experimental on rollback", () => {
    const gates = loadJSON("gemma4-transfer-gates.json");
    assert.equal(gates.rollback_policy.gemma4_status_on_rollback, "experimental");
  });

  it("rollback policy action mentions stopping Gemma 4 experiments", () => {
    const gates = loadJSON("gemma4-transfer-gates.json");
    assert.ok(
      gates.rollback_policy.action.toLowerCase().includes("stop"),
      "rollback action must mention stopping experiments",
    );
  });

  it("rollback policy action mentions continuing with Gemma 3", () => {
    const gates = loadJSON("gemma4-transfer-gates.json");
    assert.ok(
      gates.rollback_policy.action.toLowerCase().includes("gemma 3"),
      "rollback action must mention continuing with Gemma 3",
    );
  });

  it("failing coherence triggers rollback with correct gate detail", () => {
    const gates = loadTransferGates(rootDir);
    const metrics: TransferMetrics = {
      ...makePassingMetrics(),
      coherence: 0.70,
    };
    const result = evaluateAllTransferGates(gates, metrics);
    assert.equal(result.decision, "rollback");
    const coherenceResult = result.gate_results.find(
      (r) => r.gate_name === "coherence",
    );
    assert.ok(coherenceResult);
    assert.equal(coherenceResult.passed, false);
    assert.equal(coherenceResult.value, 0.70);
    assert.equal(coherenceResult.threshold, 0.80);
  });

  it("failing degeneration triggers rollback with correct gate detail", () => {
    const gates = loadTransferGates(rootDir);
    const metrics: TransferMetrics = {
      ...makePassingMetrics(),
      degenerate_rate: 0.05,
    };
    const result = evaluateAllTransferGates(gates, metrics);
    assert.equal(result.decision, "rollback");
    const degenResult = result.gate_results.find(
      (r) => r.gate_name === "degeneration",
    );
    assert.ok(degenResult);
    assert.equal(degenResult.passed, false);
  });

  it("failing adherence triggers rollback with correct gate detail", () => {
    const gates = loadTransferGates(rootDir);
    const metrics: TransferMetrics = {
      ...makePassingMetrics(),
      concept_adherence: 0.50,
    };
    const result = evaluateAllTransferGates(gates, metrics);
    assert.equal(result.decision, "rollback");
    const adherenceResult = result.gate_results.find(
      (r) => r.gate_name === "adherence",
    );
    assert.ok(adherenceResult);
    assert.equal(adherenceResult.passed, false);
  });
});

// ===========================================================================
// Prerequisite checks
// ===========================================================================

describe("Gemma 4 Transfer Protocol — Prerequisite checks", () => {
  it("checkPrerequisites passes with real Gemma 3 gates and transfer gates", () => {
    const gemma3Gates = loadGemma3AcceptanceGates(rootDir);
    const transferGates = loadTransferGates(rootDir);
    const result = checkPrerequisites(gemma3Gates, transferGates);
    assert.equal(result.all_passed, true);
    assert.ok(result.checks.length >= 5);
    assert.ok(result.checks.every((c) => c.passed));
  });

  it("checkPrerequisites fails when Gemma 3 parity status is not pass", () => {
    const gemma3Gates = loadGemma3AcceptanceGates(rootDir);
    const transferGates = loadTransferGates(rootDir);
    const modified: Gemma3AcceptanceGates = {
      ...gemma3Gates,
      methodology_decision: {
        ...gemma3Gates.methodology_decision,
        gemma3_parity_status: "fail",
      },
    };
    const result = checkPrerequisites(modified, transferGates);
    assert.equal(result.all_passed, false);
    const parityCheck = result.checks.find(
      (c) => c.check === "gemma3_parity_status_pass",
    );
    assert.ok(parityCheck);
    assert.equal(parityCheck.passed, false);
  });

  it("checkPrerequisites fails when gemma4_transfer_ready is false", () => {
    const gemma3Gates = loadGemma3AcceptanceGates(rootDir);
    const transferGates = loadTransferGates(rootDir);
    const modified: Gemma3AcceptanceGates = {
      ...gemma3Gates,
      methodology_decision: {
        ...gemma3Gates.methodology_decision,
        gemma4_transfer_ready: false,
      },
    };
    const result = checkPrerequisites(modified, transferGates);
    assert.equal(result.all_passed, false);
  });

  it("checkPrerequisites validates experimental tagging", () => {
    const gemma3Gates = loadGemma3AcceptanceGates(rootDir);
    const transferGates = loadTransferGates(rootDir);
    const result = checkPrerequisites(gemma3Gates, transferGates);
    const tagCheck = result.checks.find(
      (c) => c.check === "gemma4_tagged_experimental",
    );
    assert.ok(tagCheck);
    assert.equal(tagCheck.passed, true);
  });

  it("checkPrerequisites validates gemma4 is not default", () => {
    const gemma3Gates = loadGemma3AcceptanceGates(rootDir);
    const transferGates = loadTransferGates(rootDir);
    const result = checkPrerequisites(gemma3Gates, transferGates);
    const defaultCheck = result.checks.find(
      (c) => c.check === "gemma4_not_default",
    );
    assert.ok(defaultCheck);
    assert.equal(defaultCheck.passed, true);
  });

  it("checkPrerequisites validates rollback policy exists", () => {
    const gemma3Gates = loadGemma3AcceptanceGates(rootDir);
    const transferGates = loadTransferGates(rootDir);
    const result = checkPrerequisites(gemma3Gates, transferGates);
    const rollbackCheck = result.checks.find(
      (c) => c.check === "rollback_policy_defined",
    );
    assert.ok(rollbackCheck);
    assert.equal(rollbackCheck.passed, true);
  });
});

// ===========================================================================
// Tagging constraints
// ===========================================================================

describe("Gemma 4 Transfer Protocol — Tagging constraints", () => {
  it("transfer gates artifact marks gemma4 as experimental", () => {
    const gates = loadJSON("gemma4-transfer-gates.json");
    assert.equal(gates.tagging.gemma4_run_tag, "experimental");
  });

  it("transfer gates artifact marks gemma4 as non-default", () => {
    const gates = loadJSON("gemma4-transfer-gates.json");
    assert.equal(gates.tagging.gemma4_is_default, false);
  });

  it("decision logic references rollback on failure", () => {
    const gates = loadJSON("gemma4-transfer-gates.json");
    assert.ok(
      gates.decision_logic.fail.toLowerCase().includes("rollback"),
      "failure decision must reference rollback",
    );
  });

  it("decision logic requires ALL gates to pass", () => {
    const gates = loadJSON("gemma4-transfer-gates.json");
    assert.ok(
      gates.decision_logic.overall_rule.toLowerCase().includes("all"),
      "overall rule must require all gates to pass",
    );
  });
});

// ===========================================================================
// Transfer checklist content
// ===========================================================================

describe("Gemma 4 Transfer Protocol — Transfer checklist", () => {
  it("checklist mentions Gemma 3 parity gates as prerequisite", () => {
    const content = readFileSync(
      path.join(artifactsDir, "gemma4-transfer-checklist.md"),
      "utf-8",
    );
    assert.ok(
      content.includes("Gemma 3 parity gates"),
      "checklist must mention Gemma 3 parity gates",
    );
  });

  it("checklist mentions experimental tagging", () => {
    const content = readFileSync(
      path.join(artifactsDir, "gemma4-transfer-checklist.md"),
      "utf-8",
    );
    assert.ok(
      content.includes("experimental"),
      "checklist must mention experimental tagging",
    );
  });

  it("checklist mentions rollback path", () => {
    const content = readFileSync(
      path.join(artifactsDir, "gemma4-transfer-checklist.md"),
      "utf-8",
    );
    assert.ok(
      content.toLowerCase().includes("rollback"),
      "checklist must mention rollback",
    );
  });

  it("checklist defines prerequisites section", () => {
    const content = readFileSync(
      path.join(artifactsDir, "gemma4-transfer-checklist.md"),
      "utf-8",
    );
    assert.ok(
      content.includes("Prerequisites"),
      "checklist must have a Prerequisites section",
    );
  });

  it("checklist references gemma3-acceptance-gates.json", () => {
    const content = readFileSync(
      path.join(artifactsDir, "gemma4-transfer-checklist.md"),
      "utf-8",
    );
    assert.ok(
      content.includes("gemma3-acceptance-gates.json"),
      "checklist must reference gemma3-acceptance-gates.json",
    );
  });

  it("checklist includes threshold values for all gate metrics", () => {
    const content = readFileSync(
      path.join(artifactsDir, "gemma4-transfer-checklist.md"),
      "utf-8",
    );
    assert.ok(content.includes("0.80"), "checklist must include coherence threshold 0.80");
    assert.ok(content.includes("0.03"), "checklist must include degeneration threshold 0.03");
    assert.ok(content.includes("0.60"), "checklist must include adherence threshold 0.60");
  });
});
