## Task

**Task ID:** P2-06
**Title:** Nightly promotion pipeline and canary handoff
**Goal:** Automate end-to-end nightly promotion flow from trace ingestion through Stage D decision output and canary configuration handoff.

## Changes

### New files

- **`jobs/nightly/promote.ts`** — End-to-end nightly promotion pipeline. Orchestrates dataset mining (Stage A → B → C), experiment scoring (Stage D champion-challenger bake-off), canary handoff with rollback payload, and release artifact generation. Supports `--dry-run` mode with no production mutations. Fails when required evidence artifacts are missing or stale.
- **`jobs/nightly/tests/promote.test.ts`** — 16 tests covering config construction, evidence validation, dataset mining, experiment scoring, canary handoff (including rollback payload), release artifact completeness, full dry-run pipeline execution, and reproducibility.
- **`artifacts/releases/README.md`** — Documents the release artifact format including decision summary, canary handoff, rollback payload, and evidence links.

### Modified files

- **`package.json`** — Added `promote:nightly` script.
- **`README.md`** — Added nightly promotion pipeline section with run instructions, dry-run mode, pipeline stages, and rollback note.

## Verify Command Output

```
$ pnpm run promote:nightly -- --dry-run

[dry-run] === Nightly Promotion Pipeline ===

[dry-run] Validating evidence artifacts...
[nightly] Step 1: Dataset mining — running Stage A baseline...
[nightly]   Stage A: coherence=0.9115, correctness=0.8855
[nightly] Step 2: Single-layer sweep — running Stage B...
[nightly]   Stage B: 6 candidates
[nightly] Step 3: Multi-layer calibration — running Stage C...
[nightly]   Stage C: 1 multi-layer candidates
[nightly] Step 4: Champion-challenger bake-off — running Stage D...
[nightly]   Stage D: 0 promoted, 1 held, 0 failed gates
[dry-run] Skipping Stage D artifact write.
[dry-run] Step 5: Building canary handoff...
[nightly] No challenger promoted — skipping canary handoff.
[dry-run] Step 6: Building release artifact...
[dry-run] Skipping release artifact write.

[dry-run] === Pipeline Summary ===
[dry-run]   Release: release-nightly-20260403
[dry-run]   Total challengers: 1
[dry-run]   Promoted: 0
[dry-run]   Held: 1
[dry-run]   Failed gates: 0
[dry-run]   Promoted profile: none
[dry-run]   Dry run: true
[dry-run] Pipeline validation complete — no production mutations performed.

[dry-run] === Nightly Promotion Pipeline Complete ===

$ node jobs/nightly/tests/promote.test.ts

16 tests: 16 passed, 0 failed

$ pnpm verify

Structure: verified
JSON: 24 files validated
Tasks: 23 contracts validated
Contracts: lint passed, 6 schema tests passed
```

## Definition of Done

- [x] Nightly job orchestrates dataset mining, experiment scoring, and promotion handoff in one workflow
- [x] Release artifact includes decision summary, evidence links, and rollback instructions
- [x] Dry-run execution is reproducible and safe for CI or scheduled checks

## Constraints

- [x] Pipeline supports dry-run mode with no production mutations
- [x] Promotion handoff includes rollback payload for canary-router
- [x] Pipeline fails when required evidence artifacts are missing or stale

## Rollback Note

If nightly promotion flow fails, pause automatic handoff and require manual promotion review with static canary champion routing.
