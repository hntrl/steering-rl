## Task

**Task ID:** P1-05
**Title:** Doctor JSON output and alert thresholds
**Goal:** Add machine-readable doctor output and severity thresholds so scheduled health checks can gate and alert automatically.

## Changes

### `scripts/agent-doctor.mjs`
- Added `--format json` flag producing structured JSON output conforming to `schemas/doctor-report.schema.json`
- Added configurable `--strict` mode with `--fail-threshold` and `--warn-threshold` for CI/cron gating
- Added `remediation` field on failing/warning checks with actionable fix instructions
- Added secret redaction — `EXECUTOR_BOT_TOKEN`, `LANGSMITH_API_KEY`, `LANGCHAIN_API_KEY` values are never printed raw in text or JSON modes

### `schemas/doctor-report.schema.json`
- New JSON Schema defining the doctor report structure: `schema_version`, `timestamp`, `summary` (ok/warn/fail/total counts), and `checks` array with `level`, `title`, `message`, and optional `remediation`

### `scripts/tests/agent-doctor-json.test.mjs`
- 8 tests validating JSON schema shape, summary count arithmetic, remediation presence, secret redaction in both JSON and text modes, and strict threshold exit behavior

### `README.md`
- Documented `--format json`, `--strict`, `--fail-threshold`, and `--warn-threshold` flags

## Verify Command Output

```
$ node --test scripts/tests/agent-doctor-json.test.mjs

▶ doctor --format json
  ✔ outputs valid JSON matching the doctor-report schema (98ms)
  ✔ includes remediation on failing checks (95ms)
  ✔ schema file exists and is valid JSON Schema (0ms)
✔ doctor --format json (195ms)
▶ secret redaction
  ✔ never prints raw secret values in JSON mode (91ms)
  ✔ never prints raw secret values in text mode (96ms)
✔ secret redaction (187ms)
▶ --strict thresholds
  ✔ exits non-zero in strict mode when failures meet default threshold (106ms)
  ✔ exits non-zero in strict mode when warnings meet --warn-threshold (89ms)
  ✔ exits zero when thresholds are not breached (92ms)
✔ --strict thresholds (288ms)

tests 8 | pass 8 | fail 0
```

## Definition of Done

- [x] Doctor supports `--format json` with a stable schema
- [x] Doctor supports `--strict` thresholds suitable for CI and cron alerting
- [x] Tests validate schema shape and secret-redaction behavior

## Constraints

- [x] JSON output includes summary counts, per-check detail, and recommended remediation actions
- [x] Never prints raw secret values in text or JSON modes
- [x] Strict mode returns non-zero exit for configured failure thresholds

## Rollback Note

If JSON or strict mode causes false alarms, disable strict gating and continue using text-mode doctor checks until thresholds are recalibrated.
