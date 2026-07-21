# iOS releases & TestFlight

How a Raft iOS build travels from CI to TestFlight. The key fact: **Hands
uploads to Apple server-side** — the App Store Connect credential lives
encrypted in Hands, and the `.p8` key never leaves it. CI does not need Apple
upload credentials, and nobody runs `altool`.

## The flow

```
iOS Release workflow          Hands                          Apple
────────────────────          ─────                          ─────
build + sign IPA  ──────────▶ build + assets in R2
                              (publish_hands=true)
                              testflight-upload  ───────────▶ Build Upload API
                              (streams IPA from R2)           PROCESSING → COMPLETE
                              testflight-publish ───────────▶ VALID build
                              groups + What to Test           internal testing, or
                              beta review + notify            external Beta Review
```

1. **Build + sign + publish** — dispatch the `iOS Release` workflow
   (botiverse/mobile) with `publish_hands=true`. It builds, signs with the
   distribution certificate, and uploads the IPA + dSYM to Hands as a build
   (usually with a draft release).
2. **Upload to TestFlight** — trigger the server-side upload for that build:

   ```
   POST /api/apps/{app_id}/builds/{build_id}/testflight-upload
   ```

   Hands streams the IPA from R2 straight to Apple's Build Upload API
   (create → register file → part PUTs → commit) and returns the initial
   state. Console: the build row's TestFlight action.
3. **Poll upload processing** —

   ```
   GET /api/apps/{app_id}/testflight-uploads/{build_upload_id}
   ```

   Read the nested `state.state` field:
   `AWAITING_UPLOAD → PROCESSING → COMPLETE | FAILED`; the same object retains
   Apple's errors, warnings, and infos. `COMPLETE` means Apple accepted the
   upload transaction; wait until the corresponding build resource reports
   `processingState=VALID` before distribution.
4. **List beta groups** — use the processed Hands build to resolve the exact
   App Store Connect app and list stable group ids:

   ```
   GET /api/apps/{app_id}/builds/{build_id}/testflight-groups
   ```

5. **Publish to TestFlight** — assign the exact processed build to groups and
   write localized What to Test metadata:

   ```
   POST /api/apps/{app_id}/builds/{build_id}/testflight-publish
   {
     "distribution": "internal",
     "group_ids": ["<asc-beta-group-id>"],
     "what_to_test": {
       "en-US": "Verify login and Activity.",
       "zh-Hans": "验证登录和活动页。"
     },
     "notify_testers": false
   }
   ```

   Internal mode adds only internal groups. External mode adds only external
   groups, submits `betaAppReviewSubmissions`, and sets
   `buildBetaDetails.autoNotifyEnabled`. When an external build is already
   approved, `notify_testers=true` creates the official
   `buildBetaNotifications` resource only when automatic notification was not
   already enabled.
6. **Refresh distribution state** —

   ```
   GET /api/apps/{app_id}/builds/{build_id}/testflight-publish?distribution=external
   ```

   The response keeps Apple's raw processing, expiry, internal/external build,
   Beta App Review, auto-notify, assigned-group, and localization state. It
   distinguishes `waiting_for_review`, `in_review`, `approved_not_notified`,
   `testing`, `rejected`, `expired`, and processing failures.

These endpoints and the matching CLI/integration actions are TestFlight-only.
They never activate a Hands release and never create, submit, or release an
App Store production version.

## One-time setup (app admin)

Store the App Store Connect API credential in Hands: console → App →
Settings → TestFlight (`PUT /api/apps/{app_id}/asc-credentials`). Generate the
key in App Store Connect → Users and Access → Integrations (App Manager role);
you need the Key ID, Issuer ID, and the `.p8` file. The credential is
encrypted at rest and can be verified without exposing it
(`POST .../asc-credentials/verify`). The same credential powers the
App Store review-state surface (`GET /api/apps/{app_id}/appstore-review`).
Hands is the credential's only home — CI never needs a copy, so rotation
stays single-source.

Hands roles are intentionally split: uploading to Apple requires app admin,
distribution requires app publisher, and status/group reads require app
viewer. Apple's own role boundary still applies to the stored key: external
testing requires Account Holder, Admin, or App Manager; internal testing also
permits Developer or Marketing.

Before first external testing, App Store Connect must have the required Beta
App Description, feedback email, contact information, and export-compliance
answers. Hands fails closed and returns Apple's actionable state/error if those
prerequisites are missing. Apple allows only one build of a version in Beta App
Review at a time and up to six submitted builds in a 24-hour period.

## Versioning rules

- The **marketing version** (e.g. `1.0.0`) may repeat across uploads.
- The **build number** (`versionCode`, e.g. `1000004`) must be unique and
  ascending for that marketing version — Apple rejects reused build numbers.
  Hands build history is the quick way to see the last used code.
- TestFlight access expires 90 days after upload.
- External distribution is fail-closed: Apple must explicitly return
  `build_audience_type=APP_STORE_ELIGIBLE`. `INTERNAL_ONLY`, missing, or future
  unknown audience values are rejected before any localization, group, review,
  or notification mutation.

## CLI and Raft actions

CLI:

```sh
hands builds testflight-groups <app> <hands-build-id>
hands builds testflight-publish <app> <hands-build-id> \
  --distribution internal \
  --group-id <asc-beta-group-id> \
  --what-to-test en-US="Verify the release candidate." \
  --wait
hands builds testflight-status <app> <hands-build-id> --distribution internal
```

Raft integration actions:

- `upload-testflight-build`
- `get-testflight-upload-status`
- `list-testflight-groups`
- `publish-testflight-build`
- `get-testflight-publish-status`

Agents pass Hands app/build ids and stable beta group ids. The integration
never returns the `.p8` credential.

## Apple references

- [App Store Connect API: Prerelease Versions and Beta Testers](https://developer.apple.com/documentation/appstoreconnectapi/prerelease-versions-and-beta-testers)
- [Build Beta Notifications](https://developer.apple.com/documentation/appstoreconnectapi/build-beta-notifications)
- [Add internal testers](https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers/)
- [Invite external testers](https://developer.apple.com/help/app-store-connect/test-a-beta-version/invite-external-testers/)
- [Provide test information](https://developer.apple.com/help/app-store-connect/test-a-beta-version/provide-test-information/)
- [TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/)
