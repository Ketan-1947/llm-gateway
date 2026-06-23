// OpenAIAdapter — implements the ProviderAdapter seam for OpenAI.
// Handles the quirks of the reasoning models (o1 / o3-mini): they use
// `max_completion_tokens`, reject custom `temperature`, and don't take a
// classic system role — so we inline the system prompt for them.
// Supports one-shot call(), streaming stream(), and OpenAI-native tool use.

import OpenAI from "openai";
import { computeCost, config } from "./config.js";

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ChatParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
type ChatTool = OpenAI.Chat.Completions.ChatCompletionTool;
type ChatToolChoice = OpenAI.Chat.Completions.ChatCompletionToolChoiceOption;
import {
  GatewayError,
  type LLMRequest,
  type LLMResponse,
  type ProviderAdapter,
  type ProviderName,
  type ToolCall,
} from "./types.js";

function isReasoningModel(model: string): boolean {
  return model.startsWith("o1") || model.startsWith("o3");
}

/** Translate normalized messages -> OpenAI messages (incl. tool use). */
function toOpenAIMessages(req: LLMRequest, reasoning: boolean): ChatMessage[] {
  const messages: ChatMessage[] = [];

  if (req.systemPrompt) {
    if (reasoning) {
      // Reasoning models: fold system guidance into the first user turn.
      messages.push({ role: "user", content: `Instructions:\n${req.systemPrompt}` });
    } else {
      messages.push({ role: "system", content: req.systemPrompt });
    }
  }

  for (const m of req.messages) {
    if (m.role === "tool") {
      messages.push({
        role: "tool",
        tool_call_id: m.toolCallId ?? "",
        content: m.content,
      });
    } else if (m.role === "assistant" && m.toolCalls?.length) {
      messages.push({
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments },
        })),
      });
    } else {
      messages.push({ role: m.role, content: m.content });
    }
  }
  return messages;
}

function toOpenAITools(req: LLMRequest): ChatTool[] | undefined {
  if (!req.tools?.length) return undefined;
  return req.tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      parameters: t.parameters,
    },
  }));
}

function toOpenAIToolChoice(req: LLMRequest): ChatToolChoice | undefined {
  if (!req.tools?.length || !req.toolChoice) return undefined;
  if (typeof req.toolChoice === "string") return req.toolChoice; // auto|none|required
  return { type: "function", function: { name: req.toolChoice.name } };
}

/** Build the shared (non-streaming) request params. */
function buildParams(req: LLMRequest): ChatParams {
  const reasoning = isReasoningModel(req.model);
  const tools = toOpenAITools(req);
  const toolChoice = toOpenAIToolChoice(req);
  return {
    model: req.model,
    messages: toOpenAIMessages(req, reasoning),
    // Token cap field differs between model families.
    ...(reasoning
      ? { max_completion_tokens: req.maxTokens }
      : { max_tokens: req.maxTokens, temperature: req.temperature }),
    ...(tools ? { tools } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
  };
}

function wrapError(err: unknown, latencyMs: number): GatewayError {
  if (err instanceof OpenAI.APIError) {
    const status = err.status ?? 502;
    return new GatewayError(
      status === 401 ? 502 : status, // 401 is OUR key problem
      "provider_error",
      `OpenAI API error (${status}) after ${latencyMs}ms: ${err.message}`,
    );
  }
  return new GatewayError(
    502,
    "provider_unavailable",
    `OpenAI call failed after ${latencyMs}ms: ${(err as Error).message}`,
  );
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

  private requireClient(): OpenAI {
    if (!this.client) {
      throw new GatewayError(
        502,
        "provider_unavailable",
        "OpenAI is not configured (OPENAI_API_KEY is empty).",
      );
    }
    return this.client;
  }

  async call(req: LLMRequest): Promise<LLMResponse> {
    const client = this.requireClient();
    const start = Date.now();
    try {
      const res = await client.chat.completions.create(buildParams(req));
      const latencyMs = Date.now() - start;
      const choice = res.choices[0];
      const input = res.usage?.prompt_tokens ?? 0;
      const output = res.usage?.completion_tokens ?? 0;
      const toolCalls: ToolCall[] = (choice?.message?.tool_calls ?? []).map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      }));
      return {
        content: choice?.message?.content ?? "",
        model: res.model,
        provider: this.provider,
        tokensUsed: { input, output },
        cost: computeCost(req.model, input, output),
        latencyMs,
        finishReason: choice?.finish_reason ?? "unknown",
        ...(toolCalls.length ? { toolCalls } : {}),
      };
    } catch (err) {
      throw wrapError(err, Date.now() - start);
    }
  }

  async *stream(req: LLMRequest): AsyncGenerator<string, LLMResponse, void> {
    const client = this.requireClient();
    // Reasoning models don't stream cleanly; degrade to a one-shot call and
    // emit the whole result as a single chunk (still correct, just not live).
    if (isReasoningModel(req.model)) {
      const res = await this.call(req);
      if (res.content) yield res.content;
      return res;
    }

    const start = Date.now();
    let stream: Awaited<ReturnType<typeof client.chat.completions.create>> & AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;
    try {
      stream = (await client.chat.completions.create({
        ...buildParams(req),
        stream: true,
        stream_options: { include_usage: true },
      })) as typeof stream;
    } catch (err) {
      throw wrapError(err, Date.now() - start);
    }

    let content = "";
    let model = req.model;
    let finishReason = "stop";
    let input = 0;
    let output = 0;
    // Accumulate streamed tool calls, keyed by their position index.
    const toolAcc = new Map<number, { id: string; name: string; args: string }>();

    try {
      for await (const chunk of stream) {
        if (chunk.model) model = chunk.model;
        if (chunk.usage) {
          input = chunk.usage.prompt_tokens;
          output = chunk.usage.completion_tokens;
        }
        const choice = chunk.choices[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;

        const delta = choice.delta;
        if (delta?.content) {
          content += delta.content;
          yield delta.content;
        }
        for (const tc of delta?.tool_calls ?? []) {
          const slot = toolAcc.get(tc.index) ?? { id: "", name: "", args: "" };
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name = tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
          toolAcc.set(tc.index, slot);
        }
      }
    } catch (err) {
      throw wrapError(err, Date.now() - start);
    }

    const toolCalls: ToolCall[] = [...toolAcc.values()]
      .filter((t) => t.id || t.name)
      .map((t) => ({ id: t.id, name: t.name, arguments: t.args }));

    return {
      content,
      model,
      provider: this.provider,
      tokensUsed: { input, output },
      cost: computeCost(req.model, input, output),
      latencyMs: Date.now() - start,
      finishReason,
      ...(toolCalls.length ? { toolCalls } : {}),
    };
  }
}
