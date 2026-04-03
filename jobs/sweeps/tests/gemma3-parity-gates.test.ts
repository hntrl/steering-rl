/**
 * Tests for Gemma 3 Ramp-Parity Acceptance Gates (P3-03).
 *
 * Validates:
 *   - Acceptance gate artifact exists and is well-formed JSON
 *   - Coherence, degeneration, and adherence thresholds are defined
 *   - Each gate has pass/fail status and rationale
 *   - Ramp parity checks cover all required qualitative findings
 *   - Methodology decision is present and consistent with gate results
 *   - Parity report artifact exists
 *   - Stage B and Stage C artifacts are referenced and present
 *   - No Gemma 4 migration proposed unless all Gemma 3 gates pass
 */

import { strict as assert } from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(__filename), "..", "..", "..");
const artifactsDir = path.join(rootDir, "artifacts", "sweeps");

function loadJSON(filename: string): any {
  const filePath = path.join(artifactsDir, filename);
  assert.ok(existsSync(filePath), `Artifact file must exist: ${filename}`);
  const raw = readFileSync(filePath, "utf-8");
  return JSON.parse(raw);
}

// ===========================================================================
// Artifact existence
// ===========================================================================

describe("Gemma 3 Parity Gates — Artifact existence", () => {
  it("acceptance gates JSON artifact exists", () => {
    const filePath = path.join(artifactsDir, "gemma3-acceptance-gates.json");
    assert.ok(existsSync(filePath), "gemma3-acceptance-gates.json must exist");
  });

  it("parity report markdown artifact exists", () => {
    const filePath = path.join(artifactsDir, "gemma3-ramp-parity-report.md");
    assert.ok(existsSync(filePath), "gemma3-ramp-parity-report.md must exist");
  });

  it("Stage B sweep artifact exists", () => {
    const filePath = path.join(artifactsDir, "gemma3-stage-b-parity.json");
    assert.ok(existsSync(filePath), "gemma3-stage-b-parity.json must exist");
  });

  it("Stage C sweep artifact exists", () => {
    const filePath = path.join(artifactsDir, "gemma3-stage-c-parity.json");
    assert.ok(existsSync(filePath), "gemma3-stage-c-parity.json must exist");
  });
});

// ===========================================================================
// Acceptance gate structure
// ===========================================================================

describe("Gemma 3 Parity Gates — Acceptance gate structure", () => {
  it("acceptance gates JSON is valid and parseable", () => {
    const gates = loadJSON("gemma3-acceptance-gates.json");
    assert.equal(typeof gates, "object");
    assert.ok(gates.task_id, "task_id must be set");
    assert.equal(gates.model, "gemma-3-27b-it");
  });

  it("acceptance gates include coherence gate", () => {
    const gates = loadJSON("gemma3-acceptance-gates.json");
    const coherence = gates.acceptance_gates.coherence;
    assert.ok(coherence, "coherence gate must exist");
    assert.equal(typeof coherence.threshold, "number");
    assert.equal(typeof coherence.gate_pass, "boolean");
    assert.ok(coherence.rationale.length > 0, "coherence rationale must exist");
  });

  it("acceptance gates include degeneration gate", () => {
    const gates = loadJSON("gemma3-acceptance-gates.json");
    const degen = gates.acceptance_gates.degeneration;
    assert.ok(degen, "degeneration gate must exist");
    assert.equal(typeof degen.threshold, "number");
    assert.equal(typeof degen.gate_pass, "boolean");
    assert.ok(degen.rationale.length > 0, "degeneration rationale must exist");
  });

  it("acceptance gates include adherence gate", () => {
    const gates = loadJSON("gemma3-acceptance-gates.json");
    const adherence = gates.acceptance_gates.adherence;
    assert.ok(adherence, "adherence gate must exist");
    assert.equal(typeof adherence.threshold, "number");
    assert.equal(typeof adherence.gate_pass, "boolean");
    assert.ok(adherence.rationale.length > 0, "adherence rationale must exist");
  });
});

// ===========================================================================
// Gate threshold validation
// ===========================================================================

