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
}
