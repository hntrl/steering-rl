# Agent Instrumentation Spec (Implementation Setup)

This spec explains exactly what to set up so coding agents can implement the steering platform safely and efficiently.

It focuses on operational setup, instrumentation, and controls, not model science.

## 1) Target outcome

After setup, you should be able to:

1. assign a ticket contract to an agent,
2. run the agent in an isolated branch with guardrails,
3. collect full execution telemetry in LangSmith,
4. gate merge on deterministic verification,
5. analyze failures and improve agent behavior over time.

## 2) Required components

You need five runtime components.

- `agent-supervisor`: accepts task contracts, schedules runs, tracks lifecycle.
- `agent-runner`: executes coding agent sessions in isolated workspaces.
- `policy-gateway`: validates allowed tools/actions and blocks unsafe behavior.
- `artifact-store`: stores patches, logs, test output, and decision artifacts.
- `telemetry-pipeline`: sends structured traces/events to LangSmith.

## 3) External services and accounts

Set these up first.

- Git hosting with branch protections and required status checks.
- CI provider (GitHub Actions is fine) with required `verify` workflow.
- LangSmith workspace + API key.
- Secret manager (1Password, Doppler, Vault, or cloud secret manager).
- Object storage for artifacts (S3/GCS equivalent) or a persistent file store.

## 4) Environment variables

Minimum env set for supervisor and runners:

```bash
LANGSMITH_API_KEY=
LANGSMITH_PROJECT=steer-build-agents-staging
LANGSMITH_WORKSPACE_ID=

GIT_REMOTE_URL=
GIT_DEFAULT_BRANCH=main

ARTIFACT_STORE_URI=
ARTIFACT_STORE_PREFIX=agent-runs/

ALLOW_NETWORK_HOSTS=github.com,api.smith.langchain.com
BLOCK_DESTRUCTIVE_GIT=true

VERIFY_COMMAND=pnpm verify
```

Optional but recommended:

```bash
MAX_AGENT_RUNTIME_MINUTES=90
MAX_RETRIES_PER_TASK=2
REQUIRE_REVIEW_AGENT_FOR_RISK=high
```

## 5) Task contract (required input)

Every run must start from a strict task contract.

```json
{
  "task_id": "P0-05",
  "title": "Layer injection engine",
  "goal": "Implement per-layer residual steering injection",
  "inputs": ["feedback-loop.md", "agent-delivery-plan.md"],
  "expected_outputs": [
    "src/steering/engine.ts",
    "tests/steering/engine.test.ts"
  ],
  "constraints": [
    "No destructive git commands",
    "Must pass verify command"
  ],
  "verify_command": "pnpm test --filter steering-engine",
  "definition_of_done": [
    "Injection only applies to requested layers",
    "No-steering path remains baseline-compatible"
  ],
  "risk_level": "high",
  "rollback_note": "Feature flag STEERING_ENABLE=false"
}
```

Supervisor must reject contracts missing `verify_command`, `definition_of_done`, or `rollback_note`.

## 6) Run lifecycle

Use a fixed state machine.

`queued -> running -> verify_failed | review_needed | ready_for_pr -> merged | cancelled`

Rules:

- one active run per `task_id`
- hard timeout per run
- retry only on deterministic conditions (for example test flake), max retries enforced

## 7) Instrumentation model

Capture both event logs and trace metadata.

## 7.1 Event schema

Emit these events:

- `task_received`
- `run_started`
- `tool_call_started`
- `tool_call_finished`
- `file_changed`
- `verify_started`
- `verify_finished`
- `review_started`
- `review_finished`
- `pr_created`
- `run_completed`
- `run_failed`

Event payload shape:

