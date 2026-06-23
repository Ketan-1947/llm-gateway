// OpenAI-compatible facade. Lets any editor/tool that speaks the OpenAI Chat
// Completions protocol (Continue, Cline, Cursor, Zed, Copilot Chat BYOK, the
// `openai` SDK, etc.) use this gateway as a "custom model provider":
//
//   Base URL: http://<host>:<port>/v1     API key: a GATEWAY_API_KEY
//
//   GET  /v1/models               — model list (OpenAI shape)
//   POST /v1/chat/completions     — chat, with optional SSE streaming + tools
//
// Both translate to/from the same internal pipeline used by /v1/chat. Plain
// chats take the "simple" path (optimiser + routing). Requests carrying `tools`
// or tool messages take the "rich" path: the full message list is passed
// through verbatim (optimiser skipped) so tool-call structure is preserved.

import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { apiKeyAuth, requestKeyId } from "../services/auth.js";
import { PRICE_TABLE } from "../config.js";
import {
  runChatPipeline,
  runChatPipelineStream,
  type PipelineInput,
  type Services,
} from "../pipeline/pipeline.js";
import {
  GatewayError,
  type ChatPreferences,
  type LLMResponse,
  type Message,
  type Role,
  type ToolCall,
  type ToolChoice,
  type ToolDef,
} from "../shared/types.js";

/** The virtual model that triggers full optimise + intelligent routing. */
const AUTO_MODEL = "gateway-auto";

// ---- OpenAI request shapes (only the fields we read) ----
type ContentPart = { type?: string; text?: string };
interface OAIToolCall {
  id: string;
  type?: string;
  function: { name: string; arguments: string };
}
interface OAIMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content: string | ContentPart[] | null;
  tool_calls?: OAIToolCall[];
  tool_call_id?: string;
}
interface OAITool {
  type?: string;
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
}
type OAIToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };
interface ChatCompletionsBody {
  model?: string;
  messages: OAIMessage[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  temperature?: number;
  max_tokens?: number;
  tools?: OAITool[];
  tool_choice?: OAIToolChoice;
}

/** Flatten OpenAI content (string | parts[] | null) into plain text. */
function textOf(content: OAIMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p?.text === "string" ? p.text : "")).join("");
  }
  return "";
}

function toToolDefs(tools?: OAITool[]): ToolDef[] | undefined {
  const defs = (tools ?? [])
    .filter((t) => (t.type ?? "function") === "function" && t.function?.name)
    .map((t) => ({
      name: t.function.name,
      ...(t.function.description ? { description: t.function.description } : {}),
      parameters: t.function.parameters ?? {},
    }));
  return defs.length ? defs : undefined;
}

function toToolChoice(tc?: OAIToolChoice): ToolChoice | undefined {
  if (!tc) return undefined;
  if (typeof tc === "string") return tc; // auto | none | required
  if (tc.type === "function" && tc.function?.name) {
    return { type: "function", name: tc.function.name };
  }
  return undefined;
}

/** True when the request involves tools (defs or tool turns) -> rich path. */
function isRich(body: ChatCompletionsBody): boolean {
  if (toToolDefs(body.tools)) return true;
  return body.messages.some(
    (m) => m.role === "tool" || (m.role === "assistant" && !!m.tool_calls?.length),
  );
}

function lastUserText(messages: OAIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return textOf(messages[i].content);
  }
  return "";
}

function systemTextOf(messages: OAIMessage[]): string | undefined {
  const s = messages
    .filter((m) => m.role === "system" || m.role === "developer")
    .map((m) => textOf(m.content))
    .filter(Boolean)
    .join("\n\n");
  return s || undefined;
}

/** Translate OpenAI messages -> normalized Message[] for the rich path. */
function toNormalizedMessages(messages: OAIMessage[]): Message[] {
  const out: Message[] = [];
  for (const m of messages) {
    if (m.role === "system" || m.role === "developer") continue; // -> systemPrompt
    if (m.role === "tool") {
      out.push({ role: "tool", content: textOf(m.content), toolCallId: m.tool_call_id });
    } else if (m.role === "assistant") {
      const toolCalls: ToolCall[] = (m.tool_calls ?? []).map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      }));
      out.push({
        role: "assistant",
        content: textOf(m.content),
        ...(toolCalls.length ? { toolCalls } : {}),
      });
    } else {
      out.push({ role: m.role as Role, content: textOf(m.content) });
    }
  }
  return out;
}

/** Map a requested OpenAI model id to gateway routing preferences. */
function preferencesFor(model: string | undefined): ChatPreferences {
  // Auto / unknown ids -> let the router decide (the gateway's whole point).
  if (!model || model === AUTO_MODEL || !PRICE_TABLE[model]) return {};
  // A concrete catalog id -> honour it as an explicit choice.
  return { forceModel: model };
}

/** Build the pipeline input from an OpenAI request (simple or rich). */
function toPipelineInput(body: ChatCompletionsBody, keyId: string): PipelineInput {
  const base: PipelineInput = {
    keyId,
    preferences: preferencesFor(body.model),
    systemPrompt: systemTextOf(body.messages),
    maxTokens: body.max_tokens,
    temperature: body.temperature,
  };

  if (isRich(body)) {
    return {
      ...base,
      messages: toNormalizedMessages(body.messages),
      tools: toToolDefs(body.tools),
      toolChoice: toToolChoice(body.tool_choice),
      classifyText: lastUserText(body.messages),
    };
  }

  // Simple path: last user turn -> prompt, prior user/assistant -> context.
  const turns = body.messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role as Role, content: textOf(m.content) }));
  let lastUser = -1;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === "user") {
      lastUser = i;
      break;
    }
  }
  if (lastUser === -1) {
    throw new GatewayError(400, "invalid_request", "messages[] must contain a user message.");
  }
  return {
    ...base,
    prompt: turns[lastUser].content,
    context: turns.slice(0, lastUser),
  };
}

