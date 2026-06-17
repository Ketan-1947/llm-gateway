// RateLimiter — Phase 5. Per-key fixed-window limiter (in-memory).
// For multi-instance deployments, back this with Redis (INCR + EXPIRE) behind
// the same check() contract.

import { config } from "./config.js";
import { GatewayError } from "./types.js";

interface Window {
  count: number;
  windowStart: number;
}

export class RateLimiter {
  private hits = new Map<string, Window>();

  constructor(private perMin: number = config.rateLimitPerMin) {}

  /** Throws GatewayError(429) when the key exceeds its per-minute budget. */
  check(keyId: string): void {
    if (this.perMin <= 0) return; // disabled
    const now = Date.now();
    const w = this.hits.get(keyId);
    if (!w || now - w.windowStart >= 60_000) {
      this.hits.set(keyId, { count: 1, windowStart: now });
      return;
    }
    if (w.count >= this.perMin) {
      const retryMs = 60_000 - (now - w.windowStart);
      throw new GatewayError(
        429,
        "rate_limited",
        `Rate limit of ${this.perMin}/min exceeded. Retry in ${Math.ceil(retryMs / 1000)}s.`,
      );
    }
    w.count++;
  }
}
