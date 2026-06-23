// Environment config + the central model price table.
// Prices are the SINGLE source of truth for cost — adapters never trust
// vendor-reported costs, they compute from here.

// import type { ProviderName } from "./shared/types.js";

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProviderName } from "./shared/types.js";

// Load .env regardless of how the app is launched.
function loadDotenv(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const path of [join(process.cwd(), ".env"), join(here, ".env")]) {
    if (!existsSync(path)) continue;
    for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
    break;
  }
}
loadDotenv();

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

export const config = {
  port: Number(env("PORT", "3000")),
  host: env("HOST", "0.0.0.0"),
  // Primary answer provider. If empty, routing switches to OpenAI-only models.
  anthropicApiKey: env("ANTHROPIC_API_KEY", ""),
  // Required for complexity analysis and OpenAI fallback / OpenAI-only routing.
  openaiApiKey: env("OPENAI_API_KEY", ""),
  // Plaintext keys (dev) — empty AND no hashes => auth disabled.
  gatewayApiKeys: env("GATEWAY_API_KEYS", "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean),
  // Production: sha256 hashes of accepted keys (hex). Raw keys never stored.
  gatewayApiKeyHashes: env("GATEWAY_API_KEY_HASHES", "")
    .split(",")
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean),
  defaultModel: env("DEFAULT_MODEL", "claude-haiku-4-5"),
  defaultMaxTokens: Number(env("DEFAULT_MAX_TOKENS", "1024")),
  defaultTemperature: Number(env("DEFAULT_TEMPERATURE", "0.7")),
  // Observability (Phase 4). The "what would naive usage have cost?" baseline
  // is the headline savings metric (see architecture doc Hard Problem 3).
  baselineModel: env("BASELINE_MODEL", "claude-sonnet-4-6"),
  // Optional append-only JSONL log file; empty = in-memory only.
  usageLogFile: env("USAGE_LOG_FILE", ""),
  // Hardening (Phase 5). 0 disables a given limit.
  rateLimitPerMin: Number(env("RATE_LIMIT_PER_MIN", "60")),
  dailyBudgetUsd: Number(env("DAILY_BUDGET_USD", "0")),
  maxRequestCostUsd: Number(env("MAX_REQUEST_COST_USD", "0")),
  maxPromptTokens: Number(env("MAX_PROMPT_TOKENS", "150000")),
  jailbreakBlock: env("JAILBREAK_BLOCK", "true") === "true",
  piiMode: env("PII_MODE", "flag"), // "flag" | "block"
};

/** USD per 1,000 tokens. ILLUSTRATIVE — verify against live provider
 *  pricing before production. Several model ids here are custom to this
 *  project's spec. */
export interface ModelPrice {
  provider: ProviderName;
  inputPer1k: number;
  outputPer1k: number;
}

export const PRICE_TABLE: Record<string, ModelPrice> = {
  // Anthropic
  "claude-haiku-4-5": { provider: "anthropic", inputPer1k: 0.001, outputPer1k: 0.005 },
  "claude-sonnet-4-6": { provider: "anthropic", inputPer1k: 0.003, outputPer1k: 0.015 },
  "claude-opus-4-7": { provider: "anthropic", inputPer1k: 0.015, outputPer1k: 0.075 },
  // OpenAI
  "gpt-4o": { provider: "openai", inputPer1k: 0.0025, outputPer1k: 0.01 },
  "gpt-4o-mini": { provider: "openai", inputPer1k: 0.00015, outputPer1k: 0.0006 },
  "o3-mini": { provider: "openai", inputPer1k: 0.0011, outputPer1k: 0.0044 },
  "o1": { provider: "openai", inputPer1k: 0.015, outputPer1k: 0.06 },
};

/** Compute USD cost for a completed call. Falls back to 0 with a warning
 *  for unknown models so a missing price never crashes a request. */
export function computeCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const price = PRICE_TABLE[model];
  if (!price) {
    console.warn(`[cost] No price entry for model "${model}"; reporting cost=0`);
    return 0;
  }
  const cost =
    (inputTokens / 1000) * price.inputPer1k +
    (outputTokens / 1000) * price.outputPer1k;
  // round to 6 dp to avoid float noise in metadata
  return Math.round(cost * 1e6) / 1e6;
}