/** Best-effort map of provider finish reasons to OpenAI's vocabulary. */
function finishReason(llm: LLMResponse): "stop" | "length" | "tool_calls" {
  if (llm.toolCalls?.length) return "tool_calls";
  return /max|length/i.test(llm.finishReason) ? "length" : "stop";
}

function toOAIToolCalls(toolCalls: ToolCall[] | undefined) {
  return (toolCalls ?? []).map((tc, index) => ({
    index,
    id: tc.id,
    type: "function" as const,
    function: { name: tc.name, arguments: tc.arguments },
  }));
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function sse(reply: FastifyReply, payload: unknown): void {
  reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function registerOpenAICompatRoutes(
  app: FastifyInstance,
  services: Services,
): void {
  // --- GET /v1/models (OpenAI list shape) ---
  app.get("/v1/models", { preHandler: apiKeyAuth }, async () => {
    const created = nowSec();
    const data = [
      {
        id: AUTO_MODEL,
        object: "model",
        created,
        owned_by: "llm-gateway",
        description:
          "Optimise + intelligent routing across all providers (recommended).",
      },
      ...Object.entries(PRICE_TABLE).map(([id, p]) => ({
        id,
        object: "model",
        created,
        owned_by: p.provider,
      })),
    ];
    return { object: "list", data };
  });

  // --- POST /v1/chat/completions (OpenAI shape; tools + optional SSE) ---
  app.post<{ Body: ChatCompletionsBody }>(
    "/v1/chat/completions",
    { preHandler: apiKeyAuth },
    async (req, reply) => {
      const body = req.body;
      if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
        throw new GatewayError(
          400,
          "invalid_request",
          "Request body must include a non-empty messages[] array.",
        );
      }

      const input = toPipelineInput(body, requestKeyId(req));

      // ---------- Non-streaming ----------
      if (!body.stream) {
        const { llm, requestId } = await runChatPipeline(services, input);
        const toolCalls = toOAIToolCalls(llm.toolCalls);
        reply.header("x-request-id", requestId);
        return {
          id: `chatcmpl-${randomUUID()}`,
          object: "chat.completion",
          created: nowSec(),
          model: llm.model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: llm.content || null,
                ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
              },
              finish_reason: finishReason(llm),
            },
          ],
          usage: {
            prompt_tokens: llm.tokensUsed.input,
            completion_tokens: llm.tokensUsed.output,
            total_tokens: llm.tokensUsed.input + llm.tokensUsed.output,
          },
          // Gateway-specific extras under a namespaced key (clients ignore it).
          x_gateway_metadata: { requestId },
        };
      }

      // ---------- Streaming (true token streaming via SSE) ----------
      const gen = runChatPipelineStream(services, input);
      const id = `chatcmpl-${randomUUID()}`;
      const created = nowSec();
      let model = body.model && PRICE_TABLE[body.model] ? body.model : AUTO_MODEL;
      let started = false;

      // Hijack + opening role chunk, done exactly once before the first frame.
      const ensureStart = (): { id: string; object: string; created: number; model: string } => {
        const base = { id, object: "chat.completion.chunk", created, model };
        if (started) return base;
        started = true;
        reply.hijack();
        reply.raw.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
        });
        sse(reply, {
          ...base,
          choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        });
        return base;
      };

      try {
        // 1) Pull the "start" event. prepare() runs here — a GatewayError
        //    (rate-limit/guard/budget) throws BEFORE we hijack, so the global
        //    error handler can still send a clean JSON error.
        let ev = await gen.next();
        if (!ev.done && ev.value.type === "start") {
          model = ev.value.model;
        }

        // 2) Stream deltas (lazily starting the SSE response on the first one).
        ev = await gen.next();
        while (!ev.done) {
          if (ev.value.type === "delta" && ev.value.text) {
            const base = ensureStart();
            sse(reply, {
              ...base,
              choices: [{ index: 0, delta: { content: ev.value.text }, finish_reason: null }],
            });
          }
          ev = await gen.next();
        }

        // 3) Finalised result (also covers tool-only responses with no deltas).
        const { llm } = ev.value;
        const base = ensureStart();
        const toolCalls = toOAIToolCalls(llm.toolCalls);
        if (toolCalls.length) {
          sse(reply, {
            ...base,
            choices: [{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: null }],
          });
        }
        sse(reply, {
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: finishReason(llm) }],
        });
        if (body.stream_options?.include_usage) {
          sse(reply, {
            ...base,
            choices: [],
            usage: {
              prompt_tokens: llm.tokensUsed.input,
              completion_tokens: llm.tokensUsed.output,
              total_tokens: llm.tokensUsed.input + llm.tokensUsed.output,
            },
          });
        }
        reply.raw.write("data: [DONE]\n\n");
        reply.raw.end();
      } catch (err) {
        // Pre-stream failure -> let the global handler send JSON. Mid-stream
        // failure -> we've already committed headers, so emit an error frame.
        if (!started) throw err;
        const message =
          err instanceof Error ? err.message : "Unexpected streaming error.";
        sse(reply, { error: { message } });
        reply.raw.write("data: [DONE]\n\n");
        reply.raw.end();
      }
    },
  );
}
