// Shared types for the LLM gateway.
// In Phase 1 the only live provider is Anthropic (Claude), but these
// interfaces are the seam every future provider plugs into.

// "tool" turns carry the result of a tool the assistant asked to call.
export type Role = "user" | "assistant" | "tool";

/** A tool the assistant decided to invoke (provider-agnostic). `arguments` is
 *  the raw JSON string of the call's arguments, as both vendors emit it. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface Message {
  role: Role;
  content: string;
  /** assistant turns only: tool calls the model emitted. */
  toolCalls?: ToolCall[];
  /** "tool" turns only: which tool call this message is the result of. */
  toolCallId?: string;
}

/** A function tool the caller exposes to the model. `parameters` is a JSON
 *  Schema object (OpenAI's "function.parameters" / Anthropic's "input_schema"). */
export interface ToolDef {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

/** Normalized tool-choice. Maps to each vendor's own representation. */
export type ToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; name: string };

/** Normalized request handed to any ProviderAdapter. */
export interface LLMRequest {
  model: string;
  messages: Message[];
  maxTokens: number;
  temperature: number;
  systemPrompt?: string;
  tools?: ToolDef[];
  toolChoice?: ToolChoice;
}

/** Normalized response returned by any ProviderAdapter. */
export interface LLMResponse {
  content: string;
  model: string;
  provider: ProviderName;
  tokensUsed: { input: number; output: number };
  cost: number; // USD, computed from the central price table
  latencyMs: number;
  finishReason: string;
  /** Present when the model asked to call one or more tools. */
  toolCalls?: ToolCall[];
}

// "groq" hosts the cheap LLM classifier (llama-3.1-8b-instant). It is not a
// general answer-provider yet, but lives in the union so the price table and
// cost accounting can price classifier calls through the same path.
export type ProviderName = "anthropic" | "openai" | "groq";

// ---- Classifier + Router types (Phase 2) ----

export type TaskType =
  | "SIMPLE_QA"
  | "CREATIVE"
  | "CODE_SIMPLE"
  | "CODE_COMPLEX"
  | "REASONING"
  | "LONG_CONTEXT"
  | "MULTIMODAL"
  | "CONVERSATION"
  | "RESEARCH"
  | "SAFETY_SENSITIVE";

export interface ClassifierResult {
  taskType: TaskType;
  confidence: number; // 0..1
  signals: string[]; // human-readable reasons the type was chosen
  approxTokens: number;
}

export interface RouteTarget {
  provider: ProviderName;
  model: string;
}

export interface RoutingDecision {
  provider: ProviderName;
  model: string;
  reason: string;
  fallbacks: RouteTarget[];
}

/** The single interface the rest of the app talks to. Add a provider by
 *  implementing this — nothing else in the system needs to change. */
export interface ProviderAdapter {
  readonly provider: ProviderName;
  /** Does this adapter own the given model id? */
  supports(model: string): boolean;
  /** Make the call and return a normalized response. */
  call(req: LLMRequest): Promise<LLMResponse>;
  /** Stream the call: yields text deltas as they arrive and RETURNS the final
   *  normalized response (with usage/cost/toolCalls) when the stream ends.
   *  Errors thrown before the first yield are eligible for cross-provider
   *  fallback in dispatch; once text has been yielded, fallback is impossible. */
  stream(req: LLMRequest): AsyncGenerator<string, LLMResponse, void>;
}

// ---- Public API shapes (what clients send/receive on /v1/chat) ----

export interface ChatPreferences {
  forceModel?: string;
  optimise?: boolean; // accepted now, wired up in Phase 3
  showOptimisedPrompt?: boolean;
  maxCost?: number; // accepted now, enforced in Phase 5
}

export interface ChatRequestBody {
  prompt: string;
  context?: Message[];
  preferences?: ChatPreferences;
}

export interface ChatResponseBody {
  response: string;
  metadata: {
    originalPrompt: string;
    optimisedPrompt: string;
    rulesApplied: string[];
    tokensSaved: number;
    estCostSaved: number; // USD, tokensSaved priced at the routed model's input rate
    modelUsed: string;
    provider: ProviderName;
    taskType: string;
    classificationConfidence: number;
    routingReason: string;
    fallbackUsed: boolean;
    guardFlags: string[];
    tokensUsed: { input: number; output: number };
    cost: number;
    latencyMs: number;
    requestId: string;
  };
}

export class GatewayError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}
