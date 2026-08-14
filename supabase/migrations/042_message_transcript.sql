-- ============================================================
-- 042_message_transcript
--
-- Speech-to-text for inbound WhatsApp voice notes.
--
-- Why: a large share of customers send audio rather than typing. The
-- AI assistant only ever saw `content_type = 'text'` messages, so a
-- voice note was invisible to it — the bot stayed silent, and the
-- "24/7 support" promise broke for exactly those customers. Humans
-- had to play every clip to know what was asked.
--
-- The webhook transcribes an inbound audio message and stores the text
-- here. Two consumers:
--   1. The AI context builder treats a transcribed audio turn as if
--      the customer had typed it.
--   2. The inbox renders it under the audio player, so agents can
--      read a voice note without listening to it.
--
-- Separate column (not `content_text`) on purpose: `content_text` is
-- what the customer literally sent (a caption, or NULL for a bare
-- voice note). Keeping the machine transcription apart means the UI
-- can label it as such, and a re-transcription never overwrites real
-- customer-authored content.
--
-- NULL means "not transcribed" — no key configured, transcription
-- failed, or the message isn't audio. There is deliberately no
-- "pending" state: transcription happens inline before the row is
-- inserted, so a row either has it or never will.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS transcript TEXT;

COMMENT ON COLUMN messages.transcript IS
  'Machine transcription of an inbound audio message (migration 042). NULL when not audio or not transcribed.';
