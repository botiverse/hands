-- Drop build_assets_legacy — the credential-bearing full copy left behind by 0062.
--
-- 0062 renamed the old build_assets to build_assets_legacy, created the new
-- build_assets, and copied every row across by id (incl. r2_key, signature,
-- signing_credential_id, metadata_json). It deliberately did NOT drop the legacy
-- copy. That copy is maintained by nothing and is a standing duplicate of signing
-- material — this migration removes it, but only after PROVING nothing is lost.
--
-- WHAT THE GUARD PROVES / DOES NOT PROVE:
--   It proves NO ASSET IDENTITY/INTEGRITY IS LOST — every legacy row has a live row
--   with the same id AND the same immutable columns (r2_key, file_hash, signature,
--   signing_credential_id). It does NOT prove "every legacy byte is in live":
--   metadata_json is deliberately excluded because it is live-mutable derived data
--   (delta from_version_code, download_count bookkeeping). Guarding on a field that
--   legitimately changes would false-abort — the worst kind, because it invites the
--   on-call to disable the guard to ship. The dropped copy of a superseded
--   metadata_json is not a loss; a dropped-only signing credential would be.
--
-- WHITELIST / SNAPSHOT NOTE:
--   A prod --remote COUNT (2026-08-18, read-only) found 0 legacy rows with no live
--   id-match (of 286 legacy / 321 live), 0 of them credential-bearing — so the strict
--   assert needs no whitelist today. That count only proved id-match on a snapshot; it
--   did NOT pre-green the per-column check below, and new orphans could appear before
--   this migration runs. The strict abort therefore stays UNCONDITIONALLY. If a
--   legitimate exception ever arises (a row confirmed deliberately deleted from live),
--   add `AND l.id NOT IN ('<id>', ...)` to the NOT EXISTS below, one id at a time,
--   each with an inline justification — never widen the match to make red go away.
--
-- The guard runs BEFORE the DROP and aborts the whole migration if it fails, using a
-- CHECK-constraint violation (portable; no RAISE — trigger-only; no TEMP table — D1
-- unsupported). If it aborts, the DROP below never runs and build_assets_legacy is
-- left intact.
--
-- ┌─ IF THIS MIGRATION FAILS ON `CHECK constraint failed: ok = 1` ───────────────────┐
-- │ This is NOT a bug. It means build_assets_legacy holds a row whose credential      │
-- │ columns are NOT preserved in the live build_assets. Do NOT delete the assert to   │
-- │ make the deploy pass — that turns a guarded delete into a bare one. Correct        │
-- │ handling = list the offending rows (locator columns only, below) and escalate;     │
-- │ decide per-row whether they are recoverable-elsewhere or must be kept.             │
-- │                                                                                    │
-- │   SELECT l.id, l.created_at            -- locator columns only; do NOT SELECT *,   │
-- │   FROM build_assets_legacy l           -- which would print signature /            │
-- │   WHERE NOT EXISTS (                   -- signing_credential_id / r2_key /         │
-- │     SELECT 1 FROM build_assets b       -- metadata_json to the terminal / logs.    │
-- │     WHERE b.id = l.id                                                              │
-- │       AND IFNULL(b.r2_key,'')                = IFNULL(l.r2_key,'')                 │
-- │       AND IFNULL(b.file_hash,'')             = IFNULL(l.file_hash,'')              │
-- │       AND IFNULL(b.signature,'')             = IFNULL(l.signature,'')              │
-- │       AND IFNULL(b.signing_credential_id,'') = IFNULL(l.signing_credential_id,''));│
-- └────────────────────────────────────────────────────────────────────────────────┘

CREATE TABLE IF NOT EXISTS _guard_drop_legacy (ok INTEGER NOT NULL CHECK (ok = 1));
DELETE FROM _guard_drop_legacy;

-- ok = 1 iff live build_assets ⊇ build_assets_legacy on (id + credential columns).
-- metadata_json is intentionally excluded from the match: it is mutable live (delta
-- from_version_code, download bookkeeping) so a legitimate live update would otherwise
-- abort the drop; the credential material we must not lose is r2_key / file_hash /
-- signature / signing_credential_id.
INSERT INTO _guard_drop_legacy (ok)
SELECT CASE WHEN (
  SELECT count(*)
  FROM build_assets_legacy l
  WHERE NOT EXISTS (
    SELECT 1 FROM build_assets b
    WHERE b.id = l.id
      AND IFNULL(b.r2_key, '')                = IFNULL(l.r2_key, '')
      AND IFNULL(b.file_hash, '')             = IFNULL(l.file_hash, '')
      AND IFNULL(b.signature, '')             = IFNULL(l.signature, '')
      AND IFNULL(b.signing_credential_id, '') = IFNULL(l.signing_credential_id, '')
  )
) = 0 THEN 1 ELSE 0 END;

DROP TABLE _guard_drop_legacy;

-- Only reached when the guard proved every legacy row's credential data is preserved
-- in the live table. No export: the drop is provably lossless.
DROP TABLE build_assets_legacy;
