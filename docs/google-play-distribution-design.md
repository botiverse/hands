# Google Play distribution P0

Status: source contract. It does not authorize a deployment or a Google Play write.

## Model

Mobile CI builds once and declares exactly one signed AAB plus one signed APK
under one source commit, package, version name, and versionCode. Both objects go
to Hands first. Hands seals each object by streaming one R2 snapshot through
SHA-256 verification and an immutable final key. The parent build becomes
`ready` only after both assets are sealed.

The APK remains the Hands install carrier. Google Play promotion consumes only
the accepted AAB. CI, the CLI, and devices never receive Play credentials.
Hands calls a server-side `PLAY_RELEASE_SERVICE` binding; without that binding,
all Play writes fail closed.

P0 deliberately has no Play distribution-certificate field or gate. The only
certificate fingerprint in this contract is the CI upload-key certificate.

## Mobile artifact API

All routes use the existing Hands bearer/session authentication and app roles.

### Declare

`POST /api/apps/:appId/android-release-artifacts` requires `publisher`.

```json
{
  "source": {
    "repository": "botiverse/mobile",
    "commit_sha": "40 lowercase hex characters",
    "ci_run_id": "123456"
  },
  "package_name": "build.raft.app",
  "version_name": "1.2.3",
  "version_code": 123,
  "upload_key_cert_sha256": "64 lowercase hex characters",
  "artifacts": [
    { "kind": "aab", "filename": "raft.aab", "size_bytes": 1, "sha256": "64 lowercase hex characters" },
    { "kind": "apk", "filename": "raft.apk", "size_bytes": 1, "sha256": "64 lowercase hex characters" }
  ]
}
```

The response contains one `build_id`, two asset declarations, and one
presigned `PUT` plus `complete_url` per asset. Upload URLs and headers are
ephemeral secrets and must not be logged.

### Complete and read

- `POST /api/apps/:appId/android-release-artifacts/:buildId/assets/:assetId/complete`
  (`publisher`) hashes and seals the exact R2 stream. The caller does not
  resubmit identity fields.
- `GET /api/apps/:appId/android-release-artifacts/:buildId` (`viewer`) returns
  the shared identity and the two declarations/readbacks.

Per-asset states are `pending_upload`, `verifying`, `sealed`, or `failed`.
Parent states are `uploading`, `ready`, or `failed`.

Typed errors are `INVALID_RELEASE_ARTIFACTS`,
`ARTIFACT_UPLOAD_UNAVAILABLE`, `ARTIFACT_NOT_FOUND`, `INTEGRITY_MISMATCH`,
`IMMUTABLE_CONFLICT`, and `STATE_CONFLICT`, plus the existing authorization
errors.

## Acceptance and distribution API

- `POST /api/apps/:appId/releases/:releaseId/receipts/acceptance`
- `GET /api/apps/:appId/releases/:releaseId/receipts`
- `GET /api/apps/:appId/releases/:releaseId/distributions`
- `GET /api/apps/:appId/releases/:releaseId/distributions/play`
- `POST /api/apps/:appId/releases/:releaseId/distributions/play/promote`
- `POST /api/apps/:appId/releases/:releaseId/distributions/play/halt`
- `POST /api/apps/:appId/releases/:releaseId/distributions/play/rollback`

Reads require `viewer`; writes require `publisher`. Acceptance binds a verdict
to the exact sealed AAB and advances the release revision with compare-and-set.
Receipts are append-only at the database layer.

Promotion requires:

1. an AAB sealed to its declared SHA-256 and size;
2. the latest acceptance receipt for that exact asset is `pass` and matches
   package, source, versionCode, hash, and size;
3. requested track is `internal`, `closed`, or `production`;
4. artifact versionCode equals the live Play track maximum plus one;
5. no other edit lock exists for the app/package; there is no automatic retry;
6. no open release distribution hold;
7. an authenticated human publisher and a nonblank approval note.

The server reads track state once, reserves the release revision, streams the
exact AAB once, and compares the adapter readback package/version/track/SHA.
Only an exact match records a successful immutable receipt. Any post-reserve
error records `failed-closed` where possible. Halt and rollback remain typed
fail-closed until the server-side Play adapter explicitly implements them.

## Server-side Play adapter protocol

`PLAY_RELEASE_SERVICE` owns Google credentials. Hands makes two service-binding
requests and never sends credentials in headers or payloads:

- `GET /v1/apps/:package/tracks/:track` → `{ "max_version_code": 122 }`
- `POST /v1/apps/:package/edits` with the AAB byte stream and only public
  `x-hands-*` identity headers → exact readback `{edit_id, package_name,
  version_code, track, sha256, rollout_percent}`.

No call is retried automatically. Adapter absence, non-2xx, or malformed/mismatched
readback is a typed `play_api_error` and never becomes success.

## Non-goals

- no Play credentials, signing, or production promotion in this change;
- no store listing automation, review replies, or crash/ANR threshold gate;
- no Play distribution-certificate storage or gating;
- no inclusion of Play artifacts in Hands alpha/delta updates.
