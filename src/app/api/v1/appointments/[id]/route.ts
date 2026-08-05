// ============================================================
// GET   /api/v1/appointments/{id} — read one appointment
//                                   (scope: appointments:read)
// PATCH /api/v1/appointments/{id} — reschedule / update / cancel
//                                   (scope: appointments:write)
//
// PATCH updates only the fields you send:
//   starts_at, duration_minutes — reschedule (re-runs the overlap
//                                 check, excluding this appointment)
//   status — pending | confirmed | cancelled | completed | no_show
//   notes, service_name
//
// Account-scoped: a foreign id → 404.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import {
  APPOINTMENT_SELECT,
  serializeAppointment,
  hasOverlap,
} from '@/lib/api/v1/appointments';

const STATUSES = ['pending', 'confirmed', 'cancelled', 'completed', 'no_show'];

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'appointments:read');
    const { id } = await params;

    const { data, error } = await ctx.supabase
      .from('appointments')
      .select(APPOINTMENT_SELECT)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();

    if (error) {
      console.error('[api/v1/appointments] read error:', error);
      return fail('internal', 'Failed to read appointment', 500);
    }
    if (!data) return fail('not_found', 'Appointment not found', 404);

    return ok(serializeAppointment(data as Record<string, unknown>));
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'appointments:write');
    const { id } = await params;

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    const { data: existing } = await ctx.supabase
      .from('appointments')
      .select('id, starts_at, ends_at')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (!existing) return fail('not_found', 'Appointment not found', 404);

    const update: Record<string, unknown> = {};

    if (body.status !== undefined) {
      if (typeof body.status !== 'string' || !STATUSES.includes(body.status)) {
        return fail(
          'bad_request',
          `'status' must be one of: ${STATUSES.join(', ')}`,
          400
        );
      }
      update.status = body.status;
    }
    if (body.notes !== undefined) {
      update.notes = typeof body.notes === 'string' ? body.notes : null;
    }
    if (body.service_name !== undefined) {
      update.service_name =
        typeof body.service_name === 'string' ? body.service_name : null;
    }

    // Reschedule: recompute the window and re-check overlap (excluding
    // this appointment so an unchanged time never conflicts with itself).
    if (body.starts_at !== undefined || body.duration_minutes !== undefined) {
      const startsAtRaw =
        typeof body.starts_at === 'string'
          ? body.starts_at
          : (existing.starts_at as string);
      if (Number.isNaN(Date.parse(startsAtRaw))) {
        return fail('bad_request', "'starts_at' must be an ISO datetime", 400);
      }
      const currentDuration = Math.round(
        (Date.parse(existing.ends_at as string) -
          Date.parse(existing.starts_at as string)) /
          60_000
      );
      const duration =
        typeof body.duration_minutes === 'number'
          ? body.duration_minutes
          : currentDuration;
      if (!Number.isInteger(duration) || duration < 1 || duration > 1440) {
        return fail('bad_request', "'duration_minutes' must be 1–1440", 400);
      }
      const startsAt = new Date(startsAtRaw);
      const endsAt = new Date(startsAt.getTime() + duration * 60_000);

      if (
        await hasOverlap(
          ctx.supabase,
          ctx.accountId,
          startsAt.toISOString(),
          endsAt.toISOString(),
          id
        )
      ) {
        return fail(
          'slot_taken',
          'That time overlaps an existing appointment — query /api/v1/availability for open slots',
          409
        );
      }
      update.starts_at = startsAt.toISOString();
      update.ends_at = endsAt.toISOString();
    }

    if (Object.keys(update).length === 0) {
      return fail('bad_request', 'No updatable fields in body', 400);
    }

    const { data: updated, error } = await ctx.supabase
      .from('appointments')
      .update(update)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select(APPOINTMENT_SELECT)
      .single();

    if (error || !updated) {
      console.error('[api/v1/appointments] update error:', error);
      return fail('internal', 'Failed to update appointment', 500);
    }

    return ok(serializeAppointment(updated as Record<string, unknown>));
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
