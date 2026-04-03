# Agent Delivery Plan for Steering Platform

This plan translates the steering architecture into execution-ready tickets for coding agents.

It is optimized for parallel implementation with strict interfaces, strong CI gates, and low-risk rollout.

## 1) Delivery goals

Ship a production steering system with:

- OpenAI-compatible inference runtime
- versioned steering profiles and calibrations
- DeepAgentsJS eval coverage for steering behavior
- LangSmith closed-loop trace -> eval -> experiment pipeline
- champion/challenger canary promotion with rollback

## 2) Agent-first delivery principles

Coding agents succeed when tasks are narrow, deterministic, and testable.

Use these rules for every ticket:

1. Contract first: schema/API are frozen before implementation.
2. One ticket, one outcome: avoid mixed concerns.
3. Mandatory verify command: each ticket has a single pass/fail command.
4. No hidden dependencies: all required env vars and fixtures are declared.
5. PR must include risk and rollback notes.

## 3) Program structure

## 3.1 Tracks

- Track A: Runtime (`steering-inference-api`, guardrails, profile read path)
- Track B: Control plane (`profile-registry`, vector metadata, release manifests)
- Track C: Evaluation (`evals/steering`, judge metrics, gate checker)
- Track D: Feedback loop (`trace mining`, dataset curation, experiment ranking)
- Track E: Rollout (`canary-router`, rollback automation, dashboards)

## 3.2 Priorities

- `P0`: required for first end-to-end champion/challenger loop
- `P1`: quality, speed, and automation improvements after P0 is stable

## 4) P0 tickets (execution backlog)

Each ticket below is intentionally scoped for a coding agent.

## P0-01: Contracts package

Purpose:

- Define immutable API/schema contracts used by all services.

Deliverables:

- `contracts/openapi/inference.yaml`
- `contracts/schema/profile.json`
- `contracts/schema/run-metadata.json`
- `contracts/schema/experiment-decision.json`

Acceptance criteria:

- OpenAPI validates with no errors.
- JSON schemas validate representative fixtures.
- `steering` payload supports `concept`, `preset`, `layers`, `multiplier`, `profile_id`.
- run metadata includes required fields from `feedback-loop.md`.

Verify:

- `pnpm contracts:lint && pnpm contracts:test`

Dependencies:

- none

## P0-02: Local dev and CI gate setup

Purpose:

- Create a single deterministic quality gate for agent PRs.

Deliverables:

- root script `verify` running lint, typecheck, unit tests, and eval smoke
- CI workflow executing `verify` on PR
- PR template with risk/rollback section

Acceptance criteria:

- `pnpm verify` exits zero locally and in CI.
- CI blocks merge on any failing stage.
- PR template requires changed contracts + test evidence.

Verify:

- `pnpm verify`

Dependencies:

- P0-01

## P0-03: Profile registry read API

Purpose:

- Serve immutable steering profile versions to inference runtime.

Deliverables:

- endpoint: `GET /profiles/{profile_id}`
- endpoint: `GET /profiles/{profile_id}/manifest`
- storage model with immutable records and `active` alias support

Acceptance criteria:

- profile retrieval by `profile_id` returns exact manifest.
- immutable behavior enforced (no in-place overwrite).
- 404 for unknown profile; structured error body.
- includes `base_model_revision`, `layers`, `preset_table`, `vector_bundle_id`.

Verify:

- `pnpm test --filter profile-registry`

Dependencies:

- P0-01

## P0-04: Steering inference API skeleton

Purpose:

- Provide OpenAI-compatible chat completions endpoint with steering fields.

Deliverables:

- endpoint: `POST /v1/chat/completions`
- request parser and validation against contract
- response mapper to OpenAI-compatible shape

Acceptance criteria:

- accepts standard `messages` and model params.
- accepts `steering` block and resolves `profile_id`.
- returns deterministic 4xx on invalid steering payload.
- includes response metadata (`profile_id`, active layers, multiplier used).

