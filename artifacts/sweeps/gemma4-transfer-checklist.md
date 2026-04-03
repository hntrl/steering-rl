# Gemma 4 Transfer Checklist

**Task:** P3-06 — Gemma 4 transfer protocol (post-parity)  
**Source model:** Gemma 3 27B-IT (`gemma-3-27b-it-qat-q4_0-gguf-2025-03-15`)  
**Target model:** Gemma 4 27B-IT (`gemma-4-27b-it`)

## Prerequisites before running Gemma 4 sweeps

All prerequisites must be satisfied before any Gemma 4 transfer sweep is initiated.

### 1. Gemma 3 parity gates pass

- [ ] All three Gemma 3 acceptance gates (coherence ≥ 0.80, degeneration ≤ 0.03, adherence ≥ 0.60) are passing.
- [ ] All five Ramp parity checks pass (layer 41 best single-layer, sparse global outperforms dense, degeneration cliffs detected, default layer set match, no language reversion).
- [ ] `gemma3-acceptance-gates.json` confirms `methodology_decision.gemma3_parity_status === "pass"`.
- [ ] `gemma3-acceptance-gates.json` confirms `methodology_decision.gemma4_transfer_ready === true`.

### 2. Gemma 3 artifacts available

- [ ] `artifacts/sweeps/gemma3-acceptance-gates.json` exists and is valid JSON.
- [ ] `artifacts/sweeps/gemma3-ramp-parity-report.md` exists.
- [ ] `artifacts/sweeps/gemma3-stage-b-parity.json` exists (referenced by acceptance gates).
- [ ] `artifacts/sweeps/gemma3-stage-c-parity.json` exists (referenced by acceptance gates).

### 3. Gemma 4 transfer gates defined

- [ ] `artifacts/sweeps/gemma4-transfer-gates.json` exists and is valid JSON.
- [ ] Transfer gate thresholds are at least as strict as Gemma 3 acceptance gate thresholds:
  - Coherence threshold ≥ 0.80 (Gemma 3: 0.80)
  - Degeneration threshold ≤ 0.03 (Gemma 3: 0.03)
  - Adherence threshold ≥ 0.60 (Gemma 3: 0.60)
  - Language stability ≥ 0.99
  - Correctness ≥ 0.85

### 4. Gemma 4 baseline established

- [ ] Gemma 4 Stage A (no-steering baseline) has been run.
- [ ] Baseline metrics pass hard gates (degenerate_rate ≤ 0.03, coherence ≥ 0.80, language_stability ≥ 0.99).
- [ ] `artifacts/sweeps/gemma4-stage-a-result.json` exists and shows `status: "pass"`.

### 5. Experimental tagging confirmed

- [ ] All Gemma 4 transfer runs are tagged as `experimental`.
- [ ] Gemma 4 is NOT set as default model.
- [ ] Gemma 3 calibrated profiles remain the sole default.

### 6. Rollback path verified

- [ ] Rollback-to-Gemma-3 procedure is documented and tested.
- [ ] On any transfer gate failure: stop Gemma 4 experiments, revert to Gemma 3 defaults.
- [ ] Gemma 4 profiles remain tagged `experimental` after rollback.

## Decision flow

```
Gemma 3 parity gates pass?
  ├─ NO  → Do not start Gemma 4 transfer. Hold at Gemma 3 methodology.
  └─ YES → Check Gemma 4 transfer prerequisites
              ├─ Prerequisites incomplete → Complete prerequisites before proceeding.
              └─ Prerequisites met → Run Gemma 4 experimental sweeps
                    ├─ Transfer gates pass → Gemma 4 eligible for promotion (still experimental).
                    └─ Transfer gates fail → Rollback to Gemma 3. Stop Gemma 4 experiments.
```

## Rollback note

If Gemma 4 transfer signals regressions, stop transfer experiments and continue with Gemma 3 calibrated profiles as the sole default.
