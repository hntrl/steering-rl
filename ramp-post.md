# How we built Steer, our interpretability playground

**Ramp Labs** (@RampLabs)

*Article by Rene Sultan (@rene_sultan)*

*Note: Original post included images that are referenced below as placeholders.*

We built a system that steers an LLM toward specific concepts without retraining, and in the process learned something concrete about where meaning lives in different model architectures.

Steer a model toward expense management and it will connect any topic back to receipt reconciliation. Ask it about the weather and it explains how fluctuating temperatures are a lot like fluctuating reimbursement cycles. If you have talked to Anthropic's Golden Gate Claude, the experience is similar: a model with an obsession baked into its activations.

## Why Activation Steering

Activation steering modifies a model's internal representations at inference time. Instead of fine-tuning weights, a steering vector is added to the activations at specific layers during the forward pass. This makes it possible to alter what a model focuses on without touching the underlying parameters.

It is a lightweight, reversible intervention, and it exposes something about how models organize information internally: which layers encode which concepts, how robust those encodings are, and what happens when you perturb them.

## Opening It Up

We generalized the system. Instead of hardcoding one concept, the pipeline accepts any concept and generates a steering vector for it. A pre-loaded gallery includes "Existentialism," "Elon Musk," "Rick Sanchez," and others.

The training pipeline runs on Modal's serverless GPU infrastructure. Submit a concept, the system extracts a steering vector, and a steered model is ready to chat with in short order.

## Qwen

Our first model was Qwen 2.5 7B Instruct, a 7.61-billion-parameter model from Alibaba with 28 transformer layers, pretrained on a large-scale dataset encompassing up to 18 trillion tokens. Three problems surfaced quickly:

- **The pretraining reversion problem:** Qwen's pretraining corpus is multilingual (29+ languages), and we suspect Chinese has outsized representation. The model's behavior under stress supports this. It seems like the instruction tuning that makes it fluent in English is a learned behavior layered on top of that foundation. Steering vectors nudge internal representations, and when pushed too hard, they destabilize that instruction-tuned layer. Push far enough and the model does not just produce incoherent English; it reverts to its pretraining distribution, which for Qwen means Mandarin.
- **The size problem:** 7B parameters is not a lot. Smaller models have less representational redundancy, which means less room to push activations around before quality collapses. Qwen 7B became incoherent relatively quickly under moderate steering, especially for abstract or complex concepts.
- **The calibration problem:** We initially ran a magnitude sweep on the "Ramp" concept and picked three thresholds (low, medium, strong), then reused those same values for every concept. That does not transfer cleanly. Different concepts occupy different regions of representation space and respond differently to the same magnitude.

### What we learned about Qwen's layers

A steering vector can be applied at any layer, but the challenge is finding where it works.

- Steering early layers corrupted syntax and grammar, suggesting they handle low-level language processing.
- Steering late layers disrupted fluency without meaningfully changing reasoning, suggesting those layers are closer to token generation.
- The sweet spot was mid-layers, but the usable window was narrow: a small band of effective layers, tight multiplier ranges, and a hard failure mode if pushed too far.

## Moving to Gemma

To fix these problems, we switched from Qwen to Gemma 3 27B-IT, a 27-billion-parameter model from Google with 62 transformer layers and an alternating attention pattern: for every 5 local sliding-window attention layers (1,024-token window), there is 1 global self-attention layer that attends to full context. It is multilingual (140+ languages), but unlike Qwen, it did not revert to another language under heavy steering.

The results were immediate. The bilingual instability vanished. When Gemma degraded under heavy steering, it produced incoherent but still English output instead of switching languages, and even degraded responses were generally legible and on-topic.

But Gemma introduced a new challenge: it is significantly more sensitive to steering vector application than Qwen. Magnitudes and layer selections that worked on Qwen were far too aggressive for Gemma.

Gemma required re-solving both layer selection and multiplier calibration. Unlike Qwen's 28 layers, Gemma has 62. Based on earlier findings, we scoped experiments to layers 16-53 (38 layers) spanning early concept formation through late-stage reasoning. In our testing, layers below 16 appeared to handle syntax and embedding, while layers above 53 appeared to handle output formatting and token generation. Steering either end corrupted language abilities rather than reshaping reasoning.

## The Sweep

Moving from Qwen to Gemma revealed how differently the two models organize internal representations:

- Qwen's 28 layers are structurally uniform, with useful steering concentrated in a narrow mid-layer band.
- Gemma's 62 layers are heterogeneous (local/global alternation), with concept encoding distributed more broadly.

We did not assume which layers would work. We tested across the range and let results drive selection.

### Experimental design

We tested:

- 8 layer configurations
- 5 multiplier values (0.05 to 0.75)
- 4 concepts
- 8 prompts

That produced 1,280 generations, each evaluated by an LLM judge on coherence, keyword density, and a composite quality score.

Configurations ranged from sparse (5 evenly spaced global layers) to dense (contiguous 12-19 layer blocks), and included steering all 38 candidate layers at once. Our hypothesis: sparse global layers would offer maximum steering with lower degeneration risk.

### Key findings