```json
{
  "timestamp": "2026-04-02T20:11:00Z",
  "task_id": "P0-05",
  "run_id": "run_01HV...",
  "event_type": "tool_call_finished",
  "tool_name": "bash",
  "duration_ms": 3482,
  "status": "ok",
  "exit_code": 0,
  "files_touched": ["src/steering/engine.ts"],
  "metadata": {
    "agent_version": "coder-v3",
    "branch": "agent/P0-05/run_01HV"
  }
}
```

## 7.2 LangSmith trace metadata

Attach this metadata to every run trace:

```json
{
  "system": "coding-agents",
  "task_id": "P0-05",
  "run_id": "run_01HV...",
  "agent_model": "gpt-5.3-codex",
  "agent_version": "coder-v3",
  "branch": "agent/P0-05/run_01HV",
  "repo_sha_start": "abc1234",
  "repo_sha_end": "def5678",
  "verify_command": "pnpm test --filter steering-engine",
  "verify_passed": true,
  "retry_count": 0,
  "risk_level": "high",
  "result": "ready_for_pr"
}
```

Tags to set:

- `ticket:P0-05`
- `track:runtime`
- `risk:high`
- `result:ready_for_pr`
- `retry:0`

## 8) Policy gateway (safety controls)

Enforce policy before tool execution.

Block by default:

- destructive git (`reset --hard`, force checkout, force push)
- unauthorized network destinations
- secret reads from unmanaged paths
- bypass flags like `--no-verify` for commit hooks

Require explicit approval for:

- dependency additions
- CI workflow edits
- rollout/canary config changes

## 9) CI and merge controls

Set these repository rules:

- required checks: `verify`, `unit`, `typecheck`, `eval-smoke`
- branch protection on `main`
- at least one human review for `risk=high`
- no direct pushes to protected branches

PR body must include:

- task contract ID
- verify output summary
- files changed
- rollback plan
- known risks

## 10) Artifact retention

Store and index these per run:

- patch diff
- command log
- verify output
- test report
- review notes
- generated PR URL

Retention policy:

- keep raw artifacts for 30 days
- keep run summary and decision artifacts for 180 days

## 11) Setup sequence (what you do this week)

## Day 1: Foundation

1. Create LangSmith projects:
   - `steer-build-agents-staging`
   - `steer-build-agents-prod`
2. Configure secret manager entries for all env vars in Section 4.
3. Enable branch protection and required CI checks.
4. Add `pnpm verify` and make it deterministic.

## Day 2: Supervisor and runner

1. Stand up `agent-supervisor` service with lifecycle states.
2. Implement task contract validation.
3. Implement isolated branch creation per run.
4. Wire artifact upload and run summary persistence.

## Day 3: Telemetry and policy

1. Implement event schema emission (Section 7.1).
2. Add LangSmith trace metadata + tags (Section 7.2).
3. Implement policy gateway deny/allow rules.
4. Add alerts for `verify_failed` and timeout spikes.

## Day 4: Pilot

1. Run 3-5 low-risk tickets end to end.
2. Inspect trace completeness and artifact quality.
3. Tune retries/timeouts and policy false positives.

## Day 5: High-risk dry run

1. Execute one `risk=high` ticket with review-agent enabled.
2. Validate rollback path in staging.
3. Freeze instrumentation contract for sprint-wide use.

## 12) Operational dashboards

Track weekly:

- first-pass verify rate
- retries per ticket
- median cycle time by ticket type
- review rejection rate
- rollback-trigger count

Set alerts for:

- first-pass verify < 70%
- timeout rate > 10%
- missing LangSmith metadata > 1%

## 13) Minimal go-live checklist

- [ ] task contract validator enabled
- [ ] policy gateway blocking destructive actions
- [ ] per-run isolated branches enabled
- [ ] deterministic `pnpm verify` in CI
- [ ] LangSmith metadata/tag schema enforced
- [ ] artifact retention configured
- [ ] human-review requirement for high-risk tasks
- [ ] rollback mechanism tested in staging

When this checklist is complete, you can start assigning P0 tickets from `agent-delivery-plan.md` to coding agents with low operational risk.
