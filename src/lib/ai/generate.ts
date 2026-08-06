import {
  AiError,
  type AiConfig,
  type AiUsage,
  type ChatMessage,
  type ExecutableTool,
  type GenerateResult,
  type ProviderMessage,
  type ProviderResult,
  type ToolCall,
} from './types'
import { HANDOFF_SENTINEL, aiRequestTimeoutMs } from './defaults'
import { generateOpenAi } from './providers/openai'
import { generateAnthropic } from './providers/anthropic'
import { generateOpenRouter } from './providers/openrouter'
import type { ProviderArgs } from './providers/shared'

/** Hard cap on model→tool round-trips per reply. Past it we make one
 *  final tools-free call so the customer still gets an answer, and the
 *  spend on the account's BYO key stays bounded. */
const MAX_TOOL_ROUNDS = 5

export interface GenerateArgs {
  config: AiConfig
  /** Fully-built system prompt (see `buildSystemPrompt`). */
  systemPrompt: string
  /** Recent conversation turns, oldest first. */
  messages: ChatMessage[]
  /** Executable tools for this call (agent mode). Omit for plain
   *  text generation — the loop then collapses to a single call. */
  tools?: ExecutableTool[]
}

/**
 * Generate the next reply from the account's configured provider.
 *
 * Without `tools` this is a single provider call. With `tools` it runs
 * the agent loop: the model may request tool calls, we execute them and
 * feed the results back, repeating until the model produces text (or
 * the round cap hits, at which point a final tools-free call forces a
 * text answer). Usage is accumulated across every call in the loop.
 * Throws `AiError` on any provider/network failure.
 */
export async function generateReply(args: GenerateArgs): Promise<GenerateResult> {
  const { config, systemPrompt, messages, tools } = args
  const timeoutMs = aiRequestTimeoutMs()
  const toolDefs = tools?.map((t) => t.def)

  const convo: ProviderMessage[] = [...messages]
  let usageTotal: AiUsage | null = null

  for (let round = 0; ; round++) {
    const useTools = !!toolDefs && toolDefs.length > 0 && round < MAX_TOOL_ROUNDS
    const result = await callProvider(config, {
      apiKey: config.apiKey,
      model: config.model,
      systemPrompt,
      messages: convo,
      timeoutMs,
      ...(useTools ? { tools: toolDefs } : {}),
    })
    usageTotal = addUsage(usageTotal, result.usage)

    if (!useTools || result.toolCalls.length === 0) {
      const parsed = parseGeneration(result.text, usageTotal)
      // Some models (notably weak/free ones) "call" tools by writing
      // the invocation as text instead of using native tool calling.
      // That syntax must never reach a customer: treat the turn as a
      // handoff so a human picks it up instead.
      if (
        toolDefs &&
        toolDefs.length > 0 &&
        parsed.text &&
        leaksToolSyntax(parsed.text, toolDefs.map((d) => d.name))
      ) {
        console.warn(
          '[ai generate] model wrote a tool call as text — handing off instead of sending it to the customer. Consider a model with solid native tool calling.',
        )
        return { text: '', handoff: true, usage: usageTotal }
      }
      return parsed
    }

    convo.push({
      role: 'assistant',
      content: result.text,
      toolCalls: result.toolCalls,
    })
    for (const call of result.toolCalls) {
      convo.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: await runTool(tools!, call),
      })
    }
  }
}

/**
 * True when reply text contains tool-invocation syntax instead of (or
 * alongside) a real message — e.g. Gemini-style `tool_code` /
 * `default_api.foo(...)` blocks, or any declared tool name used as a
 * call. Checked only when tools were offered on the request.
 */
function leaksToolSyntax(text: string, toolNames: string[]): boolean {
  if (/tool_code|default_api\s*[.(]|<\s*(tool|function)[_ ]?call/i.test(text)) {
    return true
  }
  return toolNames.some((n) => text.includes(`${n}(`))
}

/** Execute one requested tool call. Failures are reported to the model
 *  as text (so it can apologize / try differently) — a broken tool must
 *  never take down the whole reply. */
async function runTool(tools: ExecutableTool[], call: ToolCall): Promise<string> {
  const tool = tools.find((t) => t.def.name === call.name)
  if (!tool) return `Error: unknown tool "${call.name}".`
  let parsed: Record<string, unknown>
  try {
    const raw: unknown = JSON.parse(call.arguments || '{}')
    parsed = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  } catch {
    return 'Error: tool arguments were not valid JSON.'
  }
  try {
    return await tool.run(parsed)
  } catch (err) {
    console.error(`[ai tools] ${call.name} failed:`, err)
    return 'Error: the tool failed to run. Do not retry; tell the customer you could not complete this right now.'
  }
}

function addUsage(a: AiUsage | null, b: AiUsage | null): AiUsage | null {
  if (!a) return b
  if (!b) return a
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  }
}

function callProvider(config: AiConfig, args: ProviderArgs): Promise<ProviderResult> {
  switch (config.provider) {
    case 'openai':
      return generateOpenAi(args)
    case 'anthropic':
      return generateAnthropic(args)
    case 'openrouter':
      return generateOpenRouter(args)
    default:
      throw new AiError(`Unsupported AI provider: ${config.provider}`, {
        code: 'unsupported_provider',
        status: 400,
      })
  }
}

/**
 * Split the raw model output into `{ text, handoff, usage }`. The
 * sentinel can appear alone or trailing a partial reply; either way we
 * treat the turn as a handoff and strip the marker from any remaining
 * text. `usage` is passed straight through (null when the provider
 * didn't report it).
 */
export function parseGeneration(
  raw: string,
  usage: AiUsage | null = null,
): GenerateResult {
  const handoff = raw.includes(HANDOFF_SENTINEL)
  const text = raw.split(HANDOFF_SENTINEL).join('').trim()
  return { text, handoff, usage }
}
