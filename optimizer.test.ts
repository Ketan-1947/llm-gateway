// Phase 3 optimizer regression suite — NO network calls.
// Proves three things:
//   1. Verbose/polite prompts get SHORTER (tokensSaved > 0).
//   2. Well-formed prompts pass through UNCHANGED (no-op).
//   3. ZERO intent drift: every case preserves intent (the guard never lets a
//      content word disappear).
// Run with:  npm run test:optimizer

import assert from "node:assert";
import { optimize } from "./optimizer.js";

let pass = 0;
let fail = 0;
const log = (ok: boolean, msg: string) => {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${msg}`);
  ok ? pass++ : fail++;
};

// --- 1) Verbose/polite prompts should shrink ---
const verbose = [
  "Could you please write a function to reverse a string?",
  "I was wondering if you could fix the bug in my code.",
  "Fix the login bug. Fix the login bug.",
];
for (const p of verbose) {
  const r = optimize(p);
  log(r.tokensSaved > 0, `shrinks (saved ${r.tokensSaved}): "${p}" -> "${r.optimisedPrompt}"`);
  log(r.intentPreserved, `intent preserved: "${p}"`);
}

// --- 2) Clean prompts should be untouched ---
const clean = [
  "List three uses of Python in data science.",
  "Write a 300-word blog post about renewable energy.",
];
for (const p of clean) {
  const r = optimize(p);
  log(
    r.optimisedPrompt === p && r.rulesApplied.length === 0,
    `no-op on clean prompt: "${p}"`,
  );
}

// --- 3) Format hint fires on open-ended single asks ---
{
  const r = optimize("Explain photosynthesis.");
  log(r.rulesApplied.includes("R2:format-hint"), `format hint added: "${r.optimisedPrompt}"`);
  log(r.intentPreserved, "format hint preserves intent");
}

// --- 4) Role injection for expert tasks (system prompt, not user text) ---
{
  const r = optimize("Design the microservices architecture for a payments platform.");
  log(
    !!r.systemPromptSuggestion && r.rulesApplied.includes("R4:role-injected"),
    `role injected: "${r.systemPromptSuggestion ?? ""}"`,
  );
  log(
    r.optimisedPrompt === "Design the microservices architecture for a payments platform.",
    "role injection does not alter the user text",
  );
}

// --- 5) Global invariant: intent preserved on every sample ---
const all = [...verbose, ...clean, "Explain photosynthesis.", "Hello there!"];
for (const p of all) {
  const r = optimize(p);
  log(r.intentPreserved, `invariant intentPreserved: "${p}"`);
}

console.log(`\nResults: ${pass} passed, ${fail} failed.`);
assert.strictEqual(fail, 0, `${fail} optimizer checks failed.`);
console.log("✅ Phase 3 optimizer suite passed.");
