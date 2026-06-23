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

## Project Structure

```text
.env.example                # Safe environment template
package.json                # Scripts + dependencies
tsconfig.json               # TypeScript config
server.ts                   # Entry point; builds Fastify + services + routes
index.html                  # Web UI served at /
*.test.ts                   # No-network regression suites
*.ts                        # Gateway source modules, all in the project root
```

Key files:

| File | Role |
|------|------|
| `server.ts` | Entry point; builds the ProviderManager; error envelope |
| `routes.ts` | Native API: `/v1/chat`, `/v1/route`, `/v1/optimise-only`, `/v1/health`, `/v1/usage` |
| `openaiCompat.ts` | OpenAI-compatible facade: `/v1/chat/completions` (true SSE streaming + tools), `/v1/models` |
| `pipeline.ts` | Shared pipeline (simple + rich/tool paths); `prepare`/`finalize`, one-shot + streaming |
| `dispatch.ts` | `ProviderManager` executes a decision with fallback |
| `claudeAdapter.ts` | `ProviderAdapter` for Anthropic |
| `openaiAdapter.ts` | `ProviderAdapter` for OpenAI (handles o1/o3 quirks) |
| `classifier.ts` | Complexity classifier and token estimator |
| `router.ts` | Routing table + confidence round-up + fallback chains |
| `optimizer.ts` | Rule-based prompt optimizer + intent-fingerprint guard |
| `guard.ts` | Pre-flight PII / jailbreak / size guard |
| `auth.ts` | Bearer API-key check |
| `budget.ts` | Per-request + daily budget caps, cost estimate |
| `rateLimit.ts` | Per-key fixed-window rate limiter |
| `usageStore.ts` | `UsageStore` seam + in-memory/JSONL impl + aggregation |
| `types.ts` | Shared types incl. the `ProviderAdapter` seam |

## Setup

Requires **Node 20.6+**.

```bash
cp .env.example .env     # add ANTHROPIC_API_KEY and OPENAI_API_KEY
npm install
npm run dev              # dev server on :3000
```

Anthropic is the primary answer provider. OpenAI is required for the
GPT-4.1-mini complexity analyser and for fallback models. If `ANTHROPIC_API_KEY`
is empty, routing automatically switches to OpenAI-only targets.

Set `GATEWAY_API_KEYS` in your local `.env` to a private value and use that
same value in the `Authorization` header examples below. Never commit your real
`.env`.

## Try it

```bash
# See the routing decision without generating an answer.
# This still calls the GPT-4.1-mini complexity analyser.
curl -X POST localhost:3000/v1/route \
  -H "Authorization: Bearer <your-gateway-key>" -H "Content-Type: application/json" \
  -d '{"prompt":"Design a scalable distributed chat system."}'
# -> deep/strong -> anthropic/claude-opus-4-7, or openai/o1 if Anthropic is not configured

curl -X POST localhost:3000/v1/route \
  -H "Authorization: Bearer <your-gateway-key>" -H "Content-Type: application/json" \
  -d '{"prompt":"What is the capital of France?"}'
# -> fast -> anthropic/claude-haiku-4-5, or openai/gpt-4o-mini if Anthropic is not configured

# Full chat (auto-routed):
curl -X POST localhost:3000/v1/chat \
  -H "Authorization: Bearer <your-gateway-key>" -H "Content-Type: application/json" \
  -d '{"prompt":"Write me a haiku about autumn."}'
# -> complexity route -> selected provider/model

# Override routing:
curl -X POST localhost:3000/v1/chat \
  -H "Authorization: Bearer <your-gateway-key>" -H "Content-Type: application/json" \
  -d '{"prompt":"Hello","preferences":{"forceModel":"claude-opus-4-7"}}'
```

`/v1/chat` metadata now includes `complexityRoute`, `complexityScores`,
`complexityReason`, `routingReason`, and `fallbackUsed`.

## Use it from an editor (OpenAI-compatible facade)

The gateway also speaks the **OpenAI Chat Completions protocol**, so any tool
that accepts a custom OpenAI-compatible provider — **Continue.dev, Cline, Cursor,
Zed, GitHub Copilot Chat (BYOK), the `openai` SDK**, etc. — can use it as a model
provider. Point the tool at:

```
Base URL: http://localhost:3000/v1
API key:  <your-gateway-key> (any GATEWAY_API_KEYS value)
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
  -H "Authorization: Bearer <your-gateway-key>" -H "Content-Type: application/json" \
  -d '{"model":"gateway-auto","messages":[{"role":"user","content":"Write a haiku about autumn."}]}'

# Streaming (SSE):
curl -N -X POST localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer <your-gateway-key>" -H "Content-Type: application/json" \
  -d '{"model":"gateway-auto","stream":true,"messages":[{"role":"user","content":"Hi"}]}'

# Tool / function calling:
curl -X POST localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer <your-gateway-key>" -H "Content-Type: application/json" \
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

| Complexity route | Primary with Anthropic key | OpenAI-only when Anthropic key is empty |
|------------------|----------------------------|----------------------------------------|
| fast | anthropic / claude-haiku-4-5 | openai / gpt-4o-mini |
| balanced | anthropic / claude-sonnet-4-6 | openai / gpt-4o |
| strong | anthropic / claude-opus-4-7 | openai / o1 |
| deep | anthropic / claude-opus-4-7 | openai / o1 |

When Anthropic is configured, OpenAI models are the fallback chain. When
`ANTHROPIC_API_KEY` is empty, the router only returns OpenAI targets. The
complexity analyser itself remains `gpt-4.1-mini`.

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
  -H "Authorization: Bearer <your-gateway-key>" -H "Content-Type: application/json" \
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
curl localhost:3000/v1/usage -H "Authorization: Bearer <your-gateway-key>"
curl "localhost:3000/v1/usage?scope=me&since=2026-06-01T00:00:00Z" \
  -H "Authorization: Bearer <your-gateway-key>"
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
npm test                 # runs all no-network suites
npm run test:routing     # >= 17/20 prompts route to expected model
npm run test:optimizer   # verbose shrinks, clean no-ops, ZERO intent drift
npm run test:usage       # aggregation, filters, baseline-savings math
npm run test:hardening   # guard blocks/flags, rate limit, budget caps
```

All suites run with **no network calls**.

## ⚠️ Caveats

- Prices in `config.ts` are **illustrative** — verify against live provider pricing before trusting cost numbers.
- The complexity classifier is an **LLM call** (`gpt-4.1-mini`). It adds a small routing cost/latency before every generated answer.
- In-memory state (usage, rate limiter, budget) is **per-instance**. For multiple replicas, back the `UsageStore` with Postgres and the limiter/budget with Redis (same interfaces).
- The PII/jailbreak guard is a **first line of defense**, not a complete safety stack — it complements provider-side guardrails, it doesn't replace them.
- ✅ **Verified after flattening:** `npm run typecheck` passes clean; all four no-network suites pass (routing, optimizer, usage, hardening).
