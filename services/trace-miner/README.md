# Trace Miner

Nightly pipeline that turns production failure traces into curated eval dataset artifacts.

## Overview

The trace miner processes failed or weak inference traces from production, deduplicates them using deterministic content hashing, clusters them by failure type, and exports versioned eval datasets following the `steer-{suite}-{source}-v{YYYYMMDD}` naming convention.

Supports two trace sources:
- **inline**: Built-in sample traces for local development and testing.
- **langsmith**: Live LangSmith trace exports from production projects, with bounded time windows, pagination, and automatic failure classification.

## Architecture

```
Trace Source
  ├── inline (sample data)
  └── langsmith (live API)
         │
         ▼
  ┌──────────────────┐
  │  Fetch + Paginate │  Bounded time windows, cursor pagination
  └──────┬───────────┘
         ▼
  ┌──────────────────┐
  │  Classify         │  Failure type detection (error, degeneration, empty-response, etc.)
  └──────┬───────────┘
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

## LangSmith Integration

The `langsmith` source connects to the LangSmith API to fetch production traces:

- **Project naming**: `steer-prod-{env}` (e.g., `steer-prod-prod`, `steer-prod-staging`)
- **Time windows**: Configurable `--start-time` and `--end-time` (defaults to last 24 hours)
- **Pagination**: Cursor-based pagination with configurable `--page-size` and `--max-traces`
- **Failure classification**: Automatic detection of errors, empty responses, degenerate output, and tagged failures
- **Environment filtering**: Use `--env` to target specific environments

### Failure Classification

Runs are classified into failure types:
- `error` — Runs with an error field or error status
- `empty-response` — Runs with empty or whitespace-only output
- `degeneration` — Runs with repetitive/degenerate output (4-gram repetition heuristic)
- Tag-based — Runs tagged with `failure`, `weak`, or `bad` labels

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
- `steer-core-langsmith-v20260402`
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

### Dry Run with LangSmith Source

```bash
pnpm run trace-miner:dry-run -- --source langsmith
```

Fetches traces from LangSmith but does not write files or mutate remote datasets.

### Normal Run with Inline Data

```bash
node --import tsx services/trace-miner/src/cli.ts
```

### Normal Run with LangSmith Source

```bash
node --import tsx services/trace-miner/src/cli.ts --source langsmith --env prod
```

### Custom Time Window

```bash
node --import tsx services/trace-miner/src/cli.ts --source langsmith --env prod \
  --start-time 2026-04-01T00:00:00Z --end-time 2026-04-02T00:00:00Z
```

### CLI Options

| Option | Description | Default |
|---|---|---|
| `--dry-run` | No file writes or remote mutations | `false` |
| `--source <type>` | Trace source: `inline` or `langsmith` | `inline` |
| `--env <name>` | Environment filter | `prod` |
| `--suite <name>` | Dataset suite name | `core` |
| `--output-dir <path>` | Output directory | `./output` |
| `--start-time <iso>` | Time window start (ISO 8601) | 24h ago |
| `--end-time <iso>` | Time window end (ISO 8601) | now |
| `--page-size <n>` | Traces per API page | `100` |
| `--max-traces <n>` | Max total traces | `1000` |

### Environment Variables

| Variable | Description |
|---|---|
| `LANGSMITH_API_KEY` | API key for LangSmith (required for `--source langsmith`) |
| `LANGSMITH_API_URL` | LangSmith API base URL (optional) |

### Testing

```bash
pnpm test --filter trace-miner
```

## Rollback

If live ingestion quality drops, disable LangSmith source mode and continue generating datasets from last known-good snapshot inputs. Switch nightly jobs from `--source langsmith` back to `--source inline` or a pinned snapshot.
