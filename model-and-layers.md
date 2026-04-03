# Model and Layer Strategy for Activation Steering

This document explains how we select the base model and steering layers, how we validate those choices, and how we run the setup in production.

The goal is practical: maximize concept steering signal while preserving coherence, instruction following, and language stability.

## 1) What we are optimizing for

Activation steering is a constrained optimization problem.

We want all of the following at once:

- Strong concept pressure (the concept is clearly present in responses)
- Low degeneration (few repetitive, incoherent, or collapsed outputs)
- Good linguistic quality (syntax, grammar, and readability stay intact)
- Stable behavior across concepts (abstract and concrete concepts both work)
- Operational viability (latency and cost are acceptable)

This means model and layer choices are first-class design decisions, not implementation details.

## 2) Model selection approach

We choose a model by evaluating behavior under stress, not just benchmark quality.

### 2.1 Initial model: Qwen 2.5 7B Instruct

Qwen 2.5 7B was a good first candidate because it is cheap to iterate on and easy to run. In practice, three failure modes limited headroom:

- Pretraining reversion under aggressive steering
- Fast coherence collapse at moderate magnitudes
- Poor transfer of one-size-fits-all multiplier presets across concepts

The practical result was a narrow safe zone for useful steering.

### 2.2 Production model: Gemma 3 27B-IT

We moved to Gemma 3 27B-IT for better steering headroom and stability:

- More representational capacity than 7B-class models
- Better degradation profile (stays legible and on-topic longer)
- No observed language reversion behavior like Qwen under heavy steering
- Architecture with alternating local/global attention, useful for layer targeting

Important tradeoff: Gemma is more steering-sensitive. Magnitudes and layer sets that were acceptable on Qwen can be too aggressive on Gemma.

## 3) Layer anatomy and why it matters

Steering effectiveness depends on where in the network we inject the vector.

Observed pattern across experiments:

- Early layers: syntax/lexical processing dominates. Steering here often damages grammar.
- Mid layers: abstract semantics and reasoning features are accessible. Best steering leverage.
- Late layers: decoding and output formatting are dominant. Steering here can trigger collapse.

For Gemma 3 27B-IT, we scoped the candidate steering window to layers 16-53.

- Below 16: language mechanics are too fragile to perturb heavily.
- Above 53: token-generation behavior is too sensitive.

This gives a 38-layer candidate set where concept steering is most likely to work.

## 4) Global vs local layers in Gemma

Gemma alternates attention style: five local sliding-window layers, then one global attention layer.

Why this matters for steering:

- Local layers are strong for short-range structure.
- Global layers can integrate concept signal across full context.

In sweep results, sparse global-layer steering consistently outperformed nearby local-layer alternatives on the coherence vs strength tradeoff.

## 5) How we select layers

We do not assume the best layers a priori. We run structured sweeps and choose from observed performance.

### 5.1 Candidate layer set

Primary candidate range: `16-53`

From that range, evaluate layer configurations across three families:

1. Sparse global-only configurations
2. Dense contiguous blocks (early-mid, mid, mid-late, late)
3. Broad coverage baselines (for example, all candidate layers)

### 5.2 Default winning configuration

For the tested concepts/prompts, the best default was:

- Sparse global layers: `23, 29, 35, 41, 47`

Best single-layer fallback:

- Layer `41` (about two-thirds depth)

Interpretation:

- Late enough to touch abstract semantics
- Early enough to avoid immediate decode-stage collapse

## 6) How we choose magnitudes

Magnitude is concept-dependent. Reusing one multiplier table for all concepts is unreliable.

Reason: concept vectors have different natural norms and geometry. The same scalar multiplier can produce very different effective perturbation strengths.

### 6.1 Effective strength framing

We treat effective steering strength as:

`effective_strength ~= alpha * ||v||`

Where:

- `alpha` is the runtime multiplier
- `v` is the concept vector for the target layer

Operationally we normalize vectors during training and calibrate `alpha` per concept family.

### 6.2 Presets

Expose presets for product UX, but back them with per-concept calibration tables:

- `low`: subtle thematic influence
- `medium`: clear concept signal with minimal quality loss (default)
- `strong`: near coherence boundary, used carefully

## 7) Sweep methodology

A standard sweep varies four axes:

- Layer config (for example, 8 configurations)
- Multiplier values (for example, 0.05 to 0.75)
- Concept set (abstract and concrete mix)
- Prompt set (coverage across styles/tasks)

Each generation is scored by a judge stack:

- Coherence
- Concept adherence (or keyword density proxy)
- Composite quality
- Degenerate/non-degenerate flag

### 7.1 Selection criteria

We choose defaults via Pareto-style filtering:

- Maximize concept adherence
- Subject to coherence floor and degeneration ceiling

Example policy:

- `coherence >= 0.80`
- `degenerate_rate <= 5%`
- pick highest concept adherence among survivors

### 7.2 Failure cliffs

Some configurations degrade gradually; others collapse abruptly over a narrow multiplier interval. We explicitly model this by storing a safe operating band per configuration.

