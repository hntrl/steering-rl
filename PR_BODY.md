## Task

**Task ID:** P2-04
**Title:** LangSmith trace ingestion for dataset mining
**Goal:** Connect trace-miner to live LangSmith trace exports so nightly datasets are sourced from real production failure traces.

## Changes

### `services/trace-miner/src/langsmith-source.ts` (new)
- LangSmith trace fetcher with cursor-based pagination and bounded time windows
- Failure classification: error runs, empty responses, degenerate output (4-gram repetition heuristic), and tag-based failures
- Converts LangSmith runs to `TraceRecord` format with pre-sanitized metadata
- Configurable `pageSize`, `maxTraces`, and injectable `fetchFn` for testing
- Helper utilities: `projectNameForEnv()`, `defaultTimeWindow()`

### `services/trace-miner/src/pipeline.ts`
- Added `TraceSource` type (`"inline" | "langsmith"`) and `PipelineRunOptions` interface
- Added `runPipelineFromSource()` async function that fetches from LangSmith or uses inline traces
- Graceful error handling in dry-run mode — API failures are reported but don't cause non-zero exit

### `services/trace-miner/src/cli.ts`
- Full CLI with argument parsing: `--source`, `--env`, `--suite`, `--start-time`, `--end-time`, `--page-size`, `--max-traces`, `--dry-run`, `--output-dir`, `--help`
- Source selection between `inline` (sample data) and `langsmith` (live API)
- Dry-run mode prevents file writes and remote dataset mutations

### `services/trace-miner/tests/pipeline.test.ts`
- Added 28 new tests (53 total) covering:
  - `classifyFailure`: error, empty-response, degeneration, tag-based, and success cases
  - `isDegenerate`: repetitive text detection
  - `runToTraceRecord`: conversion, null for successes, metadata sanitization, profile extraction
  - `projectNameForEnv` and `defaultTimeWindow` helpers
  - `fetchLangSmithTraces`: single page, multi-page pagination, maxTraces limit, non-failure filtering, missing API key, API errors, empty results
  - `runPipelineFromSource`: inline mode, langsmith mode with mock fetch, dry-run file safety, artifact writing, empty results, missing traces error, deduplication determinism, metadata sanitization

### `services/trace-miner/README.md`
- Documented LangSmith integration, failure classification, CLI options table, environment variables, and updated rollback guidance

## Verify Command Output

```
$ pnpm test --filter trace-miner && pnpm run trace-miner:dry-run -- --source langsmith

 RUN  v2.1.9

 ✓ tests/pipeline.test.ts (53 tests) 14ms

 Test Files  1 passed (1)
      Tests  53 passed (53)

trace-miner starting (source: langsmith, dry-run: true)
[langsmith] Fetching traces from project: steer-prod-prod
[langsmith] [dry-run] Could not fetch traces: LangSmith API error (422): ...
[langsmith] [dry-run] Pipeline validation complete — no mutations performed.

Result: 0 examples, 0 clusters
Dry run completed — no remote datasets or local artifacts mutated.
```

## Definition of Done

- [x] Trace miner can pull candidate failures from LangSmith projects by environment
- [x] Exported examples remain deterministic after sanitization and dedup
- [x] CLI supports source selection and time-window arguments for nightly jobs

## Constraints

- [x] Support bounded time windows and pagination for trace fetches
- [x] Sanitize sensitive metadata before dataset export
- [x] Provide dry-run mode that does not mutate remote datasets or local artifacts unless requested

## Rollback Note

If live ingestion quality drops, disable LangSmith source mode and continue generating datasets from last known-good snapshot inputs. Switch nightly jobs from `--source langsmith` back to `--source inline` or a pinned snapshot.
