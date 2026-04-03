# Trace Miner

Nightly pipeline that turns production failure traces into curated eval dataset artifacts.

## Overview

The trace miner processes failed or weak inference traces from production, deduplicates them using deterministic content hashing, clusters them by failure type, and exports versioned eval datasets following the `steer-{suite}-{source}-v{YYYYMMDD}` naming convention.

## Architecture

```
Production traces (LangSmith)
  │
  ▼
┌──────────────┐
│  Sanitize     │  Strip secrets from metadata
└──────┬───────┘
       ▼
┌──────────────┐
│  Dedup        │  SHA-256 over normalized(input + failureType)
└──────┬───────┘
       ▼
┌──────────────┐
│  Cluster      │  Deterministic labels from failureType
└──────┬───────┘
       ▼
┌──────────────┐
│  Export       │  Dataset JSON + changelog Markdown
└──────────────┘
```

## Dedup Strategy

- **Hash function**: SHA-256 over `normalize(input) + normalize(failureType)`
- **Normalization**: trim whitespace, lowercase
- **Grouping**: Traces with identical hashes collapse into one eval example
- **Ordering**: First trace seen is the canonical representative
- **Source tracking**: All contributing trace IDs are preserved

## Clustering

Deterministic label derivation from failure type:
- `degeneration` → `cluster-degeneration`
- `language-shift` → `cluster-language-shift`
- `empty response` → `cluster-empty-response`

## Dataset Naming

All datasets follow the pattern:

```
steer-{suite}-{source}-v{YYYYMMDD}
```

Examples:
- `steer-core-prodtrace-v20260402`
- `steer-degeneracy-golden-v20260402`

## Security

- All metadata is sanitized before export
- Fields matching secret patterns (`apiKey`, `token`, `password`, `secret`, `credential`, `auth`, `privateKey`) are redacted to `[REDACTED]`
- Nested objects are recursively sanitized

## Usage

### Dry Run (no mutations)

```bash
pnpm run trace-miner:dry-run
```

Computes the full pipeline but writes no files and mutates no remote datasets.

### Normal Run

```bash
node --import tsx services/trace-miner/src/cli.ts
```

Writes dataset artifact (JSON) and changelog (Markdown) to the output directory.

### Testing

```bash
pnpm test --filter trace-miner
```

## Rollback

If pipeline quality is poor, pause dataset promotion and keep previous stable dataset versions pinned in eval runs.
