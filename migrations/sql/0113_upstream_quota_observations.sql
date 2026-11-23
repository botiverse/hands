-- What an upstream last said about its own quota for one scope (e.g. App
-- Store Connect's X-Rate-Limit per API key: limit and remaining in its rolling
-- hour). Unlike upstream_quota_usage, Hands does not count these calls: the
-- upstream reports the count itself, including calls made outside Hands.
CREATE TABLE IF NOT EXISTS upstream_quota_observations (
  quota_key TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  limit_value INTEGER NOT NULL,
  remaining INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  -- Set when the upstream refused for quota (HTTP 429): until then only
  -- callers a write is waiting on may call.
  exhausted_until INTEGER,
  PRIMARY KEY (quota_key, scope_key)
);
