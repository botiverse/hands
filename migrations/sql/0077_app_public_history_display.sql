-- Public history page display options (task #888).
--
-- `public_history` already toggles whether /apps/:slug/history exists at all.
-- These two columns control what that page (and its sibling /notes/:slug and
-- /history/:releaseId/download surfaces) shows once enabled:
--
-- - `history_channels`: JSON array of channel slugs the public pages may list.
--   NULL means "every channel" (the historical behaviour). An app that only
--   wants stable releases on the page stores e.g. ["main"]. Candidate/rc
--   releases on other channels keep their real state — this only filters the
--   public listing, never touches release rows or update checks.
-- - `history_show_downloads`: 1 = the per-version Download CTA renders and
--   /apps/:slug/history/:releaseId/download resolves; 0 = no download CTA and
--   the download endpoint 404s. "Hide the button" would be cosmetic only, so
--   the endpoint respects the same flag.
--
-- Both default to the current behaviour so existing apps see no change.
ALTER TABLE apps ADD COLUMN history_channels TEXT;
ALTER TABLE apps ADD COLUMN history_show_downloads INTEGER NOT NULL DEFAULT 1;
