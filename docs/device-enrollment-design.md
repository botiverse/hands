# Android test-device enrollment and reinstall rebind

## Decision

Hands keeps two deliberately separate identities:

- `device_id` is the Android SDK's random **per-installation** UUID. It remains
  the only identity accepted by public update checks, percentage rollout,
  device-group resolution, feature flags, feedback, and analytics. Uninstall or
  clear-data may rotate it.
- a device enrollment is a private, authenticated, app-scoped **operator
  alias** for one physical QA/test device. It lets a publisher replace the
  current per-installation UUID in exact targeting without deriving or storing
  IMEI, serial, `ANDROID_ID`, advertising ID, or another permanent hardware
  fingerprint.

This preserves rollout privacy and bucketing semantics while making a managed
test slot survive the expected installation-id rotation.

## Data model

`device_enrollments` stores the stable alias, optional human label, current
installation id, `active|revoked` state, and monotonically increasing revision.
An app has at most one live enrollment for a given current installation id.

`device_enrollment_operations` is an immutable receipt ledger. Create, rebind,
and revoke all require a caller-held app-scoped `operation_id`; rebind and
revoke also require `expected_revision`. A retry with the same exact input
returns the original receipt; reusing the operation id with different input
fails closed.

The migration adds pre-insert triggers for rebind/revoke receipts. Because D1
provides atomic `batch()` rather than an interactive transaction, the trigger
is the transaction guard: it checks app, enrollment, active state, current id,
and revision before any group or feature-flag statement can commit. A stale or
revoked request aborts the entire batch.

## Rebind transaction

For active enrollment `E(revision=N, current=old)` and request
`(new, expected_revision=N, operation_id=K)`, one D1 batch:

1. inserts the immutable operation receipt; the trigger validates the exact
   current witness;
2. copies each app-scoped device-group membership from `old` to `new`, merging
   an already-present target row without creating duplicate membership;
3. removes every app-scoped `old` membership;
4. replaces and de-duplicates `old` in both `allow_device_ids` and
   `deny_device_ids` for every app feature flag, preserving other values and
   platform/cohort/default/rollout configuration;
5. moves the enrollment to `new`, increments its revision, and records actor and
   rebind time;
6. writes an app audit entry bound to the operation id.

Readers observe either the complete old state or complete new state. The public
resolver never sees an alias or an intermediate targeting gap.

## Revocation transaction

Revocation uses the same witness and receipt guard. It removes the current id
from all app device groups and feature-flag allow/deny arrays, clears the live
id from the enrollment, marks it revoked, increments revision, and writes the
audit record atomically. A revoked alias cannot be rebound; create a new alias
if the operator intentionally starts a new managed lifecycle.

Historical operation/audit rows retain the old installation ids for operator
accountability under the existing app-audit retention policy. They are
authenticated metadata and never appear in public update responses.

## Authentication and authority

All enrollment endpoints use the existing app `publisher` role/deploy-token
permission and authoritatively reject non-Android apps. Create and rebind accept
only the canonical lower-case UUIDv4 shape produced by `HandsDeviceId`; direct
legacy group members remain compatible. There is no anonymous enrollment token and no client-side ability
to self-select a group. The app SDK continues to submit only its current random
installation id. An operator obtains the replacement id from an authenticated
test workflow (for example, the app's feedback receipt), then explicitly
rebinds the alias.

## Backup, uninstall, and privacy contract

- cover-install: app-private data normally remains, so `device_id` remains;
- uninstall/clear-data: the id rotates unless Android happens to restore app
  data;
- Auto Backup/OEM restore: opportunistic only, never an identity guarantee;
- enrollment create/rebind rejects values outside the SDK UUIDv4 contract, so
  serial, IMEI, `ANDROID_ID`, and arbitrary long-lived strings cannot enter the
  enrollment/operation/audit tables through any Console, CLI, or Agent route;
- aliases are app-scoped, revocable, and invisible to public clients;
- normal production percentage rollout continues to hash the random
  per-installation id, not the stable test alias.

## Deployment and rollback

The migration and Worker/Admin/CLI behavior ship together. Applying the
migration alone is inert: no existing group member or flag changes, and no
enrollment is backfilled without operator intent. Existing direct
`device_group_members` remain supported.

Rollback of application code is safe after the additive migration: old code
ignores the new tables, while current raw installation-id memberships remain
valid. Do not drop the enrollment/receipt tables during rollback. Re-enabling
the feature later resumes from the stored revision and receipt history.

This source change does not itself deploy production, create an enrollment,
rebind a device, modify a release, or change a feature flag.