## 8) Runtime injection design

### 8.1 Injection point

Apply steering in the residual stream at selected transformer layers during forward pass.

Conceptually:

```python
for layer_idx, block in enumerate(model.layers):
    h = block(h, ...)
    if layer_idx in target_layers:
        h = h + alpha[layer_idx] * v[layer_idx]
```

### 8.2 Multi-layer weighting

Start with uniform multipliers per chosen layer. Add per-layer scaling only if sweeps show stable gains.

### 8.3 Token-time behavior

Apply steering at each generated token step to maintain consistent concept pressure through long outputs.

## 9) Degeneration safeguards

Even with good defaults, steering can exceed safe limits for some prompts.

Use a backoff ladder at runtime:

1. Reduce multiplier (for example, `strong -> medium`)
2. Reduce active layer count (for example, 5 layers -> layer 41 only)
3. Disable steering for that turn and return safe output

Degeneration heuristics can include:

- Repetition loops
- Entropy collapse signals
- Rapid coherence score drop
- Unexpected language shift

## 10) Operating defaults we recommend

Model:

- `gemma-3-27b-it`

Layer policy:

- Default: `23, 29, 35, 41, 47`
- Fallback: `41`
- Avoid steering outside `16-53` unless running a dedicated experiment

Magnitude policy:

- Start at `medium`
- Use concept-specific calibration
- Gate `strong` behind degeneration monitoring

## 11) How to port this to a new model family

When adopting a new base model, reuse the process, not the exact layer numbers.

Runbook:

1. Map architecture (layer count, attention pattern, known fragility zones)
2. Define an initial candidate range (exclude very early and very late layers)
3. Build sparse and dense layer configurations
4. Run multiplier x layer x concept x prompt sweeps
5. Select defaults using coherence/degeneration constraints
6. Publish per-concept preset calibration tables

Treat all layer assignments as empirical and model-specific until validated.

## 12) Record-keeping and reproducibility

For each model release, store a model-layer profile artifact:

- Base model ID and revision
- Candidate layer range
- Winning default layers
- Single-layer fallback
- Preset calibration table by concept class
- Sweep metadata (concepts, prompts, judge version, date)

Suggested JSON shape:

```json
{
  "model": "gemma-3-27b-it",
  "layer_range": [16, 53],
  "default_layers": [23, 29, 35, 41, 47],
  "fallback_layer": 41,
  "presets": {
    "low": 0.12,
    "medium": 0.22,
    "strong": 0.34
  },
  "notes": "Values shown as example placeholders; calibrate per concept family."
}
```

## 13) Gemma 3 Ramp-parity methodology decision

As of the P3-03 parity assessment, Gemma 3 27B-IT has been validated against Ramp-style steering findings.

### 13.1 Acceptance gate results

| Gate | Threshold | Observed | Status |
|------|-----------|----------|--------|
| Coherence | ≥ 0.80 | 0.934 (multi-layer at medium) | PASS |
| Degeneration | ≤ 0.03 | 0.0 (multi-layer at medium) | PASS |
| Adherence | ≥ 0.60 | 0.722 (multi-layer at medium) | PASS |

### 13.2 Ramp parity status

All five qualitative findings from Ramp match our observations:
- Layer 41 is the best single-layer target.
- Sparse global configurations outperform dense configurations.
- Degeneration cliffs are steep and detectable in dense configs.
- Default layer set overlaps Ramp default [23, 29, 35, 41, 47].
- No language reversion under heavy steering.

Minor divergences exist in absolute degeneration magnitudes, but directional consistency is maintained. See `artifacts/sweeps/gemma3-ramp-parity-report.md` for details.

### 13.3 Gemma 4 transfer readiness

Gemma 3 parity is sufficient to start Gemma 4 transfer experiments, subject to:
1. Gemma 3 acceptance gates remaining passing after expanded concept and prompt coverage.
2. Gemma 4 transfer protocol using Gemma 3 parity results as baseline comparison.
3. Gemma 4 experiments not replacing Gemma 3 defaults until Gemma 4 passes its own acceptance gates.

If parity evidence becomes inconclusive after expanded coverage, hold methodology status at "not ready" and rerun sweeps.

### 13.4 Artifact trail

- Stage B sweep: `artifacts/sweeps/gemma3-stage-b-parity.json`
- Stage C sweep: `artifacts/sweeps/gemma3-stage-c-parity.json`
- Preset calibration: `artifacts/sweeps/gemma3-preset-calibration.json`
- Acceptance gates: `artifacts/sweeps/gemma3-acceptance-gates.json`
- Parity report: `artifacts/sweeps/gemma3-ramp-parity-report.md`

## 14) Scope and caveats

These procedures are tuned to our experiments on Qwen 2.5 7B Instruct and Gemma 3 27B-IT. Layer behavior and safe magnitudes are not universal laws. Re-run sweeps whenever you change model family, tokenizer/inference stack, or evaluation set.
