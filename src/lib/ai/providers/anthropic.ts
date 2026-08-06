import {
  AiError,
  type ProviderMessage,
  type ProviderResult,
  type ToolCall,
} from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import {
  mergeConsecutive,
  normalizeUsage,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
} from './shared'

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'

interface AnthropicContentBlock {
  type?: string
  text?: string
  id?: string
  name?: string
  input?: unknown
}

interface AnthropicResponse {
  content?: AnthropicContentBlock[]
  usage?: { input_tokens?: number; output_tokens?: number }
}

/**
 * Anthropic's Messages API requires strictly alternating roles that
 * begin with `user`. Merge consecutive plain turns, then drop any
 * leading assistant turns (an agent greeting before the customer said
 * anything) so the transcript always starts on the customer. Tool
 * turns only ever appear at the tail (appended by the agent loop), so
 * they are unaffected. Guarantees a valid, non-empty payload.
 */
function normalizeForAnthropic(messages: ProviderMessage[]): ProviderMessage[] {
  const merged = mergeConsecutive(messages)
  while (merged.length > 0 && merged[0].role === 'assistant') {
    merged.shift()
  }
  if (merged.length === 0) {
    return [{ role: 'user', content: '(The customer has not sent a message yet.)' }]
  }
  return merged
}

/** Parse a tool call's raw JSON arguments, falling back to {} so a
 *  malformed blob degrades to "tool ran with no args" rather than a
 *  crashed reply. */
function parseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

/**
 * Map our neutral turns to Anthropic `messages` entries. Tool results
 * become `user` turns with `tool_result` blocks; consecutive tool
 * results are folded into one user turn to keep roles alternating.
 */
function toAnthropicMessages(
  messages: ProviderMessage[],
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const m of normalizeForAnthropic(messages)) {
    if (m.role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: m.toolCallId,
        content: m.content,
      }
      const last = out[out.length - 1]
      if (last && last.role === 'user' && Array.isArray(last.content)) {
        ;(last.content as unknown[]).push(block)
      } else {
        out.push({ role: 'user', content: [block] })
      }
    } else if ('toolCalls' in m) {
      const blocks: Record<string, unknown>[] = []
      if (m.content) blocks.push({ type: 'text', text: m.content })
      for (const c of m.toolCalls) {
        blocks.push({
          type: 'tool_use',
          id: c.id,
          name: c.name,
          input: parseArgs(c.arguments),
        })
      }
      out.push({ role: 'assistant', content: blocks })
    } else {
      out.push({ role: m.role, content: m.content })
    }
  }
  return out
}

/**
 * Call Anthropic's Messages endpoint with the caller's own key.
 * Returns the raw assistant text, any requested tool calls, and token
 * usage (handoff parsing and the tool loop live in `generateReply`).
 */
export async function generateAnthropic(args: ProviderArgs): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs, tools } = args

  let res: Response
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        system: systemPrompt,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: toAnthropicMessages(messages),
        ...(tools && tools.length > 0
          ? {
              tools: tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.parameters,
              })),
            }
          : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError('Anthropic', res)
  }

  const data = (await res.json().catch(() => null)) as AnthropicResponse | null
  const blocks = data?.content ?? []
  const text = blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim()
  const toolCalls: ToolCall[] = []
  for (const b of blocks) {
    if (b.type === 'tool_use' && b.id && b.name) {
      toolCalls.push({
        id: b.id,
        name: b.name,
        arguments: JSON.stringify(b.input ?? {}),
      })
    }
  }
  if (!text && toolCalls.length === 0) {
    throw new AiError('Anthropic returned an empty response.', {
      code: 'empty_response',
    })
  }
  // Anthropic reports input/output but no total — normalizeUsage sums.
  const usage = normalizeUsage({
    prompt: data?.usage?.input_tokens,
    completion: data?.usage?.output_tokens,
  })
  return { text, toolCalls, usage }
}
