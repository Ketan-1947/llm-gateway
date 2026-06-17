// OpenAIAdapter — implements the ProviderAdapter seam for OpenAI.
// Handles the quirks of the reasoning models (o1 / o3-mini): they use
// `max_completion_tokens`, reject custom `temperature`, and don't take a
// classic system role — so we inline the system prompt for them.

import OpenAI from "openai";
import { computeCost, config } from "./config.js";

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ChatParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
import {
  GatewayError,
  type LLMRequest,
  type LLMResponse,
  type ProviderAdapter,
  type ProviderName,
} from "./types.js";

function isReasoningModel(model: string): boolean {
  return model.startsWith("o1") || model.startsWith("o3");
}

export class OpenAIAdapter implements ProviderAdapter {
  readonly provider: ProviderName = "openai";
  private client: OpenAI | null;

  constructor(apiKey: string = config.openaiApiKey) {
    // Defer the hard failure to call-time so the server can boot without an
    // OpenAI key (Claude-only deployments are valid).
    this.client = apiKey ? new OpenAI({ apiKey }) : null;
  }

  supports(model: string): boolean {
    return (
      model.startsWith("gpt-") || model.startsWith("o1") || model.startsWith("o3")
    );
  }

  async call(req: LLMRequest): Promise<LLMResponse> {
    if (!this.client) {
      throw new GatewayError(
        502,
        "provider_unavailable",
        "OpenAI is not configured (OPENAI_API_KEY is empty).",
      );
    }

    const reasoning = isReasoningModel(req.model);
    const messages: ChatMessage[] = [];

    if (req.systemPrompt) {
      if (reasoning) {
        // Reasoning models: fold system guidance into the first user turn.
        messages.push({
          role: "user",
          content: `Instructions:\n${req.systemPrompt}`,
        });
      } else {
        messages.push({ role: "system", content: req.systemPrompt });
      }
    }
    for (const m of req.messages) {
      messages.push({ role: m.role, content: m.content });
    }

    const params: ChatParams = {
      model: req.model,
      messages,
      // Token cap field differs between model families.
      ...(reasoning
        ? { max_completion_tokens: req.maxTokens }
        : { max_tokens: req.maxTokens, temperature: req.temperature }),
    };

    const start = Date.now();
    try {
      const res = await this.client.chat.completions.create(params);
      const latencyMs = Date.now() - start;

      const content = res.choices[0]?.message?.content ?? "";
      const input = res.usage?.prompt_tokens ?? 0;
      const output = res.usage?.completion_tokens ?? 0;

      return {
        content,
        model: res.model,
        provider: this.provider,
        tokensUsed: { input, output },
        cost: computeCost(req.model, input, output),
        latencyMs,
        finishReason: res.choices[0]?.finish_reason ?? "unknown",
      };
    } catch (err) {
      const latencyMs = Date.now() - start;
      if (err instanceof OpenAI.APIError) {
        const status = err.status ?? 502;
        throw new GatewayError(
          status === 401 ? 502 : status, // 401 is OUR key problem
          "provider_error",
          `OpenAI API error (${status}) after ${latencyMs}ms: ${err.message}`,
        );
      }
      throw new GatewayError(
        502,
        "provider_unavailable",
        `OpenAI call failed after ${latencyMs}ms: ${(err as Error).message}`,
      );
    }
  }
}
