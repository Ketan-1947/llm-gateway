// Route definitions (full pipeline as of Phase 5):
//   POST /v1/chat          — rate-limit -> guard -> optimise -> classify ->
//                            route -> budget -> dispatch -> log
//   POST /v1/route         — DRY RUN: optimise + classify + route, no LLM call
//   POST /v1/optimise-only — optimise a prompt, no LLM call, no routing
//   GET  /v1/usage         — aggregated token/cost stats (+ baseline savings)
//   GET  /v1/health        — liveness + provider config flags
//   GET  /v1/models        — model catalog with prices

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { apiKeyAuth, requestKeyId } from "./auth.js";
import { estimateRequestCost, type BudgetTracker } from "./budget.js";
import { classify, estimateTokens } from "./classifier.js";
import { config, PRICE_TABLE } from "./config.js";
import type { ProviderManager } from "./dispatch.js";
import { preflightGuard } from "./guard.js";
import { optimize } from "./optimizer.js";
import type { RateLimiter } from "./rateLimit.js";
import { route } from "./router.js";
import {
  GatewayError,
  type ChatRequestBody,
  type ChatResponseBody,
  type LLMRequest,
  type Message,
} from "./types.js";
import type { UsageStore } from "./usageStore.js";

/** Everything the routes need, bundled so the signature stays stable. */
export interface Services {
  manager: ProviderManager;
  usage: UsageStore;
  limiter: RateLimiter;
  budget: BudgetTracker;
}

/** Price tokensSaved at a model's input rate (USD). */
function estCostSaved(model: string, tokensSaved: number): number {
  const price = PRICE_TABLE[model];
  if (!price || tokensSaved <= 0) return 0;
  return Math.round((tokensSaved / 1000) * price.inputPer1k * 1e6) / 1e6;
}

const chatBodySchema = {
  type: "object",
  required: ["prompt"],
  properties: {
    prompt: { type: "string", minLength: 1 },
    context: {
      type: "array",
      items: {
        type: "object",
        required: ["role", "content"],
        properties: {
          role: { type: "string", enum: ["user", "assistant"] },
          content: { type: "string" },
        },
      },
    },
    preferences: {
      type: "object",
      properties: {
        forceModel: { type: "string" },
        optimise: { type: "boolean" },
        showOptimisedPrompt: { type: "boolean" },
        maxCost: { type: "number" },
      },
    },
  },
} as const;

