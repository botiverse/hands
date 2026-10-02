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
error `INSUFFICIENT_APP_ROLE`.

## Acceptance and distribution API

- `POST /api/apps/:appId/releases/:releaseId/receipts/acceptance`
- `GET /api/apps/:appId/releases/:releaseId/receipts`
- `GET /api/apps/:appId/releases/:releaseId/distributions`
- `GET /api/apps/:appId/releases/:releaseId/distributions/play`
- `POST /api/apps/:appId/releases/:releaseId/distributions/play/promote`
- `POST /api/apps/:appId/releases/:releaseId/distributions/play/halt`
- `POST /api/apps/:appId/releases/:releaseId/distributions/play/rollback`

Rollback input includes `expected_revision`, human `approval.note`, and a
positive `to_version_code`. P0 validates that public request shape and then
returns the typed fail-closed adapter-not-implemented result without a Play
write.

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

Each Android app has an owner-managed Google Play binding. Hands encrypts the
service-account JSON or a Google OAuth refresh credential with an app-bound AES-GCM keyring, stores only ciphertext,
and exposes only non-secret metadata to the admin UI. Binding or re-enabling an
app first validates OAuth, package access, and all configured tracks with a
temporary edit that is deleted without commit.

`PLAY_RELEASE_SERVICE` is a private, stateless RPC Worker. Hands decrypts only
the selected app binding and transfers it directly through the private service
binding together with typed operation input:

- `verifyBinding({credential, packageName, tracks})` validates the app binding;
- `readTrackMaximum({credential, packageName, tracks, handsTrack})` returns the
  live maximum versionCode;
- `promote(input, aabStream)` transfers the AAB stream and returns exact
  `{edit_id, package_name, version_code, track, sha256, rollout_percent}`.

No call is retried automatically. Adapter absence, non-2xx, or malformed/mismatched
readback is a typed `play_api_error` and never becomes success.

The adapter is the `play-adapter/` Worker. It has no public route, `workers.dev`
hostname, preview URL, global Google credential, package allowlist, or global
track mapping. Package and track scope comes only from the authenticated app's
encrypted binding. Neither Worker returns or logs private credential material.

Each mutation creates one Google edit, streams the AAB without buffering it,
compares both the local SHA-256 and Google's bundle SHA-256/versionCode, reads
the live track again inside that edit, preserves its active releases, updates
the requested release, and commits once with
`changesInReviewBehavior=ERROR_IF_IN_REVIEW`. A fresh edit verifies the committed
track before the adapter returns success. Pre-commit failures delete the edit;
an ambiguous commit outcome is not retried or deleted. Partial rollout is
allowed only for `production`; internal and closed-test promotion is 100%.

## Non-goals

- no credential values in source, signing, deployment, or production Play write
  performed by this source change;
- no store listing automation, review replies, or crash/ANR threshold gate;
- no Play distribution-certificate storage or gating;
- no inclusion of Play artifacts in Hands alpha/delta updates.

## Google user authorization

Human app administrators can use Settings → Google Play → Authorize with Google
instead of creating a service-account key. The selected Google account needs
Play Console access to the exact package and all configured tracks. This does
not change any organization policy governing service-account key creation.

POST /api/apps/{appId}/google-play-oauth/start accepts only package_name and
tracks. It creates a ten-minute authorization with S256 PKCE, hashed state and
an encrypted verifier, bound to the session-authenticated human and effective
app administrator. The browser uses Google's consent page with androidpublisher,
openid and email scopes and offline access. The fixed callback is
/api/google-play/oauth/callback on BUSINESS_ORIGIN.

The callback must use the same authenticated Hands identity. Browser login uses
a Bearer session stored locally; initiation bridges the Google redirect with a
ten-minute HttpOnly, SameSite=Lax cookie scoped only to this callback path and
authorization. The configured business parent domain shares it with the dashboard
subdomain; unrelated hosts are rejected. That cookie is never accepted on other API routes, and session
expiry/revocation still applies. The callback clears it. It restores the
organization identity selected at initiation and checks app administrator
permission again. State is claimed once before contacting Google. Partial
consent, missing refresh tokens, unverified email, expired authorization and
failed package/track checks cannot produce a binding. Saving also checks that
the existing binding has not changed and that disconnect has not cancelled the
authorization. Pending consumed state contains no Google tokens and expires
after ten minutes; expired rows are removed at the next authorization start.

The private adapter accepts a typed authorized_user credential and exchanges
the refresh token at Google's fixed token endpoint for each operation. Tokens
and Google error bodies are never included in responses or adapter logs.
Invalid grants require reconnecting. Existing service-account bindings retain
their behavior. Promotion still requires the existing human approval and
artifact acceptance gates.

Unbind deletes the encrypted credential and pending authorization for this app.
It does not revoke the Google-wide grant: revoking that grant could affect
other apps connected with the same Google account and OAuth client. The UI links
to Google Account connections for a deliberate grant revocation.

### Operator setup

1. Enable the Google Play Android Developer API in the Google Cloud project.
2. Configure Google Auth Platform branding, audience and consent, including the
   androidpublisher, openid and email scopes. An external app in testing needs
   the intended authorizer listed as a test user; test refresh credentials may
   expire. Use the appropriate production consent configuration before relying
   on unattended publication.
3. Create an OAuth client of type Web application. For production Hands,
   register the exact authorized redirect URI
   https://hands.build/api/google-play/oauth/callback. Other installations must
   register their exact BUSINESS_ORIGIN plus the same path.
4. Store the client ID and client secret in GitHub Actions secrets
   HANDS_GOOGLE_PLAY_OAUTH_CLIENT_ID and HANDS_GOOGLE_PLAY_OAUTH_CLIENT_SECRET.
   The existing deployment writes them as Worker secrets; never put the secret
   in a browser bundle, repository, message or build log.
5. Configure and deploy the private Play adapter, PLAY_CRED_ENC_KEYS and
   HANDS_PLAY_CRED_ENC_ACTIVE_KEY_VERSION using the existing deployment path.
   Deploy the adapter before the business Worker so OAuth credentials are
   supported before the new authorization entry becomes available.
6. Apply the additive OAuth migration with the normal reviewed deployment.
   Then sign in to Hands as a human app administrator and authorize using a
   Google account with the package permissions. Test connection before asking
   for any actual Play publication.

An absent client configuration leaves the OAuth button disabled. OAuth setup
does not permit publishing an unsigned AAB or bypass Play Console's application
setup and signing requirements. Rotating or removing a Google OAuth client may
require reconnecting existing bindings; previously stored credentials remain
encrypted under the app vault's versioned keys.

Official setup and protocol references:
[Google Play OAuth clients](https://developers.google.com/android-publisher/getting_started#use_oauth_clients),
[Google server-side OAuth](https://developers.google.com/identity/protocols/oauth2/web-server).
