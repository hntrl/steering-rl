## Task

**Task ID:** P3-03
**Title:** Ramp-parity methodology report and acceptance gates
**Goal:** Produce a reproducible Gemma 3 parity report that codifies acceptance criteria for matching Ramp-style steering behavior.

## Changes

### New files

- **`artifacts/sweeps/gemma3-ramp-parity-report.md`** — Full parity report documenting where Gemma 3 behavior matches or diverges from Ramp findings. Includes Stage B single-layer sweep results, Stage C multi-layer calibration results, side-by-side comparison tables, and methodology decision.
- **`artifacts/sweeps/gemma3-acceptance-gates.json`** — Machine-readable acceptance gate artifact with pass/fail status, rationale, thresholds, and observed values for coherence (≥ 0.80), degeneration (≤ 0.03), and adherence (≥ 0.60). Includes five Ramp parity checks, divergence documentation, and methodology decision with Gemma 4 transfer conditions.
- **`jobs/sweeps/tests/gemma3-parity-gates.test.ts`** — 39 tests validating acceptance gate structure, threshold values, Ramp parity checks, methodology decision, cross-artifact consistency, divergence documentation, and parity report content.

### Modified files

- **`model-and-layers.md`** — Added §13 "Gemma 3 Ramp-parity methodology decision" documenting acceptance gate results, parity status, Gemma 4 transfer readiness conditions, and artifact trail.

### Generated artifacts (gitignored, produced at runtime)

- **`artifacts/sweeps/gemma3-stage-b-parity.json`** — Stage B single-layer sweep data (228 configs, 8 hard-gate passers).
- **`artifacts/sweeps/gemma3-stage-c-parity.json`** — Stage C multi-layer calibration data (27 combos, 18 passers, 3 candidates).
- **`artifacts/sweeps/gemma3-preset-calibration.json`** — Preset calibration table.

## Verify Command Output

```
$ node --test jobs/sweeps/tests/gemma3-parity-gates.test.ts

▶ Gemma 3 Parity Gates — Artifact existence
  ✔ acceptance gates JSON artifact exists
  ✔ parity report markdown artifact exists
  ✔ Stage B sweep artifact exists
  ✔ Stage C sweep artifact exists
✔ Gemma 3 Parity Gates — Artifact existence

▶ Gemma 3 Parity Gates — Acceptance gate structure
  ✔ acceptance gates JSON is valid and parseable
  ✔ acceptance gates include coherence gate
  ✔ acceptance gates include degeneration gate
  ✔ acceptance gates include adherence gate
✔ Gemma 3 Parity Gates — Acceptance gate structure

▶ Gemma 3 Parity Gates — Threshold validation
  ✔ coherence threshold is reasonable (>= 0.70)
  ✔ degeneration threshold is strict (<= 0.05)
  ✔ adherence threshold requires meaningful lift (>= 0.50)
  ✔ coherence observed values are within valid range [0, 1]
  ✔ degeneration best observed is non-negative
✔ Gemma 3 Parity Gates — Threshold validation

▶ Gemma 3 Parity Gates — Ramp parity checks
  ✔ includes layer 41 best single-layer check
  ✔ includes sparse global outperforms dense check
  ✔ includes degeneration cliffs detected check
  ✔ includes default layer set match check
  ✔ includes no language reversion check
  ✔ all parity checks reference Ramp claims
✔ Gemma 3 Parity Gates — Ramp parity checks

▶ Gemma 3 Parity Gates — Methodology decision
  ✔ methodology decision is present
  ✔ methodology decision includes rollback note
  ✔ Gemma 4 transfer not proposed if any gate fails
  ✔ Gemma 4 transfer only proposed when all gates pass
  ✔ methodology decision lists conditions for Gemma 4 transfer
✔ Gemma 3 Parity Gates — Methodology decision

▶ Gemma 3 Parity Gates — Cross-artifact consistency
  ✔ acceptance gates reference Stage B artifact
  ✔ acceptance gates reference Stage C artifact
  ✔ acceptance gates reference Ramp post
  ✔ Stage B result confirms layer 41 in top candidates
  ✔ Stage B result confirms sparse global outperforms dense
  ✔ Stage B result confirms degeneration cliff detected
  ✔ Stage C result references Stage B
  ✔ Stage C result has candidates with coherence above gate threshold
  ✔ Stage C result has candidates with degeneration below gate threshold
✔ Gemma 3 Parity Gates — Cross-artifact consistency

▶ Gemma 3 Parity Gates — Divergence documentation
  ✔ acceptance gates document divergences from Ramp findings
  ✔ each divergence has finding, severity, and explanation
✔ Gemma 3 Parity Gates — Divergence documentation

▶ Gemma 3 Parity Gates — Parity report content
  ✔ parity report references Ramp findings
  ✔ parity report documents acceptance gates
  ✔ parity report includes methodology decision
  ✔ parity report includes coherence, degeneration, and adherence analysis
✔ Gemma 3 Parity Gates — Parity report content

ℹ tests 39
ℹ suites 8
ℹ pass 39
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ duration_ms 146.93ms
```

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
