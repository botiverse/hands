-- Per-app rules that classify incoming crash and error reports as noise
-- (lib/feedback_rules.ts). A matching report is still stored; the rule only
-- closes it (not_planned) or keeps it out of alerts, and the ticket's
-- metadata names the rule.
CREATE TABLE IF NOT EXISTS feedback_rules (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  action TEXT NOT NULL CHECK (action IN ('close', 'mute')),
  match_json TEXT NOT NULL,
  -- 1: never matches native crashes, ANRs or Java exceptions.
  protect_high_risk INTEGER NOT NULL DEFAULT 1 CHECK (protect_high_risk IN (0, 1)),
  hits INTEGER NOT NULL DEFAULT 0,
  last_hit_at INTEGER,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_rules_app ON feedback_rules(app_id, enabled);
