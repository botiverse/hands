-- An organization's name follows its Raft server and is refreshed at every
-- sign-in. Admins can now rename it in Hands: name_customized keeps that name
-- through sign-in, and raft_name keeps the server's name so it can be handed
-- back. Existing organizations start following Raft, as before.
ALTER TABLE organizations ADD COLUMN raft_name TEXT;
ALTER TABLE organizations ADD COLUMN name_customized INTEGER NOT NULL DEFAULT 0;
UPDATE organizations SET raft_name = name WHERE raft_name IS NULL;
