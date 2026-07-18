# Notarization Lane — Test Matrix (merge minimum, per XX control-plane review)

Revision 2 (2026-07-18): 33 cases. Incorporates XX M2 corrections.

## C1: source = asset snapshot + ETag conditional read (9 cases)

| # | Test | Expected |
|---|------|----------|
| 1.1 | POST without `asset_id` when build has multiple darwin installables | 409 "ambiguous; specify asset_id" |
| 1.2 | POST without `asset_id` when build has exactly one darwin installable | succeeds (auto-select) |
| 1.3 | POST with `asset_id` belonging to a different build | 404 |
| 1.4 | POST with non-darwin platform asset | 400 (whitelist) |
| 1.5 | POST with filetype not in (zip/dmg/pkg) | 400 |
| 1.6 | DB `file_hash` != computed SHA from R2 bytes | **409/422 `ASSET_INTEGRITY_MISMATCH`** (not generic 500) |
| 1.7 | R2 object overwritten between HEAD (ETag/size) and byte-read for SHA compute | fail closed (ETag mismatch on conditional read), `ASSET_INTEGRITY_MISMATCH` |
| 1.8 | R2 object overwritten between SHA compute and S3 upload | fail closed; **second ETag-conditional GET body IS the S3 PUT body directly** (not check-then-reread; the verified body stream is what gets uploaded) |
| 1.9 | Apple request uses computed_sha256, not DB file_hash (fuzz: swap DB value) | Apple receives computed value |

## C2: logical + append-only attempts, idempotency (9 cases)

| # | Test | Expected |
|---|------|----------|
| 2.1 | Concurrent POST for same (app, asset, SHA) while InProgress | both return same logical_id + attempt_id |
| 2.2 | POST for same (app, asset, SHA) after Accepted | return existing logical result, no new Apple submission, `idempotent: true`. **logical_id unchanged** |
| 2.3 | POST for same (app, asset, SHA) after Invalid | new attempt on **same logical** (attempt_no increments), new Apple submission. **logical_id unchanged, attempt_id/attempt_no changed** |
| 2.4 | POST for same (app, asset, SHA) after Rejected | new attempt on same logical. logical_id unchanged |
| 2.5 | POST for same (app, asset, SHA) after error (infra) | new attempt on same logical. logical_id unchanged |
| 2.6 | **Accepted concurrent singleton SQL race**: two concurrent POSTs after prior Accepted | both return same logical, zero new submissions (DB permanent UNIQUE constraint is the gate) |
| 2.7 | S3 upload uncertain outcome (network timeout mid-PUT) | reconcile original submission_id via status poll; `upload_state=upload_uncertain`, `reconcile_state=needed→in_progress→reconciled`; do NOT create new submission |
| 2.8 | Temp AWS creds / sessionToken in D1 (grep all columns) | not stored anywhere |
| 2.9 | developerLogUrl in D1 / operation output / audit / API response | not present anywhere |

## C3: app ownership proven locally (5 cases)

| # | Test | Expected |
|---|------|----------|
| 3.1 | GET /apps/A/notarizations/submission-of-app-B | 404 before any Apple API call |
| 3.2 | GET /apps/A/notarizations/nonexistent-id | 404, no Apple call |
| 3.3 | GET with valid app + submission | normalized state + log summary only; no raw Apple response passthrough |
| 3.4 | Full log retained (if implemented) | stored in private R2 object, viewer-audited, size-capped; short-lived URL not returned |
| 3.5 | **SQL-level negative test**: INSERT attempt with app_id != parent logical app_id | trigger ABORTs; rejected at DB layer |

## C4: ready_for_staple triple closure (8 cases)

| # | Test | Expected |
|---|------|----------|
| 4.1 | status=Accepted + log fetched + jobId==submission_id + log SHA==source SHA | ready_for_staple=true |
| 4.2 | status=Accepted + log fetch 404 | ready_for_staple=false (log_fetched=0) |
| 4.3 | status=Accepted + log jobId != submission_id | ready_for_staple=false |
| 4.4 | status=Accepted + log SHA != source computed_sha256 | ready_for_staple=false, `SHA_BINDING_MISMATCH` |
| 4.5 | status="In Progress" | ready_for_staple=false |
| 4.6 | status=unknown/null (Apple adds new enum) | ready_for_staple=false; **raw unknown status saved in raw_apple_status; fail-closed, no auto-retry** (not treated as in_progress) |
| 4.7 | S3 PUT success ETag | recorded in `s3_receipt_etag` column but NOT treated as content hash |
| 4.8 | Attempt to UPDATE ready_for_staple=1 without matching closure | trigger ABORTs; rejected at DB layer |

## C5: error classification — 401/403/7000 distinct across 3 phases (6 cases)

| # | Test | Phase | Expected error_class |
|---|------|-------|---------------------|
| 5.1 | Apple returns 401 | POST submissions | `NOTARY_AUTH_INVALID` |
| 5.2 | Apple returns 403 | POST submissions | `NOTARY_ROLE_INSUFFICIENT` |
| 5.3 | Apple returns 7000 in terminal Rejected (team not configured) | status poll | `NOTARY_TEAM_NOT_CONFIGURED` (not role error) |
| 5.4 | Apple returns Rejected (non-7000) | status poll | status_state=rejected; error_class per raw status |
| 5.5 | Apple returns 401/403 on **status poll or log fetch** (post-submission) | GET status/logs | classified same as submit phase; attempt records error_phase |
| 5.6 | Apple returns 500/502/503 | any phase | `APPLE_REQUEST_FAILED`; **recoverable**: `reconcile_state=needed`, NOT terminal error; stays on same attempt |

## C6: audit chain survives projection deletion (3 cases — B3)

| # | Test | Expected |
|---|------|----------|
| 6.1 | DELETE build_assets row referenced by a notarization | FK RESTRICT prevents deletion |
| 6.2 | DELETE operation_logs row referenced by an attempt | succeeds; attempt.operation_id becomes NULL (ON DELETE SET NULL); attempt data survives |
| 6.3 | DELETE builds row referenced by a notarization | FK RESTRICT prevents deletion |

## C7: ownership SQL negative tests (3 cases — B2)

| # | Test | Expected |
|---|------|----------|
| 7.1 | INSERT logical with build_id belonging to different app_id | trigger ABORT |
| 7.2 | INSERT logical with asset_id belonging to different build_id | trigger ABORT |
| 7.3 | UPDATE logical.active_attempt_id to an attempt of different logical | trigger ABORT |

---
**Total: 33 cases** (9 + 9 + 5 + 8 + 6 + 3 + 3)

## Production happy-path declaration discipline
- Until one real Accepted + log-SHA closure has been observed in production, the lane
  is declared "broker/control-plane ready" only, NOT "production happy path proven."
