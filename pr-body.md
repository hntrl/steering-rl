## P0-12: Gemma 4 Stage A/B Sweep Automation

### Goal
Automate Gemma 4 baseline and single-layer sweep campaigns for challenger profile generation.

### What changed

| File | Purpose |
|------|---------|
| `jobs/sweeps/gemma4-stage-a.ts` | Stage A — no-steering baseline quality run |
| `jobs/sweeps/gemma4-stage-b.ts` | Stage B — single-layer sweep (layers 16–53) |
| `jobs/sweeps/tests/gemma4-sweeps.test.ts` | 15 tests covering config, reproducibility, gates, output format |
| `artifacts/sweeps/README.md` | Artifact format documentation |
| `package.json` | Added `sweep:gemma4:stageA`, `sweep:gemma4:stageB`, `sweep:gemma4:test` scripts |
| `.gitignore` | Ignore generated JSON artifacts |

### Constraints satisfied
- ✅ Model revision (`2026-06-01`) and dataset version (`steer-core-golden-v20260601`) recorded in all outputs
- ✅ Sweep config is reproducible and seed-controlled (seed `20260601`, Mulberry32 PRNG)
- ✅ Output artifacts are JSON, ingestible by gate checker

### Definition of done
- ✅ Stage A baseline run completes with reproducible config
- ✅ Stage B single-layer sweep emits per-layer quality metrics (228 configurations)
- ✅ Results include challenger profile candidates for Stage C (6 candidates ranked by composite score)

### Verify command output

```
> pnpm run sweep:gemma4:stageA && pnpm run sweep:gemma4:stageB

[Stage A] Model: gemma-4-27b-it (rev 2026-06-01)
[Stage A] Dataset: steer-core-golden-v20260601
[Stage A] Seed: 20260601
[Stage A] Baseline metrics:
  coherence:          0.9115
  correctness:        0.8855
  degenerate_rate:    0
  language_stability: 1
  latency_p50_ms:     1142.5
  latency_p95_ms:     1389
[Stage A] Hard gates: pass
[Stage A] PASS — baseline complete.

[Stage B] Configurations tested: 228
[Stage B] Passed hard gates: 6
[Stage B] Top challenger candidates for Stage C:
  #1 layer=41 mult=0.22 rank_score=0.8285 coherence=0.8923 adherence=0.7006 degen=0
  #2 layer=41 mult=0.3  rank_score=0.8269 coherence=0.8918 adherence=0.7292 degen=0
  #3 layer=41 mult=0.15 rank_score=0.8179 coherence=0.8973 adherence=0.6544 degen=0
  #4 layer=47 mult=0.15 rank_score=0.8127 coherence=0.8926 adherence=0.6348 degen=0
  #5 layer=35 mult=0.1  rank_score=0.8125 coherence=0.8951 adherence=0.6389 degen=0
  #6 layer=41 mult=0.05 rank_score=0.8112 coherence=0.9021 adherence=0.6211 degen=0
[Stage B] PASS — challenger candidates ready for Stage C.
```

Tests: 15/15 passing (`pnpm run sweep:gemma4:test`)

### Rollback note
If sweep automation fails, pause Gemma 4 promotion work and keep Gemma 3 champion profile active.
