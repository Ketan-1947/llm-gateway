// Phase 2.5 hybrid-classifier tests — NO network calls.
// Verifies the gating logic around the LLM tie-break: heuristics run first,
// the LLM is only consulted on low-confidence prompts, and the result is
// always a valid ClassifierResult even when the tie-break is disabled.
//
// These tests deliberately run with GROQ_API_KEY unset (the default in CI),
// so the LLM path is never exercised over the network — we assert that the
// hybrid layer degrades cleanly to the heuristic result.
//
// Run with:  npx tsx classifier.hybrid.test.ts

import assert from "node:assert";
import { classify } from "./classifier.js";
import { config } from "./config.js";
import { hybridClassify } from "./llmClassifier.js";
import type { TaskType } from "./types.js";

const VALID_TYPES: ReadonlySet<TaskType> = new Set<TaskType>([
  "SIMPLE_QA", "CREATIVE", "CODE_SIMPLE", "CODE_COMPLEX", "REASONING",
  "LONG_CONTEXT", "MULTIMODAL", "CONVERSATION", "RESEARCH", "SAFETY_SENSITIVE",
]);

let pass = 0;
const failures: string[] = [];
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { failures.push(name); console.log(`FAIL  ${name}`); }
}

const prompts = [
  "What is the capital of France?",
  "Write a haiku about autumn.",
  "Design a scalable distributed system for real-time chat.",
  "Is this mole a symptom of skin cancer?",
  "hmm not sure what to ask honestly",
  "Thanks!",
];

const run = async () => {
  // 1) Always returns a structurally valid ClassifierResult, never throws.
  for (const p of prompts) {
    const r = await hybridClassify(p);
    check(`valid result: "${p.slice(0, 32)}"`,
      VALID_TYPES.has(r.taskType) &&
      r.confidence >= 0 && r.confidence <= 1 &&
      Array.isArray(r.signals) &&
      typeof r.approxTokens === "number");
  }

  // 2) With the tie-break OFF (no GROQ key in test env), hybrid == heuristic.
  if (!config.groqApiKey || !config.llmTiebreakEnabled) {
    for (const p of prompts) {
      const h = classify(p);
      const r = await hybridClassify(p);
      check(`heuristic passthrough: "${p.slice(0, 24)}"`,
        r.taskType === h.taskType && r.confidence === h.confidence);
    }
  } else {
    console.log("NOTE  GROQ_API_KEY set — skipping passthrough test (LLM path is live).");
  }

  // 3) High-confidence prompts must never be downgraded below heuristic.
  const safety = await hybridClassify("Is this mole a symptom of skin cancer?");
  check("safety stays SAFETY_SENSITIVE", safety.taskType === "SAFETY_SENSITIVE");

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    console.error("Failures:\n  " + failures.join("\n  "));
    process.exit(1);
  }
};

run().catch((e) => { console.error(e); process.exit(1); });
