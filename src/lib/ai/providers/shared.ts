import {
  AiError,
  isPlainChat,
  type AiUsage,
  type ProviderMessage,
  type ToolCall,
  type ToolDef,
} from '../types'

// ============================================================
// Bits shared by the OpenAI + Anthropic adapters.
// ============================================================

export interface ProviderArgs {
  apiKey: string
  model: string
  systemPrompt: string
  messages: ProviderMessage[]
  timeoutMs: number
  /** Tool declarations for this call; omit for plain text generation. */
  tools?: ToolDef[]
}

/**
 * Coerce a provider's usage block into our normalized `AiUsage`, tolerant
 * of missing/partial fields (providers differ and older API versions may
 * omit counts). Returns null when there's nothing usable, so logging can
 * distinguish "no usage reported" from "zero tokens". `total` falls back
 * to prompt + completion when the provider doesn't send it (Anthropic).
 */
export function normalizeUsage(raw: {
  prompt?: unknown
  completion?: unknown
  total?: unknown
}): AiUsage | null {
  const num = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0
  const promptTokens = num(raw.prompt)
  const completionTokens = num(raw.completion)
  const total = num(raw.total)
  const totalTokens = total > 0 ? total : promptTokens + completionTokens
  if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) {
    return null
  }
  return { promptTokens, completionTokens, totalTokens }
}

/** Map a fetch rejection (timeout / DNS / offline) to a typed AiError. */
export function toNetworkError(err: unknown): AiError {
  if (err instanceof DOMException && err.name === 'TimeoutError') {
    return new AiError('The AI provider took too long to respond.', {
      code: 'timeout',
      status: 504,
    })
  }
  const msg = err instanceof Error ? err.message : String(err)
  return new AiError(`Could not reach the AI provider: ${msg}`, {
    code: 'network_error',
    status: 502,
  })
}

/** Build a typed AiError from a non-2xx provider response, pulling the
 *  provider's own error message out of the JSON body when present. */
export async function providerHttpError(
  provider: string,
  res: Response,
): Promise<AiError> {
  let detail = ''
  try {
    const body = (await res.json()) as { error?: { message?: string } | string }
    detail =
      typeof body?.error === 'string'
        ? body.error
        : (body?.error?.message ?? '')
  } catch {
    // Non-JSON error body — fall back to the status line.
  }

  const { status } = res
  const code =
    status === 401 || status === 403
      ? 'invalid_key'
      : status === 429
        ? 'rate_limited'
        : 'provider_error'
  const base =
    code === 'invalid_key'
      ? `${provider} rejected the API key`
      : code === 'rate_limited'
        ? `${provider} rate limit reached`
        : `${provider} API error (${status})`

  return new AiError(detail ? `${base}: ${detail}` : base, {
    code,
    // Surface an auth failure as 401 so the settings "Test key" button
    // can show "invalid key"; everything else is an upstream 502.
    status: code === 'invalid_key' ? 401 : 502,
  })
}

/**
 * Collapse consecutive same-role plain-text turns into one (joined with
 * blank lines). Anthropic requires strictly alternating roles; merging
 * is also harmless for OpenAI and keeps the transcript compact. Tool
 * turns (assistant tool-calls / tool results) are never merged — they
 * carry structure the providers need intact.
 */
export function mergeConsecutive(messages: ProviderMessage[]): ProviderMessage[] {
  const out: ProviderMessage[] = []
  for (const m of messages) {
    const last = out[out.length - 1]
    if (
      last &&
      isPlainChat(last) &&
      isPlainChat(m) &&
      last.role === m.role
    ) {
      last.content = `${last.content}\n\n${m.content}`
    } else {
      out.push(isPlainChat(m) ? { role: m.role, content: m.content } : m)
    }
  }
  return out
}

// ------------------------------------------------------------
// OpenAI-style Chat Completions mapping, shared by the OpenAI and
// OpenRouter adapters (OpenRouter is wire-compatible).
// ------------------------------------------------------------

interface OpenAiWireToolCall {
  id?: string
  function?: { name?: string; arguments?: string }
}

/** Map our neutral turns to Chat Completions `messages` entries. */
export function toOpenAiMessages(
  systemPrompt: string,
  messages: ProviderMessage[],
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [
    { role: 'system', content: systemPrompt },
  ]
  for (const m of mergeConsecutive(messages)) {
    if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content })
    } else if ('toolCalls' in m) {
      out.push({
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: c.arguments },
        })),
      })
    } else {
      out.push({ role: m.role, content: m.content })
    }
  }
  return out
}

/** Map tool declarations to Chat Completions `tools` entries. */
export function toOpenAiTools(tools: ToolDef[]): Record<string, unknown>[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }))
}

/** Parse `tool_calls` off a Chat Completions choice message, tolerant
 *  of partial entries (skipped rather than crashing the reply path). */
export function parseOpenAiToolCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return []
  const out: ToolCall[] = []
  for (const c of raw as OpenAiWireToolCall[]) {
    const name = c?.function?.name
    if (!c?.id || !name) continue
    out.push({ id: c.id, name, arguments: c.function?.arguments ?? '{}' })
  }
  return out
}
