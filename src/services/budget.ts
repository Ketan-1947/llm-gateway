// Budget enforcement — Phase 5.
//  - Per-request: client `maxCost` and a global hard ceiling.
//  - Per-day: rolling per-key spend cap.
// Estimates are computed BEFORE the call (worst case = full maxTokens output)
// so we can refuse expensive requests without paying for them first.

import { computeCost, config } from "../config.js";
import { GatewayError } from "../shared/types.js";

/** Worst-case cost estimate: assumes the model emits the full output budget. */
export function estimateRequestCost(
  model: string,
  inputTokens: number,
  maxOutputTokens: number,
): number {
  return computeCost(model, inputTokens, maxOutputTokens);
}

export class BudgetTracker {
  private daily = new Map<string, { day: string; spend: number }>();

  constructor(private dailyCapUsd: number = config.dailyBudgetUsd) {}

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  getDailySpend(keyId: string): number {
    const e = this.daily.get(keyId);
    return e && e.day === this.today() ? e.spend : 0;
  }

  addSpend(keyId: string, usd: number): void {
    const day = this.today();
    const e = this.daily.get(keyId);
    if (!e || e.day !== day) this.daily.set(keyId, { day, spend: usd });
    else e.spend += usd;
  }

  /** Throws GatewayError(402) if the estimate would breach any cap. */
  enforce(keyId: string, estimate: number, requestMaxCost?: number): void {
    if (requestMaxCost !== undefined && estimate > requestMaxCost) {
      throw new GatewayError(
        402,
        "budget_exceeded",
        `Estimated cost $${estimate.toFixed(4)} exceeds request maxCost $${requestMaxCost.toFixed(4)}.`,
      );
    }
    if (config.maxRequestCostUsd > 0 && estimate > config.maxRequestCostUsd) {
      throw new GatewayError(
        402,
        "budget_exceeded",
        `Estimated cost $${estimate.toFixed(4)} exceeds per-request ceiling $${config.maxRequestCostUsd.toFixed(4)}.`,
      );
    }
    if (this.dailyCapUsd > 0 && this.getDailySpend(keyId) + estimate > this.dailyCapUsd) {
      throw new GatewayError(
        402,
        "budget_exceeded",
        `Daily budget $${this.dailyCapUsd.toFixed(2)} would be exceeded for this key.`,
      );
    }
  }
}
