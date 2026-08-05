// ============================================================
// GET  /api/v1/appointments — list appointments in a date range
//                             (scope: appointments:read)
// POST /api/v1/appointments — book an appointment
//                             (scope: appointments:write)
//
// POST mirrors /api/v1/messages' contact handling: callers pass a
// phone (`to`) — what an external bot actually has — and the contact
// is found-or-created. `contact_id` is accepted as an alternative
// for callers that already resolved one.
//
// Body:
//   {
//     "to": "+18095550123",            // or "contact_id": "<uuid>"
//     "name": "Jane Doe",              // optional, names a new contact
//     "starts_at": "2026-08-06T19:00:00Z",  // required, ISO instant
//     "service_id": "<uuid>",          // optional — sets duration+name
//     "service_name": "Corte",         // optional free-text fallback
//     "duration_minutes": 45,          // optional; default 30 or the
//                                      // service's configured duration
//     "status": "confirmed",           // optional: pending|confirmed
//     "notes": "…"                     // optional
//   }
//
// A slot conflict returns 409 { error: { code: "slot_taken" } } —
// re-query /api/v1/availability and offer new times.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import {
  APPOINTMENT_SELECT,
  serializeAppointment,
  hasOverlap,
} from '@/lib/api/v1/appointments';
import {
  findOrCreateContact,
  resolveAuditUserId,
  ContactError,
} from '@/lib/api/v1/contacts';

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'appointments:read');
    const url = new URL(request.url);

    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const status = url.searchParams.get('status');
    const contactId = url.searchParams.get('contact_id');
    const limit = Math.min(
      Math.max(Number(url.searchParams.get('limit') ?? '100') || 100, 1),
      200
    );

    let query = ctx.supabase
      .from('appointments')
      .select(APPOINTMENT_SELECT)
      .eq('account_id', ctx.accountId)
      .order('starts_at', { ascending: true })
      .limit(limit);

    if (from) {
      if (Number.isNaN(Date.parse(from))) {
        return fail('bad_request', "'from' must be an ISO datetime", 400);
      }
      query = query.gte('starts_at', new Date(from).toISOString());
    }
    if (to) {
      if (Number.isNaN(Date.parse(to))) {
        return fail('bad_request', "'to' must be an ISO datetime", 400);
      }
      query = query.lt('starts_at', new Date(to).toISOString());
    }
    if (status) query = query.eq('status', status);
    if (contactId) query = query.eq('contact_id', contactId);

    const { data, error } = await query;
    if (error) {
      console.error('[api/v1/appointments] list error:', error);
      return fail('internal', 'Failed to list appointments', 500);
    }

    return okList(
      (data ?? []).map((r) => serializeAppointment(r as Record<string, unknown>)),
      null
    );
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'appointments:write');

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    const startsAtRaw = typeof body.starts_at === 'string' ? body.starts_at : '';
    if (!startsAtRaw || Number.isNaN(Date.parse(startsAtRaw))) {
      return fail('bad_request', "'starts_at' must be an ISO datetime", 400);
    }
    const startsAt = new Date(startsAtRaw);

    const status =
      typeof body.status === 'string' &&
      ['pending', 'confirmed'].includes(body.status)
        ? body.status
        : 'confirmed';

    // Resolve service → duration + denormalized name.
    let duration =
      typeof body.duration_minutes === 'number' ? body.duration_minutes : 0;
    let serviceId: string | null = null;
    let serviceName =
      typeof body.service_name === 'string' ? body.service_name : null;
    if (typeof body.service_id === 'string' && body.service_id) {
      const { data: service } = await ctx.supabase
        .from('services')
        .select('id, name, duration_minutes')
        .eq('id', body.service_id)
        .eq('account_id', ctx.accountId)
        .maybeSingle();
      if (!service) return fail('not_found', 'Service not found', 404);
      serviceId = service.id as string;
      serviceName = serviceName ?? (service.name as string);
      if (!duration) duration = service.duration_minutes as number;
    }
    if (!duration) duration = 30;
    if (!Number.isInteger(duration) || duration < 1 || duration > 1440) {
      return fail('bad_request', "'duration_minutes' must be 1–1440", 400);
    }
    const endsAt = new Date(startsAt.getTime() + duration * 60_000);

    // Resolve the contact — by id, or find-or-create by phone.
    let contactId: string;
    if (typeof body.contact_id === 'string' && body.contact_id) {
      const { data: contact } = await ctx.supabase
        .from('contacts')
        .select('id')
        .eq('id', body.contact_id)
        .eq('account_id', ctx.accountId)
        .maybeSingle();
      if (!contact) return fail('not_found', 'Contact not found', 404);
      contactId = contact.id as string;
    } else {
      const phone = typeof body.to === 'string' ? body.to.trim() : '';
      if (!phone) {
        return fail('bad_request', "Either 'to' or 'contact_id' is required", 400);
      }
      const auditUserId = await resolveAuditUserId(ctx.supabase, ctx.accountId);
      const resolved = await findOrCreateContact(
        ctx.supabase,
        ctx.accountId,
        auditUserId,
        {
          phone,
          name: typeof body.name === 'string' ? body.name : undefined,
        }
      );
      contactId = resolved.id;
    }

    if (
      await hasOverlap(
        ctx.supabase,
        ctx.accountId,
        startsAt.toISOString(),
        endsAt.toISOString()
      )
    ) {
      return fail(
        'slot_taken',
        'That time overlaps an existing appointment — query /api/v1/availability for open slots',
        409
      );
    }

    const { data: created, error } = await ctx.supabase
      .from('appointments')
      .insert({
        account_id: ctx.accountId,
        contact_id: contactId,
        service_id: serviceId,
        service_name: serviceName,
        starts_at: startsAt.toISOString(),
        ends_at: endsAt.toISOString(),
        status,
        notes: typeof body.notes === 'string' ? body.notes : null,
      })
      .select(APPOINTMENT_SELECT)
      .single();

    if (error || !created) {
      console.error('[api/v1/appointments] create error:', error);
      return fail('internal', 'Failed to create appointment', 500);
    }

    return ok(serializeAppointment(created as Record<string, unknown>), 201);
  } catch (err) {
    if (err instanceof ContactError) {
      return fail(
        err.status === 400 ? 'bad_request' : 'internal',
        err.message,
        err.status
      );
    }
    return toApiErrorResponse(err);
  }
}
