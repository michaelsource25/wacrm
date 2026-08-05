-- ============================================================
-- 038_appointments.sql — Appointments module
--
-- Adds native scheduling to wacrm: bookable `services`, weekly
-- `availability_rules`, and the `appointments` themselves — each
-- appointment tied to a contact so the calendar and the inbox share
-- one world.
--
-- Design notes
--   - Account-scoped throughout (post-017 tenancy model). RLS uses
--     `is_account_member(account_id, min_role)`:
--       services / availability_rules → settings-class (read viewer+,
--       write admin+), mirroring tags / custom_fields.
--       appointments → operational (read viewer+, insert/update
--       agent+, delete admin+), mirroring conversations-class rules.
--   - `appointments.contact_id` is ON DELETE SET NULL so history
--     survives contact deletion (the migration-004 convention).
--   - `service_name` is denormalized onto the appointment at booking
--     time so history survives a service being renamed or deleted.
--   - Times are stored as timestamptz (UTC instants). Availability
--     rule times are the business's local wall-clock times; the
--     availability endpoint converts using a caller-supplied UTC
--     offset (see /api/v1/availability).
--   - No DB-level overlap exclusion constraint (would require the
--     btree_gist extension); the API performs the overlap check and
--     the UI surfaces conflicts. Double-booking under a race is
--     possible but harmless for this domain.
--
-- Idempotent — safe to run multiple times. Tables use IF NOT
-- EXISTS; policies are dropped before recreate (Postgres has no
-- CREATE POLICY IF NOT EXISTS).
-- ============================================================

-- ============================================================
-- SERVICES — what can be booked (e.g. "Corte + barba", 45 min)
-- ============================================================
CREATE TABLE IF NOT EXISTS services (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name             text NOT NULL,
  duration_minutes integer NOT NULL DEFAULT 30
                     CHECK (duration_minutes > 0 AND duration_minutes <= 1440),
  price            numeric(12,2),
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS services_account_id_idx ON services (account_id);

ALTER TABLE services ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS services_select ON services;
CREATE POLICY services_select ON services FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS services_insert ON services;
CREATE POLICY services_insert ON services FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS services_update ON services;
CREATE POLICY services_update ON services FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS services_delete ON services;
CREATE POLICY services_delete ON services FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON services;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON services
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- AVAILABILITY_RULES — weekly opening hours
--
-- weekday: 0 = Sunday … 6 = Saturday (JS Date#getDay convention).
-- Multiple rows per weekday are allowed (split shifts, e.g.
-- 09:00–12:00 and 14:00–18:00). No rows for a weekday = closed.
-- An account with NO rules at all falls back to Mon–Sat 09:00–18:00
-- in the availability endpoint, so booking works out of the box.
-- ============================================================
CREATE TABLE IF NOT EXISTS availability_rules (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  weekday    smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time time NOT NULL,
  end_time   time NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT availability_rules_window CHECK (end_time > start_time)
);

CREATE INDEX IF NOT EXISTS availability_rules_account_idx
  ON availability_rules (account_id, weekday);

ALTER TABLE availability_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS availability_rules_select ON availability_rules;
CREATE POLICY availability_rules_select ON availability_rules FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS availability_rules_insert ON availability_rules;
CREATE POLICY availability_rules_insert ON availability_rules FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS availability_rules_update ON availability_rules;
CREATE POLICY availability_rules_update ON availability_rules FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS availability_rules_delete ON availability_rules;
CREATE POLICY availability_rules_delete ON availability_rules FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- ============================================================
-- APPOINTMENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS appointments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id   uuid REFERENCES contacts(id) ON DELETE SET NULL,
  service_id   uuid REFERENCES services(id) ON DELETE SET NULL,
  service_name text,
  starts_at    timestamptz NOT NULL,
  ends_at      timestamptz NOT NULL,
  status       text NOT NULL DEFAULT 'confirmed'
                 CHECK (status IN ('pending','confirmed','cancelled','completed','no_show')),
  notes        text,
  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT appointments_window CHECK (ends_at > starts_at)
);

-- Calendar range scans ("this week's appointments") are the hot path.
CREATE INDEX IF NOT EXISTS appointments_account_starts_idx
  ON appointments (account_id, starts_at);
-- The inbox contact panel asks "next appointment for this contact".
CREATE INDEX IF NOT EXISTS appointments_contact_idx
  ON appointments (contact_id) WHERE contact_id IS NOT NULL;

ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS appointments_select ON appointments;
CREATE POLICY appointments_select ON appointments FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS appointments_insert ON appointments;
CREATE POLICY appointments_insert ON appointments FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS appointments_update ON appointments;
CREATE POLICY appointments_update ON appointments FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS appointments_delete ON appointments;
CREATE POLICY appointments_delete ON appointments FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON appointments;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
