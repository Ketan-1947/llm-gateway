// Pre-flight guard — Phase 5. Runs BEFORE any spend.
// Detects oversized input, jailbreak attempts, and PII. Policy is config-driven.
// This is a cheap first line of defense, NOT a replacement for provider-side
// safety — it complements it.

import { config } from "./config.js";

export interface GuardResult {
  action: "allow" | "block";
  code?: string; // GatewayError code when blocked
  message?: string;
  flags: string[]; // non-blocking observations (e.g. "pii:email")
}

const JAILBREAK: RegExp[] = [
  /ignore (all )?(your |the )?(previous|prior|above) (instructions|prompts|rules)/i,
  /disregard (your|the|all) (instructions|rules|system prompt|guidelines)/i,
  /\bDAN\b|do anything now/i,
  /developer mode|jailbreak/i,
  /pretend (you are|to be) (an? )?(unrestricted|uncensored)/i,
  /bypass (your )?(safety|guidelines|filters|restrictions)/i,
  /you have no (restrictions|rules|guidelines)/i,
];

const PII: { label: string; re: RegExp }[] = [
  { label: "pii:email", re: /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/i },
  { label: "pii:ssn", re: /\b\d{3}-\d{2}-\d{4}\b/ },
  { label: "pii:credit-card", re: /\b(?:\d[ -]?){13,16}\b/ },
  { label: "pii:phone", re: /\b(?:\+?\d{1,3}[ -]?)?\(?\d{3}\)?[ -]?\d{3}[ -]?\d{4}\b/ },
];

export function preflightGuard(prompt: string, approxTokens: number): GuardResult {
  const flags: string[] = [];

  // 1) Size cap (cheapest check; protects against runaway cost).
  if (config.maxPromptTokens > 0 && approxTokens > config.maxPromptTokens) {
    return {
      action: "block",
      code: "prompt_too_large",
      message: `Prompt ~${approxTokens} tokens exceeds limit of ${config.maxPromptTokens}.`,
      flags: ["oversize"],
    };
  }

  // 2) Jailbreak attempts.
  if (JAILBREAK.some((re) => re.test(prompt))) {
    flags.push("jailbreak-suspected");
    if (config.jailbreakBlock) {
      return {
        action: "block",
        code: "prompt_blocked",
        message: "Prompt appears to be a jailbreak/prompt-injection attempt.",
        flags,
      };
    }
  }

  // 3) PII detection.
  const piiHits = PII.filter((p) => p.re.test(prompt)).map((p) => p.label);
  if (piiHits.length) {
    flags.push(...piiHits);
    if (config.piiMode === "block") {
      return {
        action: "block",
        code: "pii_blocked",
        message: `Prompt contains PII (${piiHits.join(", ")}) and PII_MODE=block.`,
        flags,
      };
    }
  }

  return { action: "allow", flags };
}
