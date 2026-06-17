// Shared types for the LLM gateway.
// In Phase 1 the only live provider is Anthropic (Claude), but these
// interfaces are the seam every future provider plugs into.

export type Role = "user" | "assistant";

export interface Message {
  role: Role;
  content: string;
}

/** Normalized request handed to any ProviderAdapter. */
export interface LLMRequest {
  model: string;
  messages: Message[];
  maxTokens: number;
  temperature: number;
  systemPrompt?: string;
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
}

export type ProviderName = "anthropic" | "openai";

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
