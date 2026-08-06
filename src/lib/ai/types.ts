// ============================================================
// Shared types for the AI reply assistant (bring-your-own-key).
//
// One small provider-agnostic surface so the inbox draft route and the
// inbound auto-reply bot both talk to `generateReply` without caring
// whether the account is on OpenAI or Anthropic.
// ============================================================

export type AiProvider = 'openai' | 'anthropic' | 'openrouter'

/**
 * Account AI setup, decrypted and ready to use. Produced by
 * `loadAiConfig` — `apiKey` is the plaintext BYO provider key
 * (stored AES-256-GCM-encrypted at rest).
 */
export interface AiConfig {
  provider: AiProvider
  model: string
  apiKey: string
  systemPrompt: string | null
  isActive: boolean
  autoReplyEnabled: boolean
  autoReplyMaxPerConversation: number
  /** Where auto-reply hands a conversation off when the model bails: an
   *  agent's `auth.users.id`, or null to leave it unassigned (drop into
   *  the shared queue). */
  handoffAgentId: string | null
  /** Optional OpenAI-compatible key for embeddings. When set, the
   *  knowledge base is embedded and semantic retrieval turns on; when
   *  null, retrieval falls back to lexical full-text search. */
  embeddingsApiKey: string | null
}

/** A single conversation turn in the shape both providers accept. */
export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

// ------------------------------------------------------------
// Tool calling (agent loop). Provider-neutral shapes: adapters
// translate to/from each provider's wire format.
// ------------------------------------------------------------

/** Declaration of one callable tool, sent to the provider. */
export interface ToolDef {
  name: string
  description: string
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>
}

/** One tool invocation the model requested. */
export interface ToolCall {
  id: string
  name: string
  /** Raw JSON string of the arguments, as the model produced them. */
  arguments: string
}

/** A declared tool plus its server-side executor. `run` receives the
 *  parsed arguments and returns a plain-text result for the model; it
 *  should return error strings rather than throw for bad input. */
export interface ExecutableTool {
  def: ToolDef
  run(args: Record<string, unknown>): Promise<string>
}

/** Assistant turn that requested tool calls (agent-loop internal —
 *  never persisted or shown to the customer). */
export interface AssistantToolMessage {
  role: 'assistant'
  content: string
  toolCalls: ToolCall[]
}

/** Result of one executed tool call, fed back to the model. */
export interface ToolResultMessage {
  role: 'tool'
  toolCallId: string
  name: string
  content: string
}

/** What provider adapters actually accept: the persisted transcript
 *  plus any in-flight tool turns appended by the agent loop. */
export type ProviderMessage =
  | ChatMessage
  | AssistantToolMessage
  | ToolResultMessage

/** Narrow a ProviderMessage to a plain text turn (no tool traffic). */
export function isPlainChat(m: ProviderMessage): m is ChatMessage {
  return (
    (m.role === 'user' || m.role === 'assistant') &&
    !('toolCalls' in m)
  )
}

/**
 * Token counts for one provider call, normalized across OpenAI
 * (`prompt`/`completion`) and Anthropic (`input`/`output`). Null when
 * the provider didn't return usage. Logged to `ai_usage_log`.
 */
export interface AiUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

/** Raw text + usage a provider adapter returns before handoff parsing.
 *  `toolCalls` is non-empty when the model asked to run tools instead
 *  of (or in addition to) producing text. */
export interface ProviderResult {
  text: string
  toolCalls: ToolCall[]
  usage: AiUsage | null
}

/** Outcome of a generation call. */
export interface GenerateResult {
  /** The reply text, with any handoff sentinel stripped. */
  text: string
  /** True when the model asked to hand off to a human (auto-reply mode). */
  handoff: boolean
  /** Provider token usage for this call, or null when unavailable. */
  usage: AiUsage | null
}

/**
 * Typed error for every AI failure mode. `status` maps cleanly to an
 * HTTP response in the draft route; `code` lets the UI/tests branch
 * (invalid_key vs rate_limited vs timeout, etc.).
 */
export class AiError extends Error {
  readonly code: string
  readonly status: number
  constructor(message: string, opts: { code?: string; status?: number } = {}) {
    super(message)
    this.name = 'AiError'
    this.code = opts.code ?? 'ai_error'
    this.status = opts.status ?? 502
  }
}
