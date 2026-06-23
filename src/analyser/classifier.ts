import OpenAI from "openai";
import { CLASSIFIER_MODEL } from "./config.js";

const ROUTES = ["fast", "balanced", "strong", "deep"] as const;

export type Route = (typeof ROUTES)[number];

type ScoreKey =
  | "context_dependency"
  | "reasoning_depth"
  | "generation_scope"
  | "precision_required"
  | "risk";

export type Scores = Record<ScoreKey, number>;

const SCORE_KEYS: ScoreKey[] = [
  "context_dependency",
  "reasoning_depth",
  "generation_scope",
  "precision_required",
  "risk",
];

const DEFAULT_SCORES: Scores = {
  context_dependency: 1,
  reasoning_depth: 1,
  generation_scope: 1,
  precision_required: 1,
  risk: 1,
};

const client = new OpenAI();

const SYSTEM_PROMPT = `You are a capability router for a multi-model AI responder.

<task>
Given a user prompt, decide what model capability route is required to answer well.
You are not classifying the topic. You are estimating how much model capability the prompt needs.
</task>

<routes>
<route name="fast">Cheap, quick, low-risk requests: short Q&A, formatting, tiny edits, direct explanations.</route>
<route name="balanced">Normal assistant work: moderate context, standard coding/help tasks, multi-step but scoped requests.</route>
<route name="strong">Harder work: larger generation, higher precision, substantial code or document creation, careful edits.</route>
<route name="deep">Highest-capability work: open-ended reasoning, architecture, strategy, tradeoffs, ambiguous/high-risk decisions.</route>
</routes>

<score_dimensions>
Score each dimension from 1 to 5:
- context_dependency: how much the prompt relies on prior messages, files, selected text, or unstated context.
- reasoning_depth: how much analysis, judgment, planning, or multi-step reasoning is required.
- generation_scope: how large or substantial the requested output is.
- precision_required: how costly a small mistake would be; code/config/data transformations score higher.
- risk: potential blast radius if the answer is wrong or incomplete.
</score_dimensions>

<rules>
- Choose the lowest-capability route that can answer safely and well.
- Do not escalate just because the topic sounds technical; escalate when capability demand is higher.
- If any score is 4 or 5, strongly consider "strong" or "deep".
- Use "deep" for open-ended tradeoffs, architecture, strategy, or uncertain judgment calls.
- Use "fast" only when all scores are low and the request is self-contained.
</rules>

<output_format>
Return ONLY a JSON object, no markdown, no explanation outside the JSON:
{
  "route": "<fast|balanced|strong|deep>",
  "scores": {
    "context_dependency": <1-5>,
    "reasoning_depth": <1-5>,
    "generation_scope": <1-5>,
    "precision_required": <1-5>,
    "risk": <1-5>
  },
  "reason": "<one sentence>"
}
</output_format>`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeScores(scores: unknown): Scores {
  const normalized = { ...DEFAULT_SCORES };

  if (!isRecord(scores)) {
    return normalized;
  }

  for (const key of SCORE_KEYS) {
    const numericValue = Number.parseInt(String(scores[key] ?? normalized[key]), 10);
    const value = Number.isNaN(numericValue) ? normalized[key] : numericValue;
    normalized[key] = Math.min(5, Math.max(1, value));
  }

  return normalized;
}

export function chooseRoute(scores: Scores): Route {
  const contextDependency = scores.context_dependency;
  const reasoningDepth = scores.reasoning_depth;
  const generationScope = scores.generation_scope;
  const precisionRequired = scores.precision_required;
  const risk = scores.risk;

  const total = Object.values(scores).reduce((sum, value) => sum + value, 0);
  const highScoreCount = Object.values(scores).filter((value) => value >= 4).length;

  if (risk >= 5) {
    return "deep";
  }

  if (reasoningDepth >= 4 && (risk >= 3 || contextDependency >= 3)) {
    return "deep";
  }

  if (highScoreCount >= 2) {
    return "deep";
  }

  if (generationScope >= 5 || precisionRequired >= 5) {
    return "strong";
  }

  if (total >= 17) {
    return "strong";
  }

  if (generationScope >= 4 || precisionRequired >= 4) {
    return "strong";
  }

  if (reasoningDepth >= 4) {
    return "deep";
  }

  if (total >= 11) {
    return "balanced";
  }

  if (contextDependency >= 3 || reasoningDepth >= 3) {
    return "balanced";
  }

  return "fast";
}

export async function llmClassify(prompt: string): Promise<[Route, Scores, string]> {
  const response = await client.chat.completions.create({
    model: CLASSIFIER_MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
    max_tokens: 100,
    temperature: 0,
    response_format: { type: "json_object" },
  });

  const raw = response.choices[0]?.message?.content?.trim() ?? "";

  try {
    const parsed: unknown = JSON.parse(raw);

    if (!isRecord(parsed)) {
      throw new Error("classifier response was not a JSON object");
    }

    const scores = normalizeScores(parsed.scores);
    let route = typeof parsed.route === "string" ? parsed.route : chooseRoute(scores);
    const reason = typeof parsed.reason === "string" ? parsed.reason : "classified by llm";

    if (!ROUTES.includes(route as Route)) {
      route = chooseRoute(scores);
    }

    return [route as Route, scores, reason];
  } catch (error) {
    return ["fast", { ...DEFAULT_SCORES }, "llm response parsing failed"];
  }
}

// Public interface.
export async function classify(prompt: string): Promise<[Route, Scores, string]> {
  return llmClassify(prompt);
}