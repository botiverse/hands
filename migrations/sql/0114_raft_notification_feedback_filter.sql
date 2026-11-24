-- Which feedback a Raft notification destination announces (feedback:new and
-- the ticket's later comment and status events): `kinds` limits the ticket
-- kinds (empty = all), `exclude_reporter_servers` drops tickets whose reporter
-- came from one of these Raft servers (id or slug), e.g. internal test servers.
ALTER TABLE raft_notification_subscriptions
  ADD COLUMN feedback_filter_json TEXT NOT NULL DEFAULT '{}';
