## P0-10: Trace mining to dataset pipeline

Build a nightly job that turns production failure traces into curated eval dataset artifacts.

### What this does

- **`services/trace-miner/src/dedup.ts`** — Deterministic dedup via SHA-256 over `normalized(input + failureType)`. Clustering by failure type with deterministic labels (`cluster-{failureType}`). Metadata sanitization strips secrets before export.
- **`services/trace-miner/src/pipeline.ts`** — Full pipeline: sanitize → dedup → cluster → export dataset JSON + changelog Markdown. Dry-run mode computes everything without writing files or mutating remote datasets.
- **`services/trace-miner/src/cli.ts`** — CLI entry point with `--dry-run` flag.
- **`services/trace-miner/tests/pipeline.test.ts`** — 22 tests covering content hashing, cluster labels, dedup behavior, metadata sanitization, dataset naming, pipeline export, dry-run mode, and secret redaction.

### Dataset naming

Follows `steer-{suite}-{source}-v{YYYYMMDD}` convention per `feedback-loop.md`.

### Verify command output

```
$ pnpm test --filter trace-miner && pnpm run trace-miner:dry-run

 ✓ tests/pipeline.test.ts (22 tests) 8ms

 Test Files  1 passed (1)
      Tests  22 passed (22)

[dry-run] Pipeline would produce dataset: steer-core-prodtrace-v20260403
[dry-run] 3 examples in 3 clusters (from 4 traces)
[dry-run] No files written.
Result: 3 examples, 3 clusters
Dry run completed — no remote datasets mutated.
```

### Definition of done

- [x] Pipeline exports dataset artifact and summary changelog
- [x] Dry run mode works without mutating remote datasets
- [x] Dedup behavior covered by tests

### Rollback note

If pipeline quality is poor, pause dataset promotion and keep previous stable dataset versions pinned in eval runs.

Closes #10
