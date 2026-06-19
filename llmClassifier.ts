// LLMClassifier — Phase 2.5. A cheap, fast LLM tie-break for the heuristic
// classifier. Runs ONLY on low-confidence prompts (see hybridClassify below),
// so it adds cost/latency to a minority of requests, not the common path.
//
// Model: llama-3.1-8b-instant on Groq (OpenAI-compatible API). Chosen for
// ~85-110ms TTFT, $0.05/$0.08 per 1M tokens, and reliable JSON. We reuse the
// existing `openai` SDK pointed at Groq's base URL — no new dependency.
//
// Contract: returns a ClassifierResult in the SAME shape the heuristic
// classifier returns, so it is a drop-in for the router. On ANY failure
// (no key, timeout, bad JSON, unknown taskType) it returns null and the
// caller falls back to the heuristic result. The router is never starved.

import OpenAI from "openai";
import { classify, estimateTokens } from "./classifier.js";
import { config } from "./config.js";
import type { ClassifierResult, Message, TaskType } from "./types.js";

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

/** Valid task types — the LLM's output is rejected if it isn't one of these. */
const TASK_TYPES: readonly TaskType[] = [
  "SIMPLE_QA",
  "CREATIVE",
  "CODE_SIMPLE",
  "CODE_COMPLEX",
  "REASONING",
  "LONG_CONTEXT",
  "MULTIMODAL",
  "CONVERSATION",
  "RESEARCH",
  "SAFETY_SENSITIVE",
];

const SYSTEM_PROMPT = `You are a routing classifier for an LLM gateway. Read the user prompt and decide which task category best fits it. Respond with ONLY a JSON object, no prose.

Categories (choose exactly one for "taskType"):
- SIMPLE_QA: short factual question, simple lookup, trivial request.
- CONVERSATION: greeting, small talk, casual chit-chat.
- CREATIVE: poem, story, lyrics, slogan, other creative writing.
- CODE_SIMPLE: a small script, snippet, or straightforward debugging task.
- CODE_COMPLEX: architecture, system design, distributed systems, complex debugging.
- REASONING: math, logic, proofs, step-by-step problem solving, optimization.
- RESEARCH: deep multi-step analysis, comparisons, literature-style synthesis.
- LONG_CONTEXT: the request hinges on a very large amount of supplied text.
- MULTIMODAL: the request refers to an image, screenshot, or picture.
- SAFETY_SENSITIVE: medical, legal, self-harm, or otherwise sensitive content.

Also return "confidence" (0.0-1.0): how sure you are.
Bias rule: when genuinely unsure between a cheaper and a more capable category, pick the MORE capable one (e.g. CODE_COMPLEX over CODE_SIMPLE, REASONING over SIMPLE_QA). Mis-routing a hard prompt to a weak model is worse than the reverse.

Output schema (return exactly these keys):
{"taskType": "<one category above>", "confidence": <number 0..1>, "reason": "<short phrase>"}`;

let client: OpenAI | null = null;
function groqClient(): OpenAI | null {
  if (!config.groqApiKey) return null;
  if (!client) {
    client = new OpenAI({
      apiKey: config.groqApiKey,
      baseURL: GROQ_BASE_URL,
    });
  }
  return client;
}

function isTaskType(v: unknown): v is TaskType {
  return typeof v === "string" && (TASK_TYPES as readonly string[]).includes(v);
}

function clampConfidence(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0.6;
  return Math.min(1, Math.max(0, n));
}

/** Build a compact view of the conversation for the classifier (cap context
 *  so the classifier call stays cheap even on long histories). */
function buildUserContent(prompt: string, context?: Message[]): string {
  if (!context || context.length === 0) return prompt;
  const recent = context
    .slice(-2)
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n")
    .slice(0, 1200);
  return `Recent context:\n${recent}\n\nPrompt to classify:\n${prompt}`;
}

/**
 * Ask the cheap LLM to classify a prompt. Returns a ClassifierResult, or null
 * on any error/timeout so the caller can fall back to the heuristic result.
 */
export async function llmClassify(
  prompt: string,
  context?: Message[],
): Promise<ClassifierResult | null> {
  const groq = groqClient();
  if (!groq) return null;

  const approxTokens = estimateTokens(prompt, context);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    config.llmClassifierTimeoutMs,
  );

  try {
    const completion = await groq.chat.completions.create(
      {
        model: config.llmClassifierModel,
        temperature: 0,
        max_tokens: 120,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserContent(prompt, context) },
        ],
      },
      { signal: controller.signal },
    );

    const raw = completion.choices[0]?.message?.content;
    if (!raw) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null; // malformed JSON — fall back to heuristic
    }

    const obj = parsed as Record<string, unknown>;
    if (!isTaskType(obj.taskType)) return null;

    const reason =
      typeof obj.reason === "string" && obj.reason.trim()
        ? obj.reason.trim()
        : "llm classification";

    return {
      taskType: obj.taskType,
      confidence: clampConfidence(obj.confidence),
      signals: [`llm tie-break (${config.llmClassifierModel}): ${reason}`],
      approxTokens,
    };
  } catch {
    // Timeout, network error, rate limit, etc. — degrade gracefully.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Hybrid classification: heuristics first, LLM tie-break only when the
 * heuristic is unsure. This is the function the request pipeline should call.
 *
 * Decision flow:
 *   1. Run the (free, instant) heuristic classifier.
 *   2. If it is confident enough, or the tie-break is disabled / unconfigured,
 *      return the heuristic result unchanged.
 *   3. Otherwise consult the cheap LLM. If it answers, use its result; if it
 *      fails for any reason, keep the heuristic result.
 *
 * Safety note: SAFETY_SENSITIVE and LONG_CONTEXT are detected by the heuristic
 * with high confidence, so they never reach the LLM and can't be downgraded by
 * it. As a belt-and-braces guard we also refuse to let the LLM override a
 * heuristic SAFETY_SENSITIVE verdict.
 */
export async function hybridClassify(
  prompt: string,
  context?: Message[],
): Promise<ClassifierResult> {
  const heuristic = classify(prompt, context);

  const shouldConsultLLM =
    config.llmTiebreakEnabled &&
    Boolean(config.groqApiKey) &&
    heuristic.confidence < config.llmTiebreakThreshold &&
    heuristic.taskType !== "SAFETY_SENSITIVE";

  if (!shouldConsultLLM) return heuristic;

  const llm = await llmClassify(prompt, context);
  if (!llm) return heuristic;

  // Never let the LLM downgrade a safety verdict (defense in depth).
  if (llm.taskType === "SAFETY_SENSITIVE" || heuristic.taskType !== "SAFETY_SENSITIVE") {
    return llm;
  }
  return heuristic;
}
