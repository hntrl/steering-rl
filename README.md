# Steering RL Build Repo

This repository contains planning docs and the agent execution scaffolding to build the steering platform end to end.

## Quick start

1. Install prerequisites:
   - GitHub CLI (`gh`) authenticated to your account
   - Node.js 20+
   - pnpm
   - Deep Agents CLI (`deepagents`) installed and configured

2. Validate task contracts:

```bash
pnpm verify
```

3. Bootstrap GitHub repo labels and issues:

```bash
bash scripts/bootstrap-github.sh
```

4. Assign tasks from `tasks/` to coding agents.

## Self-running agent orchestration

The repository includes a supervisor/worker/reconciler loop that dispatches tasks from GitHub issues and runs Deep Agents in isolated git worktrees.

### Required environment variables

```bash
export REPO="hntrl/steering-rl"
export BASE_BRANCH="main"
export EXECUTOR_BOT_TOKEN="..."

export LANGSMITH_API_KEY="..."
export LANGCHAIN_API_KEY="$LANGSMITH_API_KEY"
export LANGCHAIN_TRACING=true
export DEEPAGENTS_LANGSMITH_PROJECT="steer-build-agents-staging"

export DEEPAGENTS_AGENT="build"
export DEEPAGENTS_SHELL_ALLOW_LIST="cd,git,pnpm,npm,node,npx,python3,bash,sh,ls,cat,head,tail,grep,pwd,which,cp,mv,rm,mkdir,touch"

export MAX_PARALLEL=2
export POLL_INTERVAL_SECONDS=60
export MAX_AGENT_RUNTIME_MINUTES=20
```

Use an explicit command list for coding workflows. Do not set `DEEPAGENTS_SHELL_ALLOW_LIST=all`.

### Run once

```bash
bash scripts/agent-daemon.sh once
```

`once` runs in the foreground and prints dispatch output directly to your terminal.
Use `DRY_RUN=1` to test dispatch logic without labeling issues or starting workers.

```bash
DRY_RUN=1 bash scripts/agent-daemon.sh once
```

### Run continuously

```bash
bash scripts/agent-daemon.sh start
bash scripts/agent-daemon.sh status
bash scripts/agent-daemon.sh follow
bash scripts/agent-daemon.sh stop
```

### Reset stale locks

If a previous dry run or crash leaves a task lock behind, clear locks:

```bash
bash scripts/agent-daemon.sh reset
```

### Automatic branch cleanup

After reconciliation the reconciler automatically deletes remote branches for merged task PRs and prunes stale local worktrees that no longer have active runs.

Only branches matching `agent/P0-##` or `agent/P1-##` with merged PRs are deleted. Protected branches (`main`, `master`) are never touched.

Use `DRY_RUN=1` (or `--dry-run`) to preview planned deletions without mutating git state:

```bash
DRY_RUN=1 bash scripts/agent-daemon.sh once
```

Set `REPO_ROOT` to point at the bare repo root when running the reconciler outside a worktree.

### Orchestration logs

- Runtime state: `~/.agentd/state/runs.json`
- Structured events: `~/.agentd/logs/events.jsonl`
- Worker logs: `~/.agentd/logs/workers/`

For live Deep Agents progress, tail the latest worker log shown in the supervisor dispatch output.

### Conflict recovery

The worker automatically syncs its branch with the base branch before each agent run. When merge conflicts occur:

- **Lockfile-only conflicts** (`pnpm-lock.yaml`): Resolved automatically by checking out the upstream version and running `pnpm install --lockfile-only`. Non-lockfile task changes are preserved.
- **Non-lockfile conflicts**: The rebase is aborted and the run exits with a retry status. No task changes are discarded.
- **Repeated failures**: After 3 failed conflict-recovery attempts, the issue is marked `status:blocked` with an actionable remediation comment describing manual resolution steps.

Conflict recovery emits `branch_sync` and `conflict_recovery` events to `events.jsonl`.

To disable automatic lockfile resolution, set `DISABLE_LOCKFILE_AUTO_RESOLVE=1` in the worker environment and fall back to manual conflict resolution.

### Quick troubleshooting

- `once` runs a single dispatch cycle and exits; `status` will still show stopped afterward.
- If nothing dispatches, run `bash scripts/agent-daemon.sh reset` and retry.
- Check latest run status in `~/.agentd/state/runs.json`.
- Open `log_path` from the run record to see the exact Deep Agents error.

Run the doctor script for a consolidated diagnosis:

```bash
pnpm agent:doctor
```

The doctor report includes explicit requeue commands when root dependency tasks are blocked.

Machine-readable JSON output for CI and cron alerting:

```bash
node scripts/agent-doctor.mjs --format json
```

The JSON report follows `schemas/doctor-report.schema.json` and includes summary counts, per-check detail, and recommended remediation actions. Secret values are always redacted in both text and JSON modes.

Strict mode returns non-zero exit when failure or warning thresholds are breached:

```bash
node scripts/agent-doctor.mjs --strict                        # exit 1 on any fail
node scripts/agent-doctor.mjs --strict --fail-threshold 2     # exit 1 on >= 2 fails
node scripts/agent-doctor.mjs --strict --warn-threshold 3     # also gate on >= 3 warnings
node scripts/agent-doctor.mjs --strict --format json          # combine JSON + strict
```

Optional smoke test (30s timeout):

```bash
node scripts/agent-doctor.mjs --smoke
```

Event payloads follow `schemas/agent-event.schema.json`.

```bash
pnpm events:validate
```

## Core docs

- `steering-exec-plan.md`
- `feedback-loop.md`
- `agent-delivery-plan.md`
- `agent-instrumentation-spec.md`

## Task contracts

Task contracts live in `tasks/` and are designed for coding-agent execution.
