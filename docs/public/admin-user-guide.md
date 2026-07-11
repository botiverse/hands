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
  public version history toggle, archive. Archived apps can be **purged**
  (permanent delete of the app, its builds/releases/tickets, and all stored
  files — requires typing the slug to confirm; `POST /api/apps/:id/purge`).

Create one Hands app per product distribution target. For example, an Android app should have its own Hands app and release channels.

## Releases

The standard flow follows the draft-first policy: CI creates a **draft** release with a generated changelog; a human or agent reviews it, writes the final (optionally bilingual) changelog, and publishes explicitly. See the release runbook in the repository docs.

1. CI (or `hands builds publish-android --draft`) creates the draft.
2. Review it in Releases (or `hands releases show`).
3. Write the final changelog — per-language notes are supported (`hands releases update … --changelog-file zh=zh.md --changelog-file en=en.md`); clients receive the language matching their system locale.
4. Publish from the release row (or `hands releases publish`).

For Android, Hands selects updates by `version_code`. A device receives an update only when the published release has a higher `version_code` than the client reports.

### Staged rollouts

Set a rollout percentage when creating or editing a release (number input with 5/25/50/100 presets), and raise it with **Bump rollout**. Devices are bucketed by their stable device id, keep their bucket while the percentage climbs, and gated-out devices receive the previous active release. Clients without a device id (older SDKs) only receive fully rolled-out releases.

Each release row shows update-check analytics: how many devices are already
**on this version** and how many were **offered** it (update checks from older
clients), so you can see real rollout coverage as the percentage climbs.

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

Deploy tokens are app-scoped bearer tokens. Create them for automation instead of reusing a human browser session. Copy the token when it is created; Hands only shows the raw token once. Each token records who created it, and actions performed with it are attributed as `deploy-token:<name>@<app>` in audit logs and release provenance.

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
