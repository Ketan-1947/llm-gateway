// Native route definitions (full pipeline as of Phase 5):
//   POST /v1/chat          — rate-limit -> guard -> optimise -> classify ->
//                            route -> budget -> dispatch -> log
//   POST /v1/route         — DRY RUN: optimise + classify + route, no LLM call
//   POST /v1/optimise-only — optimise a prompt, no LLM call, no routing
//   GET  /v1/usage         — aggregated token/cost stats (+ baseline savings)
//   GET  /v1/health        — liveness + provider config flags
//
// The OpenAI-compatible facade (/v1/chat/completions, /v1/models) lives in
// openaiCompat.ts and reuses the same pipeline.

import type { FastifyInstance } from "fastify";
import { apiKeyAuth, requestKeyId } from "./auth.js";
import { config } from "./config.js";
import { CLASSIFIER_MODEL } from "./config.js";
import { classify } from "./classifier.js";
import { optimize } from "./optimizer.js";
import { estCostSaved, runChatPipeline, type Services } from "./pipeline.js";
import { route } from "./router.js";
import type { ChatRequestBody } from "./types.js";

export type { Services } from "./pipeline.js";

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
  const { usage } = services;

  // --- POST /v1/chat (native shape) ---
  app.post<{ Body: ChatRequestBody }>(
    "/v1/chat",
    { preHandler: apiKeyAuth, schema: { body: chatBodySchema } },
    async (req, reply) => {
      const { prompt, context, preferences } = req.body;
      const { body, requestId } = await runChatPipeline(services, {
        prompt,
        context,
        preferences,
        keyId: requestKeyId(req),
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
      const classification = await classify(effectivePrompt, context);
      const decision = route(classification, preferences);
      return {
        optimisedPrompt: effectivePrompt,
        rulesApplied: opt?.rulesApplied ?? [],
        tokensSaved: opt?.tokensSaved ?? 0,
        estCostSaved: estCostSaved(decision.model, opt?.tokensSaved ?? 0),
        complexityRoute: classification.route,
        complexityScores: classification.scores,
        complexityReason: classification.reason,
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
      classifier: {
        type: "complexity",
        model: CLASSIFIER_MODEL,
      },
      authEnabled: config.gatewayApiKeys.length > 0,
    };
  });
}
