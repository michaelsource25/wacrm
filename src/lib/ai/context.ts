import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChatMessage } from './types'
import { aiContextMessageLimit } from './defaults'

interface DbMessage {
  sender_type: 'customer' | 'agent' | 'bot'
  content_type: string
  content_text: string | null
  transcript: string | null
}

/**
 * Fetch the last N readable messages of a conversation and map them to
 * the provider-neutral chat shape. Customer messages become `user`;
 * agent and bot messages become `assistant`.
 *
 * "Readable" is text plus transcribed voice notes (migration 042) —
 * to the model, a transcribed audio turn is just something the
 * customer said. Media without a transcript, templates, and
 * interactive taps carry no text to model and are excluded.
 *
 * Ordered oldest-first (chronological) so the transcript reads
 * naturally and the most recent customer message lands last.
 */
export async function buildConversationContext(
  db: SupabaseClient,
  conversationId: string,
  limit: number = aiContextMessageLimit(),
): Promise<ChatMessage[]> {
  const { data, error } = await db
    .from('messages')
    .select('sender_type, content_type, content_text, transcript')
    .eq('conversation_id', conversationId)
    .or('content_type.eq.text,transcript.not.is.null')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw error

  const rows = ((data ?? []) as DbMessage[]).reverse()
  return rows
    .map((m) => ({
      sender_type: m.sender_type,
      // A voice note's transcript stands in for its (usually empty)
      // content_text; a captioned audio keeps both, caption first.
      text: [m.content_text?.trim(), m.transcript?.trim()]
        .filter(Boolean)
        .join('\n')
        .trim(),
    }))
    .filter((m) => m.text)
    // Drop past assistant turns that contain leaked tool syntax (a
    // weak model once wrote its tool call as text and it got sent):
    // left in context, the model reads its own garbage as "how I
    // reply here" and imitates it forever.
    .filter(
      (m) =>
        m.sender_type === 'customer' || !/tool_code|default_api/i.test(m.text),
    )
    .map((m) => ({
      role: m.sender_type === 'customer' ? 'user' : 'assistant',
      content: m.text,
    }))
}
