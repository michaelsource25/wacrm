-- ============================================================
-- 040_appointment_reminders
--
-- Plain-text appointment reminders, sent by a cron-driven job
-- (/api/appointments/reminders/cron) ~24h and ~2h before start.
--
-- Deliberately NOT interactive-button messages: the reminder is a
-- normal text and the customer replies in natural language ("voy",
-- "cancélala", "muévela al viernes") — the AI booking tools (see
-- lib/ai/tools/appointments.ts) interpret whatever comes back.
--
-- Sent-markers live on the appointment row itself: a conditional
-- UPDATE ... WHERE reminder_*_sent_at IS NULL is the claim that makes
-- overlapping cron runs idempotent (same fail-safe direction as the
-- ai reply slot: under-remind, never double-remind).
--
-- Account-level knobs follow the 021/039 pattern (columns on
-- `accounts`, admin-writable via the existing accounts_update RLS
-- policy): an on/off switch and an optional custom message template
-- with {name} {service} {date} {time} placeholders (NULL → built-in
-- default in code).
-- ============================================================

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS reminder_24h_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reminder_2h_sent_at TIMESTAMPTZ;

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS appointment_reminders_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS appointment_reminder_template TEXT;

ALTER TABLE accounts
  DROP CONSTRAINT IF EXISTS accounts_reminder_template_length;
ALTER TABLE accounts
  ADD CONSTRAINT accounts_reminder_template_length
  CHECK (
    appointment_reminder_template IS NULL
    OR char_length(appointment_reminder_template) BETWEEN 1 AND 1000
  );

-- The cron scan is "upcoming, not yet reminded" — the existing
-- (account_id, starts_at) index from 038 already serves it.
