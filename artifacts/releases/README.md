# Release Artifacts — Nightly Promotion Pipeline

This directory contains release artifacts produced by the nightly promotion pipeline (`jobs/nightly/promote.ts`).

## Artifact Format

Each release artifact is a JSON file named `release-nightly-{YYYYMMDD}.json` containing:

| Field | Type | Description |
|-------|------|-------------|
| `releaseId` | `string` | Unique identifier: `release-nightly-{YYYYMMDD}` |
| `createdAt` | `string` | ISO 8601 timestamp |
| `dryRun` | `boolean` | Whether this was a dry-run execution |
| `pipeline` | `string` | Always `"nightly-promotion"` |
| `decisions` | `DecisionSummary[]` | Per-challenger promotion decisions |
| `promotedProfile` | `string \| null` | Profile ID of promoted challenger, or null |
| `canaryHandoff` | `CanaryHandoff \| null` | Canary router configuration for rollout |
| `evidenceLinks` | `Record<string, string>` | Paths to evidence artifacts (Stage A–D) |
| `rollbackInstructions` | `string` | Instructions for manual rollback |
| `pipelineSummary` | `object` | Counts: totalChallengers, promoted, held, failedGates |

## Decision Summary

Each entry in `decisions` includes:

- `experimentId` — Unique experiment identifier
- `date` — Experiment date (ISO 8601 date)
- `suite` — Eval suite (e.g., `core`)
- `decision` — `promote`, `hold`, or `rollback`
- `challengerProfileId` / `championProfileId` — Profile identifiers
- `rankScore` / `championRankScore` — Weighted composite scores
- `hardGatesPassed` — Whether all hard gates passed
- `rationale` — Human-readable explanation
- `evidenceBundleId` — Reference to evidence vector bundle

## Canary Handoff

When a challenger is promoted, `canaryHandoff` contains:

- `championProfileId` / `challengerProfileId` — Profile pair
- `phases` — Rollout phases (e.g., `[10, 50, 100]`)
- `initialPhaseIndex` — Starting phase (typically `0` for 10%)
- `killSwitch` — Whether to disable steering entirely
- `rollbackPayload` — Pre-built payload for canary-router rollback

## Rollback Payload

The `rollbackPayload` is designed for direct consumption by `canary-router`:

```json
{
  "action": "rollback",
  "championProfileId": "steer-gemma4-baseline-champion",
  "challengerProfileId": "steer-gemma4-ml-...",
  "reason": "Automatic rollback from nightly promotion pipeline failure.",
  "phases": [10, 50, 100],
  "resetPhaseIndex": 0,
  "killSwitch": false,
  "instructions": "If nightly promotion flow fails, pause automatic handoff and require manual promotion review with static canary champion routing."
}
```

## Evidence Links

Release artifacts reference upstream evidence:

- `stage-a` → `artifacts/sweeps/gemma4-stage-a-result.json` (baseline metrics)
- `stage-b` → `artifacts/sweeps/gemma4-stage-b-result.json` (single-layer sweep)
- `stage-c` → `artifacts/sweeps/gemma4-stage-c-result.json` (multi-layer calibration)
- `stage-d` → `artifacts/sweeps/gemma4-stage-d-decision.json` (promotion decisions)

## Dry-Run Mode

When run with `--dry-run`, the pipeline:

- Executes all stages (A through D) and builds the full release artifact
- Does **not** write any files to disk
- Sets `dryRun: true` in the artifact
- Is safe for CI pipelines and scheduled checks

## Reproducibility

All pipeline stages use deterministic seeds. Re-running the dry-run pipeline with the same configuration produces identical decisions.
