import type { SupabaseClient } from '@supabase/supabase-js'
import type { ExecutableTool } from '../types'
import { computeFreeSlots, hasOverlap } from '@/lib/api/v1/appointments'
import { tzOffsetMinutes } from '@/lib/timezone'

// ============================================================
// Appointment tools for the AI auto-reply bot.
//
// The first pluggable bot capability: when (and only when) the account
// actually uses the appointments module (038), `buildAppointmentTools`
// returns tool definitions + a prompt fragment; otherwise null and the
// bot stays a plain support assistant. Reuses the same slot/overlap
// logic as the public API and the calendar UI, so all three doors
// (bot, API, humans) see one world.
//
// Safety model — the executors run on the service-role client, so
// every query is hand-scoped:
//   - account_id on everything (tenancy)
//   - appointments are ALWAYS bound to the conversation's contact:
//     the customer can only book/cancel/reschedule their own, no
//     matter what the model passes in.
//   - bookings are born 'confirmed' (owner's decision) and capped at
//     MAX_UPCOMING_PER_CONTACT so a prompt-injected loop can't flood
//     the calendar.
// ============================================================

/** Max pending/confirmed future appointments one contact may hold. */
const MAX_UPCOMING_PER_CONTACT = 3

/** Slot-list cap in a tool result — bounds tokens on dense days. */
const MAX_SLOTS_SHOWN = 24

const DEFAULT_DURATION_MIN = 30

interface ServiceRow {
  id: string
  name: string
  duration_minutes: number
  price: number | null
}

export interface AppointmentToolsResult {
  tools: ExecutableTool[]
  /** Capability fragment for the system prompt: services, current
   *  local date/time, and the booking protocol. */
  prompt: string
}

interface BuildArgs {
  accountId: string
  /** The conversation's contact — every write is bound to them. */
  contactId: string
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Build the booking tools for one reply, or null when the account
 * doesn't use the appointments module (no services, no availability
 * rules, no appointments ever) — the capability then stays invisible
 * to the model entirely.
 */
