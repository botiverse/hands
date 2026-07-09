# iOS distribution and TestFlight spec

Status: draft spec for review
Owner: Codex-Android-DevOPS
Updated: 2026-07-09

Official references:

- Apple App Store Connect Help: [Upload builds](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds/)

Hands should treat iOS as a first-class product type. The platform should know
when an app ships iOS artifacts, collect the right release assets, track
TestFlight state, and guide CI through signing/upload. It should not treat
Apple credentials as ordinary release attachments.

The recommended lane is:

1. macOS CI builds and signs the app.
2. CI uploads `.ipa`, `.dSYM.zip`, and build metadata to Hands as an immutable
   build record.
3. CI uploads the same signed `.ipa` to App Store Connect / TestFlight.
4. CI or a poller writes TestFlight processing/distribution status back to
   Hands.
5. Hands remains the release system of record; Apple remains the iOS
   distribution system.

## Goals

- Let an app declare an iOS product type and see iOS-specific release fields.
- Store iOS build artifacts and diagnostics assets in the normal build/release
  model.
- Manage TestFlight distribution configuration in Hands without exposing raw
  Apple secrets.
- Support automated internal TestFlight uploads from CI.
- Leave room for external TestFlight review, ad-hoc OTA, and enterprise OTA
  without forcing those into the first implementation.

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

- `ASC_KEY_ID`
- `ASC_ISSUER_ID`
- `ASC_PRIVATE_KEY_P8`
- `IOS_DIST_CERT_P12`
- `IOS_DIST_CERT_PASSWORD`
- `IOS_PROVISIONING_PROFILE`
- `HANDS_BEARER_TOKEN` or app deploy token

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
9. Upload `.ipa` to App Store Connect with Apple-supported upload tooling:
   Xcode Organizer, `altool`, or Transporter. In CI, prefer Transporter with
   App Store Connect API authentication, or fastlane `pilot` as a maintained
   wrapper around the Apple upload path.
10. Poll App Store Connect until processing is complete or times out.
11. Add selected internal tester groups.
12. Write TestFlight state back to Hands.
13. Leave final public release/publish decision under the same draft-first
    release governance as other platforms.

Internal TestFlight groups can usually be automated. External TestFlight may
require beta review and should be represented as `waiting_for_review`,
`in_review`, `approved`, or `rejected`.

## API surface

Minimal API additions:

```text
GET    /api/apps/:appId/ios/distribution-profiles
POST   /api/apps/:appId/ios/distribution-profiles
PATCH  /api/apps/:appId/ios/distribution-profiles/:profileId
DELETE /api/apps/:appId/ios/distribution-profiles/:profileId

POST   /api/apps/:appId/builds/:buildId/testflight
GET    /api/apps/:appId/builds/:buildId/testflight
PATCH  /api/apps/:appId/builds/:buildId/testflight
```

`POST /testflight` should not upload to Apple directly from the Worker. It
should create a requested operation or accept CI-reported state. The actual
upload runs in CI where Xcode and Apple credentials are available.

Suggested TestFlight state:

```json
{
  "provider": "app-store-connect",
  "app_store_connect_app_id": "1234567890",
  "app_store_connect_build_id": "abcdef",
  "version": "1.2.3",
  "build_number": "456",
  "processing_status": "processing|processed|failed|timeout",
  "internal_distribution_status": "not_started|distributed|failed",
  "external_review_status": "not_submitted|waiting_for_review|in_review|approved|rejected",
  "groups": ["Internal QA"],
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

- Never store Apple private keys, `.p8`, `.p12`, profile content, or passwords
  in D1.
- Never log secret values or raw `ExportOptions.plist` with embedded sensitive
  paths/tokens.
- Redact secret-shaped values in CI logs.
- Prefer GitHub Environment protection for iOS release secrets.
- Keep distribution-profile edit permissions at app admin or org admin level.
- Treat `.ipa` public downloads as policy-controlled. TestFlight-only releases
  should not expose the IPA by default.
- Store dSYM assets as private support artifacts.

## Phasing

### Phase 1: TestFlight bookkeeping and spec-visible UI

- Seed/support `ios-ipa`.
- Add iOS distribution profile model with secret references.
- Add admin UI for profile references.
- Add TestFlight state fields on builds/releases.
- Add CI adapter docs and a sample GitHub Actions workflow.

### Phase 2: CI upload adapter

- Add `hands builds publish-ios-testflight` or equivalent CI command.
- Upload IPA/dSYM to Hands.
- Upload to TestFlight from macOS CI.
- Write App Store Connect state back to Hands.

### Phase 3: IPA parsing and dSYM symbolication integration

- Implement `ipa-info` parser.
- Connect dSYM uploads to the symbolication matrix.
- Show iOS build metadata and crash symbolication readiness in admin UI.

### Phase 4: Ad-hoc / enterprise OTA, if needed

For machines and smoke devices, ad-hoc OTA may still be useful:

- device UDID capture via `.mobileconfig`
- device registry/export
- OTA manifest endpoint:
  `itms-services://?action=download-manifest&url=<manifest-url>`
- share page detects iOS and offers install link when channel policy allows it

Enterprise OTA is only viable if the organization already qualifies for Apple
Developer Enterprise Program. Do not design the default flow around it.

## Open questions

- Which GitHub Environment should hold iOS release secrets?
- Do we require fastlane for the first adapter, or do we implement a pure
  Xcode/Transporter path first?
- Should Hands create GitHub workflow dispatches, or should mobile repos call
  Hands after their own build completes?
- Should TestFlight external groups be platform-managed, or should Hands only
  track their state?
- How long should IPA archive retention be for TestFlight-only releases?
