# Agent Execution Rules

This file defines how coding agents should execute tasks in this repository.

## Required workflow

1. Read exactly one task contract from `tasks/`.
2. Implement only that task's scope.
3. Run the task `verify_command`.
4. Include verify output in the PR body.
5. Include rollback note from the task contract.

## Safety constraints

- Do not run destructive git commands.
- Do not bypass checks with `--no-verify` or similar flags.
- Do not add dependencies unless required by the task.
- Do not access secrets outside configured environment variables.

## Task contract fields

Every task must define:

- `task_id`
- `title`
- `goal`
- `verify_command`
- `definition_of_done`
- `rollback_note`

## Validation

Run before creating a PR:

```bash
pnpm verify
```
