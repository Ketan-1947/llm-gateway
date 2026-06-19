# LLM Gateway — Phases 1–5 (complete)

A drop-in API gateway in front of Claude and OpenAI. A prompt comes in; the
gateway **rate-limits + guards it**, **optimizes the prompt**, **classifies the
task**, **routes it to the cheapest capable model**, **enforces budgets**, calls
the provider (with cross-provider fallback), **logs cost + usage**, and returns
the answer plus full metadata.

```
Client → /v1/chat → [auth] → rate-limit → guard → optimise → classify → route
                                  → budget check → ProviderManager → Claude | OpenAI
                                                        │ (fallback on failure)
                       log usage ←  normalized response + metadata  → Client
```

- **Phase 1 (done):** end-to-end pipe, Claude pass-through, cost + latency.
- **Phase 2 (done):** task classifier, routing table, OpenAI adapter, confidence round-up, cross-provider fallback, `/v1/route` dry-run.
- **Phase 3 (done):** rule-based prompt optimizer with token counting, an intent-fingerprint guard (only ever helps or no-ops), and `/v1/optimise-only`.
- **Phase 4 (done):** per-request logging + cost meter + `/v1/usage` with a naive-baseline savings comparison.
- **Phase 5 (done):** rate limiting, per-request + daily budget caps, PII/jailbreak pre-flight guard, hashed API keys.

## Files

| File | Role |
|------|------|
| `server.ts` | Entry point; builds the ProviderManager; error envelope |
| `routes.ts` | Native API: `/v1/chat`, `/v1/route`, `/v1/optimise-only`, `/v1/health`, `/v1/usage` |
| `pipeline.ts` | Shared pipeline (simple + rich/tool paths); `prepare`/`finalize`, one-shot + streaming |
| `openaiCompat.ts` | OpenAI-compatible facade: `/v1/chat/completions` (true SSE streaming + tools), `/v1/models` |
| `auth.ts` | Bearer API-key check (stub) |
| `optimizer.ts` | Rule-based prompt optimizer + intent-fingerprint guard |
| `classifier.ts` | Heuristic task classifier → `{taskType, confidence, signals}` |
| `router.ts` | Routing table + confidence round-up + fallback chains |
| `dispatch.ts` | `ProviderManager` — executes a decision with fallback |
| `claudeAdapter.ts` | `ProviderAdapter` for Anthropic |
| `openaiAdapter.ts` | `ProviderAdapter` for OpenAI (handles o1/o3 quirks) |
| `usageStore.ts` | `UsageStore` seam + in-memory/JSONL impl + aggregation |
| `guard.ts` | Pre-flight PII / jailbreak / size guard |
| `rateLimit.ts` | Per-key fixed-window rate limiter |
| `budget.ts` | Per-request + daily budget caps, cost estimate |
| `config.ts` | Env + central price table + cost calc |
| `types.ts` | Shared types incl. the `ProviderAdapter` seam |
| `routing.test.ts` | 20-prompt routing regression suite (no network) |
| `optimizer.test.ts` | Optimizer suite: shrink, no-op, zero intent drift |
| `usage.test.ts` | Usage aggregation, filters, and baseline-savings math |
| `hardening.test.ts` | Guard, rate limiter, and budget enforcement |

> **Layout note:** files are flat in one folder (the sandbox couldn't create
> subfolders this session). Fully working as-is; in a real repo you may want
> `src/` + `src/adapters/` — just update import paths and `tsconfig`.

## Setup

Requires **Node 20.6+**.

```bash
cp .env.example .env     # add ANTHROPIC_API_KEY (OPENAI_API_KEY optional)
npm install
npm run dev              # dev server on :3000
```

OpenAI key is optional: without it, REASONING/MULTIMODAL prompts route to OpenAI
then **fail over to Claude** automatically.

## Try it