export async function buildAppointmentTools(
  db: SupabaseClient,
  { accountId, contactId }: BuildArgs,
): Promise<AppointmentToolsResult | null> {
  const [{ data: services }, { count: ruleCount }, { count: aptCount }, { data: account }] =
    await Promise.all([
      db
        .from('services')
        .select('id, name, duration_minutes, price')
        .eq('account_id', accountId)
        .eq('is_active', true)
        .order('created_at'),
      db
        .from('availability_rules')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', accountId),
      db
        .from('appointments')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', accountId),
      db.from('accounts').select('timezone').eq('id', accountId).maybeSingle(),
    ])

  const svc: ServiceRow[] = (services ?? []) as ServiceRow[]
  const moduleInUse =
    svc.length > 0 || (ruleCount ?? 0) > 0 || (aptCount ?? 0) > 0
  if (!moduleInUse) return null

  const timezone = (account?.timezone as string | null) ?? null

  /** Offset for a given local calendar date (DST-correct: computed at
   *  that date's noon UTC, not at "now"). */
  const offsetFor = (date: string) =>
    tzOffsetMinutes(timezone, new Date(`${date}T12:00:00Z`))

  const fmtLocal = (iso: string) =>
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone ?? 'UTC',
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(iso))

  const findService = (name: unknown): ServiceRow | null => {
    if (typeof name !== 'string' || !name.trim()) return null
    const q = name.trim().toLowerCase()
    return (
      svc.find((s) => s.name.toLowerCase() === q) ??
      svc.find((s) => s.name.toLowerCase().includes(q)) ??
      null
    )
  }

  /** Local-wall-time (date, HH:MM) → UTC instant, per the module's
   *  offset convention (utc = wall − offset). */
  const toInstant = (date: string, time: string): Date =>
    new Date(Date.parse(`${date}T${time}:00Z`) - offsetFor(date) * 60_000)

  const countUpcoming = async (): Promise<number> => {
    const { count } = await db
      .from('appointments')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .in('status', ['pending', 'confirmed'])
      .gte('starts_at', new Date().toISOString())
    return count ?? 0
  }

  const tools: ExecutableTool[] = [
    {
      def: {
        name: 'check_availability',
        description:
          'List free appointment slots for one calendar date (business local time). Always call this before proposing times to the customer.',
        parameters: {
          type: 'object',
          properties: {
            date: {
              type: 'string',
              description: 'Local calendar date, YYYY-MM-DD',
            },
            service_name: {
              type: 'string',
              description:
                'Optional service name to size the slots; omit for the default duration',
            },
          },
          required: ['date'],
        },
      },
      async run(args) {
        const date = args.date
        if (typeof date !== 'string' || !DATE_RE.test(date)) {
          return 'Error: date must be YYYY-MM-DD.'
        }
        const service = findService(args.service_name)
        const duration = service?.duration_minutes ?? DEFAULT_DURATION_MIN
        const slots = await computeFreeSlots(
          db,
          accountId,
          date,
          offsetFor(date),
          duration,
        )
        if (slots.length === 0) {
          return `No free slots on ${date}. The business may be closed that day — try another date.`
        }
        const shown = slots.slice(0, MAX_SLOTS_SHOWN)
        const more =
          slots.length > shown.length
            ? ` (and ${slots.length - shown.length} more later that day)`
            : ''
        return `Free ${duration}-minute slots on ${date} (local time): ${shown
          .map((s) => s.local_time)
          .join(', ')}${more}`
      },
    },
    {
      def: {
        name: 'list_my_appointments',
        description:
          "List this customer's upcoming appointments (id, local time, service, status). Use it before cancelling or rescheduling.",
        parameters: { type: 'object', properties: {} },
      },
      async run() {
        const { data } = await db
          .from('appointments')
          .select('id, starts_at, service_name, status')
          .eq('account_id', accountId)
          .eq('contact_id', contactId)
          .in('status', ['pending', 'confirmed'])
          .gte('starts_at', new Date().toISOString())
          .order('starts_at')
          .limit(10)
        if (!data || data.length === 0) {
          return 'This customer has no upcoming appointments.'
        }
        return data
          .map(
            (a) =>
              `${a.id} — ${fmtLocal(a.starts_at as string)} — ${
                (a.service_name as string | null) ?? 'no service'
              } — ${a.status}`,
          )
          .join('\n')
      },
    },
    {
      def: {
        name: 'book_appointment',
        description:
          'Book an appointment for this customer. Call ONLY after the customer explicitly confirmed a specific date and time you verified with check_availability.',
        parameters: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'Local date, YYYY-MM-DD' },
            time: {
              type: 'string',
              description: 'Local start time, 24h HH:MM (e.g. 14:00)',
            },
            service_name: {
              type: 'string',
              description: 'Service to book, when the customer chose one',
            },
            notes: {
              type: 'string',
              description: 'Optional short note from the conversation',
            },
          },
          required: ['date', 'time'],
        },
      },
      async run(args) {
        const { date, time } = args
        if (typeof date !== 'string' || !DATE_RE.test(date)) {
          return 'Error: date must be YYYY-MM-DD.'
        }
        if (typeof time !== 'string' || !TIME_RE.test(time)) {
          return 'Error: time must be 24h HH:MM.'
        }
        const starts = toInstant(date, time)
        if (starts.getTime() <= Date.now()) {
          return 'Error: that time is in the past. Ask for a future time.'
        }
        if ((await countUpcoming()) >= MAX_UPCOMING_PER_CONTACT) {
          return `Error: this customer already has ${MAX_UPCOMING_PER_CONTACT} upcoming appointments. Offer to reschedule or cancel one instead of booking more.`
        }
        const service = findService(args.service_name)
        const duration = service?.duration_minutes ?? DEFAULT_DURATION_MIN
        const ends = new Date(starts.getTime() + duration * 60_000)
        if (
          await hasOverlap(db, accountId, starts.toISOString(), ends.toISOString())
        ) {
          return 'Error: that slot is already taken. Call check_availability again and offer other times.'
        }
        const { error } = await db.from('appointments').insert({
          account_id: accountId,
          contact_id: contactId,
          service_id: service?.id ?? null,
          service_name: service?.name ?? null,
          starts_at: starts.toISOString(),
          ends_at: ends.toISOString(),
          status: 'confirmed',
          notes:
            typeof args.notes === 'string' && args.notes.trim()
              ? args.notes.trim().slice(0, 500)
              : null,
        })
        if (error) {
          console.error('[ai tools] book_appointment insert failed:', error)
          return 'Error: the appointment could not be saved. Tell the customer a human will confirm it.'
        }
        return `Booked and confirmed: ${
          service?.name ?? 'appointment'
        } on ${fmtLocal(starts.toISOString())} (${duration} min).`
      },
    },
    {
      def: {
        name: 'cancel_appointment',
        description:
          "Cancel one of this customer's upcoming appointments. Call ONLY after the customer clearly asked to cancel. Get the id from list_my_appointments.",
        parameters: {
          type: 'object',
          properties: {
            appointment_id: {
              type: 'string',
              description: 'The appointment id to cancel',
            },
          },
          required: ['appointment_id'],
        },
      },
      async run(args) {
        const id = args.appointment_id
        if (typeof id !== 'string' || !UUID_RE.test(id)) {
          return 'Error: appointment_id must be an id from list_my_appointments.'
        }
        const { data, error } = await db
          .from('appointments')
          .update({ status: 'cancelled' })
          .eq('id', id)
          .eq('account_id', accountId)
          .eq('contact_id', contactId)
          .in('status', ['pending', 'confirmed'])
          .select('starts_at, service_name')
          .maybeSingle()
        if (error) {
          console.error('[ai tools] cancel_appointment failed:', error)
          return 'Error: the cancellation could not be saved.'
        }
        if (!data) {
          return 'Error: no matching upcoming appointment for this customer. Call list_my_appointments to see what exists.'
        }
        return `Cancelled: ${
          (data.service_name as string | null) ?? 'appointment'
        } on ${fmtLocal(data.starts_at as string)}.`
      },
    },
    {
      def: {
        name: 'reschedule_appointment',
        description:
          "Move one of this customer's upcoming appointments to a new date/time the customer confirmed. Get the id from list_my_appointments and verify the new slot with check_availability first.",
        parameters: {
          type: 'object',
          properties: {
            appointment_id: {
              type: 'string',
              description: 'The appointment id to move',
            },
            date: { type: 'string', description: 'New local date, YYYY-MM-DD' },
            time: {
              type: 'string',
              description: 'New local start time, 24h HH:MM',
            },
          },
          required: ['appointment_id', 'date', 'time'],
        },
      },
      async run(args) {
        const { appointment_id: id, date, time } = args
        if (typeof id !== 'string' || !UUID_RE.test(id)) {
          return 'Error: appointment_id must be an id from list_my_appointments.'
        }
        if (typeof date !== 'string' || !DATE_RE.test(date)) {
          return 'Error: date must be YYYY-MM-DD.'
        }
        if (typeof time !== 'string' || !TIME_RE.test(time)) {
          return 'Error: time must be 24h HH:MM.'
        }
        const { data: apt } = await db
          .from('appointments')
          .select('id, starts_at, ends_at, service_name')
          .eq('id', id)
          .eq('account_id', accountId)
          .eq('contact_id', contactId)
          .in('status', ['pending', 'confirmed'])
          .maybeSingle()
        if (!apt) {
          return 'Error: no matching upcoming appointment for this customer. Call list_my_appointments to see what exists.'
        }
        const durMs =
          Date.parse(apt.ends_at as string) - Date.parse(apt.starts_at as string)
        const starts = toInstant(date, time)
        if (starts.getTime() <= Date.now()) {
          return 'Error: that time is in the past. Ask for a future time.'
        }
        const ends = new Date(starts.getTime() + durMs)
        if (
          await hasOverlap(
            db,
            accountId,
            starts.toISOString(),
            ends.toISOString(),
            id,
          )
        ) {
          return 'Error: the new slot is already taken. Call check_availability again and offer other times.'
        }
        const { error } = await db
          .from('appointments')
          .update({
            starts_at: starts.toISOString(),
            ends_at: ends.toISOString(),
            status: 'confirmed',
          })
          .eq('id', id)
          .eq('account_id', accountId)
          .eq('contact_id', contactId)
        if (error) {
          console.error('[ai tools] reschedule_appointment failed:', error)
          return 'Error: the reschedule could not be saved.'
        }
        return `Rescheduled: ${
          (apt.service_name as string | null) ?? 'appointment'
        } is now ${fmtLocal(starts.toISOString())}, confirmed.`
      },
    },
  ]

  // Current local date/time so relative dates ("tomorrow", "el viernes")
  // resolve correctly — the model has no clock of its own.
  const nowLocal = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone ?? 'UTC',
    weekday: 'long',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date())

  const serviceLines =
    svc.length > 0
      ? svc
          .map(
            (s) =>
              `- ${s.name} (${s.duration_minutes} min${
                s.price != null ? `, ${s.price}` : ''
              })`,
          )
          .join('\n')
      : `(No named services — book generic ${DEFAULT_DURATION_MIN}-minute appointments.)`

  const prompt = [
    'Background capability — appointments. This business can take appointments, and you have tools to manage them for THIS customer (always the customer\'s own — never for anyone else). This is a silent background capability, NOT the topic of the conversation: NEVER bring up appointments, availability, times, or booking on your own. Only engage it when the customer\'s LATEST message asks about booking, changing, or cancelling an appointment. For everything else, follow the business context and instructions as if this capability did not exist, and do not revive earlier appointment talk from the history.',
    `Current local date and time for the business: ${nowLocal}${timezone ? ` (${timezone})` : ' (UTC)'}. Use it to resolve relative dates like "tomorrow". All times you mention to the customer are in this local time.`,
    `Services offered:\n${serviceLines}`,
    'When (and only when) the customer asks about appointments: check_availability before proposing times, and only offer times it returned — never state or invent availability without calling it. Book only after the customer explicitly confirms one specific date and time, then confirm it back to them. If they ask to cancel or move an appointment, use list_my_appointments first, then cancel_appointment or reschedule_appointment. If a tool returns an error, do not pretend it succeeded — tell the customer honestly.',
    'Invoke tools ONLY through the native tool-calling mechanism. NEVER write tool names, function-call syntax, code, or anything like "tool_code" in your reply text — the customer sees your text verbatim and must never see tool machinery.',
  ].join('\n')

  return { tools, prompt }
}
