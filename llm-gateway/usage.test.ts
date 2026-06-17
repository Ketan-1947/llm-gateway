// Phase 4 usage-store suite — NO network calls.
// Verifies aggregation, per-key / since filters, and the naive-baseline
// savings math.  Run with:  npm run test:usage

import assert from "node:assert";
import { computeCost } from "./config.js";
import { InMemoryUsageStore, type RequestLogRecord } from "./usageStore.js";

let pass = 0;
let fail = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${msg}`);
  ok ? pass++ : fail++;
};
const approx = (a: number, b: number) => Math.abs(a - b) < 1e-6;

function rec(over: Partial<RequestLogRecord>): RequestLogRecord {
  const base: RequestLogRecord = {
    requestId: "r",
    timestamp: "2026-06-01T00:00:00Z",
    apiKeyId: "key_a",
    taskType: "SIMPLE_QA",
    provider: "anthropic",
    model: "claude-haiku-4-5",
    tokensIn: 100,
    tokensOut: 200,
    cost: 0,
    tokensSaved: 0,
    estCostSaved: 0,
    latencyMs: 100,
    fallbackUsed: false,
    optimised: true,
    ...over,
  };
  base.cost = computeCost(base.model, base.tokensIn, base.tokensOut);
  return base;
}

const store = new InMemoryUsageStore(""); // in-memory only, no file

const A = rec({ model: "claude-haiku-4-5", taskType: "SIMPLE_QA", apiKeyId: "key_a", tokensIn: 100, tokensOut: 200, timestamp: "2026-06-01T00:00:00Z", tokensSaved: 10, estCostSaved: 0.00001 });
const B = rec({ model: "claude-opus-4-7", taskType: "CODE_COMPLEX", apiKeyId: "key_a", tokensIn: 500, tokensOut: 1000, timestamp: "2026-06-10T00:00:00Z" });
const C = rec({ model: "claude-haiku-4-5", taskType: "SIMPLE_QA", apiKeyId: "key_b", tokensIn: 50, tokensOut: 50, timestamp: "2026-06-12T00:00:00Z" });
[A, B, C].forEach((r) => store.append(r));

// --- Global summary ---
const all = store.summary();
check(all.totalRequests === 3, `totalRequests = ${all.totalRequests} (exp 3)`);
check(approx(all.totalCost, A.cost + B.cost + C.cost), `totalCost = ${all.totalCost}`);
check(all.byModel["claude-haiku-4-5"]?.requests === 2, "byModel haiku requests = 2");
check(all.byModel["claude-opus-4-7"]?.requests === 1, "byModel opus requests = 1");
check(all.byTaskType["SIMPLE_QA"]?.requests === 2, "byTaskType SIMPLE_QA = 2");
check(all.byTaskType["CODE_COMPLEX"]?.requests === 1, "byTaskType CODE_COMPLEX = 1");

// --- Baseline math (what naive single-model usage would have cost) ---
const expectedBaseline =
  computeCost("claude-sonnet-4-6", A.tokensIn, A.tokensOut) +
  computeCost("claude-sonnet-4-6", B.tokensIn, B.tokensOut) +
  computeCost("claude-sonnet-4-6", C.tokensIn, C.tokensOut);
check(approx(all.baseline.baselineCost, expectedBaseline), `baselineCost = ${all.baseline.baselineCost}`);
check(approx(all.baseline.actualCost, all.totalCost), "baseline.actualCost == totalCost");
check(approx(all.baseline.netSavings, all.baseline.baselineCost - all.totalCost), "netSavings consistent");

// --- since filter ---
const recent = store.summary({ since: "2026-06-11T00:00:00Z" });
check(recent.totalRequests === 1, `since filter -> ${recent.totalRequests} (exp 1, only C)`);
check(recent.byModel["claude-haiku-4-5"]?.requests === 1, "since filter model = haiku");

// --- per-key filter ---
const keyB = store.summary({ apiKeyId: "key_b" });
check(keyB.totalRequests === 1, `key_b scope -> ${keyB.totalRequests} (exp 1)`);

console.log(`\nResults: ${pass} passed, ${fail} failed.`);
assert.strictEqual(fail, 0, `${fail} usage checks failed.`);
console.log("✅ Phase 4 usage suite passed.");