describe("Gemma 3 Parity Gates — Threshold validation", () => {
  it("coherence threshold is reasonable (>= 0.70)", () => {
    const gates = loadJSON("gemma3-acceptance-gates.json");
    assert.ok(
      gates.acceptance_gates.coherence.threshold >= 0.70,
      "coherence threshold must be >= 0.70"
    );
  });

  it("degeneration threshold is strict (<= 0.05)", () => {
    const gates = loadJSON("gemma3-acceptance-gates.json");
    assert.ok(
      gates.acceptance_gates.degeneration.threshold <= 0.05,
      "degeneration threshold must be <= 0.05"
    );
  });

  it("adherence threshold requires meaningful lift (>= 0.50)", () => {
    const gates = loadJSON("gemma3-acceptance-gates.json");
    assert.ok(
      gates.acceptance_gates.adherence.threshold >= 0.50,
      "adherence threshold must be >= 0.50"
    );
  });

  it("coherence observed values are within valid range [0, 1]", () => {
    const gates = loadJSON("gemma3-acceptance-gates.json");
    const c = gates.acceptance_gates.coherence;
    assert.ok(c.baseline_observed >= 0 && c.baseline_observed <= 1);
    assert.ok(c.best_steered_observed >= 0 && c.best_steered_observed <= 1);
  });

  it("degeneration best observed is non-negative", () => {
    const gates = loadJSON("gemma3-acceptance-gates.json");
    assert.ok(
      gates.acceptance_gates.degeneration.best_observed >= 0,
      "degeneration best_observed must be >= 0"
    );
  });
});

// ===========================================================================
// Ramp parity checks
// ===========================================================================

describe("Gemma 3 Parity Gates — Ramp parity checks", () => {
  it("includes layer 41 best single-layer check", () => {
    const gates = loadJSON("gemma3-acceptance-gates.json");
    const check = gates.ramp_parity_checks.layer_41_best_single_layer;
    assert.ok(check, "layer_41_best_single_layer check must exist");
    assert.equal(typeof check.pass, "boolean");
    assert.ok(check.observed.length > 0, "observed must describe finding");
    assert.ok(check.ramp_claim.length > 0, "ramp_claim must cite Ramp finding");
  });

  it("includes sparse global outperforms dense check", () => {
    const gates = loadJSON("gemma3-acceptance-gates.json");
    const check = gates.ramp_parity_checks.sparse_global_outperforms_dense;
    assert.ok(check, "sparse_global_outperforms_dense check must exist");
    assert.equal(typeof check.pass, "boolean");
    assert.ok(check.observed.length > 0);
    assert.ok(check.ramp_claim.length > 0);
  });

  it("includes degeneration cliffs detected check", () => {
    const gates = loadJSON("gemma3-acceptance-gates.json");
    const check = gates.ramp_parity_checks.degeneration_cliffs_detected;
    assert.ok(check, "degeneration_cliffs_detected check must exist");
    assert.equal(typeof check.pass, "boolean");
    assert.ok(check.observed.length > 0);
    assert.ok(check.ramp_claim.length > 0);
  });

  it("includes default layer set match check", () => {
    const gates = loadJSON("gemma3-acceptance-gates.json");
    const check = gates.ramp_parity_checks.default_layer_set_match;
    assert.ok(check, "default_layer_set_match check must exist");
    assert.equal(typeof check.pass, "boolean");
    assert.ok(check.observed.length > 0);
    assert.ok(check.ramp_claim.length > 0);
  });

  it("includes no language reversion check", () => {
    const gates = loadJSON("gemma3-acceptance-gates.json");
    const check = gates.ramp_parity_checks.no_language_reversion;
    assert.ok(check, "no_language_reversion check must exist");
    assert.equal(typeof check.pass, "boolean");
    assert.ok(check.observed.length > 0);
    assert.ok(check.ramp_claim.length > 0);
  });

  it("all parity checks reference Ramp claims", () => {
    const gates = loadJSON("gemma3-acceptance-gates.json");
    for (const [key, check] of Object.entries(gates.ramp_parity_checks) as [string, any][]) {
      assert.ok(
        check.ramp_claim && check.ramp_claim.length > 0,
        `parity check '${key}' must include a ramp_claim`
      );
    }
  });
});