Verify:

- `pnpm test --filter steering-inference-api`

Dependencies:

- P0-01, P0-03

## P0-05: Layer injection engine

Purpose:

- Apply steering vectors at configured layers during generation.

Deliverables:

- model wrapper with per-layer residual injection
- support for single-layer and multi-layer config
- unit tests with synthetic vectors (no provider dependency)

Acceptance criteria:

- injection occurs only on requested layers.
- disabled steering path is bitwise-stable vs baseline in test harness.
- supports per-layer multiplier override and uniform multiplier.
- logs active layer list and effective multiplier per request.

Verify:

- `pnpm test --filter steering-engine`

Dependencies:

- P0-01, P0-04

## P0-06: Runtime guardrails and backoff ladder

Purpose:

- Prevent catastrophic degeneration in live responses.

Deliverables:

- guardrail detector module (`degenerate`, `language_shift`, repetition)
- backoff policy: `strong -> medium -> single-layer -> off`
- telemetry event for each backoff step

Acceptance criteria:

- guardrail triggers are testable with fixtures.
- backoff mutates active profile for current request only.
- final run metadata reflects post-backoff active layers.
- no infinite retry loops.

Verify:

- `pnpm test --filter steering-guardrails`

Dependencies:

- P0-05

## P0-07: LangSmith tracing middleware

Purpose:

- Enforce complete trace metadata and tags on every run.

Deliverables:

- middleware that attaches required metadata schema
- automatic tags (`model:*`, `profile:*`, `preset:*`, `suite:*`)
- hard fail for missing required fields in eval/prod modes

Acceptance criteria:

- traces appear in configured LangSmith project.
- required fields (`profile_id`, `vector_bundle_id`, `layers`, `preset`) always present.
- schema validation error returned when metadata is incomplete.

Verify:

- `pnpm test --filter telemetry && pnpm test --filter tracing`

Dependencies:

- P0-01, P0-04

## P0-08: DeepAgentsJS steering eval suite

Purpose:

- Add steering-specific eval coverage with LangSmith reporting.

Deliverables:

- `evals/steering/package.json`
- `evals/steering/vitest.config.ts`
- `evals/steering/index.test.ts`
- datasets: `core`, `edge`, `degeneracy`, `migration`

Acceptance criteria:

- suite runs through existing eval harness.
- tests assert both harness metrics and steering outcomes.
- nightly mode emits experiment results to `steer-evals-{env}`.

Verify:

- `EVAL_RUNNER=<runner> pnpm --filter @deepagents/eval-steering test:eval`

Dependencies:

- P0-02, P0-07

## P0-09: Experiment gate checker

Purpose:

- Compute promotion decision from experiment metrics.

Deliverables:

- gate-check command producing `experiment-decision.json`
- hard gate checks from `feedback-loop.md`
- weighted ranking score for hard-pass candidates

Acceptance criteria:

- fails candidate when any hard gate fails.
- emits machine-readable reasons for pass/fail.
- supports champion/challenger comparison by profile ID.

Verify:

- `pnpm test --filter experiment-gates`

Dependencies:

- P0-01, P0-08

## P0-10: Trace mining to dataset pipeline

Purpose:

- Convert production failures into versioned eval datasets.

Deliverables:

- nightly job to pull traces from `steer-prod-{env}`
- clustering/dedup logic (prompt hash + failure signature)
- output dataset artifact with version naming convention

Acceptance criteria:

- pipeline exports curated dataset and changelog.
- duplicates are removed deterministically.
- dataset name format follows `steer-{suite}-{source}-v{date}`.

Verify:

- `pnpm test --filter trace-miner && pnpm run trace-miner:dry-run`

Dependencies:

- P0-07

## P0-11: Canary router and rollback automation

Purpose:

- Safely promote challengers with automated rollback.

Deliverables:

