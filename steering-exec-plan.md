# Steering Infrastructure Executive Plan (One Page)

This plan outlines how we operationalize activation steering, evaluate Gemma 4, and run a closed-loop improvement cycle with LangSmith.

## Objective

Ship a reliable steering platform that:

- improves concept adherence without sacrificing response quality,
- controls cost and latency,
- supports safe model evolution (Gemma 3 -> Gemma 4),
- and uses production evidence to continuously improve profiles.

## Scope (next 4-6 weeks)

1. Production-grade steering runtime with versioned profile control
2. DeepAgentsJS-compatible eval suite for steering-specific behavior
3. LangSmith-based feedback loop across traces, datasets, and experiments
4. Gemma 4 champion/challenger bake-off and gated rollout decision

## What we are building

## 1) Core services

- `vector-trainer`: trains concept vectors + preset calibration
- `profile-registry`: immutable profile versions (layers, presets, vector bundle)
- `steering-inference-api`: OpenAI-compatible endpoint with layer injection
- `eval-orchestrator`: runs steering evals and computes promotion score
- `canary-router`: traffic splitting + auto rollback hooks

## 2) Baseline defaults (current champion)

- Model family: Gemma 3 27B-IT
- Layer policy: sparse global `23,29,35,41,47`
- Fallback layer: `41`
- Presets: `low`, `medium` (default), `strong` with backoff guardrails

## 3) Gemma 4 experiment track

Treat Gemma 4 as a fresh architecture, not a drop-in replacement.

- Stage A: no-steering quality baseline
- Stage B: single-layer sweep
- Stage C: sparse multi-layer + preset calibration
- Stage D: head-to-head against current Gemma 3 champion

## Decision policy

Promote only if Gemma 4 passes hard gates and wins weighted ranking.

Hard gates:

- degeneration <= 3%
- coherence non-inferior (>= champion - 0.02)
- correctness non-inferior (>= champion - 0.01)
- language stability >= 99%
- p95 latency <= 1.2x champion

## LangSmith closed-loop feedback system

## 1) Data model

Every run logs:

- `profile_id`, `vector_bundle_id`, `layers`, `preset`, `multiplier`
- `base_model`, `base_model_revision`, `git_sha`
- `degenerate`, `language_shift`, token usage, latency

## 2) Trace -> eval -> experiment loop (nightly)

1. Mine production traces for failures/drift.
2. Convert representative failures into versioned eval datasets.
3. Run experiments across champion + challengers.
4. Apply hard gates, then weighted ranking.
5. If passing, progress through canary ramp; else hold.

## 3) Standardized naming

- Projects: `steer-prod-{env}`, `steer-evals-{env}`
- Datasets: `steer-{suite}-{source}-v{date}`
- Experiments: `exp-{date}-{suite}-{champion}-vs-{challenger}`

## Delivery milestones

- Week 1: metadata schema + profile registry + LangSmith project setup
- Week 2: `evals/steering` suite and baseline dashboards
- Week 3: Gemma 4 sweeps and challenger profile generation
- Week 4: champion/challenger experiments + staging canary
- Week 5-6: production canary and rollout decision

## Success criteria

- measurable adherence lift at equal or better coherence,
- stable degeneration within threshold,
- no major production regressions during canary,
- reproducible, auditable promotion decisions backed by LangSmith evidence.

## Immediate next actions

1. Freeze current Gemma 3 champion profile ID and metrics snapshot.
2. Stand up `steer-evals-staging` and `steer-prod-staging` LangSmith projects.
3. Build first `migration` dataset from current weak traces.
4. Launch Gemma 4 Stage A/B sweeps.
