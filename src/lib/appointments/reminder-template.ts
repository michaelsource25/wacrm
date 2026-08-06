import { tzOffsetMinutes } from '@/lib/timezone'

// ============================================================
// Pure helpers for appointment reminders (migration 040).
//
// Kept free of server-only imports so the settings UI can share the
// default template and placeholder rendering with the cron job.
// ============================================================

/** Used when `accounts.appointment_reminder_template` is NULL. The
 *  owner can rewrite it in any language from the Services dialog.
 *  Deliberately open-ended — no "reply YES" protocol; the customer
 *  answers however they like and the booking bot interprets it. */
export const DEFAULT_REMINDER_TEMPLATE =
  'Hi {name}! Quick reminder: your {service} is scheduled for {date} at {time}. If you need to change or cancel it, just reply here. See you soon!'

/** Placeholder for {service} when the appointment has none. */
const GENERIC_SERVICE = 'appointment'

export interface ReminderRenderArgs {
  template: string | null
  contactName: string | null
  serviceName: string | null
  /** UTC instant of the appointment start (ISO). */
  startsAt: string
  /** IANA zone of the business, or null → UTC. */
  timezone: string | null
}

/**
 * Local wall-clock parts of an appointment start, rendered numerically
 * ("07/08/2026", "3:00 PM") — language-neutral on purpose, since the
 * surrounding text carries the account's language.
 */
export function formatLocalParts(
  startsAt: string,
  timezone: string | null,
): { date: string; time: string } {
  const at = new Date(
    Date.parse(startsAt) + tzOffsetMinutes(timezone, new Date(startsAt)) * 60_000,
  )
  const dd = String(at.getUTCDate()).padStart(2, '0')
  const mm = String(at.getUTCMonth() + 1).padStart(2, '0')
  const h24 = at.getUTCHours()
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12
  return {
    date: `${dd}/${mm}/${at.getUTCFullYear()}`,
    time: `${h12}:${String(at.getUTCMinutes()).padStart(2, '0')} ${
      h24 < 12 ? 'AM' : 'PM'
    }`,
  }
}

/** Fill {name} {service} {date} {time} into the template. */
export function renderReminderTemplate(args: ReminderRenderArgs): string {
  const { template, contactName, serviceName, startsAt, timezone } = args
  const { date, time } = formatLocalParts(startsAt, timezone)

  return (template?.trim() || DEFAULT_REMINDER_TEMPLATE)
    .replaceAll('{name}', contactName?.trim() || 'there')
    .replaceAll('{service}', serviceName?.trim() || GENERIC_SERVICE)
    .replaceAll('{date}', date)
    .replaceAll('{time}', time)
}

export type ReminderKind = '24h' | '2h'

/** Don't bother reminding when the start is (nearly) here. */
const MIN_LEAD_MS = 10 * 60_000
const TWO_H_MS = 2 * 60 * 60_000
const DAY_MS = 24 * 60 * 60_000

/**
 * Which reminder (if any) is due for an appointment right now.
 * The 2h reminder wins inside its window even when the 24h one was
 * never sent (e.g. booked 90 minutes ahead) — one timely message
 * beats two back-to-back ones.
 */
export function dueReminderKind(args: {
  nowMs: number
  startsAtMs: number
  sent24h: boolean
  sent2h: boolean
}): ReminderKind | null {
  const { nowMs, startsAtMs, sent24h, sent2h } = args
  const lead = startsAtMs - nowMs
  if (lead <= MIN_LEAD_MS) return null
  if (lead <= TWO_H_MS) return sent2h ? null : '2h'
  if (lead <= DAY_MS) return sent24h ? null : '24h'
  return null
}
