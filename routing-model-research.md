# Cheapest Production-Grade LLM Routing Model — Deep Research Report

**Prepared for:** LLM middleware / gateway project
**Date:** June 2026
**Question answered:** What is the cheapest model available today that is accurate enough to classify prompt complexity and recommend an LLM routing decision — and what does it cost per 1,000 requests?

---

## TL;DR — The Answer

The cheapest *viable* production routing model is a hosted small open model with **constrained JSON decoding**. The two that win on the cheap/fast/reliable triangle are:

- **Winner: Llama 3.1 8B Instant on Groq** — `$0.05`/1M in, `$0.08`/1M out, ~85–110 ms TTFT, **100% guaranteed JSON via constrained decoding**, ≈ **$0.0115 per 1,000 routing calls**.
- **Runner-up: Gemini 2.5 Flash-Lite** — `$0.10`/1M in, `$0.40`/1M out, Google-grade reliability + native response-schema, ≈ **$0.035 per 1,000 routing calls**.

But the single most important finding of this research is that **the routing-model cost is economically irrelevant**. At your scenario (150-token prompt, 50-token classification), even the *most expensive* candidate (Claude Haiku 4.5) costs **$0.40 per 1,000 routing calls**, while correct routing saves roughly **$4.23 per 1,000 end-user requests**. The break-even is ~0.25% of traffic. So **optimise for accuracy, JSON reliability, and latency — not for shaving fractions of a cent off the router.** The cheapest model that is *reliable enough* wins, and that is decided by JSON-mode support and latency, not token price.

> A note on caution: the "complexity" labels below are a routing heuristic, not a statement about the user. Misrouting wastes money or quality — nothing more.

---

## SECTION 1 — Market Survey of Cheap LLM Options

All prices are per **1 million tokens**, verified against provider/official pricing pages in June 2026. Where an official page conflicted with aggregators, the official figure is used and the conflict is flagged.

### Comparison Table (cheapest → most expensive by input price)

| Model | Provider | Input $/1M | Output $/1M | TTFT / Latency | Context | API Ready? |
|---|---|---|---|---|---|---|
| Mistral Nemo (12B) | Mistral API | **0.02** | 0.03 | ~200–400 ms | 128K | ✅ GA |
| Ministral 3B | Mistral API | 0.04 | 0.04 | ~150–300 ms | 128K | ✅ GA |
| Gemini 1.5 Flash-8B | Google AI | 0.0375 | 0.15 | ~300–500 ms | 1M | ⚠️ GA but 1.5 line being retired |
| Cohere Command R7B | Cohere | 0.0375 | 0.15 | ~200–400 ms | 128K | ✅ GA |
| **Llama 3.1 8B Instant** | **Groq** | **0.05** | **0.08** | **~85–110 ms** | 128K | ✅ GA |
| Ministral 8B | Mistral API | 0.10 | 0.10 | ~200 ms | 128K | ✅ GA |
| Mistral Small 3 | Mistral API | 0.10 | 0.30 | ~300 ms | 32K | ✅ GA |
| **Gemini 2.5 Flash-Lite** | **Google AI** | **0.10** | **0.40** | **~400 ms** | 1M | ✅ GA |
| GPT-4o-mini | OpenAI | 0.15 | 0.60 | ~400–700 ms | 128K | ✅ GA |
| Llama 3.1 8B | Together AI | 0.18 | 0.18 | ~200–400 ms | 128K | ✅ GA |
| Llama 3.1 8B | Fireworks AI | 0.20 | 0.20 | ~200–400 ms | 128K | ✅ GA |
| o3-mini | OpenAI | 0.55 | 2.20 | reasoning — slow | 200K | ✅ GA (avoid — see §5) |
| Claude Haiku 3.5 | Anthropic | 0.80 | 4.00 | ~500–900 ms | 200K | ✅ GA |
| Claude Haiku 4.5 | Anthropic | 1.00 | 5.00 | ~400–700 ms | 200K | ✅ GA |
| *(baseline) Claude Sonnet 4.6* | Anthropic | 3.00 | 15.00 | — | 200K | ✅ GA |

**Provider notes**

