import type { SupabaseClient } from '@supabase/supabase-js'
import { engineSendText } from '@/lib/flows/meta-send'
import { loadAiConfig } from '@/lib/ai/config'
import { buildConversationContext } from '@/lib/ai/context'
import { generateReply } from '@/lib/ai/generate'
import { logAiUsage } from '@/lib/ai/usage'
import {
  dueReminderKind,
  formatLocalParts,
  renderReminderTemplate,
  type ReminderKind,
} from './reminder-template'

// ============================================================
// Appointment reminder job (migration 040).
//
// Called from /api/appointments/reminders/cron on a schedule. Scans
// upcoming pending/confirmed appointments, picks the due reminder
// (~24h / ~2h before start), claims it with a conditional UPDATE
// (idempotent under overlapping cron runs), and sends a plain text
// via the same engine path the bot uses — so the reminder lands in
// the conversation history and the bot has full context when the
// customer replies in natural language.
//
// WhatsApp constraint: a plain text only delivers inside the 24h
// customer-service window (customer messaged in the last 24h). The
// claim happens BEFORE the send, so an out-of-window failure is
// logged and NOT retried every run (fail-safe: under-remind).
// ============================================================

interface ReminderRow {
  id: string
  account_id: string
  contact_id: string | null
  service_name: string | null
  starts_at: string
  reminder_24h_sent_at: string | null
  reminder_2h_sent_at: string | null
  contact: { id: string; name: string | null } | null
  account: {
    timezone: string | null
    appointment_reminders_enabled: boolean
    appointment_reminder_template: string | null
  } | null
}

const BATCH_LIMIT = 50

/**
 * Send every due appointment reminder. Returns counts for the cron
 * response. Per-row failures are logged and skipped — one broken
 * account must not stall the rest of the batch.
 */
export async function processDueReminders(
  db: SupabaseClient,
): Promise<{ sent: number; skipped: number; failed: number }> {
  const nowMs = Date.now()
  const { data, error } = await db
    .from('appointments')
    .select(
      'id, account_id, contact_id, service_name, starts_at, reminder_24h_sent_at, reminder_2h_sent_at, contact:contacts(id, name), account:accounts(timezone, appointment_reminders_enabled, appointment_reminder_template)',
    )
    .in('status', ['pending', 'confirmed'])
    .gt('starts_at', new Date(nowMs).toISOString())
    .lte('starts_at', new Date(nowMs + 24 * 60 * 60_000).toISOString())
    .or('reminder_24h_sent_at.is.null,reminder_2h_sent_at.is.null')
    .order('starts_at')
    .limit(BATCH_LIMIT)

  if (error) {
    console.error('[reminders] scan failed:', error)
    return { sent: 0, skipped: 0, failed: 1 }
  }

  let sent = 0
  let skipped = 0
  let failed = 0

  for (const raw of (data ?? []) as unknown as ReminderRow[]) {
    try {
      const outcome = await processOne(db, raw, nowMs)
      if (outcome === 'sent') sent++
      else if (outcome === 'failed') failed++
      else skipped++
    } catch (err) {
      failed++
      console.error(`[reminders] appointment ${raw.id} failed:`, err)
    }
  }

  return { sent, skipped, failed }
}

