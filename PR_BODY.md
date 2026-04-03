## Task

**Task ID:** P3-06
**Title:** Gemma 4 transfer protocol (post-parity)
**Goal:** Define a controlled Gemma 4 transfer protocol that reuses Gemma 3 methodology artifacts without changing defaults until transfer gates pass.

## Changes

### New files

- **`artifacts/sweeps/gemma4-transfer-gates.json`** — Machine-readable transfer gate artifact encoding pass/fail thresholds and decision logic. Thresholds are at least as strict as Gemma 3 parity acceptance gates (coherence ≥ 0.80, degeneration ≤ 0.03, adherence ≥ 0.60, language stability ≥ 0.99, correctness ≥ 0.85). Includes rollback policy, experimental tagging, and decision logic.
- **`artifacts/sweeps/gemma4-transfer-checklist.md`** — Transfer checklist defining exact prerequisites before running Gemma 4 sweeps: Gemma 3 parity gates pass, artifacts available, transfer gates defined, baseline established, experimental tagging confirmed, rollback path verified.
- **`jobs/sweeps/gemma4-transfer-protocol.ts`** — Transfer protocol implementation with gate evaluation logic, prerequisite validation, artifact loaders, and CLI entry point. Exports `evaluateTransferGate`, `evaluateAllTransferGates`, `checkPrerequisites`, `loadTransferGates`, `loadGemma3AcceptanceGates`.
- **`jobs/sweeps/tests/gemma4-transfer-protocol.test.ts`** — 47 tests across 9 suites validating artifact existence, gate structure, threshold strictness, gate evaluation logic, overall evaluation (proceed/rollback), fallback-to-Gemma-3 behavior, prerequisite checks, tagging constraints, and checklist content.

## Constraints satisfied

1. **Gemma 4 transfer runs tagged experimental and non-default** — Transfer gates artifact sets `tagging.gemma4_run_tag = "experimental"` and `tagging.gemma4_is_default = false`. All evaluation results enforce these tags.
2. **Transfer gate thresholds at least as strict as Gemma 3** — Coherence ≥ 0.80 (Gemma 3: 0.80), degeneration ≤ 0.03 (Gemma 3: 0.03), adherence ≥ 0.60 (Gemma 3: 0.60).
3. **Rollback-to-Gemma-3 path** — Rollback policy triggers on any gate failure: stop Gemma 4 experiments, continue with Gemma 3 calibrated profiles as sole default.

## Verify Command Output