- **Anthropic** — Cheapest tier is **Haiku 4.5 ($1/$5)**; the older Haiku 3.5 ($0.80/$4) is still callable but newer Haiku is faster and barely pricier. There is no "nano"/sub-Haiku Claude tier. Haiku is excellent at the task but ~8–20× the token cost of the open-model options. Tool-use (function calling) gives reliable structured output.
- **OpenAI** — **GPT-4o-mini ($0.15/$0.60)** is the practical floor and supports native **Structured Outputs** (strict JSON schema). `gpt-3.5-turbo` (~$0.50/$1.50) is legacy and should not be chosen for new work. `o1-mini`/`o3-mini` ($0.55/$2.20) are *reasoning* models — wrong tool for a latency-sensitive router (they "think" before answering).
- **Google** — Cheapest practical GA option is **Gemini 2.5 Flash-Lite ($0.10/$0.40)** with native response-schema. **Gemini 1.5 Flash-8B ($0.0375/$0.15)** is cheaper but on the deprecating 1.5 line — fine short-term, risky long-term. (Note: as of June 2026 Google's pricing page already lists the newer Gemini 3.x Flash-Lite tier; 2.5 Flash-Lite remains the cheapest stable text router.) **Gemini 2.0 Flash was shut down 1 June 2026** — do not target it.
- **Meta / Llama** — Same 8B weights, very different economics by host: **Groq $0.05/$0.08**, **Together $0.18**, **Fireworks $0.20**. Groq is both the cheapest *and* the fastest for this model. Llama 3.2 **1B/3B** are mainly self-host/edge plays; few managed APIs price them attractively versus 8B, and their JSON reliability is weaker (see §4).
- **Mistral** — **Nemo ($0.02/$0.03)** and **Ministral 3B ($0.04)** are the cheapest hosted APIs on the market by raw token price. Viable, but smaller models need constrained decoding to be JSON-safe, and Mistral's free/Experiment tier may train on your data (use a paid plan).
- **Cohere** — **Command R7B ($0.0375/$0.15)** is purpose-built for cheap, high-volume classification/RAG and is a legitimate dark-horse router.
- **Self-hosted** (Llama 3.2 1B/3B, Phi-3 Mini 3.8B, Gemma 2 2B, Qwen2 1.5B, TinyLlama 1.1B): all run on a single small GPU. A smallest cloud GPU (e.g. AWS `g5.xlarge`, one A10G, ~$1.00/hr on-demand or ~$0.30–0.40/hr spot) ≈ **$220–730/month** of *fixed* cost. That only beats Groq if you are sustaining **millions** of calls/day; below that, managed APIs are cheaper and far less operational hassle. **TinyLlama and Qwen2 0.5B are too weak** for reliable 4-way classification + JSON. **Phi-3 Mini and Gemma 2 2B** can do it but need constrained decoding.

---

## SECTION 2 — The Meta-Cost Problem (the important part)

**Scenario:** 150-token prompt in, 50-token routing response out.

### Cost of the routing call itself

| Model | $/call | $/1,000 | $/month (30K) | $/year (365K) |
|---|---|---|---|---|
| Mistral Nemo | $0.0000045 | **$0.0045** | $0.14 | $1.64 |
| Ministral 3B | $0.0000080 | $0.0080 | $0.24 | $2.92 |
| Groq Llama 3.1 8B | $0.0000115 | **$0.0115** | $0.35 | $4.20 |
| Gemini 1.5 Flash-8B | $0.0000131 | $0.0131 | $0.39 | $4.79 |
| Cohere Command R7B | $0.0000131 | $0.0131 | $0.39 | $4.79 |
| Ministral 8B | $0.0000200 | $0.0200 | $0.60 | $7.30 |
| Mistral Small 3 | $0.0000300 | $0.0300 | $0.90 | $10.95 |
| Gemini 2.5 Flash-Lite | $0.0000350 | $0.0350 | $1.05 | $12.77 |
| GPT-4o-mini | $0.0000525 | $0.0525 | $1.58 | $19.16 |
| Together Llama 3.1 8B | $0.0000360 | $0.0360 | $1.08 | $13.14 |
| Claude Haiku 4.5 | $0.0004000 | $0.4000 | $12.00 | $146.00 |

**Reading:** the entire spread from cheapest to "expensive Haiku" is **$0.0045 → $0.40 per 1,000 calls.** Even the costliest is rounding error against the model spend it controls.

### Break-even — when does routing lose money?

Take a typical end-user request: **150 in + 500 out** tokens.

- Claude **Sonnet 4.6** answer: **$0.00795** per request
- Claude **Haiku 4.5** answer: **$0.00265** per request
- **Saving per query correctly downgraded Sonnet → Haiku: $0.0053**

Routing overhead (Groq/Flash-Lite) is ~$0.0000115–$0.000035 per call. So:

> **You break even if just ~0.25% of traffic is correctly downgraded.** One correct downgrade pays for ~450 routing calls.

The routing model would have to be **>99% wrong** in a way that actively upgrades cheap queries to expensive models before the economics turn negative. In practice the failure cost is not the router's token price — it is **quality loss from sending a hard prompt to a weak model** (see §3 failure modes).

### The "no router" alternative

Send **everything to Sonnet 4.6**: **$7.95 per 1,000 requests.**

With routing at a realistic **40% simple / 40% medium / 20% complex** split (80% to Haiku, 20% to Sonnet):

| | Per 1,000 requests |
|---|---|
| All-Sonnet baseline | $7.95 |
| Routed model spend | $3.71 |
| Routing overhead (Flash-8B/Groq) | $0.01 |
| **Net cost with routing** | **$3.72** |
| **Net savings** | **$4.23 (53%)** |

Routing roughly **halves** model spend, and the router overhead consumes **0.3%** of that saving. Routing is worth it the moment you have a meaningful share of simple/medium traffic — which virtually every real workload does.

---

## SECTION 3 — Accuracy & the Routing Literature

### Can a small model do the 4-way classification?

Yes — this is an *easy* task for any ≥7–8B instruction-tuned model. The four example prompts you cited ("haiku about autumn" → SIMPLE, "debug this race condition" → COMPLEX, "2+2" → SIMPLE, "geopolitical implications of Taiwan semiconductor restrictions" → EXPERT) are well within the competence of Llama 3.1 8B, Gemini Flash-Lite, GPT-4o-mini, Command R7B, and Haiku. The relevant capability is **instruction-following**, not raw knowledge, so the most predictive benchmark here is **IFEval** (instruction-following), with MMLU as a secondary signal — *not* HellaSwag/ARC, which measure commonsense/science QA that doesn't reflect routing skill.

The risk is not at 8B; it is at **1B–2B**, where label consistency and JSON validity degrade. Llama 3.2 1B and Qwen2 0.5B/1.5B will *mostly* get the obvious cases right but produce more borderline-case errors and malformed JSON.

### Failure modes (and why direction matters)

- **Under-routing (complex → simple)** is the **expensive** error: a hard prompt sent to Haiku produces a wrong/low-quality answer the user sees. The cost is quality and trust, not dollars.
- **Over-routing (simple → complex)** only wastes a few cents.

So the router should be **asymmetric / conservative**: when uncertain, round *up* a tier. This is cheap insurance — over-routing 10% of traffic costs pennies; under-routing 10% costs user-visible quality.

### What the published systems found

| System | Approach | Headline result |
|---|---|---|
| **RouteLLM** (LMSYS/Berkeley, ICLR 2025) | Learned routers (BERT classifier, matrix factorization) trained on preference data, routing between strong/weak models | **2×+ cost reduction with no significant quality loss**; matrix factorization hit **95% of GPT-4 quality using only 26% GPT-4 calls (~48% cheaper)**; up to **3.66× cheaper** on MT-Bench at a 50% quality-preservation target. Open-source framework. |
| **FrugalGPT** (Stanford, 2023) | **Cascade** — query cheap models first, escalate on low confidence | Matched **GPT-4 quality at up to 98% lower cost**, or +4% accuracy at equal cost. |
| **Hybrid LLM** (Microsoft, ICLR 2024) | Quality-aware router sending easy queries to a small model, hard ones to a large model | Comparable quality at substantially fewer large-model calls; tunable cost/quality knob. |
| **AutoMix** (2024) | Small model self-verifies its answer; POMDP meta-router escalates | **>50% compute reduction** at comparable performance via confidence-based escalation. |
| **RouterBench / LLMRouterBench** (2024–2026) | Standardized multi-LLM routing benchmarks | Confirm routers generalize; later benchmarks expand to large multi-domain, cost-aware evaluation. |

**Key takeaway from the literature:** the field's best results often come from a **tiny trained classifier (BERT-scale) or a cascade**, *not* a general-purpose LLM call. A BERT classifier in RouteLLM reached ~45% cost savings at matched quality. This directly informs the §6 recommendation: an LLM router is the easy, accurate default, but it is *not* necessarily the cheapest or best long-term design.

---

## SECTION 4 — Structured Output Reliability

This is where the "cheapest by token" models can disqualify themselves.

| Provider / model | Native structured output? | Notes |
|---|---|---|
| **Groq** (Llama 3.1/3.3, etc.) | ✅ **Constrained decoding**, `strict: true` | **Guarantees 100% schema adherence — "never errors or produces invalid JSON."** Best-in-class for a router. |
| **OpenAI** GPT-4o-mini | ✅ Structured Outputs (`response_format` json_schema) | Strict schema, very reliable. |
| **Gemini** 2.5 Flash-Lite / 1.5 Flash-8B | ✅ Response schema (via function calling / `responseSchema`) | Conforms to keys/types/structure. Slightly more setup than OpenAI. |
| **Anthropic** Haiku | ✅ Tool use / forced tool call | Reliable JSON through a forced tool. |
| **Mistral** Nemo / Ministral 3B | ⚠️ JSON mode exists, but **small models degrade** | Reliable *only* with constrained decoding; raw "respond in JSON" prompting on a 3B model produces occasional invalid output. |
| **Cohere** Command R7B | ✅ Structured outputs / JSON mode | Designed for this; reliable. |

**Critical research caveat:** studies found that naively **enforcing JSON constraints on the *smallest* models can *degrade* task quality** — in some function-calling tests, forcing the schema dropped tiny models to a **0% pass rate** because it disrupted their reasoning-action coupling. The lesson: **constrained decoding helps mid-size models (7–8B) and hurts sub-2B models.** This is another reason to land on an **8B-class model with provider-side constrained decoding** rather than a 1–3B model.

**At what size does JSON become reliable?** Empirically **~7–8B with constrained decoding** is the safe floor for "valid JSON every time." Below ~3B, expect occasional malformed output without provider-enforced grammars.

---

## SECTION 5 — Latency Analysis

The router adds latency to **every** request, so this matters as much as price.

**Acceptable budget for a router call:** aim for **< 200 ms** added latency; **< 500 ms** is the hard ceiling for interactive chat. Anything that "thinks" (reasoning models) blows this budget.

| Model (top cheap candidates) | TTFT (p50) | Total for ~50-tok output (p50) | p99 behaviour |
|---|---|---|---|
| **Groq Llama 3.1 8B** | **~85–110 ms** | **~150–200 ms** | Tight: p50→p95 ~120→280 ms, near-zero variance (LPU) |
| Gemini 2.5 Flash-Lite | ~400 ms TTFT | ~500–700 ms | More variable; forum reports of occasional ~2 s TTFT spikes |
| GPT-4o-mini | ~400–700 ms | ~600–900 ms | Variable under load |
| Mistral Nemo / Ministral | ~150–400 ms | ~300–500 ms | Provider-dependent |
| Claude Haiku 4.5 | ~400–700 ms | ~600–900 ms | Stable but not Groq-fast |

**Groq's advantage is real and material.** Its LPU delivers sub-100 ms TTFT with very low variance, ~6–10× faster than typical Gemini/OpenAI endpoints for small models, and the p50→p99 gap stays tight. For a component on the critical path of *every* request, that consistency is worth more than the fractional price differences elsewhere. **This is the decisive reason Groq Llama 3.1 8B wins over the marginally-cheaper-by-token Mistral Nemo.**

**Avoid for routing:** `o1-mini` / `o3-mini` and any reasoning model. They are designed to deliberate before answering, adding seconds of latency — unacceptable for a pre-flight router.

---

## SECTION 6 — Non-LLM Alternatives (be honest: are they better?)

### Approach A — Rule-based pre-filter (length + keywords + heuristics)

Zero cost, zero added latency. A surprising share of traffic is **obviously** simple or **obviously** expert. Realistic expectation: **rules confidently classify ~40–60%** of traffic (very short prompts, greetings, trivial Q&A → simple; presence of code blocks, stack traces, "prove", "derive", multi-constraint asks → complex/expert). The remaining ambiguous middle is where rules are unreliable. **Rules alone top out around 60–70% accuracy** across a diverse workload — good enough for the easy ends, not for the middle.

### Approach B — Embedding + lightweight classifier

Embed the prompt (**`text-embedding-3-small` at $0.02/1M**, batch $0.01/1M — i.e. **~$0.000003 per 150-token prompt**) and run a tiny logistic-regression/SVM/MLP head. This is **cheaper than any generative LLM call**, **faster** (embedding TTFT is low and there's no generation), and per the RouteLLM results a **BERT-class classifier matched ~95% routing quality at a fraction of the cost**. The cost is **engineering**: you must collect/label a routing dataset and train + maintain the head. Accuracy can **match or beat** a zero-shot cheap-LLM router once trained, because the task is narrow.

### Approach C — Fine-tuned tiny model

Fine-tuning a 1B (LoRA) for routing is cheap to train (tens of dollars on a rented GPU) and can hit high accuracy on the narrow task. But it's **operational overkill** versus Approach B's embedding head, which gets similar accuracy with less to host and maintain. Only worth it if you need free-form rationale output, not just a label.

### Approach D — Hybrid (recommended end-state)

**Rules first (catch the obvious ~50% at zero cost/latency) → embedding classifier for the ambiguous middle (~40%, sub-cent, fast) → cheap LLM fallback only for the genuinely uncertain tail (~10%).** This minimizes both cost and latency while keeping accuracy high, and lets you reserve the LLM call for cases where it actually adds value.

**Honest verdict:** For a **v1 you ship this week**, a single cheap-LLM router (Groq Llama 3.1 8B) is the right call — near-zero build cost, immediately accurate, JSON-guaranteed. But **at scale, the embedding-classifier / hybrid is genuinely cheaper *and* can be more accurate** than a generative router, because the task is a narrow, learnable classification. Plan to migrate to the hybrid once you have logged traffic to train on. Don't over-engineer it on day one; don't pretend the LLM router is the cost-optimal end-state either.

---

## SECTION 7 — Provider Reliability & Production Readiness

| Provider | Production maturity | Data privacy (paid tier) | Watch-outs |
|---|---|---|---|
| **Groq** | GA, fast-growing; paid tier for production | No training on API data on paid plans | Younger infra than hyperscalers; capacity can be tight at peak — keep a fallback |
| **Google (Gemini API / Vertex)** | Very mature; **Vertex AI** gives enterprise SLAs, regional control | Paid API not used for training; AI Studio free tier may be used — **use paid / Vertex** | Free tier rate limits low; consumer TTFT more variable than Groq |
| **OpenAI** | Very mature | API data not used for training by default; data-processing addenda available | Higher token price; more latency variance than Groq |
| **Anthropic** | Very mature | Does not train on API data by default | Most expensive of the candidates |
| **Together / Fireworks** | Production-grade open-model hosting; Fireworks markets SLA/uptime guarantees | Paid-tier DPAs available | Pricier than Groq for the same Llama 8B |
| **Mistral** | GA | **Free/Experiment plan may train on prompts — use a paid plan** | Smaller models need constrained decoding for JSON |
| **Self-host** | You own uptime | Full data control | Fixed GPU cost + ops burden; only economical at very high volume |

**General rules:** never run production on a **free tier** (no SLA, low rate limits, possible training-on-data). For any router touching sensitive prompts, use a **paid plan with a DPA / no-training guarantee** and, ideally, multi-provider failover so a single outage doesn't take down your gateway.

---

## FINAL RECOMMENDATIONS

### 🏆 WINNER — Llama 3.1 8B Instant on Groq

- **Price:** $0.05 /1M input, $0.08 /1M output (official Groq pricing).
- **Cost per 1,000 routing calls (150 in / 50 out): ≈ $0.0115.** (Per call ≈ $0.0000115.)
- **Why over the next-cheapest (Mistral Nemo $0.0045/1k):** Nemo is ~$0.007 cheaper per 1,000 calls — **economically meaningless** — while Groq gives you **~85–110 ms TTFT with near-zero variance** (vs Nemo's slower, more variable latency) **and 100%-guaranteed JSON via constrained decoding.** On a component that runs before every request, latency consistency + JSON reliability beat a sub-cent token saving every time.
- **Biggest weakness:** Groq is a younger provider than the hyperscalers; peak-time capacity/rate limits can bite. **Mitigate with a fallback provider** (see architecture).

### 🥈 RUNNER-UP — Gemini 2.5 Flash-Lite

- **Price:** $0.10 /1M in, $0.40 /1M out; **≈ $0.035 per 1,000 calls.**
- **Use it when:** you want **hyperscaler-grade reliability and SLAs** (via Vertex AI), are already in Google Cloud, or want a second provider for failover. Native response-schema makes JSON reliable. Trade-off: ~3× the (still trivial) cost and slower, more variable latency than Groq.
- *(If you must stay inside one ecosystem: **GPT-4o-mini** and **Claude Haiku 4.5** are both excellent, JSON-reliable routers — just 5–35× pricier per call, which is still negligible.)*

### 💰 Cost model for your middleware (recommended: Groq Llama 3.1 8B router)

- **Routing overhead per 1,000 user requests: ≈ $0.0115.**
- **Monthly routing overhead:** 10K → **$0.12** · 100K → **$1.15** · 1M → **$11.50**.
- **Savings vs all-Sonnet** at 40% simple / 40% medium / 20% complex (80% Haiku, 20% Sonnet): all-Sonnet $7.95/1k → routed $3.71/1k. **Net savings ≈ $4.23 per 1,000 requests (53%)** after overhead.
- **At 1M requests/month:** save **≈ $4,230/month** in model spend for **≈ $11.50** of router cost. **Unambiguously worth it.**

### 🧱 Recommended router architecture

1. **Rules pre-filter first** (free, instant): obvious simple (very short, greetings, trivial Q&A) and obvious expert (code blocks, stack traces, "prove/derive", multi-constraint) short-circuit without any model call. Expect ~40–60% handled here.
2. **LLM router for the rest:** Groq Llama 3.1 8B Instant, `strict: true` constrained JSON.
3. **System prompt (sketch):**
   > "You are a routing classifier. Read the user prompt and output ONLY JSON matching the schema. `complexity`: simple (trivial/factual/short creative), medium (multi-step but routine), complex (debugging, reasoning, multi-constraint), expert (deep domain analysis, novel synthesis). `recommended_model`: map simple/medium→haiku, complex→sonnet, expert→opus (or your provider equivalents). When uncertain, round UP one tier."
4. **JSON schema:**
   ```json
   {
     "type": "object",
     "properties": {
       "complexity": { "enum": ["simple","medium","complex","expert"] },
       "recommended_model": { "type": "string" },
       "confidence": { "type": "number" }
     },
     "required": ["complexity","recommended_model"]
   }
   ```
5. **Fallback if the routing call fails or times out (>300 ms):** default to a **safe mid tier (Sonnet)** — never fail a user request because the router hiccupped. Optionally retry once on a second provider (Gemini Flash-Lite) before defaulting.
6. **Bias conservative:** on low confidence, route *up* a tier (cheap insurance against the expensive failure mode).

### 🔁 The non-LLM end-state (be honest)

For **v1, ship the Groq LLM router** — fastest path to accurate, JSON-safe routing with near-zero build cost. But the **cost-optimal and often more-accurate long-term design is a hybrid**: rules → **embedding classifier** (`text-embedding-3-small`, ~$0.000003/prompt, trained on your logged traffic) → cheap-LLM fallback for the uncertain ~10%. The published evidence (RouteLLM's BERT classifier, FrugalGPT cascades) shows small trained classifiers match generative-router quality at a fraction of the cost. Migrate once you've logged enough labelled traffic to train on. **Don't build the hybrid before you have data; don't claim the LLM router is the cheapest possible end-state.**

### 🚫 What NOT to use

- **o1-mini / o3-mini (or any reasoning model):** they deliberate before answering — seconds of latency on the critical path. Wrong tool entirely.
- **gpt-3.5-turbo:** legacy, pricier than better options, weaker instruction-following. No reason to pick it in 2026.
- **Sub-2B models (TinyLlama, Qwen2 0.5B, Llama 3.2 1B) for the *generative* router:** unreliable JSON, and forcing schema constraints can *collapse* their accuracy (documented 0% pass rates in some tests). Fine as a fine-tuned classifier head, not as a zero-shot JSON router.
- **Gemini 2.0 Flash:** shut down 1 June 2026 — dead.
- **Gemini 1.5 Flash-8B for new long-term builds:** cheapest Google option but on the retiring 1.5 line; migration risk.
- **Any free tier in production:** no SLA, low rate limits, possible training-on-your-data (notably Mistral's Experiment plan).
- **Self-hosting a tiny model "to save money" below ~millions of calls/day:** the fixed GPU + ops cost ($220–730+/month) exceeds managed-API cost until very high volume.

---

## Pricing conflicts & caveats flagged

- **Mistral Ministral 3B/8B:** sources disagree ($0.04 vs $0.10 for 3B; $0.10 vs $0.15 for 8B) — reflects recent price cuts; verify on Mistral's live pricing page before committing.
- **Gemini line:** Google's June 2026 pricing page already surfaces **Gemini 3.x Flash-Lite** tiers alongside 2.5; 2.5 Flash-Lite ($0.10/$0.40) is used here as the cheapest *stable text* router. Re-check current SKUs at deploy time.
- **Claude generations:** as of June 2026 the current line is **Sonnet 4.6 ($3/$15)**, **Haiku 4.5 ($1/$5)**, **Opus 4.8 ($5/$25)** — used as the baseline/target tiers above.
- All latency figures are representative ranges from 2025–2026 third-party benchmarks; run your own p50/p99 measurement from your region before finalizing.

---

## Sources

- [Anthropic — Claude Haiku 4.5](https://www.anthropic.com/claude/haiku) · [Anthropic Haiku 4.5 announcement](https://www.anthropic.com/news/claude-haiku-4-5) · [Claude API pricing 2026 (CloudZero)](https://www.cloudzero.com/blog/claude-api-pricing/) · [Anthropic pricing (Finout)](https://www.finout.io/blog/anthropic-api-pricing)
- [OpenAI — GPT-4o mini](https://openai.com/index/gpt-4o-mini-advancing-cost-efficient-intelligence/) · [GPT-4o-mini pricing](https://pricepertoken.com/pricing-page/model/openai-gpt-4o-mini) · [o3-mini pricing](https://pricepertoken.com/pricing-page/model/openai-o3-mini) · [OpenAI API pricing 2026](https://pecollective.com/tools/openai-api-pricing/)
- [Google — Gemini API pricing (official)](https://ai.google.dev/gemini-api/docs/pricing) · [Gemini 2.5 Flash-Lite pricing](https://pricepertoken.com/pricing-page/model/google-gemini-2.5-flash-lite) · [Gemini 1.5 Flash-8B model card](https://www.prompthub.us/models/gemini-1-5-flash-8b)
- [Groq pricing 2026 (CloudZero)](https://www.cloudzero.com/blog/groq-pricing/) · [Groq Llama 3.1 8B cost calc (Helicone)](https://www.helicone.ai/llm-cost/provider/groq/model/llama-3.1-8b-instant) · [Groq Structured Outputs docs](https://console.groq.com/docs/structured-outputs)
- [Together AI pricing](https://www.aipricing.guru/together-pricing/) · [Fireworks AI pricing](https://costbench.com/software/llm-api-providers/fireworks-ai/) · [Llama multi-provider pricing](https://www.aipricing.guru/meta-pricing/)
- [Mistral API pricing 2026 (CloudZero)](https://www.cloudzero.com/blog/mistral-api-pricing/) · [Mistral pricing (AI Pricing Guru)](https://www.aipricing.guru/mistral-ai-pricing/)
- [Cohere Command R7B pricing](https://pricepertoken.com/pricing-page/model/cohere-command-r7b-12-2024) · [Cohere pricing (AI Pricing Guru)](https://www.aipricing.guru/cohere-pricing/)
- [OpenAI text-embedding-3-small](https://developers.openai.com/api/docs/models/text-embedding-3-small) · [Embedding pricing (Helicone)](https://www.helicone.ai/llm-cost/provider/openai/model/text-embedding-3-small)
- [RouteLLM paper (arXiv)](https://arxiv.org/pdf/2406.18665) · [RouteLLM (LMSYS blog)](https://www.lmsys.org/blog/2024-07-01-routellm/) · [RouteLLM GitHub](https://github.com/lm-sys/routellm) · [FrugalGPT (arXiv)](https://arxiv.org/abs/2305.05176)
- [RouterBench / LLMRouterBench](https://arxiv.org/html/2601.07206v1) · [AutoMix & hybrid routing overview](https://blog.n8n.io/llm-routing/)
- [Gemini structured output docs](https://ai.google.dev/gemini-api/docs/structured-output) · [Groq vs Gemini latency](https://discuss.ai.google.dev/t/high-ttft-2s-with-gemini-flash-vs-150ms-on-groq-any-optimization-or-throttling-insights/138024) · [AI API latency benchmark 2026](https://tokenmix.ai/blog/ai-api-latency-benchmark)
- [Free/paid tier & data-privacy comparison](https://apiscout.dev/guides/free-ai-apis-developers-2026) · [LLM API providers ranked 2026](https://tokenmix.ai/blog/best-llm-api-providers)
