# Sweep Artifacts — Gemma 4 Stage A/B

This directory contains output artifacts from the Gemma 4 steering sweep automation.

## Artifacts

| File | Stage | Description |
|------|-------|-------------|
| `gemma4-stage-a-result.json` | A | Baseline (no-steering) quality metrics |
| `gemma4-stage-b-result.json` | B | Single-layer sweep with per-layer metrics and challenger candidates |

## Stage A — Baseline

Runs Gemma 4 without activation steering to establish reference quality metrics.

**Recorded metadata:**
- `model` / `model_revision` — exact model identity
- `dataset_version` — eval dataset used
- `seed` — deterministic PRNG seed for reproducibility
- `judge_bundle` — scoring judge version

**Metrics emitted:**
- `coherence` — LLM judge coherence score
- `correctness` — task correctness rate
- `degenerate_rate` — fraction of degenerate outputs
- `language_stability` — fraction without language drift
- `latency_p50_ms` / `latency_p95_ms` — latency percentiles

**Hard gates (must pass to proceed):**
- `degenerate_rate <= 3%`
- `language_stability >= 99%`
- `coherence >= 0.80`

## Stage B — Single-Layer Sweep

Sweeps each candidate layer (16–53) at multiple multiplier values, measuring steering effectiveness per layer.

**Sweep axes:**
- Layers: 16–53 (38 candidate layers)
- Multipliers: 0.05, 0.10, 0.15, 0.22, 0.30, 0.40

**Per-layer metrics:**
- All Stage A metrics plus `concept_adherence` and `rank_score`

**Hard gates for candidate selection:**
- `degenerate_rate <= 3%`
- `coherence >= baseline - 0.02` (non-inferiority)
- `correctness >= baseline - 0.01` (non-inferiority)
- `language_stability >= 99%`

**Rank score formula** (from feedback-loop.md):
```
rank_score = 0.35 * correctness
           + 0.20 * coherence
           + 0.20 * concept_adherence
           + 0.10 * solve_rate_norm
           + 0.10 * (1 - degenerate_rate)
           + 0.05 * latency_norm
```

**Output:** Top 10 challenger candidates ranked by `rank_score`, each with a `profile_id` suitable for Stage C multi-layer optimization.

## Gate Checker Compatibility

Both result files are JSON with a predictable schema:
- `stage` — `"A"` or `"B"`
- `config` — full reproducible configuration (model, revision, dataset, seed)
- `metrics` (Stage A) / `per_layer_metrics` + `challenger_candidates` (Stage B)
- `timestamp` — ISO 8601 execution time

These files are designed to be consumed by the promotion gate checker and experiment tracking systems.

## Reproducibility

All runs are seed-controlled. Re-running with the same `seed`, `model_revision`, and `dataset_version` produces identical metrics. The seed, model revision, and dataset version are recorded in every output artifact.
