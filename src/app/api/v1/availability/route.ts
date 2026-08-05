// ============================================================
// GET /api/v1/availability — free booking slots for a local date
// (scope: appointments:read).
//
// Query params:
//   date       required, "YYYY-MM-DD" — the business's local date
//   service_id optional — slot length = that service's duration
//   duration   optional minutes (1–1440) — overrides the default 30
//              when no service_id is given
//   tz_offset  optional minutes to ADD to UTC to get local time
//              (e.g. -240 for Santo Domingo). Defaults to 0.
//
// Returns { data: { date, duration_minutes, slots: [{ starts_at,
// local_time }] } }. Book a slot by POSTing its `starts_at` to
// /api/v1/appointments.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { computeFreeSlots } from '@/lib/api/v1/appointments';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'appointments:read');
    const url = new URL(request.url);

    const date = url.searchParams.get('date') ?? '';
    if (!DATE_RE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
      return fail('bad_request', "'date' must be a valid YYYY-MM-DD", 400);
    }

    const tzOffset = Number(url.searchParams.get('tz_offset') ?? '0');
    if (!Number.isFinite(tzOffset) || Math.abs(tzOffset) > 14 * 60) {
      return fail('bad_request', "'tz_offset' must be minutes in ±840", 400);
    }

    let duration = Number(url.searchParams.get('duration') ?? '30');
    const serviceId = url.searchParams.get('service_id');
    if (serviceId) {
      const { data: service } = await ctx.supabase
        .from('services')
        .select('duration_minutes')
        .eq('id', serviceId)
        .eq('account_id', ctx.accountId)
        .maybeSingle();
      if (!service) return fail('not_found', 'Service not found', 404);
      duration = service.duration_minutes as number;
    }
    if (!Number.isInteger(duration) || duration < 1 || duration > 1440) {
      return fail('bad_request', "'duration' must be 1–1440 minutes", 400);
    }

    const slots = await computeFreeSlots(
      ctx.supabase,
      ctx.accountId,
      date,
      tzOffset,
      duration
    );

    return ok({ date, duration_minutes: duration, slots });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
