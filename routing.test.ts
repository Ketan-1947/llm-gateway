// Complexity router regression suite — NO network calls.
// Verifies fast/balanced/strong/deep route-to-model mapping and forceModel.

import assert from "node:assert";
import { config, PRICE_TABLE } from "./config.js";
import { route } from "./router.js";
import type { ComplexityResult, ComplexityRoute } from "./types.js";

interface Case {
  complexityRoute: ComplexityRoute;
  expectModel: string;
}

const scores = {
  context_dependency: 1,
  reasoning_depth: 1,
  generation_scope: 1,
  precision_required: 1,
  risk: 1,
};

function classification(complexityRoute: ComplexityRoute): ComplexityResult {
  return {
    route: complexityRoute,
    scores,
    reason: `test ${complexityRoute}`,
    approxTokens: 100,
  };
}

const cases: Case[] = [
  {
    complexityRoute: "fast",
    expectModel: config.anthropicApiKey ? "claude-haiku-4-5" : "gpt-4o-mini",
  },
  {
    complexityRoute: "balanced",
    expectModel: config.anthropicApiKey ? "claude-sonnet-4-6" : "gpt-4o",
  },
  {
    complexityRoute: "strong",
    expectModel: config.anthropicApiKey ? "claude-opus-4-7" : "o1",
  },
  {
    complexityRoute: "deep",
    expectModel: config.anthropicApiKey ? "claude-opus-4-7" : "o1",
  },
];

let pass = 0;
let fail = 0;

for (const testCase of cases) {
  const decision = route(classification(testCase.complexityRoute));
  const ok = decision.model === testCase.expectModel;
  ok ? pass++ : fail++;
  console.log(
    `[${ok ? "PASS" : "FAIL"}] ${testCase.complexityRoute} -> ` +
      `${decision.provider}/${decision.model} (exp ${testCase.expectModel})`,
  );
}

const forcedModel = "gpt-4o";
const forced = route(classification("fast"), { forceModel: forcedModel });
const forcedOk =
  forced.model === forcedModel &&
  forced.provider === PRICE_TABLE[forcedModel].provider &&
  forced.fallbacks.length === 0;
forcedOk ? pass++ : fail++;
console.log(`[${forcedOk ? "PASS" : "FAIL"}] forceModel overrides complexity route`);

console.log(`\nResults: ${pass} passed, ${fail} failed.`);
assert.strictEqual(fail, 0, `${fail} routing checks failed.`);
console.log("✅ Complexity routing suite passed.");