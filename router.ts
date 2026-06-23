// ModelRouter — maps complexity analysis to provider/model targets.
// The router is pure decision logic; provider execution lives in dispatch.ts.

import { config, PRICE_TABLE } from "./config.js";
import {
  type ComplexityResult,
  type ComplexityRoute,
  GatewayError,
  type ChatPreferences,
  type RouteTarget,
  type RoutingDecision,
} from "./types.js";

const ANTHROPIC_PRIMARY_TABLE: Record<ComplexityRoute, RouteTarget & { note: string }> = {
  fast: {
    provider: "anthropic",
    model: "claude-haiku-4-5",
    note: "low complexity — cheapest capable tier",
  },
  balanced: {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    note: "normal assistant work — balanced quality and cost",
  },
  strong: {
    provider: "anthropic",
    model: "claude-opus-4-7",
    note: "high complexity — stronger model for precision and scope",
  },
  deep: {
    provider: "anthropic",
    model: "claude-opus-4-7",
    note: "deep complexity — top general capability",
  },
};

const OPENAI_ONLY_TABLE: Record<ComplexityRoute, RouteTarget & { note: string }> = {
  fast: {
    provider: "openai",
    model: "gpt-4o-mini",
    note: "low complexity — cheapest OpenAI tier",
  },
  balanced: {
    provider: "openai",
    model: "gpt-4o",
    note: "normal assistant work — balanced OpenAI model",
  },
  strong: {
    provider: "openai",
    model: "o1",
    note: "high complexity — strongest OpenAI reasoning tier",
  },
  deep: {
    provider: "openai",
    model: "o1",
    note: "deep complexity — strongest OpenAI reasoning tier",
  },
};

const ANTHROPIC_PRIMARY_FALLBACKS: Record<string, RouteTarget[]> = {
  "claude-haiku-4-5": [{ provider: "openai", model: "gpt-4o-mini" }],
  "claude-sonnet-4-6": [
    { provider: "openai", model: "gpt-4o" },
    { provider: "anthropic", model: "claude-haiku-4-5" },
  ],
  "claude-opus-4-7": [
    { provider: "openai", model: "o1" },
    { provider: "anthropic", model: "claude-sonnet-4-6" },
  ],
  "o1": [
    { provider: "anthropic", model: "claude-opus-4-7" },
    { provider: "anthropic", model: "claude-sonnet-4-6" },
  ],
  "gpt-4o": [{ provider: "anthropic", model: "claude-sonnet-4-6" }],
  "gpt-4o-mini": [{ provider: "anthropic", model: "claude-haiku-4-5" }],
};

const OPENAI_ONLY_FALLBACKS: Record<string, RouteTarget[]> = {
  "o1": [{ provider: "openai", model: "gpt-4o" }],
  "gpt-4o": [{ provider: "openai", model: "gpt-4o-mini" }],
};

function routingTable(): Record<ComplexityRoute, RouteTarget & { note: string }> {
  return config.anthropicApiKey ? ANTHROPIC_PRIMARY_TABLE : OPENAI_ONLY_TABLE;
}

function fallbackTable(): Record<string, RouteTarget[]> {
  return config.anthropicApiKey ? ANTHROPIC_PRIMARY_FALLBACKS : OPENAI_ONLY_FALLBACKS;
}

function scoreSummary(classification: ComplexityResult): string {
  return Object.entries(classification.scores)
    .map(([key, value]) => `${key}:${value}`)
    .join(", ");
}

export function route(
  classification: ComplexityResult,
  prefs?: ChatPreferences,
): RoutingDecision {
  // Client override always wins (within budget, enforced in Phase 5).
  if (prefs?.forceModel) {
    const price = PRICE_TABLE[prefs.forceModel];
    if (!price) {
      throw new GatewayError(
        400,
        "unsupported_model",
        `Forced model "${prefs.forceModel}" is not in the model catalog.`,
      );
    }
    return {
      provider: price.provider,
      model: prefs.forceModel,
      reason: `Forced by client to "${prefs.forceModel}"; routing bypassed.`,
      fallbacks: [],
    };
  }

  const target = routingTable()[classification.route];
  const fallbacks = fallbackTable();

  return {
    provider: target.provider,
    model: target.model,
    reason:
      `Complexity ${classification.route}: ${target.note}. ` +
      `Reason: ${classification.reason}. Scores: ${scoreSummary(classification)}.`,
    fallbacks: fallbacks[target.model] ?? [],
  };
}

export {
  ANTHROPIC_PRIMARY_TABLE,
  OPENAI_ONLY_TABLE,
  ANTHROPIC_PRIMARY_FALLBACKS,
  OPENAI_ONLY_FALLBACKS,
};