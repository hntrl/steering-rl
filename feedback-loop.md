# Steering Feedback Loop with Evals, Traces, and Experiments (LangSmith)

This document defines how the steering infrastructure should work end to end, and how we run a continuous feedback loop using LangSmith traces, evals, and experiments.

The intent is to make model + layer changes (including Gemma 4 experiments) safe, measurable, and promotable.

## 1) What this system does

We run a champion/challenger loop:

1. Serve steering in production with strict metadata logging.
2. Collect traces from real traffic.
3. Mine weak or failed traces into curated eval cases.
4. Run experiments across candidate steering profiles.
5. Promote only if hard gates pass and weighted score improves.

Core idea: no manual intuition-only promotions.

## 2) Infrastructure architecture

## 2.1 Services

- `vector-trainer`: Offline jobs that train concept vectors and calibration tables.
- `profile-registry`: Versioned storage for steering profiles (layers, presets, vector refs).
- `steering-inference-api`: OpenAI-compatible runtime endpoint that applies activation steering.
- `deepagentsjs-eval-runner`: Controlled test harness for repeatable comparisons.
- `langsmith-telemetry`: Trace/experiment/dataset logging and analysis.

## 2.2 Data flow

```text
User request -> steering-inference-api -> model forward pass with layer injection
     |                                             |
     +---------------- trace + metadata ----------> LangSmith project (prod)

LangSmith prod traces -> mining pipeline -> eval dataset curation -> LangSmith datasets
                                                           |
                                                           v
                                             deepagentsjs eval suites
                                                           |
                                                           v
                                            LangSmith experiments + ranking
                                                           |
                                                           v
                                               promote / hold / rollback
```

## 2.3 Steering profile object (registry)

Each profile should be immutable and versioned.

```json
{
  "profile_id": "steer-gemma3-default-v12",
  "base_model": "gemma-3-27b-it",
  "base_model_revision": "2026-03-15",
  "layers": [23, 29, 35, 41, 47],
  "fallback_layer": 41,
  "vector_bundle_id": "vec-bundle-2026-04-01-rc2",
  "preset_table": {
    "low": 0.12,
    "medium": 0.22,
    "strong": 0.34
  },
  "judge_bundle": "judge-v4",
  "created_at": "2026-04-02T00:00:00Z"
}
```

## 3) LangSmith naming conventions

Use deterministic names so automation and dashboards are stable.

## 3.1 Projects

- Production traces: `steer-prod-{env}`
  - Examples: `steer-prod-dev`, `steer-prod-staging`, `steer-prod-prod`
- Offline evals: `steer-evals-{env}`
  - Examples: `steer-evals-staging`, `steer-evals-prod-shadow`
- Backfill/replay jobs: `steer-replay-{env}`

## 3.2 Datasets

Pattern:

`steer-{suite}-{source}-v{YYYYMMDD}`

Examples:

- `steer-core-golden-v20260402`
- `steer-degeneracy-prodtrace-v20260402`
- `steer-gemma4-migration-v20260402`

Recommended suites:

- `core`: canonical high-signal tasks (stable regression set)
- `edge`: difficult prompts and known failure patterns
- `degeneracy`: repetition/collapse stress cases
- `migration`: model-switch deltas (for Gemma 4 or future families)

## 3.3 Experiments

Pattern:

`exp-{date}-{suite}-{champion}-vs-{challenger}`

Examples:

- `exp-20260402-core-gemma3v12-vs-gemma4v3`
- `exp-20260402-degeneracy-gemma3v12-vs-gemma4v3`

## 3.4 Tags

Apply tags on every run/experiment:

- `model:{base_model}`
- `profile:{profile_id}`
- `preset:{low|medium|strong}`
- `concept:{concept_slug}`
- `suite:{core|edge|degeneracy|migration}`
- `candidate:{champion|challenger}`
- `release:{release_id}`

## 4) Required metadata schema

Log the following metadata on every traced run.

```json
{
  "env": "prod",
  "agent": "deepagentsjs",
  "base_model": "gemma-3-27b-it",
  "base_model_revision": "2026-03-15",
  "profile_id": "steer-gemma3-default-v12",
  "vector_bundle_id": "vec-bundle-2026-04-01-rc2",
  "layers": [23, 29, 35, 41, 47],
  "fallback_layer": 41,
  "preset": "medium",
  "multiplier": 0.22,
  "concept": "expense-management",
  "request_id": "req_01HV...",
  "thread_id": "thread_01HV...",
  "dataset_version": "steer-core-golden-v20260402",
  "git_sha": "abc1234",
  "judge_bundle": "judge-v4",
  "latency_ms": 1720,
  "input_tokens": 1034,
  "output_tokens": 402,
  "degenerate": false,
  "language_shift": false
}
```

Notes:

- `profile_id` and `vector_bundle_id` must always be present.
- `layers` should reflect actual active layers after any runtime backoff.
- `degenerate` should be the post-guardrail outcome for the final response.

## 5) Metrics and scoring

Use two metric families.

## 5.1 Agent/harness metrics (from Deep Agents eval style)

- `correctness = passed / total`
- `solve_rate = average(expected_steps / wall_clock_seconds)` with failures as zero
- `step_ratio = total_actual_steps / total_expected_steps`
- `tool_call_ratio = total_actual_tool_calls / total_expected_tool_calls`

## 5.2 Steering-specific metrics

- `concept_adherence` (LLM judge or rubric score)
- `coherence` (LLM judge score)
- `degenerate_rate` (fraction of failed-style outputs)
- `language_stability` (no unintended language drift)
- `safety_violation_rate` (if applicable)

## 5.3 Composite ranking score

Use weighted rank for challenger ordering after hard gates:

