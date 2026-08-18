-- Existing rows keep their exact configured role and therefore cannot gain
-- privileges silently. New rows are explicit owner-server rows and derive an
-- account's app role from that account's role in the Raft server.
ALTER TABLE app_server_grants
ADD COLUMN access_model TEXT NOT NULL DEFAULT 'legacy_role'
  CHECK (access_model IN ('legacy_role', 'owner_server'));
