-- ============================================================
-- 039_account_timezone
--
-- Business timezone for the account, as an IANA zone name (e.g.
-- "America/Santo_Domingo"). Needed by the AI booking tools: the bot
-- computes free slots and speaks appointment times in the business's
-- local time, and availability_rules (038) hold local wall-clock
-- windows that must be anchored to a real zone to become instants.
--
-- Follows the 021 default_currency pattern: a single column on
-- `accounts`, admin-editable (the existing accounts_update RLS policy
-- from 017 already restricts writes to admins+). NULL means "not set"
-- — consumers fall back to UTC, matching the availability endpoint's
-- tz_offset=0 default.
--
-- No enum/FK of valid zones: the IANA set churns and Postgres's own
-- pg_timezone_names differs by version. A length sanity check keeps
-- garbage out; runtime code validates via Intl and falls back to UTC.
-- ============================================================

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS timezone TEXT;

ALTER TABLE accounts
  DROP CONSTRAINT IF EXISTS accounts_timezone_length;
ALTER TABLE accounts
  ADD CONSTRAINT accounts_timezone_length
  CHECK (timezone IS NULL OR char_length(timezone) BETWEEN 1 AND 64);
