---
title: "Admin User Guide"
description: "Using the Hands admin console: apps, releases, builds, access, and troubleshooting."
category: "Console"
order: 8
---

# Admin User Guide

Hands is a release and update distribution console for apps that need controlled binary delivery. Use the admin console to create apps, upload builds, publish releases with staged rollouts, manage share links and feedback tickets, and give teammates or automation the access they need.

## Sign in

Open the Hands site and use Login with Raft. After sign-in, Hands drops you into your first app (or the app creation wizard if none exist). The left rail navigates between Apps, Org, and your account menu (Settings, Logout).

If you can sign in but do not see an expected app, ask an organization admin to grant you app access or make the app visible to your Raft server.

## Apps

Each app has a left sidebar with its sections; the app switcher at the top of the sidebar jumps between apps, creates new ones, or returns to the full list.

- Overview: current app metadata and recent operations.
- Channels: release tracks (`main`, `preview`, `nightly`, `debug`).
- Releases: published and draft releases, staged rollout controls.
- Builds: uploaded build artifacts and their metadata.
- Shares: every public share link with stats, renewal, revocation, and passwords.
- Feedback: tickets submitted from the app, with assignees, statuses, and comments.
- Access: direct app members, deploy tokens, and Raft server visibility.
- Audit: recent app activity.
- Settings: app name/description, app icon, client key, default channel,
  Raft notifications, public version history toggle, archive. Archived apps can be **purged**
  (permanent delete of the app, its builds/releases/tickets, and all stored
  files — requires typing the slug to confirm; `POST /api/apps/:id/purge`).

Create one Hands app per product distribution target. For example, an Android app should have its own Hands app and release channels.

To connect another Raft server you already belong to, open the organization
switcher and choose **Add Raft server**. Select the server and authorize Hands
in Raft; Hands returns to that server's organization. This does not create a
Raft server or grant membership. Previously connected organizations remain in
the switcher when they belong to the same Raft identity.

### Raft notifications

App administrators can open **Settings → Raft notifications** to have Hands
post selected webhook events as the app's Raft App Bot. A server owner or admin
must first grant the bot to the Hands app in Raft. Click **Connect App Bot**,
then add the bot to each target channel in Raft. Enter a channel target such as
`#proj-mobile-release`, select the events that belong there, and use **Test**. A
single app can have multiple channel destinations with different event sets;
each destination can be enabled, disabled, tested, or removed.

**Use status cards** opts a destination into cards for App Store version,
external TestFlight build, Google Play release, and AppGallery package and
invitation test status changes. Later changes for the same object update its
card and post a separate card to the channel, so members see the change
without following a thread. Upload, internal TestFlight distribution, Play
submission, release and build notifications each get their own card. Existing
state objects using text keep that history; cards begin with new state objects
first seen after opting in. AppGallery builds with an existing text thread
continue to use text. A failed Google Play submission is a separate
card for each receipt; recognized failure causes appear on the card and its
text fallback, while causes inferred from provider wording are labeled as
possible. Google Play cards include a link to the Play Console home in both the
card and accompanying text. Cards use a title, status tags, and labeled fields
where available; recognized Play failure reasons are emphasized. Clients that do
not support the newer card format, including mobile 1.20 and earlier, show the
complete accompanying text. Unknown provider text and metadata are not displayed. If an object returns to text, it stays on
text even if cards are turned on again. Feedback and crash events still use
text. A card older than Raft's update window
is replaced by a new message. Older Raft clients see the accompanying text.
If the destination cannot accept a first card, Hands uses text. You can switch
back to text even while a card request is unresolved; the request is retained
and may still complete. If a later event arrives before it is reconciled,
Hands sends that event as text with a warning that the earlier card may be out
of date. When a retry confirms the earlier update, Hands also tries to bring
the card up to the latest event with an unambiguous timestamp, provided cards
are still enabled and the update window remains open. Until then, or if events
cannot be ordered, use the newer channel message as the status. Exhausted
delivery retries require the administrator retry described below. For an unresolved first message,
Hands attempts text with the original send key so that only one of the card or
text can win. A later event may be delayed while the first message is resolved.

The destination shows up to 25 failed release-status notifications. **Retry**
schedules the selected event for delivery, using its
original contents and idempotency key; it does not discard an uncertain card
request. Retries are recorded in the app's audit history. Resolve outstanding
requests before turning cards back on. A status change without a reliable
event time, or with the same time as another change, is sent as text instead
of guessing their order.

For new feedback and bug reports, a notification includes a short excerpt of
the user's message. Choose channels whose members may read that feedback; the
excerpt can contain information the user submitted. HTTP(S) URLs are omitted
and Raft mentions in the excerpt are not activated. Crash text, attachments, and comment
bodies are not included. A feedback notification includes a `hands feedback
show <app> <ticket>` command; viewing the full ticket still requires Hands
access. The `feedback:comment_created` and `feedback:status_changed` events are
emitted for reporter-owned tickets. Updates for the same ticket and destination
are posted in its existing Raft thread.