- Sparse global layers performed best. The sparse 5-layer global configuration stayed coherent across the full multiplier range.
- At multiplier 0.75 (most aggressive tested), sparse global steering produced 0% degenerate outputs and coherence 0.858.
- Dense late-layer steering failed hard. A dense late 12-layer setup at 0.55 produced coherence 0.113 with 83% degenerate outputs.
- Late-layer sensitivity was extreme. The dense 19-layer mid-to-late setup at 0.55 produced 100% degenerate outputs.
- Steering all 38 candidate layers at 0.35 still produced 73% degeneracy.
- Degeneration cliffs were steep and layer-dependent: some configs degraded gradually, while others collapsed abruptly over small multiplier increases.
- In this sweep, global layers outperformed nearby local layers, likely because global attention can integrate concept context across the full sequence.

For the tested concepts and prompts, **layer 41** (about 66% network depth) was the best single-layer target: late enough for abstract semantics, early enough to avoid immediate token-generation collapse.

**Chosen default:** sparse 5-layer global configuration at layers **23, 29, 35, 41, 47**.

*Image placeholder: sweep chart / layer-performance data*

These results came from a relatively small sweep (4 concepts, 8 prompts, LLM-judged evaluation). We used them to pick a practical default, not claim a universal steering law.

### The effective strength problem

Different concepts have different natural magnitudes in representation space. A "mild" steering strength for one concept can be catastrophic for another. In our experience, abstract concepts like "absurdism" tended to produce smaller vectors than concrete ones like "marine biology," so the same multiplier yielded different effective strengths.

We expose three presets (low, medium, strong) calibrated across concept types:

- **Low:** subtle thematic influence
- **Medium (default):** clear concept presence with minimal quality loss
- **Strong:** aggressive concept pressure near the coherence boundary

## Serving Without Burning Money

Gemma 27B is not a small model. Steer AI is an experimental project, not a revenue-generating product, so keeping GPUs warm 24/7 is not practical.

The bottleneck is cold start. Loading Gemma into GPU memory from scratch takes 60-120 seconds before first token. Our solution uses Modal's GPU memory snapshots: both container memory and GPU memory are snapshotted with Gemma already loaded. On cold function startup, the snapshot is restored and only the user-specific steering vector is loaded. Cold start drops to roughly 5-12 seconds.

## Why This Matters

More organizations will fine-tune models for domain-specific use cases. When those models fail on specific inputs, the default response is usually more data or hyperparameter tuning. Interpretability adds another path: inspect internals, locate useful representations, and intervene at leverage points.

The tooling is improving quickly. Work like Anthropic's activation-oracle research and applied interpretability efforts from startups like Goodfire is expanding what teams can do in practice.

Organizations that build interpretability muscle now will be better positioned as LLMs shift from black boxes to systems we can understand and engineer. Steer AI is how we are building that muscle.

Steer AI is live at **<https://labs.ramp.com/steer-ai>**. Pick a concept and talk to it.

Want to keep up with our next AI experiments? Subscribe and follow @RampLabs. We are also hiring across roles at Ramp.

## Scope note

The empirical observations in this post, including layer function assignments, steering behavior, and sweep results, reflect our experiments on Gemma 3 27B-IT and Qwen 2.5 7B Instruct with a limited set of concepts and prompts. These findings informed our design decisions but should not be treated as general properties of these architectures. Results may vary with different models, concepts, or evaluation methods.

## References

1. Turner, A. M., Thiergart, L., Leech, G., et al. "Steering Language Models With Activation Engineering." arXiv preprint arXiv:2308.10248 (2023). <https://arxiv.org/abs/2308.10248>
2. Panickssery, N., Gabrieli, N., Schulz, J., et al. "Steering Llama 2 via Contrastive Activation Addition." arXiv preprint arXiv:2312.06681 (2023). <https://arxiv.org/abs/2312.06681>
3. Templeton, A., Conerly, T., Marcus, J., et al. "Scaling Monosemanticity: Extracting Interpretable Features from Claude 3 Sonnet." Transformer Circuits Thread, Anthropic (2024). <https://transformer-circuits.pub/2024/scaling-monosemanticity>
4. Karvonen, A., Chua, J., Dumas, C., et al. "Activation Oracles: Training and Evaluating LLMs as General-Purpose Activation Explainers." arXiv preprint arXiv:2512.15674 (2025). <https://arxiv.org/abs/2512.15674>
5. Chen, R., Arditi, A., Sleight, H., Evans, O., Lindsey, J. "Persona Vectors: Monitoring and Controlling Character Traits in Language Models." arXiv preprint arXiv:2507.21509 (2025). <https://arxiv.org/abs/2507.21509>
6. Gemma Team, Google DeepMind. "Gemma 3 Technical Report." arXiv preprint arXiv:2503.19786 (2025). <https://arxiv.org/abs/2503.19786>
7. Google Developers. "Gemma explained: What's New in Gemma 3." Google Developers Blog (2025). <https://developers.googleblog.com/gemma-explained-whats-new-in-gemma-3>
8. Hugging Face. "Welcome Gemma 3." Hugging Face Blog (2025). <https://huggingface.co/blog/gemma3>
9. Qwen Team. "Qwen2.5 Technical Report." arXiv preprint arXiv:2412.15115 (2024). <https://arxiv.org/abs/2412.15115>
10. Qwen Team. "Qwen2.5: A Party of Foundation Models." Qwen Blog (2024). <https://qwen.ai/blog?id=qwen2.5>
11. steering-vectors contributors. "steering-vectors: A Python library for steering language models." GitHub (2024). <https://github.com/steering-vectors/steering-vectors>
12. Modal Labs. "GPU Memory Snapshots: Supercharging Sub-second Startup." Modal Blog (2025). <https://modal.com/blog/gpu-mem-snapshots>