- traffic split config (`10/90`, `50/50`, `100/0`)
- rollback triggers (degenerate rate, p95 latency, error rate)
- runtime kill switch for steering disable

Acceptance criteria:

- canary percentages can be changed without redeploy.
- rollback executes within SLA after threshold breach.
- kill switch forces no-steering baseline path.

Verify:

- `pnpm test --filter rollout && pnpm run canary:simulation`

Dependencies:

- P0-06, P0-09

## P0-12: Gemma 4 Stage A/B automation

Purpose:

- Run initial Gemma 4 baseline and single-layer sweep campaign.

Deliverables:

- reproducible job config for Stage A (no steering) and Stage B (single-layer)
- result artifact with per-layer coherence/adherence/degeneration
- candidate profile set for Stage C planning

Acceptance criteria:

- jobs run from CI or scheduler with fixed seed/config.
- outputs include model revision and dataset version.
- artifacts are ingestible by experiment gate checker.

Verify:

- `pnpm run sweep:gemma4:stageA && pnpm run sweep:gemma4:stageB`

Dependencies:

- P0-08, P0-09

## 5) P1 tickets (post-P0 stability)

## P1-01: Per-concept adaptive calibration service

- Learn and serve concept-family-specific preset tables.
- Acceptance: medium preset variance reduced vs global table on migration suite.

## P1-02: Judge ensemble and confidence calibration

- Add multi-judge scoring and confidence intervals for adherence/coherence.
- Acceptance: lower score volatility run-to-run on fixed dataset.

## P1-03: Cost-aware routing policy

- Route traffic by request class to optimize quality/cost.
- Acceptance: cost/token reduction without hard-gate regressions.

## P1-04: Dashboard pack and alert tuning

- Production dashboards for correctness, coherence, degeneration, latency, cost.
- Acceptance: actionable alerts with low false positive rate over one week.

## P1-05: Auto release notes from experiment decisions

- Generate profile changelog from gate-check artifacts.
- Acceptance: every promotion has linked evidence bundle and rollback plan.

## 6) Dependency and parallelization plan

Recommended execution order:

1. P0-01, P0-02
2. P0-03, P0-04 (parallel)
3. P0-05
4. P0-06, P0-07 (parallel)
5. P0-08, P0-10 (parallel)
6. P0-09
7. P0-11
8. P0-12

High-parallel windows:

- After P0-04: runtime and telemetry can split
- After P0-07: evals and trace-mining can split

## 7) Agent task template (copy/paste)

Use this template when assigning work to coding agents:

```text
Task ID: P0-XX
Goal: <single sentence>
Inputs: <paths/specs/tickets this depends on>
Expected outputs: <files/endpoints/artifacts>
Constraints: <security/perf/compat requirements>
Tests to add: <unit/integration/eval>
Verify command: <single command>
Definition of done:
- <criterion 1>
- <criterion 2>
Rollback note: <how to disable or revert feature safely>
```

## 8) Definition of done (global)

A ticket is complete only when all are true:

- contract compliance validated
- tests included and passing
- telemetry and metadata complete
- docs updated for changed behavior
- rollback path documented
- `pnpm verify` passes in CI

## 9) Risks specific to coding-agent implementation

- Contract drift across parallel branches
- Implicit assumptions in prompts (missing edge-case handling)
- Flaky evals due to external provider variance
- Metadata omissions that break experiment comparability

Mitigations:

- lock contracts first (P0-01)
- require ticket-level verify commands
- keep provider-dependent tests separate from deterministic unit tests
- enforce metadata schema validation at runtime

## 10) First sprint recommendation

Target sprint: complete P0-01 through P0-08.

This yields a working vertical slice:

- steering requests can be served,
- traces are complete in LangSmith,
- steering eval suite runs,
- champion/challenger comparison is possible.

Then add P0-09 through P0-12 for full closed-loop promotion and Gemma 4 campaign automation.
