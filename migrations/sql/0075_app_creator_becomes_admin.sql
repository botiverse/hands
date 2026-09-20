-- Migration 0075: make each existing app's creator that app's admin.
--
-- Numbered 0075, not 0074: migration numbers are assigned by entry order into main, and
-- 0074_app_purge_records landed first (applied to production on 2026-09-18). Two migrations
-- sharing a number is not something the merge path catches - it is a new file, so git sees no
-- conflict and the PR shows CLEAN - which is exactly why the collision has to be checked rather
-- than discovered at the next deploy's apply step.
--
-- WHY
-- ---
-- Until #531, `handleCreateApp` created the app, its product types and its channels
-- and never wrote `app_members`. `getAppMemberRole` reads `app_members` only, so the
-- creator's app_role resolved to nothing and every `requireAppRole("admin")` call on
-- the app they had just created answered 403 - the app was an orphan to its own
-- creator. #531 fixed the write going forward; this migration repairs the apps that
-- were created before it landed.
--
-- WHERE THE CREATOR IS RECORDED
-- -----------------------------
-- `apps` has no creator column. The only record is the `app.create` audit row, whose
-- `actor_id` is NULL in practice (the audit writer used by this path inserts six
-- columns and omits actor_id/actor_type), leaving the `actor` TEXT as the only
-- identity: 'raft:<username>@<server_slug>', e.g. 'raft:artin@slock-android'.
--
-- The mapping therefore joins on BOTH username AND server_slug. Matching on username
-- alone is wrong: raft_accounts is unique on (provider, provider_subject, server_id)
-- and the same handle exists on more than one server (e.g. artin is present on both
-- 'slock-android' and 'botiverse'), so a username-only join can attribute an app to
-- the wrong account on the wrong server.
--
-- SCOPE
-- -----
-- Only rows that are absent are inserted; nothing is updated, so no existing member
-- can be demoted or have a role changed, and re-running is a no-op. Rows whose actor
-- does not map to an account (a non-raft: actor such as the early 'admin' literal) are
-- skipped rather than guessed at: granting an app role to a guessed account is worse
-- than leaving that app as it is, and an unmapped app that already has an admin needs
-- nothing.
--
-- CENSUS (read-only, run before applying and after)
-- -------------------------------------------------
--   WITH creat AS (
--     SELECT al.app_id,
--            substr(al.actor, 6, instr(al.actor,'@')-6) AS name,
--            substr(al.actor, instr(al.actor,'@')+1)   AS server
--     FROM audit_logs al
--     WHERE al.action='app.create' AND al.actor LIKE 'raft:%'
--   )
--   SELECT COUNT(*)                                                        AS mappable,
--          SUM(CASE WHEN am.id IS NULL THEN 1 ELSE 0 END)                  AS to_insert,
--          SUM(CASE WHEN am.id IS NOT NULL THEN 1 ELSE 0 END)              AS already_present,
--          SUM(CASE WHEN am.id IS NOT NULL AND am.app_role <> 'admin'
--                   THEN 1 ELSE 0 END)                                     AS would_change_existing
--   FROM creat c
--   JOIN raft_accounts ra ON ra.username = c.name AND ra.server_slug = c.server
--   LEFT JOIN app_members am ON am.app_id = c.app_id AND am.account_id = ra.id;
--
-- Pre-apply (2026-09-16): mappable 26, to_insert 26, already_present 0,
--                         would_change_existing 0.
-- Post-apply expectation: to_insert 0, already_present 26, would_change_existing 0,
--                         and zero apps without an admin:
--   SELECT COUNT(*) FROM apps a
--   WHERE NOT EXISTS (SELECT 1 FROM app_members m
--                     WHERE m.app_id = a.id AND m.app_role = 'admin');
--
-- The unmapped app is deliberately left alone: at the time this was written 'myapp-android'
-- had actor = 'admin' (not a raft: handle) and already carried an admin row. That app was
-- purged on 2026-09-20, so its app.create audit row is gone and no such row exists today -
-- finding none is the expected result, not a regression. The skip branch still stands on its
-- own: any actor that is not a raft: handle is skipped rather than guessed at.

-- Inserts one admin row per app whose recorded creator maps to an account and is not
-- already a member. `joined_at` uses the app's own creation time, not now(): the row
-- describes a grant that has been true since the app existed, and stamping it with the
-- migration's timestamp would make it look like a permission granted today.
INSERT INTO app_members (id, app_id, account_id, app_role, invited_by, joined_at)
SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4'
         || substr(lower(hex(randomblob(2))), 2) || '-a'
         || substr(lower(hex(randomblob(2))), 2) || '-'
         || lower(hex(randomblob(6))),
       a.id,
       ra.id,
       'admin',
       NULL,
       a.created_at
FROM apps a
JOIN audit_logs al
  ON al.app_id = a.id AND al.action = 'app.create' AND al.actor LIKE 'raft:%'
JOIN raft_accounts ra
  ON ra.username   = substr(al.actor, 6, instr(al.actor, '@') - 6)
 AND ra.server_slug = substr(al.actor, instr(al.actor, '@') + 1)
WHERE NOT EXISTS (
  SELECT 1 FROM app_members m WHERE m.app_id = a.id AND m.account_id = ra.id
);

-- Guard: the backfill must not leave an app that HAS a mappable creator without an
-- admin. RAISE() only works inside a trigger, and a trigger is the wrong tool for a
-- one-shot backfill, so the assertion is a CHECK on a scratch table: inserting a
-- non-zero count violates ok = 0 and aborts the migration.
--
-- If this fires, do NOT weaken the assertion to make the deploy pass - that turns a
-- guarded backfill into an unguarded one. List the offenders and decide per-row
-- whether the actor text is stale or the mapping rule is wrong.
--
-- It asserts the exact property the INSERT establishes: every mappable creator HAS a
-- membership. It deliberately does not assert that the role is 'admin', because the
-- INSERT skips anyone who is already a member - so a creator who was already present
-- with some other role keeps it, and asserting 'admin' here would fire on correct data.
-- Nor does it assert "every app has an admin": that is false after this migration,
-- since an app whose actor never mapped (the literal 'admin' actor, e.g. the since-purged
-- 'myapp-android') is intentionally skipped, and a dev-token-created app has no account at all.
CREATE TABLE IF NOT EXISTS _0074_guard_unbackfilled (ok INTEGER NOT NULL CHECK (ok = 0));
DELETE FROM _0074_guard_unbackfilled;
INSERT INTO _0074_guard_unbackfilled (ok)
SELECT COUNT(*)
FROM (
  SELECT al.app_id,
         substr(al.actor, 6, instr(al.actor, '@') - 6) AS name,
         substr(al.actor, instr(al.actor, '@') + 1)    AS server
  FROM audit_logs al
  WHERE al.action = 'app.create' AND al.actor LIKE 'raft:%'
) c
JOIN raft_accounts ra
  ON ra.username = c.name AND ra.server_slug = c.server
WHERE NOT EXISTS (
  SELECT 1 FROM app_members m
  WHERE m.app_id = c.app_id AND m.account_id = ra.id
);
DROP TABLE _0074_guard_unbackfilled;

-- Deliberately no second guard asserting "row count increased by N". It cannot be
-- written soundly from inside the migration: a pre-existing admin row with no inviter
-- and a joined_at equal to the app's created_at is indistinguishable from a backfilled
-- one, so such a count would fire on legitimate pre-existing data and block the deploy.
-- An assertion that can reject a correct state is worse than no assertion. What is
-- checkable and necessarily true is guard 1 above: every mappable creator is an admin.
