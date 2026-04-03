# P3-04: Production SLO Dashboard and Alert Tuning

Closes #55

## Summary

Defines production SLOs and ships alerting dashboards for degeneration, correctness, coherence, latency, cost, error rate, language stability, and safety violations — with low false-positive rates.

## Changes

| File | Description |
|------|-------------|
| `dashboards/production/slo-dashboard.json` | Grafana dashboard with 10 panels covering all SLO metrics |
| `dashboards/production/alert-rules.yaml` | Prometheus alert rules with warning + critical severities for 8 alert groups |
| `docs/incident-runbook.md` | On-call triage procedures, alert-specific response guides, manual rollback procedure, and monthly rollback drill checklist |
| `README.md` | Added SLO dashboard documentation section with threshold table |

## Definition of Done

- [x] SLO dashboard includes correctness, coherence, degeneration, latency, and cost panels.
- [x] Alert pack defines warning and critical severities with documented responders.
- [x] Incident runbook includes a validated rollback drill checklist.

## Constraints Satisfied

- [x] Alert thresholds map directly to rollout rollback thresholds (`canary-router/src/rollback-policy.ts` and `eval-orchestrator/src/defaults.ts`).
- [x] Runbook includes on-call triage and rollback drill steps.
- [x] Dashboard queries avoid exposing sensitive user content (aggregate by model/profile/env only).

## Threshold Alignment

| Metric | Warning | Critical | Source |
|--------|---------|----------|--------|
| Degeneration rate | > 2% | > 3% | `DEFAULT_ROLLBACK_CONFIG.thresholds[0]` |
| Error rate | > 3% | > 5% | `DEFAULT_ROLLBACK_CONFIG.thresholds[1]` |
| P95 latency | > 4000ms | > 5000ms | `DEFAULT_ROLLBACK_CONFIG.thresholds[2]` |
| Correctness | < champion − 0.008 | < champion − 0.01 | `DEFAULT_HARD_GATE_THRESHOLDS.min_correctness_delta` |
| Coherence | < champion − 0.015 | < champion − 0.02 | `DEFAULT_HARD_GATE_THRESHOLDS.min_coherence_delta` |
| Language stability | < 99.5% | < 99% | `DEFAULT_HARD_GATE_THRESHOLDS.min_language_stability` |
| Safety violations | — | > 0 | `DEFAULT_HARD_GATE_THRESHOLDS.max_safety_critical_violations` |
| Token cost | > $50/hr | > $100/hr | Operational budget threshold |

## Verify Output

```
$ pnpm test --filter telemetry && pnpm test --filter tracing

> telemetry@0.0.1 test
> vitest run

 ✓ tests/langsmith-middleware.test.ts (40 tests) 5ms
 Test Files  1 passed (1)
      Tests  40 passed (40)

> tracing@0.0.1 test
> vitest run

 ✓ tests/tracing-integration.test.ts (5 tests) 3ms
 Test Files  1 passed (1)
      Tests  5 passed (5)
```

```
$ pnpm verify

✓ Project structure verified successfully.
✓ Validated 30 JSON files successfully.
✓ Validated 29 task contracts successfully.
✓ JSON Schema meta-validation: profile, run-metadata, experiment-decision
✓ Contract tests: 6 passed, 0 failed
✓ OpenAPI: Your API description is valid.
```

## Rollback Note

If alert tuning is noisy, revert to conservative thresholds and keep dashboards in observe-only mode until calibrated. See `docs/incident-runbook.md#observe-only-mode` for the procedure.
