// ComplexityClassifier — uses src/analyser to classify prompt capability needs.
// The output is complexity-based: fast | balanced | strong | deep.

import { analysePrompt } from "../analyser/analyser.js";
import type { ComplexityResult, Message } from "../shared/types.js";

/** Rough token estimate (~4 chars/token). Good enough for routing buckets. */
export function estimateTokens(prompt: string, context?: Message[]): number {
  const contextChars = (context ?? []).reduce(
    (count, message) => count + message.content.length,
    0,
  );
  return Math.ceil((prompt.length + contextChars) / 4);
}

export async function classify(
  prompt: string,
  context?: Message[],
): Promise<ComplexityResult> {
  const analysis = await analysePrompt(prompt);

  return {
    route: analysis.route,
    scores: analysis.scores,
    reason: analysis.reason,
    approxTokens: estimateTokens(prompt, context),
  };
}