-- What Google said on the latest failure of an access episode, redacted by the
-- worker (lib/upstream_error.ts): {"service","http_status","message"} as JSON.
-- Carried on the access_failed alert so the reader sees Google's own words.
ALTER TABLE google_play_access_state ADD COLUMN last_upstream_json TEXT;
