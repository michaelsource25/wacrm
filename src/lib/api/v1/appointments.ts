// ============================================================
// Public API (v1) helpers for the appointments module.
//
// Shared by /api/v1/availability and /api/v1/appointments[/{id}]:
// serialization, the overlap check, and free-slot computation.
//
// Time model
//   - `appointments.starts_at/ends_at` are UTC instants.
//   - `availability_rules` hold the business's local wall-clock
//     windows. Callers of the availability endpoint pass `tz_offset`
//     (minutes to ADD to UTC to get local time; e.g. Santo Domingo
//     is -240). Slot instants are computed as local wall time minus
//     that offset. Defaults to 0 (UTC) when omitted.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

export interface ApiAppointment {
  id: string;
  contact_id: string | null;
  service_id: string | null;
  service_name: string | null;
  starts_at: string;
  ends_at: string;
  status: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
  contact: { id: string; phone: string; name: string | null } | null;
}

/** Embed used by every appointment read on the public API. */
export const APPOINTMENT_SELECT =
  '*, contact:contacts(id, phone, name)';

export function serializeAppointment(
  row: Record<string, unknown>
): ApiAppointment {
  const contact = row.contact as
    | { id: string; phone: string; name: string | null }
    | null
    | undefined;
  return {
    id: row.id as string,
    contact_id: (row.contact_id as string | null) ?? null,
    service_id: (row.service_id as string | null) ?? null,
    service_name: (row.service_name as string | null) ?? null,
    starts_at: row.starts_at as string,
    ends_at: row.ends_at as string,
    status: row.status as string,
    notes: (row.notes as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    contact: contact
      ? { id: contact.id, phone: contact.phone, name: contact.name ?? null }
      : null,
  };
}

/**
 * True when a non-cancelled appointment overlaps [startsAt, endsAt) in
 * this account. `excludeId` lets a reschedule ignore the appointment
 * being moved. Cancelled slots are free by definition.
 */
export async function hasOverlap(
  db: SupabaseClient,
  accountId: string,
  startsAt: string,
  endsAt: string,
  excludeId?: string
): Promise<boolean> {
  let query = db
    .from('appointments')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', accountId)
    .neq('status', 'cancelled')
    .lt('starts_at', endsAt)
    .gt('ends_at', startsAt);
  if (excludeId) query = query.neq('id', excludeId);
  const { count } = await query;
  return (count ?? 0) > 0;
}

/** One bookable slot returned by the availability endpoint. */
export interface Slot {
  /** UTC instant, ISO 8601 — pass this back as `starts_at` to book. */
  starts_at: string;
  /** Local wall-clock label, "HH:MM" (per the caller's tz_offset). */
  local_time: string;
}

/** Fallback opening hours for accounts with zero configured rules:
 *  Mon–Sat 09:00–18:00, so booking works before any setup. */
const DEFAULT_RULES = [1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday,
  start_time: '09:00:00',
  end_time: '18:00:00',
}));

function parseTime(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/**
 * Compute free slots for a local calendar date.
 *
 * @param date       local date "YYYY-MM-DD" (the business's day)
 * @param tzOffset   minutes to add to UTC to get local time (e.g. -240)
 * @param duration   slot length in minutes (also the step)
 */
export async function computeFreeSlots(
  db: SupabaseClient,
  accountId: string,
  date: string,
  tzOffset: number,
  duration: number
): Promise<Slot[]> {
  // Weekday of the *local* date. Parsing "YYYY-MM-DD" with T00:00Z is
  // stable regardless of the server's own timezone.
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();

  const { data: allRules } = await db
    .from('availability_rules')
    .select('weekday, start_time, end_time')
    .eq('account_id', accountId);

  const rules =
    allRules && allRules.length > 0
      ? allRules.filter((r) => r.weekday === weekday)
      : DEFAULT_RULES.filter((r) => r.weekday === weekday);
  if (rules.length === 0) return []; // closed that day

  // UTC range covering the local day, for the busy-appointments query.
  const dayStartUtc = new Date(
    Date.parse(`${date}T00:00:00Z`) - tzOffset * 60_000
  );
  const dayEndUtc = new Date(dayStartUtc.getTime() + 24 * 60 * 60_000);

  const { data: busy } = await db
    .from('appointments')
    .select('starts_at, ends_at')
    .eq('account_id', accountId)
    .neq('status', 'cancelled')
    .lt('starts_at', dayEndUtc.toISOString())
    .gt('ends_at', dayStartUtc.toISOString());

  const busyRanges = (busy ?? []).map((b) => ({
    start: Date.parse(b.starts_at as string),
    end: Date.parse(b.ends_at as string),
  }));

  const now = Date.now();
  const slots: Slot[] = [];

  for (const rule of rules) {
    const windowStart = parseTime(rule.start_time as string);
    const windowEnd = parseTime(rule.end_time as string);
    for (
      let minute = windowStart;
      minute + duration <= windowEnd;
      minute += duration
    ) {
      const startMs = dayStartUtc.getTime() + minute * 60_000;
      const endMs = startMs + duration * 60_000;
      if (startMs <= now) continue; // never offer the past
      const clash = busyRanges.some(
        (b) => b.start < endMs && b.end > startMs
      );
      if (clash) continue;
      const hh = String(Math.floor(minute / 60)).padStart(2, '0');
      const mm = String(minute % 60).padStart(2, '0');
      slots.push({
        starts_at: new Date(startMs).toISOString(),
        local_time: `${hh}:${mm}`,
      });
    }
  }

  slots.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  return slots;
}
