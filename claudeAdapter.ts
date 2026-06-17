// ClaudeAdapter — implements the ProviderAdapter seam for Anthropic.
// Translates the gateway's normalized LLMRequest into an Anthropic call
// and back into a normalized LLMResponse with cost + latency.

import Anthropic from "@anthropic-ai/sdk";
import { computeCost, config } from "./config.js";
import {
  GatewayError,
  type LLMRequest,
  type LLMResponse,
  type ProviderAdapter,
  type ProviderName,
} from "./types.js";

export class ClaudeAdapter implements ProviderAdapter {
  readonly provider: ProviderName = "anthropic";
  private client: Anthropic;

  constructor(apiKey: string = config.anthropicApiKey) {
    this.client = new Anthropic({ apiKey });
  }

  supports(model: string): boolean {
    return model.startsWith("claude");
  }

  async call(req: LLMRequest): Promise<LLMResponse> {
    const start = Date.now();
    try {
      const msg = await this.client.messages.create({
        model: req.model,
        max_tokens: req.maxTokens,
        temperature: req.temperature,
        ...(req.systemPrompt ? { system: req.systemPrompt } : {}),
        messages: req.messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
      });

      const latencyMs = Date.now() - start;

      // Concatenate all text blocks; ignore non-text blocks in Phase 1.
      // Using the discriminant directly avoids depending on a specific
      // exported block type name across SDK versions.
      const content = msg.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("");

      const input = msg.usage.input_tokens;
      const output = msg.usage.output_tokens;

      return {
        content,
        model: msg.model,
        provider: this.provider,
        tokensUsed: { input, output },
        cost: computeCost(msg.model, input, output),
        latencyMs,
        finishReason: msg.stop_reason ?? "unknown",
      };
    } catch (err) {
      const latencyMs = Date.now() - start;
      if (err instanceof Anthropic.APIError) {
        // Surface a clean, typed error the API layer can map to HTTP.
        const status = err.status ?? 502;
        throw new GatewayError(
          status === 401 ? 502 : status, // 401 is OUR key problem, not the client's
          "provider_error",
          `Anthropic API error (${status}) after ${latencyMs}ms: ${err.message}`,
        );
      }
      throw new GatewayError(
        502,
        "provider_unavailable",
        `Anthropic call failed after ${latencyMs}ms: ${(err as Error).message}`,
      );
    }
  }
}
