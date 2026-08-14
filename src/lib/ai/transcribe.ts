import type { SupabaseClient } from '@supabase/supabase-js'
import { AiError, type AiConfig } from './types'
import { aiRequestTimeoutMs } from './defaults'
import { loadAiConfig } from './config'
import { providerHttpError, toNetworkError } from './providers/shared'

// ============================================================
// Speech-to-text for inbound voice notes (migration 042).
//
// Whisper is an OpenAI endpoint; Anthropic has none, and OpenRouter
// proxies chat completions rather than audio. So this always talks to
// api.openai.com with an OpenAI-compatible key — exactly the same
// constraint (and key-selection story) as embeddings.ts.
//
// Everything here is best-effort: a voice note that can't be
// transcribed still lands in the inbox with its audio player. It just
// won't reach the bot.
// ============================================================

const OPENAI_TRANSCRIPTIONS_URL = 'https://api.openai.com/v1/audio/transcriptions'

const TRANSCRIBE_MODEL = 'whisper-1'

/** OpenAI rejects uploads past 25 MB. WhatsApp voice notes are far
 *  smaller, so anything near this is not a voice note worth sending. */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024

/**
 * The OpenAI-compatible key to transcribe with, or null when the
 * account has none.
 *
 * Prefers the dedicated embeddings key (explicitly an OpenAI key),
 * falling back to the main key only when the provider IS OpenAI — an
 * Anthropic or OpenRouter key would be rejected by api.openai.com.
 */
export function transcriptionKey(config: AiConfig): string | null {
  if (config.embeddingsApiKey) return config.embeddingsApiKey
  if (config.provider === 'openai') return config.apiKey
  return null
}

/**
 * Transcribe audio bytes. Throws `AiError` on provider/network
 * failure; callers degrade rather than surface.
 */
export async function transcribeAudio(args: {
  apiKey: string
  audio: Buffer
  /** MIME type from Meta, e.g. "audio/ogg; codecs=opus". */
  contentType: string
}): Promise<string> {
  const { apiKey, audio, contentType } = args

  if (audio.byteLength === 0) {
    throw new AiError('Empty audio payload.', { code: 'empty_audio' })
  }
  if (audio.byteLength > MAX_AUDIO_BYTES) {
    throw new AiError('Audio is too large to transcribe.', {
      code: 'audio_too_large',
    })
  }

  // Whisper picks the decoder from the filename extension, so the
  // extension has to match the actual container. WhatsApp voice notes
  // are OGG/Opus; other inbound audio can be mp3/mp4/amr.
  const mime = contentType.split(';')[0].trim().toLowerCase()
  const ext = MIME_EXTENSION[mime] ?? 'ogg'

  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(audio)], { type: mime }), `audio.${ext}`)
  form.append('model', TRANSCRIBE_MODEL)

  let res: Response
  try {
    res = await fetch(OPENAI_TRANSCRIPTIONS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(aiRequestTimeoutMs()),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) throw await providerHttpError('OpenAI', res)

  const data = (await res.json().catch(() => null)) as { text?: string } | null
  const text = typeof data?.text === 'string' ? data.text.trim() : ''
  if (!text) {
    throw new AiError('Transcription returned no text.', {
      code: 'empty_transcription',
    })
  }
  return text
}

const MIME_EXTENSION: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'm4a',
  'audio/wav': 'wav',
  'audio/webm': 'webm',
  'audio/amr': 'amr',
}

/**
 * Transcribe an inbound voice note for an account, resolving the key
 * from its AI config. Returns null — never throws — whenever
 * transcription isn't possible (AI off, no OpenAI-compatible key,
 * provider error): the voice note still reaches the inbox, it just
 * won't be readable by the bot.
 */
export async function transcribeInboundAudio(
  db: SupabaseClient,
  args: { accountId: string; audio: Buffer; contentType: string },
): Promise<string | null> {
  try {
    const config = await loadAiConfig(db, args.accountId)
    if (!config) return null

    const apiKey = transcriptionKey(config)
    if (!apiKey) {
      console.info(
        `[transcribe] account ${args.accountId} has no OpenAI-compatible key — voice notes stay untranscribed. Add an embeddings key (an OpenAI key) in the AI setup to enable this.`,
      )
      return null
    }

    return await transcribeAudio({
      apiKey,
      audio: args.audio,
      contentType: args.contentType,
    })
  } catch (err) {
    console.error(
      '[transcribe] failed:',
      err instanceof Error ? err.message : err,
    )
    return null
  }
}
