// Phase 2 routing regression suite — NO network calls.
// Runs classify() + route() over 20 prompts and checks the chosen model.
// Run with:  npm run test:routing   (alias for: tsx routing.test.ts)
//
// Phase 2 done condition: >= 17/20 route to the expected model.

import assert from "node:assert";
import { classify } from "./classifier.js";
import { route } from "./router.js";
import type { TaskType } from "./types.js";

interface Case {
  prompt: string;
  expectType: TaskType;
  expectModel: string;
  note?: string;
}

const longDoc =
  "Summarize the following document:\n" + "lorem ipsum dolor sit amet. ".repeat(900); // > 4000 tokens

const cases: Case[] = [
  { prompt: "What is the capital of France?", expectType: "SIMPLE_QA", expectModel: "claude-haiku-4-5" },
  { prompt: "Hey, how are you doing today?", expectType: "CONVERSATION", expectModel: "claude-haiku-4-5" },
  { prompt: "Write me a poem about the ocean.", expectType: "CREATIVE", expectModel: "claude-sonnet-4-6" },
  { prompt: "Write a Python script to rename files in a folder.", expectType: "CODE_SIMPLE", expectModel: "claude-sonnet-4-6" },
  { prompt: "Debug this stack trace: NullPointerException at line 42.", expectType: "CODE_SIMPLE", expectModel: "claude-sonnet-4-6" },
  { prompt: "Design a scalable distributed system for real-time chat with millions of users.", expectType: "CODE_COMPLEX", expectModel: "claude-opus-4-7" },
  { prompt: "Refactor this function to be more readable: ```js const f = () => 1```", expectType: "CODE_SIMPLE", expectModel: "claude-sonnet-4-6" },
  { prompt: "Prove that the square root of 2 is irrational.", expectType: "REASONING", expectModel: "o3-mini" },
  { prompt: "Solve for x step by step: 3x^2 + 2x - 5 = 0.", expectType: "REASONING", expectModel: "o3-mini" },
  { prompt: "Calculate the probability of rolling three sixes in a row.", expectType: "REASONING", expectModel: "o3-mini" },
  { prompt: "Write a comprehensive in-depth analysis of remote work trends across industries.", expectType: "RESEARCH", expectModel: "claude-opus-4-7" },
  { prompt: longDoc, expectType: "LONG_CONTEXT", expectModel: "claude-sonnet-4-6" },
  { prompt: "Is this mole a symptom of skin cancer?", expectType: "SAFETY_SENSITIVE", expectModel: "claude-sonnet-4-6" },
  { prompt: "What does this image show?", expectType: "MULTIMODAL", expectModel: "gpt-4o" },
  { prompt: "Thanks, that was super helpful!", expectType: "CONVERSATION", expectModel: "claude-haiku-4-5" },
  { prompt: "Who won the Nobel Prize in Physics in 1921?", expectType: "SIMPLE_QA", expectModel: "claude-haiku-4-5" },
  { prompt: "Design the database schema and microservices architecture for an e-commerce platform.", expectType: "CODE_COMPLEX", expectModel: "claude-opus-4-7" },
  { prompt: "What is an interesting fact about octopuses?", expectType: "SIMPLE_QA", expectModel: "claude-haiku-4-5" },
  { prompt: "Explain quantum entanglement simply.", expectType: "SIMPLE_QA", expectModel: "claude-sonnet-4-6", note: "low confidence -> rounded up to Sonnet" },
  { prompt: "Write a haiku about autumn.", expectType: "CREATIVE", expectModel: "claude-sonnet-4-6" },
  { prompt: "Design a scalable distributed chat system.", expectType: "CODE_COMPLEX", expectModel: "claude-opus-4-7" },
];

let typeHits = 0;
let modelHits = 0;
const failures: string[] = [];

for (const c of cases) {
  const cls = classify(c.prompt);
  const dec = route(cls);
  const typeOk = cls.taskType === c.expectType;
  const modelOk = dec.model === c.expectModel;
  if (typeOk) typeHits++;
  if (modelOk) modelHits++;

  const shortPrompt = c.prompt.length > 60 ? c.prompt.slice(0, 57) + "..." : c.prompt;
  const status = modelOk ? "PASS" : "FAIL";
  console.log(
    `[${status}] "${shortPrompt}"\n` +
      `        type=${cls.taskType} (exp ${c.expectType}) conf=${cls.confidence.toFixed(2)} ` +
      `-> ${dec.provider}/${dec.model} (exp ${c.expectModel})${c.note ? `  // ${c.note}` : ""}`,
  );
  if (!modelOk) failures.push(`${shortPrompt} -> got ${dec.model}, expected ${c.expectModel}`);
}

console.log(
  `\nResults: model ${modelHits}/${cases.length}, taskType ${typeHits}/${cases.length}`,
);
if (failures.length) {
  console.log("Failures:\n  " + failures.join("\n  "));
}

// Phase 2 done condition.
assert.ok(
  modelHits >= 17,
  `Routing accuracy too low: ${modelHits}/${cases.length} (need >= 17).`,
);
console.log("\n✅ Phase 2 routing suite passed (>= 17/20).");
