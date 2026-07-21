# iOS distribution and TestFlight spec

Status: implemented baseline; follow-up design remains below
Owner: Codex-Android-DevOPS
Updated: 2026-07-21

Official references:

- Apple App Store Connect Help: [Upload builds](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds/)
- Apple App Store Connect API: [Prerelease Versions and Beta Testers](https://developer.apple.com/documentation/appstoreconnectapi/prerelease-versions-and-beta-testers)
- Apple Help: [Add internal testers](https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers/)
- Apple Help: [Invite external testers](https://developer.apple.com/help/app-store-connect/test-a-beta-version/invite-external-testers/)
- Apple Help: [TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/)

Hands should treat iOS as a first-class product type. The platform should know
when an app ships iOS artifacts, collect the right release assets, track
TestFlight state, and guide CI through signing/upload. It should not treat
Apple credentials as ordinary release attachments.

The recommended lane is:

1. macOS CI builds and signs the app.
2. CI uploads `.ipa`, `.dSYM.zip`, and build metadata to Hands as an immutable
   build record.
3. Hands streams that same immutable `.ipa` to Apple's Build Upload API using
   the app's encrypted server-side ASC credential.
4. Hands resolves the processed build, assigns selected beta groups, writes
   localized What to Test text, submits external Beta App Review when needed,
   and synchronizes Apple state.
5. Hands remains the release system of record; Apple remains the iOS
   distribution system.

## Goals

- Let an app declare an iOS product type and see iOS-specific release fields.
- Store iOS build artifacts and diagnostics assets in the normal build/release
  model.
- Manage TestFlight distribution configuration in Hands without exposing raw
  Apple secrets.
- Support internal and external TestFlight distribution without exporting ASC
  credentials to CI or agents.
- Leave room for ad-hoc OTA and enterprise OTA without conflating either with
  TestFlight or App Store production publishing.

## Non-goals

- Hands does not replace App Store Connect or TestFlight for App Store-style
  distribution.
- Hands does not expose Apple private keys, certificates, profiles, or `.p8`
  files in normal release pages.
- Hands does not perform signing inside Cloudflare Workers. iOS signing needs
  macOS/Xcode tooling and should run in CI or a trusted signing service.
- Hands does not assume Apple Enterprise Program eligibility.

## Product model

Seed or support product type:

```text
name: ios-ipa
display_name: iOS app
parser_kind: ipa-info
default_assets:
  - platform: ios
    filetype: ipa
  - platform: ios
    filetype: dsym.zip
```

An iOS build should capture:

- `bundle_id`: `CFBundleIdentifier`
- `version_name`: `CFBundleShortVersionString`
- `version_code`: numeric representation of `CFBundleVersion` where possible,
  with original build number preserved in metadata
- `minimum_os_version`: `MinimumOSVersion`
- `team_id`
- signing identity summary, not private key material
- App Store Connect app id and TestFlight build id, once known
- processing state, tester-group distribution state, and external beta review
  state, once known

## Artifact model

Release artifacts:

| Asset | Stored in Hands | Publicly downloadable | Purpose |
|---|---:|---:|---|
| `.ipa` | yes | optional | Archive, ad-hoc/enterprise OTA, diagnostics |
| `.dSYM.zip` | yes | no | Crash symbolication |
| `ExportOptions.plist` summary | metadata only | no | Debugging CI export behavior |
| App Store Connect processing response | metadata only | no | TestFlight status tracking |
| Apple certificate / `.p12` | no | no | Secret material |
| Provisioning profile | reference only by default | no | Secret/sensitive signing material |
| App Store Connect `.p8` key | no | no | Secret material |

`.ipa` files may be downloadable only when the app/channel policy permits it.
For TestFlight-only releases, the primary user action is not “Download IPA”; it
is “Open TestFlight” or “View App Store Connect build”.

## Distribution profiles

Add a first-class iOS distribution profile concept. A distribution profile is
not a raw credential record; it is a configuration object plus references to
where secrets live.

Suggested fields:

```text
ios_distribution_profiles
  id
  org_id
  app_id nullable
  name
  bundle_id
  apple_team_id
  app_store_connect_app_id nullable
  signing_mode                -- manual | xcode-managed | match | external
  distribution_method         -- testflight | ad-hoc | enterprise
  github_environment nullable -- e.g. ios-release
  secret_refs_json            -- names only, never values
  testflight_groups_json      -- ["Internal", "QA"]
  external_testing_enabled
  created_at
  updated_at
```

`secret_refs_json` should store names and providers, for example:

```json
{
  "provider": "github-actions",
  "environment": "ios-release",
  "app_store_connect_key_id": "ASC_KEY_ID",
  "app_store_connect_issuer_id": "ASC_ISSUER_ID",
  "app_store_connect_private_key": "ASC_PRIVATE_KEY_P8",
  "signing_certificate_p12": "IOS_DIST_CERT_P12",
  "signing_certificate_password": "IOS_DIST_CERT_PASSWORD",
  "provisioning_profile": "IOS_PROVISIONING_PROFILE"
}
```

Hands may validate that required secret references are configured by asking the
CI provider or by running a dry-run workflow. It must not store or display the
secret values in D1, logs, public docs, or messages.

## Admin UX

### App settings

When an app supports `ios-ipa`, show an **iOS Distribution** settings section:

- Bundle ID
- Apple Team ID
- App Store Connect App ID
- Distribution method: TestFlight, ad-hoc OTA, enterprise OTA
- Signing mode: manual secrets, Xcode managed, fastlane match, external CI
- GitHub Environment / secret reference names
- TestFlight groups
- External testing enabled flag

The save action persists references and non-secret metadata only.

### New release / build view

When product type is `ios-ipa`, show iOS-specific fields:

- IPA asset
- dSYM asset
- Bundle ID
- Version / build number
- TestFlight upload status
- TestFlight processing status
- Internal groups distributed to
- External beta review status
- App Store Connect build link

If the release has no distribution profile, the UI should block “Upload to
TestFlight” and show a setup action, while still allowing `.ipa` archive upload
if the user has publisher/admin permissions.

## CI adapter

The first supported automation should be GitHub Actions on macOS.

Inputs:

- app slug
- channel
- release type
- version / build number
- distribution profile id
- changelog source
- TestFlight group selection

Required CI secrets depend on signing mode. For the manual-secrets mode:

- `IOS_DIST_CERT_P12`
- `IOS_DIST_CERT_PASSWORD`
- `IOS_PROVISIONING_PROFILE`
- `HANDS_BEARER_TOKEN` or app deploy token

The App Store Connect Key ID, Issuer ID, and `.p8` are configured once in
Hands App Settings. Hands encrypts them server-side; CI and Raft agents never
receive the key.

Workflow:

1. Checkout source.
2. Select Xcode.
3. Install signing certificate and provisioning profile into a temporary
   keychain.
4. `xcodebuild archive`.
5. `xcodebuild -exportArchive` to produce `.ipa`.
6. Zip dSYMs.
7. Create or update Hands build record with source metadata.
8. Upload the signed `.ipa` and `.dSYM.zip` to Hands, for example:
   ```sh
   hands builds publish-ios --ipa build/App.ipa --dsym build/App.dSYM.zip --draft
   ```
9. An authorized app admin invokes Hands `testflight-upload`; the Worker
   streams the exact stored IPA to Apple's official Build Upload API.
10. Poll the returned Build Upload id to
    `state.state=COMPLETE|FAILED`, then resolve the exact app/version/build
    tuple until the ASC build is `VALID`.
11. List stable beta group ids and invoke `testflight-publish` with an explicit
    `internal|external` mode, selected group ids, localized What to Test text,
    and an opt-in notification flag.
12. For external groups, submit Beta App Review and track
    `WAITING_FOR_REVIEW|IN_REVIEW|APPROVED|REJECTED`; notify automatically after
    approval or send the official build notification for an already-approved
    build.
13. Leave final public release/publish decision under the same draft-first
    release governance as other platforms.

Internal TestFlight groups can usually be automated. External TestFlight may
require beta review and should be represented as `waiting_for_review`,
`in_review`, `approved`, or `rejected`.

## API surface

Current TestFlight API:

```text
POST   /api/apps/:appId/builds/:buildId/testflight-upload
GET    /api/apps/:appId/testflight-uploads/:buildUploadId
GET    /api/apps/:appId/builds/:buildId/testflight-groups
POST   /api/apps/:appId/builds/:buildId/testflight-publish
GET    /api/apps/:appId/builds/:buildId/testflight-publish
```

The Worker is the upload/distribution boundary because it already owns the
encrypted ASC API credential and immutable Hands IPA. CI owns signing, but it
does not need upload credentials. Every mutation writes an operation/audit
record with provider ids and states, never credential material.

Suggested TestFlight state:

```json
{
  "provider": "app-store-connect",
  "app_store_connect_app_id": "1234567890",
  "app_store_connect_build_id": "abcdef",
  "version": "1.2.3",
  "build_number": "456",
  "processing_state": "PROCESSING|VALID|FAILED|INVALID",
  "internal_build_state": "READY_FOR_BETA_TESTING|IN_BETA_TESTING|...",
  "external_build_state": "READY_FOR_BETA_SUBMISSION|WAITING_FOR_BETA_REVIEW|IN_BETA_REVIEW|BETA_APPROVED|IN_BETA_TESTING|...",
  "external_review_status": "WAITING_FOR_REVIEW|IN_REVIEW|APPROVED|REJECTED",
  "groups": [{"id":"...","name":"Internal QA","is_internal":true}],
  "localizations": [{"locale":"en-US","whats_new":"Verify login"}],
  "auto_notify_enabled": false,
  "expiration_date": "2026-10-19T00:00:00Z",
  "build_url": "https://appstoreconnect.apple.com/...",
  "updated_at": "2026-07-09T00:00:00Z"
}
```

## Parser requirements

`ipa-info` parser should:

- unzip the IPA
- find `Payload/*.app/Info.plist`
- parse binary or XML plist
- extract bundle id, display name, version, build number, minimum OS
- detect embedded provisioning profile metadata if present, without storing raw
  profile content as public metadata
- optionally extract an app icon only when available as a normal PNG; skip
  `Assets.car` extraction in MVP

## Security requirements

- Store the App Store Connect `.p8` only as authenticated encrypted ciphertext;
  never return plaintext after the write request. Keep signing `.p12`, profile
  content, and passwords outside Hands in the CI signing boundary.
- Never log secret values or raw `ExportOptions.plist` with embedded sensitive
  paths/tokens.
- Redact secret-shaped values in CI logs.
- Prefer GitHub Environment protection for iOS release secrets.
- Keep distribution-profile edit permissions at app admin or org admin level.
- Treat `.ipa` public downloads as policy-controlled. TestFlight-only releases
  should not expose the IPA by default.
- Store dSYM assets as private support artifacts.

## Phasing

### Implemented: Hands build, upload, and TestFlight distribution

- `ios-ipa` build plus private dSYM support asset.
- Encrypted per-app ASC credential with verify/rotate/delete controls.
- Official server-side Build Upload API and processing polling.
- Stable internal/external beta group discovery.
- Localized What to Test upsert, group assignment, external Beta App Review,
  automatic/manual tester notification, and live state synchronization.
- CLI and Raft integration actions that accept Hands build/group ids without
  exposing Apple credentials.

### Follow-up: IPA parsing and dSYM symbolication integration

- Implement `ipa-info` parser.
- Connect dSYM uploads to the symbolication matrix.
- Show iOS build metadata and crash symbolication readiness in admin UI.

### Follow-up: Ad-hoc / enterprise OTA, if needed

For machines and smoke devices, ad-hoc OTA may still be useful:

- device UDID capture via `.mobileconfig`
- device registry/export
- OTA manifest endpoint:
  `itms-services://?action=download-manifest&url=<manifest-url>`
- share page detects iOS and offers install link when channel policy allows it

Enterprise OTA is only viable if the organization already qualifies for Apple
Developer Enterprise Program. Do not design the default flow around it.

## Open questions

- Should Hands create GitHub workflow dispatches, or should mobile repos call
  Hands after their own build completes?
- How long should IPA archive retention be for TestFlight-only releases?
