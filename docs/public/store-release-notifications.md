---
title: "Store Release Notifications in Raft"
description: "Automatically push Google Play, App Store, TestFlight, and AppGallery release status to a Raft channel, and trigger follow-up agent workflows."
category: "Console"
order: 18
---

# Store release notifications in Raft

Hands can automatically post Google Play, App Store, TestFlight, and AppGallery release and review updates to a Raft channel through your app's managed Raft App Bot. Humans and agents in the channel get one shared timeline of uploads, review transitions, and live store availability without manually refreshing store consoles.

## 1. How to enable it {#how-to-enable}

Connecting a Hands app to a Raft channel requires three setup steps: granting the bot in Raft, connecting the bot and channel in Hands, and wiring the store integration for your platform.

### Required permissions

| Step | Who can perform it | Required role / permission |
| --- | --- | --- |
| Grant the Hands App Bot on the Raft server | Raft server owner or admin | Raft server `owner` or `admin` |
| Add the bot to the target Raft channel | Channel member (public) or channel/server admin (private) | Permission to add members to the target channel (for example `#proj-mobile-release`) |
| Connect the App Bot & manage channel subscriptions in Hands | Hands app administrator | Hands app `admin` (or org `owner` / `admin`) |
| Configure store credentials / webhooks in Hands | Hands app administrator | Hands app `admin` + store-side credentials (see below) |

### Step 1: Connect the App Bot and bind a Raft channel

1. In Raft, have a server owner or admin grant the bot permission to the installed Hands app.
2. In the Hands console, open your app and go to **Settings → Raft notifications** (`GET / POST /api/apps/:appId/raft-notifications`).
3. Click **Connect App Bot** (`POST /api/apps/:appId/raft-notifications/connect`). Hands mints and encrypts one bot credential per Raft server installation; connecting additional Hands apps on the same Raft server reuses that installation credential without rotating it.
4. In Raft, add the connected bot account (for example `@hands-4cc7a2`) to the target channel (such as `#proj-mobile-release`).
5. Back in Hands, enter the **Target channel** (`#channel-name`), select the events to subscribe to, and click **Add destination**.
6. Click **Test** (`POST /api/apps/:appId/raft-notifications/:subscriptionId/test`) to verify that the bot can post to the channel.
7. Optional: click **Use status cards** on the destination so supported store and release events render as rich status cards (and update in place when the same version or build changes state) while also posting a new card to the channel for visibility.

A single Hands app can bind multiple Raft channels with different event sets, and multiple Hands apps (for example `raft-ios` and `raft-android`) can post into the same release channel.

### Step 2: Enable store event sources

Subscribing a Raft channel tells Hands *where* to send notifications. Make sure the store integration for your platform is also active so Hands receives or observes store events:

- **Google Play**: In **Integrations → Google Play**, connect your Google account, select the Android package name and your `internal`, `closed`, and `production` tracks, and save so the binding is `enabled` and `verified`. See [Google Play Authorization](google-play-oauth.md).
- **App Store & TestFlight**:
  1. In **Integrations → TestFlight**, store your App Store Connect API credential (`PUT /api/apps/:appId/asc-credentials`).
  2. Create and register the App Store Connect webhook on the app so Apple pushes review and build state transitions to Hands:
     ```bash
     hands api POST /api/apps/<app-uuid>/apple-webhook -d '{"apple_app_id":"<numeric-asc-app-id>"}'
     hands api POST /api/apps/<app-uuid>/apple-webhook/register
     ```
     See [iOS Releases & TestFlight — App Store Connect webhook notifications](ios-testflight.md#app-store-connect-webhook-notifications) for details.

---

## 2. Which events are pushed {#which-events-are-pushed}

Each channel destination can subscribe to any combination of the following store, release, build, and feedback events.

### Google Play events

| Event | Trigger & states covered |
| --- | --- |
| `google_play:submission_succeeded` | A Hands Play operation completed and recorded an immutable receipt: submitting a release to a track (`Release submitted`), saving changes without sending for review (`--changes-not-sent-for-review` → `Release saved; not sent for review`), sending existing changes for review (`hands releases play-send-for-review` → `Review request sent`), or uploading native symbols (`Symbols uploaded`). Includes package name, version, `version_code`, track, and requested rollout percentage. |
| `google_play:submission_failed` | A Hands Play submission or review request failed or was blocked after creating an operation receipt. Includes the reason code and recognized Play failure diagnostics, plus a direct link to Google Play Console. |
| `google_play:release_state_changed` | The observed Google Play release lifecycle state on a configured track (`internal`, `closed`, or `production`) changed. States include:<br>• `RELEASE_LIFECYCLE_STATE_DRAFT` (*Draft*)<br>• `RELEASE_LIFECYCLE_STATE_NOT_SENT_FOR_REVIEW` (*Not sent for review*)<br>• `RELEASE_LIFECYCLE_STATE_IN_REVIEW` (*In review*)<br>• `RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED` (*Approved; waiting for release*)<br>• `RELEASE_LIFECYCLE_STATE_NOT_APPROVED` (*Review rejected*)<br>• `RELEASE_LIFECYCLE_STATE_PUBLISHED` (*Available on track (may be partially rolled out or paused)*) |

### App Store & TestFlight events

| Event | Trigger & states covered |
| --- | --- |
| `app_store:version_state_changed` | App Store version review or release state changed in App Store Connect. States include:<br>• `PREPARE_FOR_SUBMISSION` (*Preparing for submission*)<br>• `WAITING_FOR_REVIEW` (*Waiting for review*)<br>• `IN_REVIEW` (*In review*)<br>• `PENDING_DEVELOPER_RELEASE` (*Approved; waiting for developer release*)<br>• `PENDING_APPLE_RELEASE` (*Waiting for Apple release*)<br>• `READY_FOR_SALE` / `READY_FOR_DISTRIBUTION` (*Ready for distribution*)<br>• `REJECTED` (*Review rejected*) / `METADATA_REJECTED` (*Metadata rejected*)<br>• `DEVELOPER_REJECTED` (*Withdrawn by developer*) / `INVALID_BINARY` (*Build is invalid*)<br>Hands enriches the notification best-effort with the marketing `version_string` (such as `1.22.0`) and an App Store Connect link. |
| `app_store:build_upload_state_changed` | Apple build upload processing state changed (`AWAITING_UPLOAD`, `PROCESSING`, `COMPLETE` / *Upload processed*, `FAILED` / *Upload processing failed*). |
| `testflight:upload_processing` | Hands uploaded an IPA to App Store Connect and Apple's immediate readback reported `PROCESSING`. |
| `testflight:internal_distribution_ready` | Hands published a build to internal TestFlight groups and verified readback in `IN_BETA_TESTING` (*Ready for internal testing*). Includes selected test group names, localized `What to test` notes, and `source_commit` when available. |
| `testflight:external_state_changed` | External TestFlight build beta state changed in App Store Connect. States include:<br>• `WAITING_FOR_BETA_REVIEW` (*Waiting for beta review*) / `IN_BETA_REVIEW` (*In beta review*)<br>• `BETA_APPROVED` (*Approved for beta testing*) / `BETA_REJECTED` (*Beta review rejected*)<br>• `READY_FOR_BETA_SUBMISSION` / `READY_FOR_BETA_TESTING` / `IN_BETA_TESTING` (*Beta testing*)<br>• `MISSING_EXPORT_COMPLIANCE` / `IN_EXPORT_COMPLIANCE_REVIEW`<br>• `PROCESSING_EXCEPTION` (*Build processing failed*) / `EXPIRED` (*Build expired*)<br>Hands enriches the event best-effort with `version`, `version_code` (build number), localized `What to test` notes, and `source_commit`. |
| `testflight:crash_submission_created` | A tester submitted a TestFlight crash feedback report. Hands creates a deduplicated crash ticket, stores the `.ips` log as an attachment, and posts a notification with `hands feedback show <app> <ticket>` (never raw crash text). |

### AppGallery, Hands release, build, and feedback events

In addition to Apple and Google Play store events, a channel can also subscribe to:

- **AppGallery Connect**: `appgallery:package_state_changed` (`uploading`, `processing`, `ready`, `failed`) and `appgallery:invitation_state_changed` (`uploading`, `processing`, `ready`, `testing_review`, `testing_scheduled`, `testing_active`, `rejected`, `stopped`).
- **Hands channels & builds**: `release:draft_created`, `release:new`, `release:published`, `release:superseded`, `release:rolled_back`, `release:cancelled`, `release:channel_emptied`, `build:succeeded`, `build:failed`.
- **Feedback & crash alerts**: `feedback:new`, `feedback:comment_created`, `feedback:status_changed`, `crash:new_group`, `crash:spike`, `error:new_group`, `error:spike`.

---

## 3. When events are pushed: real-time vs. periodic polling {#when-events-are-pushed}

Hands combines **immediate event-driven delivery** with **periodic read-only store polling**, depending on whether the upstream store provides a webhook or synchronous receipt:

| Source | Events | How Hands detects the change | Delivery timing |
| --- | --- | --- | --- |
| **Hands operation receipts** | `google_play:submission_succeeded`<br>`google_play:submission_failed`<br>`testflight:upload_processing`<br>`testflight:internal_distribution_ready`<br>`release:*`, `build:*` | Recorded atomically when a Hands CLI or API operation finishes its store readback. | **Immediate**: enqueued to Cloudflare Queues right away and posted to Raft within seconds. |
| **App Store Connect Webhooks** | `app_store:version_state_changed`<br>`testflight:external_state_changed`<br>`app_store:build_upload_state_changed`<br>`testflight:crash_submission_created` | Apple pushes signed `x-apple-signature` webhook events to `/api/apps/:appId/apple-webhook` as soon as state changes in App Store Connect. | **Immediate upon Apple webhook arrival**: Hands verifies the signature, commits the receipt, and enqueues delivery to Raft immediately. |
| **Google Play lifecycle polling** | `google_play:release_state_changed` | Google Play does not push release review/lifecycle webhooks. A Worker Cron Trigger runs **every 5 minutes** and queries the configured `internal`, `closed`, and `production` tracks via the read-only Android Publisher API. | **Every ~5 minutes** (rotating up to 4 verified apps / 12 track queries per 5-minute tick). The first observation on a track is labeled `First observation; this may not be a recent change` (`initial_snapshot`); subsequent messages only fire when `state` actually changes (`transition`). |
| **AppGallery Connect polling** | `appgallery:invitation_state_changed`<br>`appgallery:package_state_changed` | Immediate for transitions triggered by Hands commands; background compilation and review transitions are polled by the **5-minute** Worker Cron Trigger (up to 4 pending items per tick). | **Immediate** for Hands actions; **every ~5 minutes** for background store processing and review changes. |

### Delivery retries

Every notification is backed by the durable `webhook_deliveries` queue in D1. The first attempt runs immediately via Cloudflare Queues; if Raft is temporarily unreachable, the 5-minute cron reaper retries with backoff (`5 minutes`, `30 minutes`, `2 hours`). If all automatic attempts are exhausted, app admins can inspect and trigger **Retry** directly from **Settings → Raft notifications**.

---

## 4. What agents can do with notifications {#what-agents-can-do}

Because the Hands App Bot posts structured, machine-readable messages (and cards) directly into a Raft channel, AI agents that have joined that channel are woken automatically by Raft whenever a release state changes — eliminating manual console polling and sleep loops.

Common agent workflows in `#proj-mobile-release` include:

1. **Notify stakeholders the moment a store review passes or goes live**
   - When `google_play:release_state_changed` reports `Available on track` (`RELEASE_LIFECYCLE_STATE_PUBLISHED`) on `production` — or when `app_store:version_state_changed` transitions from `WAITING_FOR_REVIEW` / `IN_REVIEW` to `PENDING_DEVELOPER_RELEASE` or `READY_FOR_DISTRIBUTION` — the release agent in the channel immediately sees the version, build number (`version_code`), and track, and can notify the release owner (for example, messaging `artin` as soon as Google Play `1.22.0` passes review and goes live on `production`).
2. **Chain multi-step release pipelines automatically**
   - **TestFlight**: Upload an IPA (`hands builds testflight-upload`), wait passively for the channel notification `📦 Upload processed` (`app_store:build_upload_state_changed` → `COMPLETE`) or `✈️ Ready for internal testing` (`testflight:internal_distribution_ready`), and then immediately proceed to external TestFlight distribution or `hands app-store prepare` + `submit`.
   - **Manual App Store release**: When a version configured with `MANUAL` release type reaches `PENDING_DEVELOPER_RELEASE` (*Approved; waiting for developer release*), the agent can prompt the human owner for release confirmation or run `hands app-store release <app> <version-id> --version-name <ver> --commit` once authorized.
3. **React immediately to rejections or submission failures**
   - If `app_store:version_state_changed` reports `REJECTED` / `METADATA_REJECTED`, or `google_play:release_state_changed` reports `Review rejected` (`RELEASE_LIFECYCLE_STATE_NOT_APPROVED`), or `google_play:submission_failed` fires with a reason code, the agent can immediately alert the team in the release thread, run `hands app-store preflight` / `status` to inspect the state, and prepare the fix without waiting for a human to check App Store Connect or Play Console.
4. **Triage TestFlight crashes and user feedback in context**
   - When `testflight:crash_submission_created` or `feedback:new` arrives in the channel, it includes the exact CLI command (`hands feedback show <app> <ticket>`). An agent can run that command right away to inspect the symbolicated stack trace or attachment and open a fix PR.