export function registerRoutes(app: FastifyInstance, services: Services): void {
  const { manager, usage, limiter, budget } = services;
  // --- POST /v1/chat ---
  app.post<{ Body: ChatRequestBody }>(
    "/v1/chat",
    { preHandler: apiKeyAuth, schema: { body: chatBodySchema } },
    async (req, reply) => {
      const { prompt, context, preferences } = req.body;
      const requestId = `req_${randomUUID()}`;
      const keyId = requestKeyId(req);

      // 1) Rate limit (per key, before any work).
      limiter.check(keyId);

      // 2) Pre-flight guard on the raw prompt (PII / jailbreak / size).
      const guard = preflightGuard(prompt, estimateTokens(prompt, context));
      if (guard.action === "block") {
        throw new GatewayError(400, guard.code ?? "prompt_blocked", guard.message ?? "Blocked.");
      }

      // 3) Optimize unless opted out (only ever helps or no-ops).
      const doOptimise = preferences?.optimise !== false;
      const opt = doOptimise ? optimize(prompt) : null;
      const effectivePrompt = opt ? opt.optimisedPrompt : prompt;

      // 4) Route on the (possibly optimized) prompt: optimise -> route.
      const classification = classify(effectivePrompt, context);
      const decision = route(classification, preferences);

      const messages: Message[] = [
        ...(context ?? []),
        { role: "user", content: effectivePrompt },
      ];

      const baseReq: Omit<LLMRequest, "model"> = {
        messages,
        maxTokens: config.defaultMaxTokens,
        temperature: config.defaultTemperature,
        ...(opt?.systemPromptSuggestion
          ? { systemPrompt: opt.systemPromptSuggestion }
          : {}),
      };

      // 5) Budget check BEFORE spending (worst-case = full output budget).
      const estimate = estimateRequestCost(
        decision.model,
        estimateTokens(effectivePrompt, context),
        config.defaultMaxTokens,
      );
      budget.enforce(keyId, estimate, preferences?.maxCost);

      // 6) Dispatch.
      const { response: llmRes, fallbackUsed } = await manager.dispatch(
        decision,
        baseReq,
      );

      // 7) Record actual spend against the daily budget.
      budget.addSpend(keyId, llmRes.cost);

      const tokensSaved = opt?.tokensSaved ?? 0;

      const body: ChatResponseBody = {
        response: llmRes.content,
        metadata: {
          originalPrompt: prompt,
          optimisedPrompt: effectivePrompt,
          rulesApplied: opt?.rulesApplied ?? [],
          tokensSaved,
          estCostSaved: estCostSaved(decision.model, tokensSaved),
          modelUsed: llmRes.model,
          provider: llmRes.provider,
          taskType: classification.taskType,
          classificationConfidence: classification.confidence,
          routingReason: decision.reason,
          fallbackUsed,
          guardFlags: guard.flags,
          tokensUsed: llmRes.tokensUsed,
          cost: llmRes.cost,
          latencyMs: llmRes.latencyMs,
          requestId,
        },
      };

      // Phase 4: log the request (cost meter + usage). Never throw from here.
      usage.append({
        requestId,
        timestamp: new Date().toISOString(),
        apiKeyId: keyId,
        taskType: classification.taskType,
        provider: llmRes.provider,
        model: llmRes.model,
        tokensIn: llmRes.tokensUsed.input,
        tokensOut: llmRes.tokensUsed.output,
        cost: llmRes.cost,
        tokensSaved,
        estCostSaved: body.metadata.estCostSaved,
        latencyMs: llmRes.latencyMs,
        fallbackUsed,
        optimised: doOptimise,
      });

      reply.header("x-request-id", requestId);
      return body;
    },
  );

  // --- GET /v1/usage (aggregated token/cost stats; no LLM call) ---
  app.get<{ Querystring: { since?: string; scope?: string } }>(
    "/v1/usage",
    { preHandler: apiKeyAuth },
    async (req) => {
      // scope=me limits stats to the calling key; default is global.
      const apiKeyId = req.query.scope === "me" ? requestKeyId(req) : undefined;
      return usage.summary({ since: req.query.since, apiKeyId });
    },
  );

  // --- POST /v1/route (dry run: optimise + classify + route, no LLM call) ---
  app.post<{ Body: ChatRequestBody }>(
    "/v1/route", // POST: needs a body, but never calls an LLM
    { preHandler: apiKeyAuth, schema: { body: chatBodySchema } },
    async (req) => {
      const { prompt, context, preferences } = req.body;
      const doOptimise = preferences?.optimise !== false;
      const opt = doOptimise ? optimize(prompt) : null;
      const effectivePrompt = opt ? opt.optimisedPrompt : prompt;
      const classification = classify(effectivePrompt, context);
      const decision = route(classification, preferences);
      return {
        optimisedPrompt: effectivePrompt,
        rulesApplied: opt?.rulesApplied ?? [],
        tokensSaved: opt?.tokensSaved ?? 0,
        estCostSaved: estCostSaved(decision.model, opt?.tokensSaved ?? 0),
        taskType: classification.taskType,
        confidence: classification.confidence,
        signals: classification.signals,
        approxTokens: classification.approxTokens,
        provider: decision.provider,
        model: decision.model,
        routingReason: decision.reason,
        fallbacks: decision.fallbacks,
      };
    },
  );

  // --- POST /v1/optimise-only (optimise a prompt; no LLM call, no routing) ---
  app.post<{ Body: ChatRequestBody }>(
    "/v1/optimise-only",
    { preHandler: apiKeyAuth, schema: { body: chatBodySchema } },
    async (req) => {
      const { prompt } = req.body;
      return optimize(prompt);
    },
  );

  // --- GET /v1/health ---
  app.get("/v1/health", async () => {
    return {
      status: "ok",
      uptimeSeconds: Math.round(process.uptime()),
      providers: {
        anthropic: Boolean(config.anthropicApiKey),
        openai: Boolean(config.openaiApiKey),
      },
      authEnabled: config.gatewayApiKeys.length > 0,
    };
  });

  // --- GET /v1/models ---
  app.get("/v1/models", async () => {
    return {
      models: Object.entries(PRICE_TABLE).map(([id, p]) => ({
        id,
        provider: p.provider,
        inputPer1k: p.inputPer1k,
        outputPer1k: p.outputPer1k,
      })),
      default: config.defaultModel,
    };
  });
}
