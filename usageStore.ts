// Usage store — Phase 4 observability.
// Logs one record per LLM call and aggregates usage/cost on demand.
//
// The default implementation is in-memory (+ optional append-only JSONL file)
// so the gateway runs with ZERO external infra. For production, implement the
// same `UsageStore` interface against Postgres — nothing else changes. This is
// the same seam pattern as ProviderAdapter.

import { appendFileSync } from "node:fs";
import { computeCost, config } from "./config.js";
import type { ProviderName } from "./types.js";

export interface RequestLogRecord {
  requestId: string;
  timestamp: string; // ISO 8601
  apiKeyId: string; // hashed/truncated key id, or "anonymous"
  taskType: string;
  provider: ProviderName;
  model: string;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  tokensSaved: number;
  estCostSaved: number;
  latencyMs: number;
  fallbackUsed: boolean;
  optimised: boolean;
}

export interface UsageQuery {
  since?: string; // ISO timestamp; records strictly before are excluded
  apiKeyId?: string; // scope to one key
}

export interface UsageSummary {
  totalRequests: number;
  totalCost: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalTokensSaved: number;
  totalEstCostSaved: number;
  byModel: Record<string, { requests: number; cost: number; tokensIn: number; tokensOut: number }>;
  byTaskType: Record<string, { requests: number; cost: number }>;
  // The meta-cost proof: what naive single-model usage would have cost.
  baseline: {
    model: string;
    baselineCost: number;
    actualCost: number;
    netSavings: number;
    savingsPct: number;
  };
}

export interface UsageStore {
  append(record: RequestLogRecord): void;
  summary(query?: UsageQuery): UsageSummary;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export class InMemoryUsageStore implements UsageStore {
  private records: RequestLogRecord[] = [];

  constructor(private logFile: string = config.usageLogFile) {}

  append(record: RequestLogRecord): void {
    this.records.push(record);
    if (this.logFile) {
      try {
        appendFileSync(this.logFile, JSON.stringify(record) + "\n");
      } catch (err) {
        // Never let logging failures break a request.
        console.warn(`[usage] failed to write log file: ${(err as Error).message}`);
      }
    }
  }

  summary(query: UsageQuery = {}): UsageSummary {
    const sinceMs = query.since ? Date.parse(query.since) : undefined;
    const rows = this.records.filter((r) => {
      if (query.apiKeyId && r.apiKeyId !== query.apiKeyId) return false;
      if (sinceMs !== undefined && Date.parse(r.timestamp) < sinceMs) return false;
      return true;
    });

    const byModel: UsageSummary["byModel"] = {};
    const byTaskType: UsageSummary["byTaskType"] = {};
    let totalCost = 0;
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    let totalTokensSaved = 0;
    let totalEstCostSaved = 0;
    let baselineCost = 0;

    for (const r of rows) {
      totalCost += r.cost;
      totalTokensIn += r.tokensIn;
      totalTokensOut += r.tokensOut;
      totalTokensSaved += r.tokensSaved;
      totalEstCostSaved += r.estCostSaved;
      baselineCost += computeCost(config.baselineModel, r.tokensIn, r.tokensOut);

      const m = (byModel[r.model] ??= { requests: 0, cost: 0, tokensIn: 0, tokensOut: 0 });
      m.requests++;
      m.cost = round6(m.cost + r.cost);
      m.tokensIn += r.tokensIn;
      m.tokensOut += r.tokensOut;

      const t = (byTaskType[r.taskType] ??= { requests: 0, cost: 0 });
      t.requests++;
      t.cost = round6(t.cost + r.cost);
    }

    const netSavings = baselineCost - totalCost;
    const savingsPct = baselineCost > 0 ? (netSavings / baselineCost) * 100 : 0;

    return {
      totalRequests: rows.length,
      totalCost: round6(totalCost),
      totalTokensIn,
      totalTokensOut,
      totalTokensSaved,
      totalEstCostSaved: round6(totalEstCostSaved),
      byModel,
      byTaskType,
      baseline: {
        model: config.baselineModel,
        baselineCost: round6(baselineCost),
        actualCost: round6(totalCost),
        netSavings: round6(netSavings),
        savingsPct: Math.round(savingsPct * 10) / 10,
      },
    };
  }
}