```bash
# See the routing decision WITHOUT spending anything (no LLM call):
curl -X POST localhost:3000/v1/route \
  -H "Authorization: Bearer dev-key-123" -H "Content-Type: application/json" \
  -d '{"prompt":"Design a scalable distributed chat system."}'
# -> CODE_COMPLEX -> anthropic/claude-opus-4-7

curl -X POST localhost:3000/v1/route \
  -H "Authorization: Bearer dev-key-123" -H "Content-Type: application/json" \
  -d '{"prompt":"What is the capital of France?"}'
# -> SIMPLE_QA -> anthropic/claude-haiku-4-5

# Full chat (auto-routed):
curl -X POST localhost:3000/v1/chat \
  -H "Authorization: Bearer dev-key-123" -H "Content-Type: application/json" \
  -d '{"prompt":"Write me a haiku about autumn."}'
# -> CREATIVE -> claude-sonnet-4-6

# Override routing:
curl -X POST localhost:3000/v1/chat \
  -H "Authorization: Bearer dev-key-123" -H "Content-Type: application/json" \
  -d '{"prompt":"Hello","preferences":{"forceModel":"claude-opus-4-7"}}'
```

`/v1/chat` metadata now includes `taskType`, `classificationConfidence`,
`routingReason`, and `fallbackUsed`.

## Use it from an editor (OpenAI-compatible facade)

The gateway also speaks the **OpenAI Chat Completions protocol**, so any tool
that accepts a custom OpenAI-compatible provider — **Continue.dev, Cline, Cursor,
Zed, GitHub Copilot Chat (BYOK), the `openai` SDK**, etc. — can use it as a model
provider. Point the tool at:

```
Base URL: http://localhost:3000/v1
API key:  dev-key-123        (any GATEWAY_API_KEYS value)
Model:    gateway-auto       (full optimise + intelligent routing)
```

> **Copilot note:** BYOK applies to Copilot **Chat / agent mode only** — inline
> autocomplete stays on GitHub's models and cannot be redirected. Continue/Cline
> are the lowest-friction way to try it.

Endpoints:

- `GET /v1/models` — model list in OpenAI shape. Advertises `gateway-auto` plus
  every catalog model.
- `POST /v1/chat/completions` — standard request/response, with **true token
  streaming** (`stream: true`) and **function/tool calling** (`tools` +
  `tool_choice`). Routing/optimisation details come back under
  `x_gateway_metadata` (non-streaming).

`model` handling: `gateway-auto` (or any unknown id) → full auto-routing; a
concrete catalog id (e.g. `claude-sonnet-4-6`) → forced model.

**Two pipeline paths**, chosen automatically:
- **Simple** (plain chat, no tools): last user turn → optimiser → classify →
  route. The optimiser's token savings still apply.
- **Rich** (request carries `tools` or tool/assistant-tool-call turns): the full
  `messages[]` are passed through **verbatim** (optimiser skipped, so tool-call
  structure is never rewritten); classify + route still choose the model. Tool
  defs/calls/results are translated to each provider's native format (OpenAI
  function calling ⇄ Anthropic `tool_use`/`tool_result`).

```bash
# Non-streaming, OpenAI shape:
curl -X POST localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer dev-key-123" -H "Content-Type: application/json" \
  -d '{"model":"gateway-auto","messages":[{"role":"user","content":"Write a haiku about autumn."}]}'

# Streaming (SSE):
curl -N -X POST localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer dev-key-123" -H "Content-Type: application/json" \
  -d '{"model":"gateway-auto","stream":true,"messages":[{"role":"user","content":"Hi"}]}'

# Tool / function calling:
curl -X POST localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer dev-key-123" -H "Content-Type: application/json" \
  -d '{"model":"gateway-auto","messages":[{"role":"user","content":"Weather in Paris?"}],
       "tools":[{"type":"function","function":{"name":"get_weather",
         "parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}]}'
# -> finish_reason "tool_calls", message.tool_calls[0].function = {name:"get_weather", arguments:"{\"city\":\"Paris\"}"}
```

> **Streaming is true token streaming**: deltas are forwarded from the provider
> as they arrive (`ProviderAdapter.stream()`), with usage/cost finalised when the
> stream ends. Cross-provider fallback applies only *before the first token* — once
> bytes are on the wire, the chosen stream is committed.

## Routing table

| Task type | Provider | Model |
|-----------|----------|-------|
| SIMPLE_QA, CONVERSATION | Anthropic | claude-haiku-4-5 |
| CREATIVE, CODE_SIMPLE, LONG_CONTEXT, SAFETY_SENSITIVE | Anthropic | claude-sonnet-4-6 |
| CODE_COMPLEX, RESEARCH | Anthropic | claude-opus-4-7 |
| REASONING | OpenAI | o3-mini |
| MULTIMODAL | OpenAI | gpt-4o |

