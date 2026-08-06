import { AiError, type ProviderResult } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import {
  normalizeUsage,
  parseOpenAiToolCalls,
  providerHttpError,
  toNetworkError,
  toOpenAiMessages,
  toOpenAiTools,
  type ProviderArgs,
} from './shared'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

interface OpenRouterResponse {
  choices?: { message?: { content?: string | null; tool_calls?: unknown } }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

/**
 * Call OpenRouter's Chat Completions endpoint with the caller's own key.
 * OpenRouter is OpenAI-compatible and fronts hundreds of vendor models
 * (`vendor/model` IDs) behind one key, so this mirrors the OpenAI adapter
 * almost exactly — `max_tokens` rather than `max_completion_tokens`,
 * since that's the field OpenRouter documents and translates for every
 * backend model, not just OpenAI's own. Tool calls use the same wire
 * shape as OpenAI (OpenRouter translates for non-OpenAI backends).
 */
export async function generateOpenRouter(args: ProviderArgs): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs, tools } = args

  let res: Response
  try {
    res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: toOpenAiMessages(systemPrompt, messages),
        max_tokens: MAX_OUTPUT_TOKENS,
        ...(tools && tools.length > 0 ? { tools: toOpenAiTools(tools) } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError('OpenRouter', res)
  }

  const data = (await res.json().catch(() => null)) as OpenRouterResponse | null
  const message = data?.choices?.[0]?.message
  const text = typeof message?.content === 'string' ? message.content.trim() : ''
  const toolCalls = parseOpenAiToolCalls(message?.tool_calls)
  if (!text && toolCalls.length === 0) {
    throw new AiError('OpenRouter returned an empty response.', {
      code: 'empty_response',
    })
  }
  const usage = normalizeUsage({
    prompt: data?.usage?.prompt_tokens,
    completion: data?.usage?.completion_tokens,
    total: data?.usage?.total_tokens,
  })
  return { text, toolCalls, usage }
}
