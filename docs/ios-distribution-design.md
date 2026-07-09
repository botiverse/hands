# iOS distribution lane — design (task #70)

Status: design for review · Owner: CC-Quiver-Owner · 2026-07-04

Raft mobile already has iOS shared targets; once an iOS app exists we need a
distribution story. Unlike Android, Apple gates everything on signing
identity, so the plan is phased by which Apple program we hold.

## 0. Decision needed first (artin)

| Question | Why it matters |
|---|---|
| Do we have an Apple Developer Program account ($99/yr)? | Required for everything below. |
| Do we want the Apple Developer **Enterprise** Program ($299/yr, DUNS, strict review)? | Only path to UDID-free in-house OTA installs. Hard to get since 2020; many orgs are rejected. |
| Is TestFlight acceptable for testers? | If yes, phases 2–3 shrink a lot. |

Recommendation: **TestFlight for humans, ad-hoc OTA via Hands for
machines/CI smoke devices.** Enterprise only if we already qualify.

## 1. Phase 1 — ipa hosting + OTA install (ad-hoc / enterprise signed)

What Hands needs regardless of program:

- **Product type `ios-ipa`** (schema already supports product types; seed it).
- **Container parser**: unzip ipa → `Payload/*.app/Info.plist` (binary plist →
  need a plist parser lib) → `CFBundleIdentifier`, `CFBundleShortVersionString`,
  `CFBundleVersion`, min OS. Icon: prefer `AppIcon60x60@3x.png` style files in
  the payload (pre-Assets.car apps); Assets.car extraction is out of scope
  (needs private tooling) — fall back to app-level icon.
- **OTA manifest endpoint**: `GET /apps/:slug/releases/:id/manifest.plist` —
  XML plist with `software-package` URL (signed R2 link), bundle id, version,
  display name. Install links use
  `itms-services://?action=download-manifest&url=<https manifest URL>`.
  HTTPS is mandatory (we have it). Manifest URL itself must be reachable by
  the device at install time → manifest served directly (no expiring
  signature on the manifest route; the package URL inside it is signed
  per-request).
- **Share page / history page**: detect iOS UA → the Download button becomes
  “Install” with the itms-services link; Android keeps the APK link.

## 2. Phase 2 — UDID capture + device registry (ad-hoc lane)

Ad-hoc profiles require each device UDID in the provisioning profile
(100 devices/type/year cap).

- **`devices` table**: id, app_id (nullable = org-wide), udid, name, model,
  ios_version, registered_by page token, created_at.
- **Capture flow** (same as Pgyer/Zealot): `/apps/:slug/register-device`
  serves a `.mobileconfig` (unsigned is fine; Settings shows “unverified”)
  whose payload asks the device for UDID/PRODUCT/VERSION and POSTs to our
  callback URL; callback stores the row and redirects to a “registered,
  tell the admin” page.
- **Admin Devices tab**: list/export UDIDs (copy-paste into the Apple
  developer portal or feed fastlane `register_devices`).
- **Re-provisioning**: after adding UDIDs, the app must be re-signed with the
  updated profile. CI job (macOS runner) with `fastlane sigh`/`match`-style
  secrets: cert (.p12) + profile, or App Store Connect API key. Hands just
  hosts the resulting ipa; re-sign automation is a mobile-repo workflow.

## 3. Phase 3 — TestFlight lane (parallel, recommended for humans)

- CI (macOS runner) builds + uploads via App Store Connect API key
  (`fastlane pilot` / `xcrun altool` successor `notarytool`-era APIs).
- Hands's role is bookkeeping only: record the build/version + TestFlight
  link on the release (new optional `external_url` on releases), so the
  release timeline stays single-source in Hands even when Apple hosts the
  binary.

## 4. What we explicitly skip

- Assets.car icon extraction (private format churn).
- On-device resigning services (legal/ToS risk).
- Enterprise program assumption — decide only if artin confirms eligibility.

## 5. Effort estimate

| Piece | Size |
|---|---|
| ios-ipa product type + parser (plist) | 1–2 days |
| manifest.plist + share/history iOS install links | 1 day |
| UDID capture + devices tab + export | 1–2 days |
| mobile repo macOS CI (sign + upload) | 1–2 days, needs Apple creds |
| TestFlight bookkeeping (`external_url`) | 0.5 day |

Phase 1+2 ≈ one focused week once Apple credentials exist. Nothing blocks
Android work; the lanes share the release/rollout/share machinery already
built.
