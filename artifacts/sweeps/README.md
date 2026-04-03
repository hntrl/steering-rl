# Sweep Artifacts — Gemma 4 Stage A/B/C + Gemma 3 Parity

This directory contains output artifacts from the Gemma 4 steering sweep automation and Gemma 3 Ramp-parity sweeps.

## Artifacts

| File | Stage | Description |
|------|-------|-------------|
| `gemma4-stage-a-result.json` | A | Baseline (no-steering) quality metrics |
| `gemma4-stage-b-result.json` | B | Single-layer sweep with per-layer metrics and challenger candidates |
| `gemma4-stage-c-result.json` | C | Multi-layer calibration sweep with ranked candidates and preset tables |
| `gemma3-stage-b-parity.json` | B-parity | Gemma 3 27B-IT Ramp-parity single-layer sweep with sparse/dense controls |

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

## Stage C — Multi-Layer Calibration

Combines top Stage B single-layer winners into sparse multi-layer profiles and calibrates preset multipliers (low / medium / strong) for each candidate.

**Inputs:**
- Stage A baseline result (coherence, correctness, latency thresholds)
- Stage B challenger candidates (top-K unique layers by rank_score)

**Sweep axes:**
- Layer combinations: sizes 3, 4, 5 from top-6 Stage B layers
- Preset multipliers:
  - `low`: 0.08, 0.10, 0.12
  - `medium`: 0.18, 0.22, 0.26
  - `strong`: 0.30, 0.35, 0.40

**Per-combination metrics:**
- All Stage B metrics: `coherence`, `concept_adherence`, `correctness`, `degenerate_rate`, `language_stability`, `latency_p50_ms`, `latency_p95_ms`, `rank_score`

**Hard gates for candidate selection:**
- `degenerate_rate <= 3%`
- `coherence >= baseline - 0.02` (non-inferiority)
- `correctness >= baseline - 0.01` (non-inferiority)
- `language_stability >= 99%`
- `p95_latency_ms <= baseline_p95 * 1.20`

**Preset calibration:**
For each layer combination that passes hard gates at all three preset levels, the best multiplier per preset is selected by rank_score. Only combinations with valid presets across all three levels are promoted to candidates.

**Output:** Ranked multi-layer candidates, each with:
- Layer set (sorted ascending)
- Fallback layer (≈ two-thirds depth within the set)
- Calibrated preset table (`low`, `medium`, `strong`)
- Full profile bundle compatible with the profile schema and Stage D / canary routing

## Stage B-Parity — Gemma 3 Ramp-Parity Single-Layer Sweep

Reproduces Ramp-style single-layer findings on Gemma 3 27B-IT using deterministic layer and multiplier sweeps across layers 16-53. Includes sparse global and dense control configurations so degeneration cliffs are measurable.

**Model:** Gemma 3 27B-IT

**Sweep axes:**
- Layers: 16–53 (38 candidate layers, single-layer sweep)
- Multipliers: 0.05, 0.15, 0.25, 0.35, 0.55, 0.75

**Configurations tested:**
- `sparse-global-5` — Ramp default: layers 23, 29, 35, 41, 47
- `sparse-global-all` — All global attention layers in candidate range
- `dense-early-mid` — Dense block layers 16-27
- `dense-mid` — Dense block layers 28-39
- `dense-late` — Dense block layers 42-53
- `dense-mid-to-late-19` — Dense 19-layer block layers 28-46
- `all-candidate-layers` — All 38 candidate layers at once

**Per-layer metrics:**
- `coherence`, `concept_adherence`, `correctness`, `degenerate_rate`, `language_stability`, `latency_p50_ms`, `latency_p95_ms`, `rank_score`

**Hard gates for candidate selection:**
- `degenerate_rate <= 3%`
- `coherence >= baseline - 0.02` (non-inferiority)
- `correctness >= baseline - 0.01` (non-inferiority)
- `language_stability >= 99%`

**Ramp parity checks:**
- Layer 41 appears in top candidates (matches Ramp-reported best single-layer)
- Sparse global configs outperform dense configs (matches Ramp finding)
- Degeneration cliffs detected in dense configs at high multipliers

**Run-card metadata:** Every result includes `run_id`, `task_id`, `model`, `model_revision`, `dataset_version`, `seed`, `judge_bundle`, `git_sha`, `created_at` for full reproducibility.

**Output:** Ranked single-layer candidates with hard-gate pass/fail metrics, configuration comparison results, and Ramp parity summary.

## Gate Checker Compatibility

Both result files are JSON with a predictable schema:
- `stage` — `"A"`, `"B"`, or `"C"`
- `config` — full reproducible configuration (model, revision, dataset, seed)
- `metrics` (Stage A) / `per_layer_metrics` + `challenger_candidates` (Stage B) / `per_combination_metrics` + `candidates` (Stage C)
- `timestamp` — ISO 8601 execution time

These files are designed to be consumed by the promotion gate checker and experiment tracking systems.

## Reproducibility

All runs are seed-controlled. Re-running with the same `seed`, `model_revision`, and `dataset_version` produces identical metrics. The seed, model revision, and dataset version are recorded in every output artifact.