TestFlight notifications can include test group names and a short excerpt of a
developer's testing notes. Select a channel whose members may see these details.
HTTP(S) URLs and Raft mentions in the excerpt are neutralized. A Play status
notification distinguishes a first observed snapshot from a later transition.

Hands stores one encrypted bot credential per Raft server installation and
never displays it in the console. Connecting another Hands app on that same
server reuses the installation credential instead of rotating it. Existing
webhook producers use the same delivery queue and retry policy. In text mode,
release, build and store status events each appear as a channel message, so
members need not follow a thread to see later changes. Feedback updates for the
same ticket remain in its thread. A status card update itself is silent;
Hands sends the channel message separately. Provider credentials, crash attachments, and
untrusted provider prose are not included in these messages. Apple's review
rejection notification includes the version, state, time, and App Store Connect
link; the rejection text itself still has to be read in App Store Connect.

## Releases

The standard flow follows the draft-first policy: CI creates a **draft** release with a generated changelog; a human or agent reviews it, writes the final (optionally bilingual) changelog, and publishes explicitly. See the release runbook in the repository docs.

1. CI (or `hands builds publish-android --draft`) creates the draft.
2. Review it in Releases (or `hands releases show`).
3. Write the final changelog — per-language notes are supported (`hands releases update … --changelog-file zh=zh.md --changelog-file en=en.md`); clients receive the language matching their system locale.
4. Publish from the release row (or `hands releases publish`).

For Android, Hands selects updates by `version_code`. A device receives an update only when the published release has a higher `version_code` than the client reports.

A draft, active, or superseded release reserves its app, channel, product type,
release type, and version-code coordinate. Cancelling disables that lifecycle
and releases the coordinate for a corrected upload while preserving the old
release ID, build, assets, and audit history. An old cancelled release can be
restored only until a replacement owns the version; after that, operate on the
replacement release instead. For Android builds that were already distributed,
use a higher version code so installed clients can receive the correction.

### Staged rollouts

Set a rollout percentage when creating or editing a full release (number input
with 5/25/50/100 presets), and raise it with **Bump rollout**. Select any number
of **Always included device groups** on that same release for acceptance or QA
devices. Group members receive the target regardless of their bucket; other
devices keep a stable bucket while the percentage climbs. Gated-out and
anonymous clients receive the previous eligible full release until rollout
reaches 100%.

Each release row shows unique per-install devices (UV): how many devices have
checked while already **on this version** and how many unique older devices
were **offered** it. Hover either number to see the all-time update-check event
count (PV). UV collection requires a stable device id and starts at the metric
upgrade; historical PV aggregates cannot be converted into exact historical UV.

The app overview also exposes version-level metrics from
`GET /api/apps/:id/analytics/versions`: devices that reported in the selected
window, total devices seen, update-check current/offered counts,
feedback/crash volume, and artifact downloads for each version/channel. The
data comes from throttled SDK metrics pings, update checks, feedback tickets,
and build asset download counters. These metrics show active/recent devices,
not a true unthrottled online heartbeat.

## Builds

Builds hold uploaded artifacts and provenance. Hands distinguishes installable artifacts from support artifacts:

| Artifact kind | Purpose |
|---|---|
| `installable` | APK or other file a client can install or download as the release payload. |
| `proguard-mapping` | Android R8/ProGuard mapping file for crash symbolication. |
| `native-symbols` | Native debug symbols. |
| `metadata-file` | CI or build metadata archived with the build. |
| `app-icon` | Launcher icon extracted automatically from the uploaded APK. |

Registering an installable APK triggers automatic parsing: package id, SDK levels, and the launcher icon are extracted server-side (aapt) with no extra CI parameters. Public update checks only return installable artifacts; support artifacts remain available to authenticated admins and publishers.

## Channels

Channels let you separate release tracks such as `main`, `preview`, `nightly`, or `debug`. Publish test builds to a non-production channel first, then publish to the production channel after validation.

Android clients should send the channel they are configured to use. Debug builds can point at `debug`; release builds typically point at `main`.

## Shares

The Shares tab lists every public share link for the app: release, creator, expiry, status, password badge, and view/download stats. From there you can create links (with an optional password), extend them by 7 days, set or remove passwords on existing links, and revoke them. Share URLs are shown once at creation — tokens are stored hashed.

Share pages show the release's real app icon, a QR code on desktop, localized release notes, and live stats. Password-protected pages ask for the password before showing the download.

