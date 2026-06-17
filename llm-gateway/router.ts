// ModelRouter — Phase 2. Pure decision logic: given a classification (and
// optional client prefs), pick provider + model and a fallback chain, with a
// human-readable reason. No I/O here; execution lives in dispatch.ts.

import { PRICE_TABLE } from "./config.js";
import {
  GatewayError,
  type ChatPreferences,
  type ClassifierResult,
  type RouteTarget,
  type RoutingDecision,
  type TaskType,
} from "./types.js";

/** Below this confidence the router rounds UP to a more capable model. */
const CONFIDENCE_THRESHOLD = 0.6;

/** Primary routing table (mirrors the architecture doc §2.4). */
const ROUTING_TABLE: Record<TaskType, RouteTarget & { note: string }> = {
  SIMPLE_QA: { provider: "anthropic", model: "claude-haiku-4-5", note: "factual single-turn — cheapest capable tier" },
  CONVERSATION: { provider: "anthropic", model: "claude-haiku-4-5", note: "casual chat — fast and cheap" },
  CREATIVE: { provider: "anthropic", model: "claude-sonnet-4-6", note: "strong prose at balanced cost" },
  CODE_SIMPLE: { provider: "anthropic", model: "claude-sonnet-4-6", note: "scripts/debugging — Sonnet handles cheaply" },
  LONG_CONTEXT: { provider: "anthropic", model: "claude-sonnet-4-6", note: "large-context at sane cost" },
  SAFETY_SENSITIVE: { provider: "anthropic", model: "claude-sonnet-4-6", note: "careful handling, mid-tier headroom" },
  REASONING: { provider: "openai", model: "o3-mini", note: "dedicated low-cost reasoning" },
  CODE_COMPLEX: { provider: "anthropic", model: "claude-opus-4-7", note: "architecture/system design — top capability" },
  RESEARCH: { provider: "anthropic", model: "claude-opus-4-7", note: "multi-step deep analysis" },
  MULTIMODAL: { provider: "openai", model: "gpt-4o", note: "image-capable default" },
};

/** One-tier-up escalation used on low-confidence classifications. */
const ESCALATION: Record<string, RouteTarget> = {
  "claude-haiku-4-5": { provider: "anthropic", model: "claude-sonnet-4-6" },
  "claude-sonnet-4-6": { provider: "anthropic", model: "claude-opus-4-7" },
  "o3-mini": { provider: "openai", model: "o1" },
  "gpt-4o-mini": { provider: "openai", model: "gpt-4o" },
};

/** Deterministic fallback chains (cross-provider, then degrade). */
const FALLBACKS: Record<string, RouteTarget[]> = {
  "claude-haiku-4-5": [{ provider: "openai", model: "gpt-4o-mini" }],
  "claude-sonnet-4-6": [
    { provider: "openai", model: "gpt-4o" },
    { provider: "anthropic", model: "claude-haiku-4-5" },
  ],
  "claude-opus-4-7": [
    { provider: "openai", model: "o1" },
    { provider: "anthropic", model: "claude-sonnet-4-6" },
  ],
  "o3-mini": [
    { provider: "anthropic", model: "claude-sonnet-4-6" },
    { provider: "openai", model: "gpt-4o-mini" },
  ],
  "o1": [
    { provider: "anthropic", model: "claude-opus-4-7" },
    { provider: "anthropic", model: "claude-sonnet-4-6" },
  ],
  "gpt-4o": [{ provider: "anthropic", model: "claude-sonnet-4-6" }],
  "gpt-4o-mini": [{ provider: "anthropic", model: "claude-haiku-4-5" }],
};

export function route(
  classification: ClassifierResult,
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
      fallbacks: [], // respect an explicit choice — don't silently switch
    };
  }

  const base = ROUTING_TABLE[classification.taskType];
  let target: RouteTarget = { provider: base.provider, model: base.model };
  let reason = `${classification.taskType} (conf ${classification.confidence.toFixed(
    2,
  )}): ${base.note}. Signals: ${classification.signals.join(", ")}.`;

  // Low confidence -> round up to a more capable model where one exists.
  if (classification.confidence < CONFIDENCE_THRESHOLD && ESCALATION[base.model]) {
    target = ESCALATION[base.model];
    reason =
      `Low confidence (${classification.confidence.toFixed(2)}) on ` +
      `${classification.taskType}; rounded up ${base.model} -> ${target.model} to protect quality. ` +
      `Signals: ${classification.signals.join(", ")}.`;
  }

  return {
    provider: target.provider,
    model: target.model,
    reason,
    fallbacks: FALLBACKS[target.model] ?? [],
  };
}

// Exposed for tests / inspection.
export { ROUTING_TABLE, FALLBACKS, ESCALATION, CONFIDENCE_THRESHOLD };
