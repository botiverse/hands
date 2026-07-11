# HarmonyOS AppGallery Connect integration

Status: implementation design for Hands task #137.

## Goal

Hands should take a reviewed OHOS draft build and drive the AppGallery
Connect lifecycle without moving build signing into the server:

1. upload the already signed `.app` from Hands storage;
2. wait for Huawei package compilation and parsing;
3. publish it to invitation/public App Testing or submit it for store review;
4. mirror review, rejection, scheduled release, and phased rollout state;
5. keep every external mutation resumable, idempotent, and auditable.

CI remains responsible for source checkout, KMP/Hvigor compilation, signing,
and local package validation. Hands receives the signed `.app`, standalone
`.hap`, symbols, and metadata, then owns market delivery.

## Official capability boundary

AppGallery Connect currently exposes APIs for:

- AGC API client authentication using OAuth client credentials, with
  developer-level Service Account/PS256 support reserved as a future credential kind;
- HarmonyOS `.app` upload, including large/multipart uploads and SHA-256;
- package binding and asynchronous compile/parse status;
- invitation testing and public testing, including groups, members, invite
  codes, quotas, validity, review, stop/delete, and promotion;
- store review submission, cancellation while eligible, review/rejection
  status, scheduled release, and phased release controls;
- phased release pause, resume, acceleration, and full rollout;
- provisioning and download/install-failure reports.

The API does not create the initial AppGallery Connect app record or Service
Account. Account roles, legal/compliance onboarding, some declarations, and
final policy decisions remain manual. There is no documented historical
package rollback API; recovery is pause/cancel when allowed or a new
higher-version build.

Package processing is asynchronous. Do not use a fixed two-minute sleep:
persist the external package id and poll compile/parse status with backoff.

## Authentication and credential storage

Follow the existing `app_asc_credentials` pattern, but keep Huawei credentials
in a separate table and encryption domain.

`app_agc_credentials`:

| Column | Purpose |
|---|---|
| `id`, `app_id` | One active credential set per Hands app. |
| `service_account_id`, `key_id` | Non-secret identifiers shown in Settings. |
| `credential_ciphertext_b64`, `credential_iv_b64` | Entire AGC credential JSON encrypted with AES-GCM. |
| `credential_fingerprint` | SHA-256 fingerprint for rotation/audit, never the private key. |
| `created_by_actor`, `created_at`, `updated_at` | Audit ownership. |

Use a new Worker secret, `AGC_CRED_ENC_KEY`. Do not reuse
`ASC_CRED_ENC_KEY`, OHOS signing secrets, or a deploy token. The API only
returns metadata; decrypted credential material is scoped to the AGC client
call and must never enter operation output, logs, audit payloads, or the admin
SPA.

Settings actions:

- `PUT /api/apps/:appId/agc-credentials`
- `GET /api/apps/:appId/agc-credentials`
- `DELETE /api/apps/:appId/agc-credentials`
- `POST /api/apps/:appId/agc-credentials/verify`

The connection test mints a short-lived JWT and performs a read-only app
lookup for the configured `main` channel bundle name.

## Persistent market model

`operation_logs` is useful for progress UI, but is not sufficient as the
source of truth for a multi-hour review lifecycle. Add a provider-neutral
submission model so Apple and Huawei can eventually share status UI.

`market_submissions`:

| Column | Purpose |
|---|---|
| `id`, `app_id`, `release_id`, `build_id` | Hands ownership. |
| `provider` | `appgallery`. |
| `lane` | `invitation_test`, `public_test`, or `production`. |
| `status` | Normalized state listed below. |
| `external_app_id`, `external_package_id`, `external_test_id` | Huawei ids needed to resume. |
| `idempotency_key` | Unique hash of provider/app/build/lane/config. |
| `request_json` | Non-secret testing/release configuration. |
| `provider_state_json` | Redacted latest provider response. |
| `last_error_json`, `retry_count`, `next_poll_at` | Retry scheduling. |
| `created_by_actor`, timestamps | Audit and UI. |

Normalized status:

```text
draft
upload_url_requested
uploading
uploaded
processing
ready
testing_review
testing_active
store_review
rejected
approved
scheduled
phased
live
paused
cancelled
failed
```

Store every provider transition in `market_submission_events`; keep
`provider_state_json` as the latest snapshot. A unique `idempotency_key`
prevents double-clicks and workflow retries from creating duplicate test
versions or store submissions.

## Durable execution

Do not perform the whole publish in an HTTP request. Use a Cloudflare Workflow
per submission (or a Queue consumer until Workflows is enabled) and store the
workflow instance id on `market_submissions`.

Steps must be individually retryable:

1. load encrypted credentials and exchange the API client secret for an OAuth access token;
2. resolve the manually created AGC app by bundle name;
3. request the short-lived upload URL;
4. stream the `.app` from R2, using multipart upload when required;
5. verify the returned checksum/package id;
6. bind the package to the selected test or production version;
7. poll compile/parse status with exponential backoff and jitter;
8. apply the requested lane configuration;
9. stop at a human approval gate before test review/store review submission;
10. submit and poll review/release state until terminal or long-term waiting;
11. update Hands status, operation progress, and audit events.

Refresh the OAuth access token before expiry. A five-minute upload URL must
be reacquired if upload has not started or a retry crosses its validity
window. Provider `429` and `5xx` responses are retryable; validation, policy,
and permission errors require user action.

