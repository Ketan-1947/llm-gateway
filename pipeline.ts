// Shared request pipeline: rate-limit -> guard -> optimise -> classify ->
// route -> budget -> dispatch -> log. Extracted so BOTH the native /v1/chat
// route and the OpenAI-compatible /v1/chat/completions facade run the exact
// same logic — only request/response translation differs at the edges.
//
// Two shapes of input are supported:
//   • simple  — {prompt, context}: the optimiser runs, then classify+route.
//   • rich     — {messages, tools}: a full normalized message list is passed
//                through verbatim (for tool/agent conversations); the optimiser
//                is skipped (it rewrites a single prompt string and would lose
//                tool-call structure), but classify+route still apply.

import { randomUUID } from "node:crypto";
import { estimateRequestCost, type BudgetTracker } from "./budget.js";
import { classify, estimateTokens } from "./classifier.js";
import { config, PRICE_TABLE } from "./config.js";
import type { ProviderManager } from "./dispatch.js";
import { preflightGuard } from "./guard.js";
import { optimize } from "./optimizer.js";
import type { RateLimiter } from "./rateLimit.js";
import { route } from "./router.js";
import {
  type ComplexityResult,
  GatewayError,
  type ChatPreferences,
  type ChatResponseBody,
  type LLMRequest,
  type LLMResponse,
  type Message,
  type RoutingDecision,
  type ToolChoice,
  type ToolDef,
} from "./types.js";
import type { UsageStore } from "./usageStore.js";

/** Everything the pipeline/routes need, bundled so signatures stay stable. */
export interface Services {
  manager: ProviderManager;
  usage: UsageStore;
  limiter: RateLimiter;
  budget: BudgetTracker;
}

/** Price tokensSaved at a model's input rate (USD). */
export function estCostSaved(model: string, tokensSaved: number): number {
  const price = PRICE_TABLE[model];
  if (!price || tokensSaved <= 0) return 0;
  return Math.round((tokensSaved / 1000) * price.inputPer1k * 1e6) / 1e6;
}

/** Normalized input to the pipeline (independent of the wire format used). */
export interface PipelineInput {
  /** Stable per-key id for rate-limit/budget/stats (see auth.requestKeyId). */
  keyId: string;
  preferences?: ChatPreferences;
  /** Optional system prompt supplied by the caller (e.g. an editor). */
  systemPrompt?: string;
  /** Output cap override; defaults to config.defaultMaxTokens. */
  maxTokens?: number;
  /** Sampling temperature override; defaults to config.defaultTemperature. */
  temperature?: number;

  // --- simple shape ---
  prompt?: string;
  context?: Message[];

  // --- rich shape (tool/agent conversations) ---
  messages?: Message[];
  tools?: ToolDef[];
  toolChoice?: ToolChoice;
  /** Text used for classify/guard in rich mode (defaults to the last user turn). */
  classifyText?: string;
}

/** Internal carry between prepare() and finalize(). */
interface Prepared {
  requestId: string;
  keyId: string;
  decision: RoutingDecision;
  baseReq: Omit<LLMRequest, "model">;
  classification: ComplexityResult;
  guardFlags: string[];
  doOptimise: boolean;
  tokensSaved: number;
  rulesApplied: string[];
  originalPrompt: string;
  effectivePrompt: string;
}

export interface PipelineResult {
  body: ChatResponseBody;
  /** The raw provider response — useful for protocol-specific shaping. */
  llm: LLMResponse;
  requestId: string;
}

function lastUserText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i].content;
  }
  return messages[messages.length - 1]?.content ?? "";
}

/**
 * Steps 1–5: rate-limit -> guard -> optimise -> classify -> route -> budget.
 * No provider spend yet. Throws GatewayError on rate-limit / guard / budget
 * failures BEFORE any dispatch.
 */
