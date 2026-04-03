# Steering RL Build Repo

This repository contains planning docs and the agent execution scaffolding to build the steering platform end to end.

## Quick start

1. Install prerequisites:
   - GitHub CLI (`gh`) authenticated to your account
   - Node.js 20+
   - pnpm

2. Validate task contracts:

```bash
pnpm verify
```

3. Bootstrap GitHub repo labels and issues:

```bash
bash scripts/bootstrap-github.sh
```

4. Assign tasks from `tasks/` to coding agents.

## Core docs

- `steering-exec-plan.md`
- `feedback-loop.md`
- `agent-delivery-plan.md`
- `agent-instrumentation-spec.md`

## Task contracts

Task contracts live in `tasks/` and are designed for coding-agent execution.
