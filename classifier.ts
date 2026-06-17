// TaskClassifier — Phase 2, heuristics only.
// Maps a prompt to a TaskType + confidence using cheap, free signals
// (length, code markers, keyword families, question structure). No LLM call.
// Low-confidence results are handled by the router (it rounds UP to a more
// capable model). A cheap LLM tie-break is the documented Phase-2.5 upgrade.

import type { ClassifierResult, Message, TaskType } from "./types.js";

/** Rough token estimate (~4 chars/token). Good enough for routing buckets. */
export function estimateTokens(prompt: string, context?: Message[]): number {
  const ctxChars = (context ?? []).reduce((n, m) => n + m.content.length, 0);
  return Math.ceil((prompt.length + ctxChars) / 4);
}

const RE = {
  code: /```|\bfunction\b|\bclass\b|=>|;\s*\n|\bdef \b|\bimport \b|#include|console\.log|public static|<\/?[a-z]+>|SELECT .* FROM/i,
  codeIntent:
    /\b(debug|stack ?trace|syntax error|compile|refactor|unit test|regex|null pointer|segfault|fix (this|the|my) (bug|code|function)|write\b[^.\n]{0,30}\b(script|function|program|snippet|code))\b/i,
  // NOTE: no trailing \b — several entries are stems (scalab, fault toler,
  // load balanc) that must match longer words like "scalable"/"scalability".
  complexEng:
    /\b(architect|system design|design a system|distributed|microservices?|scalab|high availability|fault toler|throughput|consistency model|database schema|event[- ]driven|kubernetes|load balanc|trade[- ]?offs?|design review|code review)/i,
  reasoning:
    /\b(prove|theorem|derive|calculate|solve|step[- ]by[- ]step|logic puzzle|optimi[sz]e (the )?algorithm|time complexity|big[- ]o|equation|probability|combinatori|how many ways|reason through)/i,
  research:
    /\b(research|comprehensive|in[- ]depth|deep dive|literature review|survey of|analy[sz]e .* and (compare|evaluate)|pros and cons of .* across|state of the art|systematic)/i,
  creative:
    /\b(poem|haiku|sonnet|story|short story|fiction|novel|lyrics|song|screenplay|tagline|slogan|write (a|me a) (story|poem|tale)|limerick|narrative)\b/i,
  safety:
    /\b(suicide|self[- ]harm|kill myself|overdose|dosage|prescri|diagnos|medical advice|legal advice|am i (going )?to die|symptoms? of)\b/i,
  multimodal: /\b(this image|the image|attached (photo|image|picture)|in the picture|screenshot above|look at this image)\b/i,
  greeting:
    /^(hi|hey|hello|yo|sup|good (morning|afternoon|evening)|thanks|thank you|how are you|what'?s up)\b/i,
  simpleQ: /^(what|who|when|where|which|whose|is|are|does|do|can|how many|how much)\b/i,
  simplifier: /\b(simply|in simple terms|like i'?m (5|five)|eli5|briefly|short answer|tl;?dr)\b/i,
};

export function classify(prompt: string, context?: Message[]): ClassifierResult {
  const approxTokens = estimateTokens(prompt, context);
  const p = prompt.trim();
  const signals: string[] = [];
  const result = (taskType: TaskType, confidence: number): ClassifierResult => ({
    taskType,
    confidence,
    signals,
    approxTokens,
  });

  // 1) Very large input dominates: route as long-context regardless of topic.
  if (approxTokens > 4000) {
    signals.push(`large input (~${approxTokens} tokens)`);
    return result("LONG_CONTEXT", 0.85);
  }

  // 2) Safety-sensitive content gets careful handling.
  if (RE.safety.test(p)) {
    signals.push("safety-sensitive keywords");
    return result("SAFETY_SENSITIVE", 0.8);
  }

  // 3) Multimodal references (no attachment plumbing yet, but route by intent).
  if (RE.multimodal.test(p)) {
    signals.push("references an image");
    return result("MULTIMODAL", 0.7);
  }

  // 4) Code.
  const looksLikeCode = RE.code.test(p) || RE.codeIntent.test(p);
  if (looksLikeCode) {
    signals.push("code present or coding intent");
    if (RE.complexEng.test(p) || approxTokens > 1500) {
      signals.push("architecture/complexity signals");
      return result("CODE_COMPLEX", 0.8);
    }
    return result("CODE_SIMPLE", 0.75);
  }

  // 5) Pure architecture/system-design discussion (no code block) is complex.
  if (RE.complexEng.test(p)) {
    signals.push("system-design keywords");
    return result("CODE_COMPLEX", 0.72);
  }

  // 6) Reasoning — but a "explain simply" cue downgrades to SIMPLE_QA.
  if (RE.reasoning.test(p)) {
    if (RE.simplifier.test(p)) {
      signals.push("reasoning keywords but 'explain simply' cue");
      return result("SIMPLE_QA", 0.6);
    }
    signals.push("reasoning/math keywords");
    return result("REASONING", 0.75);
  }

  // 7) Research / deep analysis.
  if (RE.research.test(p)) {
    signals.push("research/deep-analysis keywords");
    return result("RESEARCH", 0.7);
  }

  // 8) Creative writing.
  if (RE.creative.test(p)) {
    signals.push("creative-writing keywords");
    return result("CREATIVE", 0.8);
  }

  // 9) Short casual chat / greetings.
  const wordCount = p.split(/\s+/).filter(Boolean).length;
  if (RE.greeting.test(p) && wordCount <= 12) {
    signals.push("greeting / casual");
    return result("CONVERSATION", 0.65);
  }

  // 10) Short, well-formed factual question.
  if (RE.simpleQ.test(p) && wordCount <= 40 && p.includes("?")) {
    signals.push("short factual question");
    return result("SIMPLE_QA", 0.7);
  }

  // Default: low confidence -> router will round up to a safer model.
  signals.push("no decisive signal");
  return result("SIMPLE_QA", 0.4);
}