async function prepare(services: Services, input: PipelineInput): Promise<Prepared> {
  const { limiter, budget } = services;
  const { keyId, preferences } = input;
  const requestId = `req_${randomUUID()}`;
  const rich = Array.isArray(input.messages);

  limiter.check(keyId);

  const guardText = rich
    ? input.classifyText ?? lastUserText(input.messages!)
    : input.prompt ?? "";
  const contextForCount = rich ? input.messages : input.context;

  if (!guardText) {
    throw new GatewayError(400, "invalid_request", "No prompt/messages to process.");
  }

  const guard = preflightGuard(guardText, estimateTokens(guardText, contextForCount));
  if (guard.action === "block") {
    throw new GatewayError(400, guard.code ?? "prompt_blocked", guard.message ?? "Blocked.");
  }

  const doOptimise = !rich && preferences?.optimise !== false;
  const opt = doOptimise ? optimize(input.prompt!) : null;
  const effectivePrompt = rich ? guardText : opt ? opt.optimisedPrompt : input.prompt!;

  const classification = await classify(effectivePrompt, contextForCount);
  const decision = route(classification, preferences);

  const dispatchMessages: Message[] = rich
    ? input.messages!
    : [...(input.context ?? []), { role: "user", content: effectivePrompt }];

  // Preserve a caller-supplied system prompt; keep the optimiser's suggestion
  // too when present (caller's instructions first so they take precedence).
  const systemPrompt =
    [input.systemPrompt, opt?.systemPromptSuggestion].filter(Boolean).join("\n\n") ||
    undefined;

  const maxTokens = input.maxTokens ?? config.defaultMaxTokens;
  const baseReq: Omit<LLMRequest, "model"> = {
    messages: dispatchMessages,
    maxTokens,
    temperature: input.temperature ?? config.defaultTemperature,
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(input.tools?.length ? { tools: input.tools } : {}),
    ...(input.toolChoice ? { toolChoice: input.toolChoice } : {}),
  };

  // 5) Budget check BEFORE spending (worst-case = full output budget).
  const estimate = estimateRequestCost(
    decision.model,
    estimateTokens(effectivePrompt, contextForCount),
    maxTokens,
  );
  budget.enforce(keyId, estimate, preferences?.maxCost);

  return {
    requestId,
    keyId,
    decision,
    baseReq,
    classification,
    guardFlags: guard.flags,
    doOptimise,
    tokensSaved: opt?.tokensSaved ?? 0,
    rulesApplied: opt?.rulesApplied ?? [],
    originalPrompt: rich ? guardText : input.prompt!,
    effectivePrompt,
  };
}

/** Build the response body, record spend, and log usage. Never throws. */
function finalize(
  services: Services,
  p: Prepared,
  llm: LLMResponse,
  fallbackUsed: boolean,
): ChatResponseBody {
  services.budget.addSpend(p.keyId, llm.cost);

  const estSaved = estCostSaved(p.decision.model, p.tokensSaved);
  const body: ChatResponseBody = {
    response: llm.content,
    metadata: {
      originalPrompt: p.originalPrompt,
      optimisedPrompt: p.effectivePrompt,
      rulesApplied: p.rulesApplied,
      tokensSaved: p.tokensSaved,
      estCostSaved: estSaved,
      modelUsed: llm.model,
      provider: llm.provider,
      complexityRoute: p.classification.route,
      complexityScores: p.classification.scores,
      complexityReason: p.classification.reason,
      approxTokens: p.classification.approxTokens,
      routingReason: p.decision.reason,
      fallbackUsed,
      guardFlags: p.guardFlags,
      tokensUsed: llm.tokensUsed,
      cost: llm.cost,
      latencyMs: llm.latencyMs,
      requestId: p.requestId,
    },
  };

  services.usage.append({
    requestId: p.requestId,
    timestamp: new Date().toISOString(),
    apiKeyId: p.keyId,
    complexityRoute: p.classification.route,
    provider: llm.provider,
    model: llm.model,
    tokensIn: llm.tokensUsed.input,
    tokensOut: llm.tokensUsed.output,
    cost: llm.cost,
    tokensSaved: p.tokensSaved,
    estCostSaved: estSaved,
    latencyMs: llm.latencyMs,
    fallbackUsed,
    optimised: p.doOptimise,
  });

  return body;
}

/**
 * Run the full gateway pipeline for a single chat turn (one-shot). Throws
 * GatewayError on rate-limit / guard / budget / provider failures.
 */
export async function runChatPipeline(
  services: Services,
  input: PipelineInput,
): Promise<PipelineResult> {
  const p = await prepare(services, input);
  const { response: llm, fallbackUsed } = await services.manager.dispatch(
    p.decision,
    p.baseReq,
  );
  const body = finalize(services, p, llm, fallbackUsed);
  return { body, llm, requestId: p.requestId };
}

/** Event stream emitted by runChatPipelineStream. */
export type PipelineStreamEvent =
  | { type: "start"; requestId: string; model: string }
  | { type: "delta"; text: string };

/**
 * Streaming variant: yields a "start" event (after the no-spend prepare steps,
 * before any token), then "delta" events, and RETURNS the final body + llm
 * response once the stream completes (usage logged in finalize()).
 *
 * GatewayError from prepare() (rate-limit/guard/budget) is thrown on the first
 * .next(), before "start" — so the caller can still respond with a clean JSON
 * error. Provider failures before the first token fail over inside dispatch.
 */
export async function* runChatPipelineStream(
  services: Services,
  input: PipelineInput,
): AsyncGenerator<PipelineStreamEvent, { body: ChatResponseBody; llm: LLMResponse }, void> {
  const p = await prepare(services, input);
  yield { type: "start", requestId: p.requestId, model: p.decision.model };

  const gen = services.manager.dispatchStream(p.decision, p.baseReq);
  let step = await gen.next();
  while (!step.done) {
    yield { type: "delta", text: step.value };
    step = await gen.next();
  }
  const { response: llm, fallbackUsed } = step.value;
  const body = finalize(services, p, llm, fallbackUsed);
  return { body, llm };
}