Low-confidence (<0.6) classifications round **up** one tier (e.g. Haiku→Sonnet)
to protect quality. Each model has a deterministic cross-provider fallback chain
in `router.ts`.

## The optimizer contract

The optimizer is **rule-based only** (no LLM call, zero added cost) and can only
ever **help or no-op**. Every candidate rewrite is checked against an intent
fingerprint — the set of content words in the original prompt. If any content
word would be lost, the rewrite is discarded and the original prompt is sent
untouched. Rules implemented: strip politeness/filler (R1), normalize whitespace
(R8), de-duplicate sentences (R3), inject an output-format hint on open-ended
asks (R2), and suggest an expert role via the system prompt (R4). `tokensSaved`
is priced at the routed model's input rate to produce `estCostSaved`.

Try it without spending anything:

```bash
curl -X POST localhost:3000/v1/optimise-only \
  -H "Authorization: Bearer dev-key-123" -H "Content-Type: application/json" \
  -d '{"prompt":"Could you please write a function to reverse a string?"}'
# -> "Write a function to reverse a string?"  (tokensSaved > 0, rulesApplied: [R1])
```

Opt out per request with `{"preferences":{"optimise":false}}`.

## Usage & cost tracking (Phase 4)

Every `/v1/chat` call is logged (hashed key id, model, tokens, cost, savings,
latency, fallback). `GET /v1/usage` aggregates it — including the **savings vs
baseline** number, which is the answer to "is this gateway actually saving
money?" (architecture doc Hard Problem 3): it reprices every logged request as
if it had naively gone to `BASELINE_MODEL` and reports the delta.

```bash
curl localhost:3000/v1/usage -H "Authorization: Bearer dev-key-123"
curl "localhost:3000/v1/usage?scope=me&since=2026-06-01T00:00:00Z" \
  -H "Authorization: Bearer dev-key-123"
```

Storage is an injectable `UsageStore` (in-memory + optional JSONL via
`USAGE_LOG_FILE`). Swap in Postgres for production by implementing the same
interface — nothing else changes. Logging never throws into the request path.

## Hardening (Phase 5)

Enforced in `/v1/chat`, in order, **before any spend**: per-key **rate limit** →
pre-flight **guard** (block jailbreak/oversize, flag PII) → optimise/classify/route
→ **budget check** (worst-case estimate vs the client's `maxCost`, a global
per-request ceiling, and a rolling **daily cap** per key). Actual spend is then
recorded so the daily cap is real. Auth accepts **hashed keys**
(`GATEWAY_API_KEY_HASHES`, sha256) with a timing-safe compare; raw keys are never
stored or logged. `guardFlags` (e.g. `pii:email`) appear in `/v1/chat` metadata.

All limits are config-driven and default-safe; set any to `0` to disable.

## Test (✅ all phase done conditions)

```bash
npm test                 # runs all four suites
npm run test:routing     # >= 17/20 prompts route to expected model
npm run test:optimizer   # verbose shrinks, clean no-ops, ZERO intent drift
npm run test:usage       # aggregation, filters, baseline-savings math
npm run test:hardening   # guard blocks/flags, rate limit, budget caps
```

All suites run with **no network calls**.

## ⚠️ Caveats

- Prices in `config.ts` are **illustrative** — verify against live provider pricing before trusting cost numbers.
- The classifier is **heuristic**. The documented next upgrade is a cheap LLM tie-break on low-confidence cases, then a learned classifier once you have labeled logs.
- In-memory state (usage, rate limiter, budget) is **per-instance**. For multiple replicas, back the `UsageStore` with Postgres and the limiter/budget with Redis (same interfaces).
- The PII/jailbreak guard is a **first line of defense**, not a complete safety stack — it complements provider-side guardrails, it doesn't replace them.
- ✅ **Verified end-to-end in-sandbox:** `tsc --noEmit` passes clean; all four suites pass (routing 21/21, optimizer, usage, hardening); the server boots and serves `/v1/health`, `/v1/models`, `/v1/route`, `/v1/optimise-only`, `/v1/usage`, and `/v1/chat` correctly returns 401 (no key), 400 (jailbreak guard), 402 (budget cap), 429 (rate limit), and reaches the provider + fails over. Live testing also caught and fixed a classifier regex bug (`scalab\b` never matched "scalable").
