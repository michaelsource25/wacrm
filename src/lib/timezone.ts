// ============================================================
// IANA-timezone helpers.
//
// `accounts.timezone` (migration 039) stores an IANA zone name. The
// appointments time model (see lib/api/v1/appointments.ts) works in
// "minutes to ADD to UTC to get local wall time" (e.g. Santo Domingo
// is -240); these helpers bridge the two representations using Intl,
// so there's no bundled tz database and DST is handled by the runtime.
// ============================================================

/**
 * Offset in minutes to ADD to UTC to get local wall time in `timeZone`
 * at the instant `at` (DST-correct). Returns 0 for an invalid or
 * missing zone name — the safe "treat as UTC" fallback used across
 * the appointments module.
 */
export function tzOffsetMinutes(
  timeZone: string | null | undefined,
  at: Date = new Date(),
): number {
  if (!timeZone) return 0
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    const parts: Record<string, string> = {}
    for (const p of dtf.formatToParts(at)) parts[p.type] = p.value
    const asUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    )
    return Math.round((asUtc - at.getTime()) / 60_000)
  } catch {
    return 0 // unknown zone → UTC
  }
}

/** True when `timeZone` is a zone name the runtime's Intl accepts. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}