```text
rank_score =
  0.35 * correctness
  + 0.20 * coherence
  + 0.20 * concept_adherence
  + 0.10 * solve_rate_norm
  + 0.10 * (1 - degenerate_rate)
  + 0.05 * latency_norm
```

Keep weights in config, not code constants.

## 6) Promotion policy (hard and soft gates)

Hard gates are non-negotiable. Soft gates rank passing candidates.

## 6.1 Hard gates

Candidate must satisfy all:

- `degenerate_rate <= 3%` on `core` and `migration`
- `coherence >= champion_coherence - 0.02`
- `correctness >= champion_correctness - 0.01`
- `language_stability >= 99%`
- `p95_latency_ms <= champion_p95_latency_ms * 1.20`
- no critical safety regressions

## 6.2 Soft gates

Among hard-pass candidates:

- prefer higher `concept_adherence`
- prefer lower cost/token
- prefer lower p95 latency
- prefer lower step/tool ratios (efficiency)

## 6.3 Canary policy

After offline pass:

1. `10%` staging canary for 24h
2. `10%` production canary for 24h
3. `50%` production for 24h
4. `100%` promote if all guardrails stay green

Auto-rollback triggers:

- `degenerate_rate` exceeds threshold for 30 min rolling window
- critical error rate spike
- p95 latency breach sustained for 30 min

## 7) Minimal DeepAgentsJS eval suite structure

Create `evals/steering/` in the DeepAgentsJS monorepo style.

## 7.1 Files

```text
evals/steering/
  package.json
  vitest.config.ts
  index.test.ts
  datasets/
    core.json
    edge.json
    degeneracy.json
```

## 7.2 package.json

```json
{
  "name": "@deepagents/eval-steering",
  "private": true,
  "type": "module",
  "scripts": {
    "test:eval": "vitest run"
  },
  "dependencies": {
    "@deepagents/evals": "workspace:*",
    "deepagents": "workspace:*",
    "langsmith": "^0.5.4",
    "vitest": "^4.0.18"
  }
}
```

## 7.3 vitest config

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    setupFiles: ["@deepagents/evals/setup"],
    reporters: ["default", "langsmith/vitest/reporter"],
    testTimeout: 120_000,
  },
});
```

## 7.4 Test skeleton

```ts
import * as ls from "langsmith/vitest";
import { expect } from "vitest";
import { getDefaultRunner } from "@deepagents/evals";

const runner = getDefaultRunner();

ls.describe(
  runner.name,
  () => {
    ls.test(
      "steering medium keeps coherence",
      { inputs: { query: "Explain budgeting basics" } },
      async ({ inputs }) => {
        const result = await runner
          .extend({
            modelKwargs: {
              steering: {
                concept: "expense-management",
                preset: "medium",
                layers: [23, 29, 35, 41, 47],
              },
            },
          })
          .run({ query: inputs.query });

        expect(result).toHaveAgentSteps(1);
        expect(result).toHaveFinalTextContaining("budget", true);
      },
    );
  },
  { projectName: "steer-evals-staging", upsert: true },
);
```

Use additional custom evaluators for `coherence`, `concept_adherence`, and `degenerate` scoring.

## 8) Trace mining -> dataset curation process

Nightly job:

1. Pull recent traces from `steer-prod-prod`.
2. Filter for errors, high latency, or low feedback scores.
3. Cluster by failure mode (collapse, low adherence, tool misuse, etc.).
4. Convert representative traces into dataset examples.
5. Version and publish dataset.

Recommended CLI patterns:

```bash
# Recent failed traces
langsmith trace list --project steer-prod-prod --last-n-minutes 1440 --error --limit 500

# Export full traces for curation
langsmith trace export /tmp/steer-traces --project steer-prod-prod --last-n-minutes 1440 --full --limit 500

# List experiments for comparison
langsmith experiment list --limit 50
```

## 9) Gemma 4 migration playbook

Treat Gemma 4 as a fresh family.

## 9.1 Candidate setup

- Champion: current Gemma 3 profile (for example `steer-gemma3-default-v12`)
- Challenger set:
  - Gemma 4 single-layer scan profiles
  - Gemma 4 sparse global profiles
  - Gemma 4 calibrated preset profiles

## 9.2 Required eval suites

- `core`
- `edge`
- `degeneracy`
- `migration` (prompts where Gemma 3 is currently strongest)

## 9.3 Decision

Promote only if Gemma 4 challenger passes hard gates in all suites and wins soft ranking on at least two suites, with no production canary regression.

## 10) Operational cadence and ownership

- Daily: monitor dashboards and trace-level anomalies.
- Nightly: trace mining + dataset updates + experiment run.
- Weekly: promotion review meeting (model owner + infra + product).
- Release: snapshot profile registry and publish changelog.

Ownership:

- Model owner: profile training and calibration
- Infra owner: runtime stability and rollback system
- Eval owner: dataset quality and gate policy

## 11) Dashboard and alert checklist

Track at minimum:

- correctness trend
- coherence trend
- concept adherence trend
- degenerate rate
- p50/p95 latency
- cost per 1K output tokens
- language stability

Alerts:

- critical: degenerate rate or safety violations
- warning: latency and adherence drift

## 12) Implementation checklist

1. Add metadata schema enforcement to inference API.
2. Create LangSmith projects with naming conventions above.
3. Add `evals/steering` suite in DeepAgentsJS style.
4. Implement nightly trace-mining dataset pipeline.
5. Implement experiment ranking service with hard/soft gates.
6. Add canary router and auto-rollback triggers.
7. Run Gemma 4 challenger campaign.

This gives a complete, auditable closed-loop system where model/layer decisions are continuously improved by real traffic and controlled eval evidence.
