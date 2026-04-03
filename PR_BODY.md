## Task

**Task ID:** P2-01
**Title:** Provider-backed steering inference adapter
**Goal:** Replace the stub chat completion path with a real provider adapter that executes steering requests against a live model runtime.

## Changes

### `services/steering-inference-api/src/providers/model-adapter.ts` (new)
- `ModelAdapter` interface with `chatCompletion(request)` method
- `HttpModelAdapter` implementation using `fetch` against an OpenAI-compatible endpoint
- `ProviderError` class with `statusCode`, `retryable`, and `providerCode` fields
- Upstream status mapping: 429→529, 5xx→502, connection failure→502
- Bearer token read from `INFERENCE_API_KEY` env var; never logged

### `services/steering-inference-api/src/routes/chat-completions.ts`
- Route now accepts a `ModelAdapter` via `ChatCompletionsRouterOptions`
- When adapter is present, delegates to provider instead of returning stub text
- Provider responses are forwarded with the original OpenAI-compatible shape
- `ProviderError` instances map to structured 5xx responses with `retryable` flag
- Unknown errors map to 500 with `internal_error` code
- Steering metadata attached to both success and error paths when profile resolves
- Stub fallback preserved for backward compatibility (no adapter injected)

### `services/steering-inference-api/src/app.ts`
- `createApp` accepts optional `AppOptions` with `adapter` field
- Backward compatible — passing a `ProfileRegistry` directly still works

### `services/steering-inference-api/tests/chat-completions.test.ts`
- 14 new tests covering provider adapter integration and error handling
- Mock adapter using `vi.fn()` for deterministic tests
- Tests verify: provider response forwarding, steering param forwarding, metadata attachment on success/error, structured 5xx mapping, rate limit handling, connection errors, unknown errors, and that validation/profile errors short-circuit before reaching the adapter

### `services/steering-inference-api/package.json`
- Renamed package from `steering-guardrails` to `steering-inference-api` to match the verify filter

### `README.md`
- Added Steering Inference API section documenting the provider adapter, environment variables, and error mapping table

## Verify Command Output

```
$ pnpm test --filter steering-inference-api

> steering-inference-api@0.0.1 test
> vitest run

 RUN  v3.2.4

 ✓ tests/guardrails.test.ts (19 tests) 5ms
 ✓ tests/chat-completions.test.ts (47 tests) 51ms

 Test Files  2 passed (2)
      Tests  66 passed (66)
   Start at  01:16:38
   Duration  520ms
```

## Definition of Done

- [x] Chat completions route calls a provider adapter instead of returning stub text
- [x] Steering metadata is attached to successful responses and error paths remain deterministic
- [x] Provider failures map to structured 5xx responses with retry-safe error codes

## Constraints

- [x] Preserve OpenAI-compatible request and response shape
- [x] Do not log raw prompts or secret tokens in runtime logs
- [x] Keep deterministic unit tests by mocking provider calls

## Rollback Note

If live adapter behavior is unstable, switch routing back to the deterministic stub path behind a feature flag while keeping metadata validation enabled. The stub fallback is preserved — passing no adapter to `createApp()` or `createChatCompletionsRouter()` returns the original stub behavior.
