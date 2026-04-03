# Task Contracts

Each JSON file in this directory is a contract that a coding agent can execute.

## Rules

- One task per agent run.
- Run only the task `verify_command` for completion.
- Include verify output and rollback note in PR.

## Validate

```bash
pnpm verify
```

## Create GitHub issues

```bash
node scripts/create-gh-issues.mjs --repo <owner/repo>
```
