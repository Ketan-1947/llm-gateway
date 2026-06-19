// ProviderManager — executes a RoutingDecision against the right adapter,
// with cross-provider fallback. The router decides; this dispatches.

import {
  GatewayError,
  type LLMRequest,
  type LLMResponse,
  type ProviderAdapter,
  type ProviderName,
  type RouteTarget,
  type RoutingDecision,
} from "./types.js";

export interface DispatchResult {
  response: LLMResponse;
  fallbackUsed: boolean;
}

/** Errors worth failing over on (transient / capacity / our-side auth). */
function isRetryable(err: unknown): boolean {
  if (!(err instanceof GatewayError)) return false;
  if (err.code === "provider_unavailable") return true;
  if (err.code === "provider_error") {
    return err.statusCode === 429 || err.statusCode >= 500;
  }
  return false;
}

export class ProviderManager {
  private adapters = new Map<ProviderName, ProviderAdapter>();

  constructor(adapters: ProviderAdapter[]) {
    for (const a of adapters) this.adapters.set(a.provider, a);
  }

  async dispatch(
    decision: RoutingDecision,
    baseReq: Omit<LLMRequest, "model">,
  ): Promise<DispatchResult> {
    const targets: RouteTarget[] = [
      { provider: decision.provider, model: decision.model },
      ...decision.fallbacks,
    ];

    let lastErr: unknown;

    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      const adapter = this.adapters.get(t.provider);
      if (!adapter || !adapter.supports(t.model)) {
        lastErr = new GatewayError(
          502,
          "provider_unavailable",
          `No adapter for ${t.provider}/${t.model}.`,
        );
        continue; // try next target
      }

      try {
        const response = await adapter.call({ ...baseReq, model: t.model });
        return { response, fallbackUsed: i > 0 };
      } catch (err) {
        lastErr = err;
        if (isRetryable(err) && i < targets.length - 1) {
          continue; // fail over to the next target
        }
        // Non-retryable (e.g. 400 bad request) -> surface immediately.
        throw err;
      }
    }

    throw new GatewayError(
      503,
      "all_providers_failed",
      `All routing targets failed. Last error: ${
        lastErr instanceof Error ? lastErr.message : String(lastErr)
      }`,
    );
  }

  /**
   * Streaming variant of dispatch. Yields text deltas and RETURNS the final
   * DispatchResult. Cross-provider fallback is only possible BEFORE the first
   * token: once any text has been yielded we are committed to that stream, so a
   * later failure propagates. A pre-first-token failure on a retryable error
   * fails over to the next target exactly like dispatch().
   */
  async *dispatchStream(
    decision: RoutingDecision,
    baseReq: Omit<LLMRequest, "model">,
  ): AsyncGenerator<string, DispatchResult, void> {
    const targets: RouteTarget[] = [
      { provider: decision.provider, model: decision.model },
      ...decision.fallbacks,
    ];

    let lastErr: unknown;

    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      const adapter = this.adapters.get(t.provider);
      if (!adapter || !adapter.supports(t.model)) {
        lastErr = new GatewayError(
          502,
          "provider_unavailable",
          `No adapter for ${t.provider}/${t.model}.`,
        );
        continue;
      }

      const gen = adapter.stream({ ...baseReq, model: t.model });
      let step: IteratorResult<string, LLMResponse>;
      try {
        // The first .next() runs the adapter up to its first yield — this is
        // where a pre-token provider error surfaces (and is recoverable).
        step = await gen.next();
      } catch (err) {
        lastErr = err;
        if (isRetryable(err) && i < targets.length - 1) continue;
        throw err;
      }

      // Committed to this stream now. Drain it; errors here are unrecoverable.
      while (!step.done) {
        yield step.value;
        step = await gen.next();
      }
      return { response: step.value, fallbackUsed: i > 0 };
    }

    throw new GatewayError(
      503,
      "all_providers_failed",
      `All streaming targets failed. Last error: ${
        lastErr instanceof Error ? lastErr.message : String(lastErr)
      }`,
    );
  }
}
