import { supabaseAdmin } from './admin-client'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { retrieveKnowledge } from './knowledge'
import { generateReply } from './generate'
import { buildSystemPrompt } from './defaults'
import { buildAppointmentTools } from './tools/appointments'
import { buildProductTools } from './tools/products'
import { buildHandoffSummary } from './handoff'
import { logAiUsage } from './usage'
import { latestUserMessage } from './query'
import { engineSendText } from '@/lib/flows/meta-send'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'

const DEFAULT_SESSION_GAP_HOURS = 6

/** Quiet period after which a new inbound counts as a fresh session
 *  (and a fresh reply budget). Override with `AI_SESSION_GAP_HOURS`. */
export function aiSessionGapHours(): number {
  const raw = Number(process.env.AI_SESSION_GAP_HOURS)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SESSION_GAP_HOURS
}

/**
 * True when the bot hasn't auto-replied in this thread for longer than
 * the session gap — i.e. the customer went away and came back.
 *
 * Anchored on the bot's own last auto-reply rather than the last
 * message in the thread: the webhook has already persisted the inbound
 * that triggered us, so "last message" would always be seconds old.
 * A thread the bot has never replied to has no session to continue,
 * and its count is 0 anyway, so the caller skips this.
 */
async function isNewSession(
  db: ReturnType<typeof supabaseAdmin>,
  conversationId: string,
): Promise<boolean> {
  const { data } = await db
    .from('messages')
    .select('created_at')
    .eq('conversation_id', conversationId)
    .eq('ai_generated', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!data?.created_at) return false
  const gapMs = Date.now() - Date.parse(data.created_at as string)
  return gapMs > aiSessionGapHours() * 60 * 60_000
}

/** The account's display currency (021), for prices the bot quotes.
 *  Falls back to USD — the same default the column carries. */
async function accountCurrency(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
): Promise<string> {
  const { data } = await db
    .from('accounts')
    .select('default_currency')
    .eq('id', accountId)
    .maybeSingle()
  return (data?.default_currency as string | null) ?? 'USD'
}

interface DispatchArgs {
  /** Tenancy key — drives config, contact, and whatsapp_config lookups. */
  accountId: string
  conversationId: string
  contactId: string
  /** The account's WhatsApp config owner, used for the outbound send's
   *  audit columns (mirrors how the flow runner passes it through). */
  configOwnerUserId: string
}

/**
 * AI auto-reply for a freshly-arrived inbound message.
 *
 * Invoked from the WhatsApp webhook's `after()` block, only when no
 * deterministic flow consumed the message (flows win). Mirrors the flow
 * runner's contract: it owns its try/catch and NEVER throws — a failing
 * or slow LLM call must not affect the webhook's 200 to Meta.
 *
 * Eligibility gates (any → silent no-op):
 *   - AI off / auto-reply disabled for the account
 *   - a human agent is assigned (they own the thread)
 *   - auto-reply was disabled for this conversation (prior handoff)
 *   - the per-conversation reply cap is reached
 *   - there's nothing to reply to
 *
 * The 24h WhatsApp session window is inherently open here — we're
 * reacting to a customer message that just landed — so no separate
 * window check is needed.
 */
