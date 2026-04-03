# Vector Injection Methodology Plan (Ramp-Parity First)

This plan pivots the project toward reproducing Ramp-style activation steering behavior first, then evaluating transfer to Gemma 4.

## Primary objective

Reproduce Ramp-like findings on Gemma 3 27B-IT with reproducible artifacts:

- effective single-layer target near layer 41,
- effective sparse global-layer set near 23, 29, 35, 41, 47,
- clear degeneration cliffs for dense mid/late-layer configurations,
- calibrated low/medium/strong presets with stable quality tradeoffs.

Gemma 4 is a later transfer step, not the current target.

## Explicitly out of scope for this phase

- production canary orchestration,
- SLO dashboards and alert packs,
- promotion governance workflows,
- cost and quota policy enforcement.

Those are rollout concerns and can be revisited after methodology parity is established.

## Methodology workstreams

### 1) Gemma 3 baseline freeze

- Freeze baseline model config (Gemma 3 revision, seed, prompt sets, judge bundle).
- Define a fixed prompt/concept suite covering:
  - concept adherence prompts,
  - coherence and correctness guard prompts,
  - degeneration stress prompts.
- Standardize run-card metadata so each result is traceable and rerunnable.

### 2) Vector construction protocol

- Build or harden vector extraction from paired positive/negative samples.
- Fix deterministic preprocessing and normalization.
- Emit vector bundle artifacts with:
  - `vector_bundle_id`,
  - model revision,
  - training seed,
  - concept metadata,
  - layer coverage.

### 3) Gemma 3 single-layer sweep (Stage B parity)

- Sweep candidate layers (16-53) one at a time with multiplier grid.
- Track per run:
  - concept adherence,
  - coherence,
  - correctness,
  - degeneration rate,
  - language stability,
  - latency.
- Apply hard gates first, then rank surviving candidates.

### 4) Gemma 3 sparse multi-layer calibration (Stage C parity)

- Build multi-layer candidates only from Stage B passing layers.
- Sweep sparse layer sets (3-5 layers).
- Calibrate preset table (`low`, `medium`, `strong`) per concept family.
- Produce deterministic top candidate set and fallback policy.

### 5) Parity and robustness validation

- Validate whether observed behavior matches Ramp-like qualitative outcomes.
- Run ablations:
  - no-steering vs single-layer vs sparse multi-layer,
  - uniform multiplier vs per-layer weighting,
  - concept family sensitivity.
- Confirm degeneration remains bounded inside selected operating bands.

### 6) Transfer readiness (Gemma 4 later)

- Document portability assumptions from Gemma 3 results.
- Define transfer experiment protocol and success thresholds for Gemma 4.
- Do not switch default model until Gemma 3 parity is locked.

## Success criteria

- Repeatable layer rankings across seeded reruns on Gemma 3.
- Measurable adherence lift with non-inferior coherence and correctness.
- Degeneration and language drift within accepted thresholds.
- Full reproducibility artifact trail (config, seed, dataset, model revision, vector bundle).

## Proposed execution order

1. Baseline freeze and run-card schema.
2. Vector bundle reproducibility.
3. Stage B single-layer parity sweep.
4. Stage C sparse multi-layer and preset calibration.
5. Parity + robustness report.
6. Gemma 4 transfer-readiness protocol.

## Immediate next actions

1. Re-scope open P3 tickets to this methodology-first plan.
2. Keep daemon paused until re-scoped tickets are approved.
3. Run one deterministic Gemma 3 Stage B campaign and snapshot results.
4. Use Stage B winners to define Stage C candidates.
5. Publish a parity report before any Gemma 4 migration work.
