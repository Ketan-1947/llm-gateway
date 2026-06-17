// PromptOptimizer — Phase 3, rule-based only (NO LLM call).
//
// Contract: the optimizer can only ever HELP or NO-OP. It never makes a prompt
// worse and never changes intent. Every candidate is checked against an
// intent fingerprint (the set of content words in the original); if any
// content word is lost, the optimization is discarded and the original is
// returned untouched.
//
// Rules implemented here (subset of the architecture doc's R1–R15):
//   R8  normalize whitespace
//   R1  strip politeness / filler  ("Can you please ..." -> imperative)
//   R3  de-duplicate identical sentences
//   R2  inject an output-format hint for open-ended explain/describe prompts
//   R4  suggest an expert role (returned as systemPrompt; does NOT touch the
//       user text or the intent fingerprint)

import { estimateTokens } from "./classifier.js";

export interface OptimizeResult {
  optimisedPrompt: string;
  rulesApplied: string[];
  originalTokens: number;
  optimisedTokens: number;
  tokensSaved: number; // originalTokens - optimisedTokens (can be < 0)
  intentPreserved: boolean;
  systemPromptSuggestion?: string;
}

// --- Intent fingerprint -------------------------------------------------

const STOPWORDS = new Set([
  "please", "kindly", "could", "would", "should", "the", "a", "an", "of", "to",
  "for", "and", "or", "but", "with", "that", "this", "these", "those", "is",
  "are", "was", "were", "be", "been", "being", "do", "does", "did", "can",
  "you", "me", "my", "i", "we", "us", "it", "in", "on", "at", "by", "as",
  "from", "about", "into", "your", "their", "them", "they", "he", "she",
  // Filler / politeness words removed by R1 — excluded so the intent guard
  // is never tripped by stripping them.
  "wonder", "wondering", "like", "want", "need", "will", "just", "really",
  "very", "basically", "actually", "literally", "help", "thanks", "thank",
]);

/** Significant content words (len >= 4, not stopwords). Used to detect drift. */
function contentTokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !STOPWORDS.has(w)),
  );
}

/** True iff every content word in `original` survives in `candidate`. */
function intentPreserved(original: string, candidate: string): boolean {
  const before = contentTokens(original);
  const after = contentTokens(candidate);
  for (const w of before) if (!after.has(w)) return false;
  return true;
}

// --- Rules --------------------------------------------------------------

const POLITE_LEAD = [
  /^\s*i\s+was\s+wondering\s+if\s+you\s+could\s+/i,
  /^\s*i\s+would\s+(really\s+)?like\s+(you\s+)?to\s+/i,
  /^\s*i'?d\s+(really\s+)?like\s+(you\s+)?to\s+/i,
  /^\s*i\s+(need|want)\s+you\s+to\s+/i,
  /^\s*(could|can|would|will)\s+you\s+(please\s+|kindly\s+)?/i,
  /^\s*please\s+(could|can|would)\s+you\s+/i,
  /^\s*please\s+/i,
  /^\s*kindly\s+/i,
];

function capitalizeFirst(s: string): string {
  const t = s.trimStart();
  return t.length ? t[0].toUpperCase() + t.slice(1) : t;
}

function normalizeWhitespace(s: string): string {
  return s.replace(/[ \t]+/g, " ").replace(/\s*\n\s*\n\s*/g, "\n\n").trim();
}

function stripPoliteness(s: string): string {
  let out = s;
  for (const re of POLITE_LEAD) out = out.replace(re, "");
  // Remove stray inline politeness words.
  out = out.replace(/\b(please|kindly)\b/gi, " ");
  out = out.replace(/[ \t]+/g, " ").replace(/\s+([.,!?])/g, "$1").trim();
  return capitalizeFirst(out);
}

