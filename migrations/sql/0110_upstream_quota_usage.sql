-- How much of an upstream's rationed calls Hands has spent, per quota window.
-- Today: Google Play's tracks.releases.list, about 12 calls per package per hour,
-- resetting around minute :10 (worker/src/lib/upstream_quota.ts holds the
-- registry). Several Hands paths spend the same quota (the hourly poll,
-- review-status, the stats page, the promote gate, send-for-review); this table
-- lets each one see what the others used before it calls.
-- exhausted_until is set when the upstream itself says the quota is used up:
-- nothing in Hands calls again before that time.
CREATE TABLE upstream_quota_usage (
  quota_key TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  used INTEGER NOT NULL,
  exhausted_until INTEGER NULL,
  updated_at INTEGER,
  PRIMARY KEY (quota_key, scope_key, window_start)
);