export async function dispatchInboundToAiReply(
  args: DispatchArgs,
): Promise<void> {
  const { accountId, conversationId, contactId, configOwnerUserId } = args

  try {
    const db = supabaseAdmin()

    const config = await loadAiConfig(db, accountId)
    if (!config || !config.autoReplyEnabled) return

    // Deterministic, user-configured responders win over the LLM — the
    // caller already excludes messages a Flow consumed. Message-level
    // automations (`new_message_received` / `keyword_match`) are
    // dispatched independently for this same inbound and may send their
    // own reply, so if the account has any active one we stand down to
    // avoid double-texting the customer. (Relationship triggers like
    // `first_inbound_message` don't count — they're not per-message
    // auto-responders.)
    // From here on the account HAS auto-reply enabled, so a stand-down
    // is worth one log line — "the bot went quiet" is otherwise
    // undiagnosable from the outside.
    const standDown = (reason: string) =>
      console.info(
        `[ai auto-reply] standing down on conversation ${conversationId}: ${reason}`,
      )

    const { data: autoResponders } = await db
      .from('automations')
      .select('id')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .in('trigger_type', ['new_message_received', 'keyword_match'])
      .limit(1)
    if (autoResponders && autoResponders.length > 0) {
      return standDown(
        'an active new-message/keyword automation exists — deterministic responders win',
      )
    }

    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled, ai_reply_count')
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr || !conv) return standDown('conversation not found')
    if (conv.assigned_agent_id) {
      return standDown('a human agent is assigned to this thread')
    }
    if (conv.ai_autoreply_disabled) {
      return standDown('auto-reply is paused here (handoff / take-over)')
    }
    // A returning customer starts a fresh session. The reply cap exists
    // to stop a runaway loop (two bots answering each other), which
    // plays out in minutes — so a long quiet gap unambiguously means
    // "new conversation", not "same burst". Without this the counter
    // accumulates across weeks and the bot eventually goes permanently
    // silent on exactly the customers who come back most often.
    let replyCount = conv.ai_reply_count ?? 0
    if (replyCount > 0 && (await isNewSession(db, conversationId))) {
      // Concurrent inbounds can both reset; that's idempotent, and the
      // atomic claim below still enforces the cap.
      await db
        .from('conversations')
        .update({ ai_reply_count: 0 })
        .eq('id', conversationId)
      console.info(
        `[ai auto-reply] conversation ${conversationId}: customer returned after ${aiSessionGapHours()}h+ — reply budget reset.`,
      )
      replyCount = 0
    }

    // Cheap early-out; the authoritative cap check is the atomic claim
    // below (this read can race a concurrent inbound).
    if (replyCount >= config.autoReplyMaxPerConversation) {
      return standDown(
        `per-conversation reply cap reached (${replyCount}/${config.autoReplyMaxPerConversation}) — Resume AI resets it`,
      )
    }

    const messages = await buildConversationContext(db, conversationId)
    if (messages.length === 0) return standDown('no text messages to reply to')

    // Account-wide throttle on the shared BYO key. The per-conversation
    // cap bounds one thread; this bounds a burst across many threads (a
    // marketing blast landing 200 replies at once) so we never run the
    // owner's key past the provider's rate limit. Over the limit → skip
    // the auto-reply; the inbound still sits in the inbox for a human.
    const acctLimit = checkRateLimit(
      `ai-autoreply:${accountId}`,
      RATE_LIMITS.aiAutoReplyAccount,
    )
    if (!acctLimit.success) {
      console.warn(
        `[ai auto-reply] account ${accountId} hit the per-account rate limit — skipping this inbound.`,
      )
      return
    }

    // Ground the reply in the account's knowledge base (best-effort),
    // and load the pluggable bot capabilities. Each one activates only
    // when the account actually uses that module (appointments: has
    // services/rules/appointments; products: has active catalog rows),
    // so a generalist support bot stays generalist. A capability that
    // fails to load must never silence the whole bot, so each degrades
    // to "not offered" and the reply goes out without it.
    const [knowledge, booking, catalog] = await Promise.all([
      retrieveKnowledge(db, accountId, config, latestUserMessage(messages)),
      buildAppointmentTools(db, { accountId, contactId }).catch((err) => {
        console.error('[ai auto-reply] appointment tools unavailable:', err)
        return null
      }),
      buildProductTools(db, {
        accountId,
        conversationId,
        contactId,
        configOwnerUserId,
        currency: await accountCurrency(db, accountId),
      }).catch((err) => {
        console.error('[ai auto-reply] product tools unavailable:', err)
        return null
      }),
    ])

    const capabilities = [booking?.prompt, catalog?.prompt].filter(
      (p): p is string => !!p,
    )
    const tools = [...(booking?.tools ?? []), ...(catalog?.tools ?? [])]

    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
      capabilities: capabilities.length > 0 ? capabilities : undefined,
    })

    const { text, handoff, usage } = await generateReply({
      config,
      systemPrompt,
      messages,
      tools: tools.length > 0 ? tools : undefined,
    })

    // Record token spend on the account's BYO key. Fire-and-forget so it
    // never adds latency to the customer-facing send: `logAiUsage`
    // swallows its own errors, so the floating promise can't reject.
    // Logged regardless of handoff — the provider call happened either
    // way.
    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: 'auto_reply',
      provider: config.provider,
      model: config.model,
      usage,
    })

    if (handoff || !text) {
      // The model can't (or shouldn't) answer — stop auto-replying on
      // this thread and hand it to a human. We (a) pause the bot here
      // (sticky until re-enabled), (b) route the conversation to the
      // configured handoff agent — null leaves it in the shared queue —
      // and (c) leave a short internal note so whoever picks it up has
      // context. Assigning fires the `on_conversation_assigned` trigger,
      // which notifies the agent.
      const summary = buildHandoffSummary({
        messages,
        replyCount: conv.ai_reply_count ?? 0,
      })
      const update: Record<string, unknown> = {
        ai_autoreply_disabled: true,
        ai_handoff_summary: summary,
      }
      // Only set the assignee when a target is configured AND the thread
      // isn't already owned — never stomp an existing human assignment.
      if (config.handoffAgentId && !conv.assigned_agent_id) {
        update.assigned_agent_id = config.handoffAgentId
      }
      await db.from('conversations').update(update).eq('id', conversationId)
      return
    }

    // Atomically claim a reply slot: the cap check + increment happen in
    // one UPDATE, so concurrent inbounds can never overshoot the cap. If
    // another inbound just took the last slot, `claimed` is false and we
    // skip the send. (We consume a slot slightly before the send lands —
    // fail-safe: under-reply rather than over-reply.)
    const { data: claimed, error: claimErr } = await db.rpc(
      'claim_ai_reply_slot',
      {
        conversation_id: conversationId,
        max_replies: config.autoReplyMaxPerConversation,
      },
    )
    if (claimErr) {
      // A real error here (vs. losing the cap race) is almost always a
      // deploy issue — e.g. `claim_ai_reply_slot` not EXECUTE-able by the
      // service role, or the migration not applied. Log it loudly: a
      // silent return makes "auto-reply never fires" undiagnosable.
      console.error('[ai auto-reply] claim_ai_reply_slot failed:', claimErr)
      return
    }
    if (claimed !== true) return // lost the per-conversation cap race

    await engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text,
      aiGenerated: true,
    })
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err)
  }
}