function dedupeSentences(s: string): { text: string; removed: number } {
  const parts = s.split(/(?<=[.!?])\s+/);
  const seen = new Set<string>();
  const kept: string[] = [];
  let removed = 0;
  for (const p of parts) {
    const key = p.trim().toLowerCase();
    if (key && seen.has(key)) {
      removed++;
      continue;
    }
    if (key) seen.add(key);
    kept.push(p);
  }
  return { text: kept.join(" ").trim(), removed };
}

const FORMAT_WORDS =
  /\b(bullet|bullets|list|steps?|numbered|table|paragraph|sentence|words?|concise|briefly|tl;?dr|json|markdown)\b/i;

function maybeFormatHint(s: string): string | null {
  // Only for clearly open-ended, single-request explain/describe prompts that
  // don't already specify a format. Additive (never removes meaning).
  if (FORMAT_WORDS.test(s)) return null;
  if (!/^(explain|describe|summari[sz]e|compare|outline)\b/i.test(s.trim())) {
    return null;
  }
  const sentenceCount = s.split(/[.!?]+/).filter((x) => x.trim()).length;
  if (sentenceCount > 1) return null; // keep it to simple single asks
  const base = s.trim().replace(/\s*$/, "").replace(/[.?!]*$/, "");
  return `${base} in 3 concise bullet points.`;
}

const ROLE_CUES: { re: RegExp; role: string }[] = [
  {
    re: /\b(architecture|system design|distributed system|microservices?|scalab|database schema|code review)\b/i,
    role: "You are a senior software architect. Be precise and call out trade-offs.",
  },
  {
    re: /\b(prove|theorem|derive|probability|complexity|algorithm)\b/i,
    role: "You are a careful mathematician. Show your reasoning step by step.",
  },
];

function maybeRole(s: string): string | undefined {
  for (const c of ROLE_CUES) if (c.re.test(s)) return c.role;
  return undefined;
}

// --- Public API ---------------------------------------------------------

export function optimize(prompt: string): OptimizeResult {
  const originalTokens = estimateTokens(prompt);
  const rulesApplied: string[] = [];

  let candidate = prompt;

  const ws = normalizeWhitespace(candidate);
  if (ws !== candidate) {
    rulesApplied.push("R8:whitespace");
    candidate = ws;
  }

  const stripped = stripPoliteness(candidate);
  if (stripped !== candidate) {
    rulesApplied.push("R1:strip-politeness");
    candidate = stripped;
  }

  const { text: deduped, removed } = dedupeSentences(candidate);
  if (removed > 0) {
    rulesApplied.push(`R3:dedupe(${removed})`);
    candidate = deduped;
  }

  // Additive value rules (may increase tokens but improve quality).
  let addedValue = false;
  const hint = maybeFormatHint(candidate);
  if (hint) {
    candidate = hint;
    rulesApplied.push("R2:format-hint");
    addedValue = true;
  }

  const role = maybeRole(prompt);
  if (role) {
    rulesApplied.push("R4:role-injected");
    addedValue = true;
  }

  // Guard 1: intent must be preserved, else discard everything.
  if (!intentPreserved(prompt, candidate)) {
    return {
      optimisedPrompt: prompt,
      rulesApplied: ["none:intent-guard-tripped"],
      originalTokens,
      optimisedTokens: originalTokens,
      tokensSaved: 0,
      intentPreserved: false,
    };
  }

  const optimisedTokens = estimateTokens(candidate);

  // Guard 2: floor — if we didn't add value and didn't reduce tokens, no-op.
  if (!addedValue && optimisedTokens >= originalTokens) {
    return {
      optimisedPrompt: prompt,
      rulesApplied: [],
      originalTokens,
      optimisedTokens: originalTokens,
      tokensSaved: 0,
      intentPreserved: true,
    };
  }

  return {
    optimisedPrompt: candidate,
    rulesApplied,
    originalTokens,
    optimisedTokens,
    tokensSaved: originalTokens - optimisedTokens,
    intentPreserved: true,
    systemPromptSuggestion: role,
  };
}
