-- ============================================================
-- 037_ai_openrouter_provider.sql — add OpenRouter as an AI provider
--
-- OpenRouter (https://openrouter.ai) is an OpenAI-compatible proxy that
-- fronts hundreds of vendor models behind a single BYO key, so it slots
-- into the existing provider column as a third option alongside
-- 'openai' / 'anthropic'. Widens the two CHECK constraints that
-- enumerate allowed providers:
--   - ai_configs.provider    (029_ai_reply.sql)
--   - ai_usage_log.provider  (033_ai_reply_polish.sql)
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_configs
  DROP CONSTRAINT IF EXISTS ai_configs_provider_check;
ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'openrouter'));

ALTER TABLE ai_usage_log
  DROP CONSTRAINT IF EXISTS ai_usage_log_provider_check;
ALTER TABLE ai_usage_log
  ADD CONSTRAINT ai_usage_log_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'openrouter'));
