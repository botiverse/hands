-- Migration 0018: apps.default_channel_id (P2.5.9 / P5.7)
--
-- Per-app "default release channel" — pre-fills the channel dropdown in
-- the NewReleaseDialog so onboarding (first release after creating an
-- app) doesn't force the user to type the channel slug from memory.
--
-- Design:
--   - nullable; default is the first channel sorted by created_at ASC
--     (legacy behavior pre-0018: prod / beta / internal seed order).
--   - FK with ON DELETE SET NULL so deleting the channel doesn't break
--     the app; UI falls back to the first remaining channel.
--   - SELECT returns default_channel_id + default_channel_slug (via JOIN)
--     so the admin UI can show "Default: production" without a 2nd round-trip.

ALTER TABLE apps ADD COLUMN default_channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_apps_default_channel
  ON apps(default_channel_id) WHERE default_channel_id IS NOT NULL;

-- Backfill: pick the first channel per app (by created_at) as the default,
-- only for apps that have channels and don't already have one set.
UPDATE apps
SET default_channel_id = (
  SELECT id FROM channels
  WHERE channels.app_id = apps.id
  ORDER BY created_at ASC
  LIMIT 1
)
WHERE default_channel_id IS NULL
  AND EXISTS (SELECT 1 FROM channels WHERE channels.app_id = apps.id);