// ===========================================================================
// Methodology decision
// ===========================================================================

describe("Gemma 3 Parity Gates — Methodology decision", () => {
  it("methodology decision is present", () => {
    const gates = loadJSON("gemma3-acceptance-gates.json");
    assert.ok(gates.methodology_decision, "methodology_decision must exist");
    assert.ok(
      gates.methodology_decision.gemma3_parity_status,
      "gemma3_parity_status must be set"
    );
    assert.equal(
      typeof gates.methodology_decision.gemma4_transfer_ready,
      "boolean"
    );
    assert.ok(
      gates.methodology_decision.rationale.length > 0,
      "rationale must exist"
    );
  });

  it("methodology decision includes rollback note", () => {
    const gates = loadJSON("gemma3-acceptance-gates.json");
    assert.ok(
      gates.methodology_decision.rollback_note,
      "rollback_note must be present"
    );
    assert.ok(
      gates.methodology_decision.rollback_note.length > 0,
      "rollback_note must not be empty"
    );
  });

  it("Gemma 4 transfer not proposed if any gate fails", () => {
    const gates = loadJSON("gemma3-acceptance-gates.json");
    const allGatesPass = Object.values(gates.acceptance_gates).every(
      (g: any) => g.gate_pass === true
    );
    if (!allGatesPass) {
      assert.equal(
        gates.methodology_decision.gemma4_transfer_ready,
        false,
        "Gemma 4 transfer must not be ready if any gate fails"
      );
    }
  });

  it("Gemma 4 transfer only proposed when all gates pass", () => {
    const gates = loadJSON("gemma3-acceptance-gates.json");
    if (gates.methodology_decision.gemma4_transfer_ready) {
      const allGatesPass = Object.values(gates.acceptance_gates).every(
        (g: any) => g.gate_pass === true
      );
      assert.ok(
        allGatesPass,
        "all acceptance gates must pass before Gemma 4 transfer is ready"
      );
    }
  });

  it("methodology decision lists conditions for Gemma 4 transfer", () => {
    const gates = loadJSON("gemma3-acceptance-gates.json");
    assert.ok(
      Array.isArray(gates.methodology_decision.conditions_for_gemma4),
      "conditions_for_gemma4 must be an array"
    );
    assert.ok(
      gates.methodology_decision.conditions_for_gemma4.length > 0,
      "must have at least one condition for Gemma 4 transfer"
    );
  });
});

// ===========================================================================
// Cross-artifact consistency
// ===========================================================================

