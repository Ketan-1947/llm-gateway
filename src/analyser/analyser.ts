import { classify, Route, Scores } from "./classifier.js";
import { CLASSIFIER_MODEL } from "./config.js";

export interface AnalysisResult {
  route: Route;
  scores: Scores;
  reason: string;
}

async function analysePrompt(prompt: string): Promise<AnalysisResult> {
  const [route, scores, reason] = await classify(prompt);

  return {
    route,
    scores,
    reason,
  };
}

export {analysePrompt};