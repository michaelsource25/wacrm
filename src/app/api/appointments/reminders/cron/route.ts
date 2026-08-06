import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { processDueReminders } from '@/lib/appointments/reminders'

/**
 * Send due appointment reminders (~24h and ~2h before start). Meant
 * to be hit every 5–10 minutes by a scheduler (Dokploy Schedules /
 * external pinger), same contract as the automations/flows crons:
 * shared secret via the `x-cron-secret` header, matched against
 * `AUTOMATION_CRON_SECRET` (one secret for every cron endpoint keeps
 * the pinger config simple).
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const result = await processDueReminders(supabaseAdmin())
  return NextResponse.json(result)
}
