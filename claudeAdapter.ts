// ClaudeAdapter — implements the ProviderAdapter seam for Anthropic.
// Translates the gateway's normalized LLMRequest into an Anthropic call
// (incl. tool use) and back into a normalized LLMResponse with cost + latency.
// Supports both a one-shot call() and a streaming stream().

import Anthropic from "@anthropic-ai/sdk";
import { computeCost, config } from "./config.js";
import {
  GatewayError,
  type LLMRequest,
  type LLMResponse,
  type ProviderAdapter,
  type ProviderName,
  type ToolCall,
} from "./types.js";

// Anthropic's message/param types vary slightly across SDK versions; we keep
// the translation loosely typed and lean on the discriminants at runtime.
type AnthropicMessage = Anthropic.MessageParam;

/** Translate normalized messages -> Anthropic messages. Consecutive "tool"
 *  results are merged into one user turn of tool_result blocks (Anthropic
 *  requires tool results to follow the tool_use turn as user content). */
function toAnthropicMessages(req: LLMRequest): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  let pendingToolResults: Anthropic.ToolResultBlockParam[] = [];

  const flushToolResults = () => {
    if (pendingToolResults.length) {
      out.push({ role: "user", content: pendingToolResults });
      pendingToolResults = [];
    }
  };

  for (const m of req.messages) {
    if (m.role === "tool") {
      pendingToolResults.push({
        type: "tool_result",
        tool_use_id: m.toolCallId ?? "",
        content: m.content,
      });
      continue;
    }
    flushToolResults();

    if (m.role === "assistant" && m.toolCalls?.length) {
      const blocks: Array<Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam> = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls) {
        blocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: safeJson(tc.arguments),
        });
      }
      out.push({ role: "assistant", content: blocks });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  flushToolResults();
  return out;
}

function safeJson(s: string): unknown {
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    return {};
  }
}

function toAnthropicTools(req: LLMRequest): Anthropic.Tool[] | undefined {
  if (!req.tools?.length || req.toolChoice === "none") return undefined;
  return req.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Tool.InputSchema,
  }));
}

function toAnthropicToolChoice(
  req: LLMRequest,
): Anthropic.ToolChoice | undefined {
  if (!req.tools?.length || !req.toolChoice || req.toolChoice === "none") {
    return undefined;
  }
  if (req.toolChoice === "auto") return { type: "auto" };
  if (req.toolChoice === "required") return { type: "any" };
  return { type: "tool", name: req.toolChoice.name };
}

/** Build the create() params shared by call() and stream(). */
function buildParams(req: LLMRequest): Anthropic.MessageCreateParamsNonStreaming {
  const tools = toAnthropicTools(req);
  const toolChoice = toAnthropicToolChoice(req);
  return {
    model: req.model,
    max_tokens: req.maxTokens,
    temperature: req.temperature,
    ...(req.systemPrompt ? { system: req.systemPrompt } : {}),
    ...(tools ? { tools } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
    messages: toAnthropicMessages(req),
  };
}

/** Pull text + tool calls out of a finished Anthropic message. */
function fromAnthropicMessage(msg: Anthropic.Message, model: string): LLMResponse {
  let content = "";
  const toolCalls: ToolCall[] = [];
  for (const b of msg.content) {
    if (b.type === "text") content += b.text;
    else if (b.type === "tool_use") {
      toolCalls.push({
        id: b.id,
        name: b.name,
        arguments: JSON.stringify(b.input ?? {}),
      });
    }
  }
  const input = msg.usage.input_tokens;
  const output = msg.usage.output_tokens;
  return {
    content,
    model: msg.model || model,
    provider: "anthropic",
    tokensUsed: { input, output },
    cost: computeCost(msg.model || model, input, output),
    latencyMs: 0, // filled by caller
    finishReason: msg.stop_reason ?? "unknown",
    ...(toolCalls.length ? { toolCalls } : {}),
  };
}

function wrapError(err: unknown, latencyMs: number): GatewayError {
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 502;
    return new GatewayError(
      status === 401 ? 502 : status, // 401 is OUR key problem, not the client's
      "provider_error",
      `Anthropic API error (${status}) after ${latencyMs}ms: ${err.message}`,
    );
  }
  return new GatewayError(
    502,
    "provider_unavailable",
    `Anthropic call failed after ${latencyMs}ms: ${(err as Error).message}`,
  );
}

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
      const msg = await this.client.messages.create(buildParams(req));
      const res = fromAnthropicMessage(msg, req.model);
      res.latencyMs = Date.now() - start;
      return res;
    } catch (err) {
      throw wrapError(err, Date.now() - start);
    }
  }

  async *stream(req: LLMRequest): AsyncGenerator<string, LLMResponse, void> {
    const start = Date.now();
    let stream: ReturnType<Anthropic["messages"]["stream"]>;
    try {
      // Calling .stream() (and awaiting the first event) is where a pre-token
      // failure surfaces — dispatch relies on that for fallback.
      stream = this.client.messages.stream(buildParams(req));
    } catch (err) {
      throw wrapError(err, Date.now() - start);
    }

    try {
      for await (const event of stream) {
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          yield event.delta.text;
        }
      }
      const final = await stream.finalMessage();
      const res = fromAnthropicMessage(final, req.model);
      res.latencyMs = Date.now() - start;
      return res;
    } catch (err) {
      throw wrapError(err, Date.now() - start);
    }
  }
}