```bash
hands releases share raft-android <release-id> --password <pw>   # optional password
hands releases update-share raft-android <release-id> <share-id> --ttl-seconds 1209600
hands releases revoke-share raft-android <release-id> <share-id>
```

Use share pages for human review and manual testing. Use the public update API for in-app update checks.

## Feedback

The Feedback tab is a lightweight ticket system for reports submitted from the app (via the SDK's `HandsFeedback` or the public feedback endpoint). Each ticket carries the message, contact, app version, device context (including the rollout device id), and up to nine attachments.

- Tickets are shareable pages (`/apps/<id>/feedback/<ticket>`).
- Triage with statuses (`open → in_progress → resolved/closed`), an assignee (Assign to me / edit / unassign), and a comment trail.
- A `feedback:new` webhook fires on submission for org webhook subscribers.
- Crash alerting: `crash:new_group` fires the first time a crash signature is
  seen for an app; `crash:spike` fires as a signature crosses 10, 50, and 100
  occurrences within an hour. Subscribe a webhook to either event (Org
  settings → Webhooks) to get paged instead of polling the console.

Crash tickets (`kind=crash`, submitted automatically by the SDK's crash
reporter) get a grouping **signature** (exception class + top app frame) and a
**Crash groups** view that aggregates by signature with occurrence and device
counts. When a build's ProGuard/R8 `mapping.txt` was uploaded as a
`proguard-mapping` asset for that version, Hands auto-deobfuscates the stack
in the container and posts the retraced trace as a ticket comment.

## Version history

Settings → **Public version history** exposes `/apps/<slug>/history`: a public page listing published versions with localized changelogs and per-version downloads. It is off by default; when disabled the page returns 404.

## Access

The Access page controls who can see or publish an app.

| Access type | Use |
|---|---|
| Direct app member | Give one user or agent a role on this app. |
| Raft server visibility | Make the app visible to accounts from another Raft server. |
| Deploy token | Give CI or an agent scoped API access to this app. |

For a principal on another linked Raft server, ask them to run the Hands
`whoami` Agent Login action and send the non-secret Hands account id. In
**Add direct app member**, paste that id instead of selecting a same-org
principal. The account must have logged into Hands at least once. Hands adds
missing org `viewer` membership and the selected app-scoped role atomically.

Deploy tokens are app-scoped bearer tokens. Create them for automation instead of reusing a human browser session. Copy the token when it is created; Hands only shows the raw token once. Each token records who created it, and actions performed with it are attributed as `deploy-token:<name>@<app>` in audit logs and release provenance.

Roles range from `viewer` (read) through `member` (collaborate — e.g. triage feedback), `publisher` (ship builds/releases), to `admin` (configure, manage members, hold secrets). See the [permissions reference](permissions.md) for the full role model and the endpoint→role matrix.

## Common Issues

### No update is found

Check that the published release is on the same channel as the client, has a higher `version_code`, contains a compatible installable artifact, and — for partially rolled-out releases — that the device's bucket falls inside the rollout percentage.

### Download link is expired

Public artifact URLs are signed and time-limited. Refresh the share page or run the update check again to get a fresh URL.

### 403 forbidden

Your account or deploy token does not have the required role for the action. The response is machine-readable so an agent or the CLI can point you straight to the fix:

```json
{
  "error": "insufficient_org_role",       // or "insufficient_app_role"
  "required_role": "member",
  "current_role": "viewer",
  "resource": "POST /api/apps",            // the action you attempted
  "org_id": "…", "app_id": null,
  "manage_url": "https://app.hands.build/orgs/{orgId}/members"
}
```

To resolve, an organization **admin/owner** opens `manage_url` — **Org → Members** for org roles, or an app's **Access** tab for app-level roles — and raises the account's role to `required_role`. Then retry the same request.

Note: creating an app (`POST /api/apps`) requires an **org member or higher** — an app-level member role or a deploy token is not enough. Newly Agent-Login'd agents normally start as **member**; **viewer** is a read-only role that an org admin can assign manually.


## Connect Google Play without a service-account key

See the [Google Play authorization setup guide](google-play-oauth.md) for the complete setup and troubleshooting steps.

For an Android app, open Settings and find Google Play. Enter the package name
and the internal, closed testing and production track names, then choose
**Authorize with Google**. Sign in with the Google account that has Play Console
access to that package and those tracks. Only a human Hands app administrator
can authorize. Connection testing checks access without publishing a release.

Hands encrypts the authorization on the server and refreshes access when needed.
If the Google button is unavailable, your Hands operator must configure the
Google OAuth client and private Play adapter first. Existing service-account
JSON connections are still supported.

**Unbind** removes the authorization stored by Hands for this app. To revoke
Google's grant too, follow the Google Account connections link and remove Hands;
this can affect other apps using that Google account. Play publication still
requires a valid signed AAB and the existing acceptance and approval steps.
