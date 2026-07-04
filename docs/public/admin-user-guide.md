# Admin User Guide

Quiver is a release and update distribution console for apps that need controlled binary delivery. Use the admin console to create apps, upload builds, publish releases, manage release channels, and give teammates or automation the access they need.

## Sign in

Open the Quiver site and use Login with Raft. After sign-in, Quiver shows the apps you can access in the current organization.

If you can sign in but do not see an expected app, ask an organization admin to grant you app access or make the app visible to your Raft server.

## Apps

The Apps page lists the apps visible to your account. Select an app to open its detail pages:

- Overview: current app metadata and the default entry point.
- Releases: published and draft releases by channel.
- Builds: uploaded build artifacts and their metadata.
- Access: direct app members, deploy tokens, and Raft server visibility.
- Audit: recent app activity.

Create one Quiver app per product distribution target. For example, an Android app should have its own Quiver app and release channels.

## Releases

Use Releases to prepare and publish updates.

1. Choose the app.
2. Open Releases.
3. Create a release or select an existing draft.
4. Upload the installable artifact.
5. Add release notes and metadata.
6. Publish to the intended channel.

For Android, Quiver selects updates by `version_code`. A device receives an update only when the published release has a higher `version_code` than the client reports.

## Builds

Builds hold uploaded artifacts and provenance. Quiver distinguishes installable artifacts from support artifacts:

| Artifact kind | Purpose |
|---|---|
| `installable` | APK or other file a client can install or download as the release payload. |
| `proguard-mapping` | Android R8/ProGuard mapping file for crash symbolication. |
| `native-symbols` | Native debug symbols. |
| `metadata-file` | CI or build metadata archived with the build. |

Public update checks only return installable artifacts. Support artifacts remain available to authenticated admins and publishers.

## Channels

Channels let you separate release tracks such as `main`, `preview`, `nightly`, or `debug`. Publish test builds to a non-production channel first, then publish to the production channel after validation.

Android clients should send the channel they are configured to use. Debug builds can point at `debug`; release builds typically point at `main`.

## Public Share Pages

Release share pages provide a temporary public download page for a release. New share pages expire after 7 days by default. A share page can show basic view and download stats. Renew or change the expiration when a manual review window needs more time; revoke a share when it should no longer be accessible.

Use share pages for human review and manual testing. Use the public update API for in-app update checks.

CLI examples (`update-share` is available in source version `0.1.2`; use the HTTP API directly until that CLI version is published to npm):

```bash
quiver releases share raft-android <release-id>
quiver releases update-share raft-android <release-id> <share-id>
quiver releases update-share raft-android <release-id> <share-id> --ttl-seconds 1209600
quiver releases update-share raft-android <release-id> <share-id> --expires-at 1783742182499
```

## Access

The Access page controls who can see or publish an app.

| Access type | Use |
|---|---|
| Direct app member | Give one user or agent a role on this app. |
| Raft server visibility | Make the app visible to accounts from another Raft server. |
| Deploy token | Give CI or an agent scoped API access to this app. |

Deploy tokens are app-scoped bearer tokens. Create them for automation instead of reusing a human browser session. Copy the token when it is created; Quiver only shows the raw token once.

## Common Issues

### No update is found

Check that the published release is on the same channel as the client, has a higher `version_code`, and contains a compatible installable artifact.

### Download link is expired

Public artifact URLs are signed and time-limited. Refresh the share page or run the update check again to get a fresh URL.

### 403 forbidden

Your account or deploy token does not have the required role for the action. Ask an app admin to grant access or use a token with the correct role.
