# Incident Runbook — Steering RL Production SLOs

This runbook covers on-call triage, response procedures, and rollback drills for all steering-rl production SLO alerts.

## Responder Directory

| Role | Slack Channel | PagerDuty Schedule |
|------|--------------|-------------------|
| steering-oncall | #steering-alerts | steering-primary |
| ml-platform-lead | #ml-platform | ml-platform-escalation |
| ml-safety-lead | #ml-safety | ml-safety-critical |
| infra-oncall | #infra-alerts | infra-primary |
| finance-alerts | #finance-ops | — (Slack only) |

## Escalation Policy

1. **Warning alerts**: steering-oncall acknowledges within 10 minutes. Investigate and resolve or escalate.
2. **Critical alerts**: steering-oncall + ml-platform-lead paged simultaneously. Acknowledge within 5 minutes.
3. **Safety-critical**: Immediate page to ml-safety-lead with no wait period. Zero-tolerance — rollback first, investigate second.

---

## General Triage Steps

For any alert:

1. **Acknowledge** the alert in PagerDuty / Slack within the SLA window.
2. **Open the SLO dashboard** (`dashboards/production/slo-dashboard.json`) and identify which metric(s) are breached.
3. **Check recent deployments**: Review canary-router state and recent profile/model promotions.
4. **Correlate with other alerts**: A latency spike may cause error rate increases. A model change may affect correctness and coherence simultaneously.
5. **Check auto-rollback status**: Canary-router should have triggered auto-rollback for metrics exceeding `DEFAULT_ROLLBACK_CONFIG` thresholds. Verify rollback executed.
6. **If auto-rollback did not fire**: Execute manual rollback (see [Manual Rollback Procedure](#manual-rollback-procedure)).

---

## Alert-Specific Procedures

### Degeneration Rate Breach

**Alert names**: `DegenerationRateWarning`, `DegenerationRateCritical`
**Thresholds**: Warning > 2%, Critical > 3% (30-minute rolling window)
**Rollback threshold**: 3% — matches `canary-router DEFAULT_ROLLBACK_CONFIG.thresholds[0]`

**Triage**:
1. Check `steering_degenerate_total` broken down by `profile_id` and `base_model` to isolate the affected cohort.
2. Review the most recent profile promotion or vector bundle update.
3. Check if the degeneration is concentrated on specific concept domains.

**Resolution**:
- If isolated to a new candidate: verify auto-rollback executed, confirm champion is serving.
- If affecting champion: escalate to ml-platform-lead; consider reverting the latest profile update.
- If caused by upstream model issue: coordinate with model provider.

---

### Correctness Score Drop

**Alert names**: `CorrectnessScoreWarning`, `CorrectnessScoreCritical`
**Thresholds**: Warning < champion − 0.008, Critical < champion − 0.01 (30-minute rolling window)
**Rollback threshold**: champion − 0.01 — matches `eval-orchestrator DEFAULT_HARD_GATE_THRESHOLDS.min_correctness_delta`

**Triage**:
1. Compare current candidate correctness against champion baseline on the SLO dashboard.
2. Check if the eval-orchestrator recently promoted a new candidate.
3. Review eval suite results for the promoted candidate.

**Resolution**:
- Roll back the candidate to the previous champion.
- Re-run eval suite to confirm the regression before re-attempting promotion.

---

### Coherence Score Drop

**Alert names**: `CoherenceScoreWarning`, `CoherenceScoreCritical`
**Thresholds**: Warning < champion − 0.015, Critical < champion − 0.02 (30-minute rolling window)
**Rollback threshold**: champion − 0.02 — matches `eval-orchestrator DEFAULT_HARD_GATE_THRESHOLDS.min_coherence_delta`

**Triage**:
1. Check coherence breakdown by concept and profile.
2. Correlate with any recent vector bundle or steering multiplier changes.
3. Check if the drop is across all concepts or localized.

**Resolution**:
- If localized: disable the affected profile/concept steering vector.
- If broad: rollback the candidate and investigate the steering vector bundle.

---

### P95 Latency Breach

**Alert names**: `P95LatencyWarning`, `P95LatencyCritical`
**Thresholds**: Warning > 4000ms, Critical > 5000ms (30-minute rolling window)
**Rollback threshold**: 5000ms — matches `canary-router DEFAULT_ROLLBACK_CONFIG.thresholds[2]`

**Triage**:
1. Check if latency increase correlates with traffic spike (check request rate).
2. Review infrastructure metrics: GPU utilization, memory pressure, queue depth.
3. Check if a new model revision or profile with more layers is causing increased computation.

**Resolution**:
- If traffic-related: scale infrastructure; this is not a model issue.
- If model-related: rollback to previous candidate/profile with lower layer count.
- If infrastructure-related: page infra-oncall for scaling or incident response.

---

### Error Rate Spike

**Alert names**: `ErrorRateWarning`, `ErrorRateCritical`
**Thresholds**: Warning > 3%, Critical > 5% (30-minute rolling window)
**Rollback threshold**: 5% — matches `canary-router DEFAULT_ROLLBACK_CONFIG.thresholds[1]`

**Triage**:
1. Check error types: are these inference timeouts, input validation failures, or model errors?
2. Correlate with latency — a latency spike can cause timeout-driven errors.
3. Check if errors are concentrated on a specific model/profile combination.

**Resolution**:
- If timeout-driven: address the latency root cause first.
- If validation-driven: check recent API contract changes or client updates.
- If model-driven: rollback the candidate.

---

### Cost Anomaly

**Alert names**: `TokenCostWarning`, `TokenCostCritical`
**Thresholds**: Warning > $50/hr, Critical > $100/hr

**Triage**:
1. Check token usage rate breakdown by model and profile.
2. Look for sudden spikes in `input_tokens` or `output_tokens` rate.
3. Check if a misconfigured profile is causing excessive token generation (e.g., high multiplier).

**Resolution**:
- If traffic-driven: verify the traffic is legitimate; adjust rate limits if needed.
- If profile-driven: rollback the offending profile configuration.
- If loop-driven: investigate for retry loops or recursive inference calls.

---

### Safety Critical Violation

**Alert names**: `SafetyCriticalViolation`
**Thresholds**: Any violation > 0 (zero tolerance, no wait period)
**Rollback threshold**: 0 — matches `eval-orchestrator DEFAULT_HARD_GATE_THRESHOLDS.max_safety_critical_violations`

**Triage**:
1. **Rollback immediately** — do not wait for investigation.
2. Identify the violating request(s) via `steering_safety_critical_violations_total` labels.
3. Check what candidate/profile was serving when the violation occurred.

**Resolution**:
- Mandatory rollback to champion.
- Safety review required before any re-promotion.
- Escalate to ml-safety-lead regardless of auto-rollback status.
- Document the violation in the safety incident log.

---

### Language Stability Drop

**Alert names**: `LanguageStabilityWarning`, `LanguageStabilityCritical`
**Thresholds**: Warning < 99.5%, Critical < 99% (30-minute rolling window)
**Rollback threshold**: 99% — matches `eval-orchestrator DEFAULT_HARD_GATE_THRESHOLDS.min_language_stability`

**Triage**:
1. Check `steering_language_shift_total` by concept and input language.
2. Determine if the shift is from a specific source language or concept domain.
3. Review recent vector bundle changes that may have introduced cross-lingual interference.

**Resolution**:
- Rollback the candidate if language shifts are broad.
- If isolated to a concept, disable that concept's steering vector.

---

## Manual Rollback Procedure

When auto-rollback has not fired or needs to be manually triggered:

1. **Verify current canary state**:
   ```bash
   curl -s http://canary-router:8080/api/v1/status | jq .
   ```

2. **Trigger manual rollback**:
   ```bash
   curl -X POST http://canary-router:8080/api/v1/rollback \
     -H "Content-Type: application/json" \
     -d '{"reason": "manual-slo-breach", "operator": "<your-name>"}'
   ```

3. **Verify rollback completed**:
   ```bash
   curl -s http://canary-router:8080/api/v1/status | jq '.active_candidate'
   # Should show "champion" only
   ```

4. **Confirm metrics recovering** on the SLO dashboard within 5–10 minutes.

5. **Post in #steering-alerts** with rollback confirmation and reason.

---

## Rollback Drill Checklist

This drill should be executed **monthly** to validate the rollback path. Schedule it during a maintenance window.

### Pre-Drill

- [ ] Notify #steering-alerts that a rollback drill is starting.
- [ ] Confirm the SLO dashboard is accessible and showing current data.
- [ ] Confirm canary-router health endpoint returns 200.
- [ ] Verify PagerDuty routing rules are correctly configured for all responder roles.
- [ ] Record current champion candidate and metrics baseline.

### Drill Execution

- [ ] **Step 1**: Simulate a metric breach by deploying a known-bad test candidate to a canary slice (0% traffic, synthetic probes only).
- [ ] **Step 2**: Verify the alert fires within the expected `for` duration (5 min for most alerts).
- [ ] **Step 3**: Confirm the alert routes to the correct Slack channel and PagerDuty schedule.
- [ ] **Step 4**: Acknowledge the alert within the SLA window (10 min warning, 5 min critical).
- [ ] **Step 5**: Execute the [Manual Rollback Procedure](#manual-rollback-procedure) against the test candidate.
- [ ] **Step 6**: Verify the rollback completes and the test candidate is no longer serving.
- [ ] **Step 7**: Verify the SLO dashboard reflects the rollback (metrics return to baseline).
- [ ] **Step 8**: Verify the alert resolves automatically after the metric recovers.

### Post-Drill

- [ ] Document drill results: time-to-alert, time-to-acknowledge, time-to-rollback.
- [ ] Record any issues encountered (alert didn't fire, routing misconfigured, dashboard stale, etc.).
- [ ] File follow-up tickets for any issues found.
- [ ] Post drill summary in #steering-alerts.
- [ ] Update this runbook if any steps were incorrect or unclear.

### Drill Success Criteria

| Metric | Target |
|--------|--------|
| Time from breach to alert firing | ≤ `for` duration + 2 min |
| Time from alert to acknowledgment | ≤ SLA window |
| Time from acknowledgment to rollback complete | ≤ 5 min |
| Alert auto-resolves after recovery | Yes |
| No false positives from drill traffic | Yes |

---

## Observe-Only Mode

If alert tuning is producing excessive false positives:

1. Set all alert rules to `for: 30m` (increased from default) to reduce noise.
2. Change critical alerts to warning severity temporarily.
3. Keep dashboards active for passive monitoring.
4. Tune thresholds based on observed P50/P95 distributions over 48 hours.
5. Revert to standard thresholds once calibrated.

> **Rollback note**: If alert tuning is noisy, revert to conservative thresholds and keep dashboards in observe-only mode until calibrated.