async function processOne(
  db: SupabaseClient,
  apt: ReminderRow,
  nowMs: number,
): Promise<'sent' | 'skipped' | 'failed'> {
  if (!apt.contact_id || !apt.contact) return 'skipped' // contact deleted
  if (apt.account && !apt.account.appointment_reminders_enabled) return 'skipped'

  const kind = dueReminderKind({
    nowMs,
    startsAtMs: Date.parse(apt.starts_at),
    sent24h: !!apt.reminder_24h_sent_at,
    sent2h: !!apt.reminder_2h_sent_at,
  })
  if (!kind) return 'skipped'

  // Claim before sending: only one cron run wins this reminder, and a
  // send failure is never retried into a spam loop.
  if (!(await claim(db, apt.id, kind))) return 'skipped'

  // The reminder rides the contact's existing conversation so the
  // customer's natural-language reply lands where the booking bot
  // (and human agents) already operate. No conversation → the
  // contact never chatted on WhatsApp → nothing to ride; skip.
  const { data: conv } = await db
    .from('conversations')
    .select('id')
    .eq('account_id', apt.account_id)
    .eq('contact_id', apt.contact_id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (!conv) return 'skipped'

  const { data: waConfig } = await db
    .from('whatsapp_config')
    .select('user_id')
    .eq('account_id', apt.account_id)
    .maybeSingle()
  if (!waConfig) return 'skipped' // WhatsApp not configured

  // Hybrid drafting: the cron is the alarm clock; the account's AI
  // (when configured) writes the reminder in the business's voice and
  // the customer's language, with the conversation as context. Any
  // AI failure falls back to the deterministic template — a reminder
  // must never depend on the model being alive.
  const text =
    (await draftReminderWithAi(db, apt, conv.id as string)) ??
    renderReminderTemplate({
      template: apt.account?.appointment_reminder_template ?? null,
      contactName: apt.contact.name,
      serviceName: apt.service_name,
      startsAt: apt.starts_at,
      timezone: apt.account?.timezone ?? null,
    })

  try {
    await engineSendText({
      accountId: apt.account_id,
      userId: waConfig.user_id as string,
      conversationId: conv.id as string,
      contactId: apt.contact_id,
      text,
    })
    return 'sent'
  } catch (err) {
    // Most common cause: outside WhatsApp's 24h service window (the
    // customer hasn't written in >24h, so Meta rejects plain text).
    // Already claimed → logged once, not retried.
    console.error(
      `[reminders] send failed for appointment ${apt.id} (${kind}):`,
      err instanceof Error ? err.message : err,
    )
    return 'failed'
  }
}

/**
 * Ask the account's AI to write the reminder. Returns null whenever
 * that isn't possible (AI off / not configured / provider error /
 * model bailed) — the caller then uses the deterministic template.
 */
async function draftReminderWithAi(
  db: SupabaseClient,
  apt: ReminderRow,
  conversationId: string,
): Promise<string | null> {
  try {
    const config = await loadAiConfig(db, apt.account_id)
    if (!config) return null

    // Recent turns give the model the customer's language and tone.
    const messages = await buildConversationContext(db, conversationId).catch(
      () => [],
    )

    const { date, time } = formatLocalParts(
      apt.starts_at,
      apt.account?.timezone ?? null,
    )
    const systemPrompt = [
      'You are a customer-messaging assistant for a business that uses a WhatsApp CRM.',
      `Your ONLY task right now: write a short, friendly WhatsApp reminder for this upcoming appointment — customer: ${
        apt.contact?.name ?? 'the customer'
      }; service: ${apt.service_name ?? 'appointment'}; local date: ${date}; local time: ${time}.`,
      'Write in the language the customer has been using in the conversation (fall back to the language of the business context). Do NOT answer any pending question from the transcript — this message is only the reminder. Invite them to reply here if they need to change or cancel. No emojis unless the business tone uses them. Output only the message text.',
      config.systemPrompt?.trim()
        ? `Business context and instructions:\n${config.systemPrompt.trim()}`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n')

    const { text, handoff, usage } = await generateReply({
      config,
      systemPrompt,
      messages,
    })
    void logAiUsage(db, {
      accountId: apt.account_id,
      conversationId,
      mode: 'draft',
      provider: config.provider,
      model: config.model,
      usage,
    })
    if (handoff || !text) return null
    return text
  } catch (err) {
    console.error(
      `[reminders] AI draft failed for appointment ${apt.id} — using template:`,
      err instanceof Error ? err.message : err,
    )
    return null
  }
}

async function claim(
  db: SupabaseClient,
  appointmentId: string,
  kind: ReminderKind,
): Promise<boolean> {
  const column = kind === '24h' ? 'reminder_24h_sent_at' : 'reminder_2h_sent_at'
  const { data } = await db
    .from('appointments')
    .update({ [column]: new Date().toISOString() })
    .eq('id', appointmentId)
    .is(column, null)
    .in('status', ['pending', 'confirmed'])
    .select('id')
    .maybeSingle()
  return !!data
}