## App Testing flow

App Testing should ship before unattended production submission because it is
the safer first consumer of the signed package.

Invitation testing request:

```json
{
  "lane": "invitation_test",
  "groups": ["internal"],
  "valid_days": 30,
  "max_testers": 100,
  "release_notes": { "zh-CN": "...", "en-US": "..." }
}
```

Public testing adds region/quota/validity configuration. Hands stores group
and test ids, invite codes/links, quota, validity, review state, and stop time.
The UI exposes `Submit for testing review`, `Stop test`, and, when Huawei says
the test is promotable, `Promote to production/phased release`.

Test members and groups should be managed as AGC resources, not copied into
Hands org membership. Hands app admins choose which AGC group a submission
uses; it does not send Raft identities to Huawei automatically.

## Production publish flow

Production submission begins from a reviewed Hands draft release and requires
an explicit app-admin confirmation. The request chooses one of:

- `review_only`: submit for review but do not schedule release;
- `scheduled`: release at a configured UTC instant after approval;
- `phased`: begin with a configured phase and allow pause/resume/accelerate;
- `full`: full rollout after approval.

Hands draft/active state and AppGallery state are related but not identical:

- a Hands draft may be in testing or store review;
- AppGallery approval does not automatically activate the Hands release;
- activating Hands does not submit to AppGallery;
- UI presents both states and makes each mutation explicit.

This separation avoids making an internal OTA/download decision silently
change a public store submission.

## API and UI surface

Proposed APIs:

- `POST /api/apps/:appId/releases/:releaseId/agc/testing`
- `POST /api/apps/:appId/releases/:releaseId/agc/submit`
- `GET /api/apps/:appId/market-submissions`
- `GET /api/apps/:appId/market-submissions/:submissionId`
- `POST /api/apps/:appId/market-submissions/:submissionId/approve`
- `POST /api/apps/:appId/market-submissions/:submissionId/cancel`
- `POST /api/apps/:appId/market-submissions/:submissionId/pause`
- `POST /api/apps/:appId/market-submissions/:submissionId/resume`
- `POST /api/apps/:appId/market-submissions/:submissionId/full-rollout`
- `POST /api/apps/:appId/market-submissions/:submissionId/retry`

Admin adds an `AppGallery` page for OHOS apps, parallel to the iOS
`TestFlight` and `App Store` pages. It shows credential health, bundle mapping,
current test/store submission, rejection detail, operation timeline, and only
the controls allowed by the current provider state.

CLI/agent commands should call the same Hands APIs; CI must only create the
Hands draft. Market submit remains a separate reviewed action.

## Delivery plan

### P0A: foundation

- migration for encrypted AGC credentials, market submissions, and events;
- API client OAuth exchange and read-only connection test;
- AppGallery page with credential configuration and app/bundle resolution;
- provider-neutral operation kinds and status polling.

### P0B: invitation testing

- `.app` upload from R2, checksum verification, package bind, parse polling;
- invitation-test creation, group selection, review submit/status, stop;
- durable retries, idempotency, audit logs, and CLI/agent actions.

### P0C: production review

- production version bind and explicit review submission;
- review/rejection/status sync and cancellation where Huawei permits it;
- scheduled and full release after an explicit approval gate.

### P1: public/phased release

- public testing, quotas, validity, promotion;
- phased rollout pause/resume/accelerate/full;
- localized listing/release-note sync and install-failure reports;
- credential/profile expiry visibility.

## Acceptance criteria

- repeated trigger with the same idempotency key creates one AGC submission;
- Worker restart/redeploy does not lose upload/parse/review progress;
- raw AGC credentials and access tokens never appear in API responses or logs;
- a signed Hands `.app` is uploaded without buffering the whole file in D1;
- parse polling handles success, Huawei validation failure, timeout, and retry;
- testing and production submission require separate explicit approval;
- review rejection details are visible and auditable;
- phased release controls are only enabled in compatible provider states;
- every external mutation records actor, request intent, provider id, and result;
- integration tests use a fake AGC server; a real sandbox/app test proves one
  invitation test before production submission is enabled.

## Official references

- API overview: <https://developer.huawei.com/consumer/cn/doc/app/agc-help-connect-api-introduction-0000002270974725>
- Service Account authentication: <https://developer.huawei.com/consumer/cn/doc/app/agc-help-connect-api-obtain-server-auth-0000002271134661>
- Upload Management: <https://developer.huawei.com/consumer/cn/doc/app/agc-help-upload-api-guide-0000002271160549>
- Publishing: <https://developer.huawei.com/consumer/cn/doc/app/agc-help-publish-api-guide-0000002271134665>
- Submit for release: <https://developer.huawei.com/consumer/cn/doc/app/agc-help-publish-api-app-submit-0000002271160585>
- Phased release: <https://developer.huawei.com/consumer/cn/doc/app/agc-help-publish-api-phased-release-0000002271000625>
- App Testing: <https://developer.huawei.com/consumer/cn/doc/app/agc-help-test-api-guide-0000002236015562>
- Provisioning: <https://developer.huawei.com/consumer/cn/doc/app/agc-help-provision-api-guide-0000002271000601>
- Reports: <https://developer.huawei.com/consumer/cn/doc/app/agc-help-report-api-guide-0000002271134669>