describe("Gemma 3 Parity Gates — Cross-artifact consistency", () => {
  it("acceptance gates reference Stage B artifact", () => {
    const gates = loadJSON("gemma3-acceptance-gates.json");
    assert.equal(gates.stage_b_ref, "gemma3-stage-b-parity.json");
  });

  it("acceptance gates reference Stage C artifact", () => {
    const gates = loadJSON("gemma3-acceptance-gates.json");
    assert.equal(gates.stage_c_ref, "gemma3-stage-c-parity.json");
  });

  it("acceptance gates reference Ramp post", () => {
    const gates = loadJSON("gemma3-acceptance-gates.json");
    assert.equal(gates.ramp_reference, "ramp-post.md");
  });

  it("Stage B result confirms layer 41 in top candidates", () => {
    const stageB = loadJSON("gemma3-stage-b-parity.json");
    assert.ok(
      stageB.ramp_parity_check.layer_41_in_top_candidates,
      "Stage B must confirm layer 41 in top candidates"
    );
  });

  it("Stage B result confirms sparse global outperforms dense", () => {
    const stageB = loadJSON("gemma3-stage-b-parity.json");
    assert.ok(
      stageB.ramp_parity_check.sparse_global_outperforms_dense,
      "Stage B must confirm sparse global outperforms dense"
    );
  });

  it("Stage B result confirms degeneration cliff detected", () => {
    const stageB = loadJSON("gemma3-stage-b-parity.json");
    assert.ok(
      stageB.ramp_parity_check.degeneration_cliff_detected,
      "Stage B must confirm degeneration cliff detected"
    );
  });

  it("Stage C result references Stage B", () => {
    const stageC = loadJSON("gemma3-stage-c-parity.json");
    assert.equal(
      stageC.stage_b_ref,
      "gemma3-stage-b-parity.json",
      "Stage C must reference Stage B artifact"
    );
  });

  it("Stage C result has candidates with coherence above gate threshold", () => {
    const gates = loadJSON("gemma3-acceptance-gates.json");
    const stageC = loadJSON("gemma3-stage-c-parity.json");
    const threshold = gates.acceptance_gates.coherence.threshold;
    const topCandidate = stageC.candidates[0];
    assert.ok(
      topCandidate.metrics.coherence >= threshold,
      `top candidate coherence (${topCandidate.metrics.coherence}) must be >= gate threshold (${threshold})`
    );
  });

  it("Stage C result has candidates with degeneration below gate threshold", () => {
    const gates = loadJSON("gemma3-acceptance-gates.json");
    const stageC = loadJSON("gemma3-stage-c-parity.json");
    const threshold = gates.acceptance_gates.degeneration.threshold;
    const topCandidate = stageC.candidates[0];
    assert.ok(
      topCandidate.metrics.degenerate_rate <= threshold,
      `top candidate degen rate (${topCandidate.metrics.degenerate_rate}) must be <= gate threshold (${threshold})`
    );
  });
});

// ===========================================================================
// Divergence documentation
// ===========================================================================

describe("Gemma 3 Parity Gates — Divergence documentation", () => {
  it("acceptance gates document divergences from Ramp findings", () => {
    const gates = loadJSON("gemma3-acceptance-gates.json");
    assert.ok(
      Array.isArray(gates.divergences),
      "divergences must be an array"
    );
    assert.ok(
      gates.divergences.length > 0,
      "must document at least one divergence"
    );
  });

  it("each divergence has finding, severity, and explanation", () => {
    const gates = loadJSON("gemma3-acceptance-gates.json");
    for (const d of gates.divergences) {
      assert.ok(d.finding, "divergence must have a finding");
      assert.ok(
        ["low", "medium", "high"].includes(d.severity),
        `severity must be low/medium/high, got '${d.severity}'`
      );
      assert.ok(d.explanation, "divergence must have an explanation");
    }
  });
});

// ===========================================================================
// Parity report content
// ===========================================================================

describe("Gemma 3 Parity Gates — Parity report content", () => {
  it("parity report references Ramp findings", () => {
    const reportPath = path.join(artifactsDir, "gemma3-ramp-parity-report.md");
    const content = readFileSync(reportPath, "utf-8");
    assert.ok(
      content.includes("ramp-post.md") || content.includes("Ramp"),
      "report must reference Ramp findings"
    );
  });

  it("parity report documents acceptance gates", () => {
    const reportPath = path.join(artifactsDir, "gemma3-ramp-parity-report.md");
    const content = readFileSync(reportPath, "utf-8");
    assert.ok(
      content.includes("Acceptance") || content.includes("acceptance"),
      "report must document acceptance gates"
    );
  });

  it("parity report includes methodology decision", () => {
    const reportPath = path.join(artifactsDir, "gemma3-ramp-parity-report.md");
    const content = readFileSync(reportPath, "utf-8");
    assert.ok(
      content.includes("Methodology") || content.includes("methodology"),
      "report must include methodology decision"
    );
  });

  it("parity report includes coherence, degeneration, and adherence analysis", () => {
    const reportPath = path.join(artifactsDir, "gemma3-ramp-parity-report.md");
    const content = readFileSync(reportPath, "utf-8");
    assert.ok(content.includes("oherence"), "report must discuss coherence");
    assert.ok(
      content.includes("egeneration") || content.includes("egenerate"),
      "report must discuss degeneration"
    );
    assert.ok(
      content.includes("dherence") || content.includes("adherence"),
      "report must discuss adherence"
    );
  });
});
