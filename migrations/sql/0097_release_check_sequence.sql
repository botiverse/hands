-- Caller-assigned ordering for release checks. Once a (release, source) row
-- carries a sequence, only a write with a larger sequence replaces it and a
-- write without one is refused; reviewed_at no longer orders that row.
-- decision_id is the caller's identifier for the decision, stored and read
-- back as sent. Both are NULL for existing rows and for callers that do not
-- send them, which keep the reviewed_at rules.
ALTER TABLE release_checks ADD COLUMN sequence INTEGER;
ALTER TABLE release_checks ADD COLUMN decision_id TEXT;