```
$ node --test jobs/sweeps/tests/gemma4-transfer-protocol.test.ts

▶ Gemma 4 Transfer Protocol — Artifact existence
  ✔ transfer gates JSON artifact exists
  ✔ transfer checklist markdown exists
  ✔ transfer gates JSON is valid and parseable
  ✔ Gemma 3 acceptance gates artifact exists (dependency)
✔ Gemma 4 Transfer Protocol — Artifact existence

▶ Gemma 4 Transfer Protocol — Gate structure
  ✔ transfer gates include coherence gate
  ✔ transfer gates include degeneration gate
  ✔ transfer gates include adherence gate
  ✔ transfer gates include language stability gate
  ✔ transfer gates include correctness gate
  ✔ each gate records gemma3_threshold for traceability
✔ Gemma 4 Transfer Protocol — Gate structure

▶ Gemma 4 Transfer Protocol — Threshold strictness
  ✔ coherence threshold is at least as strict as Gemma 3 (>= 0.80)
  ✔ degeneration threshold is at least as strict as Gemma 3 (<= 0.03)
  ✔ adherence threshold is at least as strict as Gemma 3 (>= 0.60)
  ✔ language stability threshold is at least 0.99
✔ Gemma 4 Transfer Protocol — Threshold strictness

▶ Gemma 4 Transfer Protocol — Gate evaluation
  ✔ evaluateTransferGate passes a gte gate when value meets threshold
  ✔ evaluateTransferGate fails a gte gate when value is below threshold
  ✔ evaluateTransferGate passes a lte gate when value is below threshold
  ✔ evaluateTransferGate fails a lte gate when value exceeds threshold
  ✔ evaluateTransferGate fails closed on missing metric
✔ Gemma 4 Transfer Protocol — Gate evaluation

▶ Gemma 4 Transfer Protocol — Overall evaluation
  ✔ evaluateAllTransferGates returns proceed when all gates pass
  ✔ evaluateAllTransferGates returns rollback when any gate fails
  ✔ rollback decision includes rollback action
  ✔ single gate failure triggers rollback even if others pass
  ✔ gemma4 is always tagged experimental in evaluation results
✔ Gemma 4 Transfer Protocol — Overall evaluation

▶ Gemma 4 Transfer Protocol — Fallback to Gemma 3
  ✔ rollback policy specifies gemma3 as default on rollback
  ✔ rollback policy specifies gemma4 as experimental on rollback
  ✔ rollback policy action mentions stopping Gemma 4 experiments
  ✔ rollback policy action mentions continuing with Gemma 3
  ✔ failing coherence triggers rollback with correct gate detail
  ✔ failing degeneration triggers rollback with correct gate detail
  ✔ failing adherence triggers rollback with correct gate detail
✔ Gemma 4 Transfer Protocol — Fallback to Gemma 3

▶ Gemma 4 Transfer Protocol — Prerequisite checks
  ✔ checkPrerequisites passes with real Gemma 3 gates and transfer gates
  ✔ checkPrerequisites fails when Gemma 3 parity status is not pass
  ✔ checkPrerequisites fails when gemma4_transfer_ready is false
  ✔ checkPrerequisites validates experimental tagging
  ✔ checkPrerequisites validates gemma4 is not default
  ✔ checkPrerequisites validates rollback policy exists
✔ Gemma 4 Transfer Protocol — Prerequisite checks

▶ Gemma 4 Transfer Protocol — Tagging constraints
  ✔ transfer gates artifact marks gemma4 as experimental
  ✔ transfer gates artifact marks gemma4 as non-default
  ✔ decision logic references rollback on failure
  ✔ decision logic requires ALL gates to pass
✔ Gemma 4 Transfer Protocol — Tagging constraints

▶ Gemma 4 Transfer Protocol — Transfer checklist
  ✔ checklist mentions Gemma 3 parity gates as prerequisite
  ✔ checklist mentions experimental tagging
  ✔ checklist mentions rollback path
  ✔ checklist defines prerequisites section
  ✔ checklist references gemma3-acceptance-gates.json
  ✔ checklist includes threshold values for all gate metrics
✔ Gemma 4 Transfer Protocol — Transfer checklist

ℹ tests 47
ℹ suites 9
ℹ pass 47
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ duration_ms 138.54ms
```

## Rollback Note

If Gemma 4 transfer signals regressions, stop transfer experiments and continue with Gemma 3 calibrated profiles as the sole default.

```
$ pnpm verify

Project structure verified successfully.
Validated 30 JSON files successfully.
Validated 29 task contracts successfully.
contracts/openapi/inference.yaml: validated — Your API description is valid. 🎉
Schema: profile — 2/2 passed
Schema: run-metadata — 2/2 passed
Schema: experiment-decision — 2/2 passed
Results: 6 passed, 0 failed
```

## Definition of Done

- [x] Parity report documents where Gemma 3 behavior matches or diverges from Ramp findings.
- [x] Acceptance-gate artifact is machine-readable and includes pass/fail rationale.
- [x] Methodology decision states whether Gemma 3 parity is sufficient to start Gemma 4 transfer experiments.

## Constraints

- [x] Report explicitly compares observed results against Ramp qualitative findings.
- [x] Acceptance gates include coherence, degeneration, and adherence thresholds.
- [x] Does not propose Gemma 4 migration until Gemma 3 acceptance gates pass.

## Acceptance Gate Summary

| Gate | Threshold | Observed | Status |
|------|-----------|----------|--------|
| Coherence | ≥ 0.80 | 0.934 | **PASS** |
| Degeneration | ≤ 0.03 | 0.0 | **PASS** |
| Adherence | ≥ 0.60 | 0.722 | **PASS** |

**Methodology decision:** Gemma 3 parity is sufficient — Gemma 4 transfer experiments may begin.

## Rollback Note

If parity evidence is inconclusive, hold methodology status at 'not ready' and rerun sweeps with expanded concept and prompt coverage.
