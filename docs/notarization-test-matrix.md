# Notarization Lane — Test Matrix (merge minimum, per XX control-plane review)

Revision 3 (2026-07-18): 43 cases. Incorporates XX r2/r3 corrections.

## C1: source = asset snapshot + ETag conditional read (9)

| # | Test | Expected |
|---|------|----------|
| 1.1 | POST without `asset_id`, multiple darwin installables | 409 "ambiguous; specify asset_id" |
| 1.2 | POST without `asset_id`, exactly one darwin installable | succeeds (auto-select) |
| 1.3 | POST with `asset_id` belonging to different build | 404 |
| 1.4 | POST with non-darwin platform asset | 400 |
| 1.5 | POST with filetype not in (zip/dmg/pkg) | 400 |
| 1.6 | DB `file_hash` != computed SHA from R2 bytes | 409/422 `ASSET_INTEGRITY_MISMATCH` |
| 1.7 | R2 overwritten between HEAD and SHA read | fail closed, `ASSET_INTEGRITY_MISMATCH` |
| 1.8 | R2 overwritten between SHA and upload | second ETag GET body IS S3 PUT body directly |
| 1.9 | Apple request uses computed_sha256 not DB value | verified |

## C2: logical + append-only attempts, idempotency (9)

| # | Test | Expected |
|---|------|----------|
| 2.1 | Concurrent POST same (app,asset,SHA) while InProgress | same logical_id + attempt_id |
| 2.2 | POST after Accepted | existing logical, no new submission, logical_id unchanged |
| 2.3 | POST after Invalid | new attempt same logical, logical_id unchanged, attempt_no++ |
| 2.4 | POST after Rejected | new attempt same logical, logical_id unchanged |
| 2.5 | POST after error | new attempt same logical, logical_id unchanged |
| 2.6 | Accepted concurrent singleton SQL race | both same logical, zero new submissions |
| 2.7 | S3 uncertain (timeout mid-PUT) | reconcile original submission_id; upload_uncertain→reconciled; no new submission |
| 2.8 | Temp AWS creds / sessionToken in D1 | not stored |
| 2.9 | developerLogUrl in D1/output/audit/response | not present |

## C3: app ownership proven locally (5)

| # | Test | Expected |
|---|------|----------|
| 3.1 | GET /apps/A/notarizations/submission-of-B | 404 before Apple call |
| 3.2 | GET /apps/A/notarizations/nonexistent | 404, no Apple call |
| 3.3 | GET valid app+submission | normalized only; no raw passthrough |
| 3.4 | Full log retained | private R2, viewer-audited, size-capped; no URL passthrough |
| 3.5 | SQL: INSERT attempt app_id != parent | trigger ABORT |

## C4: ready_for_staple triple closure (8)

| # | Test | Expected |
|---|------|----------|
| 4.1 | Accepted + log + jobId==sub_id + SHA match | ready=true |
| 4.2 | Accepted + log 404 | ready=false (log_fetched=0) |
| 4.3 | Accepted + jobId != submission_id | ready=false |
| 4.4 | Accepted + SHA != source | ready=false, `SHA_BINDING_MISMATCH` |
| 4.5 | status="In Progress" | ready=false |
| 4.6 | status unknown | ready=false; raw saved; fail-closed no auto-retry |
| 4.7 | S3 PUT ETag | in s3_receipt_etag, not content hash |
| 4.8 | SQL: UPDATE ready=1 without closure | trigger ABORT |

## C5: error classification — 401/403/7000 distinct (6)

| # | Test | Phase | Expected |
|---|------|-------|----------|
| 5.1 | 401 on POST submissions | submit | `NOTARY_AUTH_INVALID` |
| 5.2 | 403 on POST submissions | submit | `NOTARY_ROLE_INSUFFICIENT` |
| 5.3 | 7000 in terminal Rejected | poll | `NOTARY_TEAM_NOT_CONFIGURED` |
| 5.4 | Rejected non-7000 | poll | rejected; error_class per raw |
| 5.5 | 401/403 on status_poll or log_fetch | poll/log | same classification; error_phase recorded |
| 5.6 | 500/502/503 | any | `APPLE_REQUEST_FAILED`; reconcile_state=needed; NOT terminal |

## C6: audit chain survival (3)

| # | Test | Expected |
|---|------|----------|
| 6.1 | DELETE build_assets referenced by notarization | FK RESTRICT blocks |
| 6.2 | DELETE operation_logs referenced by attempt | succeeds; operation_id→NULL; attempt survives |
| 6.3 | DELETE builds referenced by notarization | FK RESTRICT blocks |

## C7: ownership SQL negative tests (3)

| # | Test | Expected |
|---|------|----------|
| 7.1 | INSERT logical build_id from different app | trigger ABORT |
| 7.2 | INSERT logical asset_id from different build | trigger ABORT |
| 7.3 | UPDATE logical.active_attempt_id to foreign attempt | trigger ABORT |

---
**Total: 43** (9+9+5+8+6+3+3)

## C8: XX-demonstrated bypass negative tests (10 — r3+r4)

| # | Test | r2/3 bug | fix |
|---|------|--------|-----|
| 8.1 | UPDATE active_attempt_id NULL→foreign | `!=` NULL when OLD NULL | `IS NOT` + INSERT trigger |
| 8.2 | UPDATE build_id only (not asset_id) | trigger fired only on asset_id | trigger fires on both columns |
| 8.3 | INSERT ready=1 with no active attempt | no INSERT trigger | `trg_notarize_ready_ins` |
| 8.4 | Pending attempt (log_fetched=0) → ready=1 | only checked submission_id | full closure check |
| 8.5 | UPDATE active attempt fields while parent ready | no attempt-side trigger | `trg_notarize_attempt_break_closure_upd` |
| 8.6 | DELETE active attempt while parent ready | no protection | `trg_notarize_attempt_break_closure_del` |
| 8.7 | SHA 64-char with non-hex chars | `GLOB '[0-9a-f]*'` first-char only | `NOT GLOB '*[^0-9a-f]*'` |
| 8.8 | error_class non-NULL on healthy pending | CHECK was tautological | non-NULL requires concrete error condition |
| **8.9** | **Rename active attempt id (t→t2)** — parent still points to old id | identity fields mutable | `trg_notarize_attempt_freeze_identity` — id/notarization_id/app_id/attempt_no/created_at immutable |
| **8.10** | **Reparent active attempt (n1→n2)** in same app — parent n1 remains ready | identity fields mutable | same trigger — notarization_id immutable |
| **8.11** | **Direct DELETE of non-ready/non-active attempt** while parent exists | delete trigger only guarded ready active | `trg_notarize_attempt_no_direct_delete` — rejects all direct deletes while parent exists |
| **8.12** | **UPDATE logical source-snapshot columns** (r2_key/r2_etag/source_size_bytes/computed_sha256/etc.) after creation | no freeze trigger | `trg_notarize_freeze_snapshot` — source identity columns immutable |

---
**Grand total: 43 + 12 = 55 cases**
