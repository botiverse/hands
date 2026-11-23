---
title: "Google Play Authorization"
description: "Connect, configure, verify, and revoke Google Play access without a service-account key."
category: "Console"
order: 7
---

# Connect Google Play

Connect your Google account to publish an Android app through Hands. You do not need a service-account JSON key.

## Before you connect

You need administrator access to your app in Hands and a Google account with access to the same app in Google Play Console. The app must already exist in Play Console. Your Google account needs permission for the testing or production tracks you plan to use.

## Connect your account

1. Open your Android app in Hands and select **Integrations** in the left sidebar.
2. Find **Google Play** and click **Connect**.
3. Sign in to the Google account that has access to your Play app, then approve the requested access.
4. When you return to Hands, expand Google Play to finish setup. A connected account can show **Needs configuration** until you save the app settings.

## Choose your app and tracks

1. Select your app's Android package name. Hands suggests package names from your uploaded Android builds; you can also enter it manually. It must match the app in Play Console.
2. Hands loads the available Play tracks for that package. Choose your internal testing, closed testing and production tracks. If you have multiple closed testing tracks, select the one you intend to use, such as alpha or beta.
3. Click **Save**. Hands checks the connection and enables it when validation succeeds.

Connecting and saving settings do not upload or publish a release. You can use **Test connection** to check access again without publishing.

## Publish a build

Prepare a signed Android App Bundle (AAB) for your Play app. Complete your normal build review and acceptance, then explicitly submit the release to the intended track through Hands. Start with internal testing to verify the build before broader distribution. A publisher with the app's publishing permission can submit; this can be a person or an agent.

Use a new version code for each new build. Your first upload can use your app's existing version-number scheme; it does not need to start at 1. Google Play may require additional app setup or review before accepting a release.

## If something goes wrong

| What you see | What to do |
| --- | --- |
| Connect is unavailable because Google authorization is not configured | Contact your Hands administrator to enable the Google Play integration on this server. |
| Google refuses access | Confirm you signed in to the account that has access to your app in Play Console. Follow any access or verification instructions shown by Google. |
| You return to Hands but the connection fails | Check the error shown next to Google Play and click Connect to try again. |
| The track list cannot load | Check the package name and your Google account's app permissions, then refresh the tracks. If the error includes SERVICE_DISABLED, ask your Hands administrator to enable the Google Play API for this integration. |
| The account is connected but still needs configuration | Expand Google Play, choose the package name and tracks, and save. |
| A previously working connection stops working | Try Test connection. Reconnect if Google access has expired or been revoked. |

When Google refuses a request, Hands shows what Google said under its own
explanation: in the CLI as a line like `Google Play said (HTTP 403): ...`, in API
errors as `upstream: { service, http_status, message }`, in receipts, and on
"Google Play access failing" alerts. The text is Google's, clipped to 300
characters, with anything that looks like a token, key or email address
replaced by `[redacted]`.

## Disable or disconnect

**Disable** stops publishing through this connection while keeping its settings for later use.

**Unbind** removes this app's saved Google Play connection from Hands. To revoke access to the Google account itself, visit [Google account connections](https://myaccount.google.com/connections) and remove the associated application. This can affect other Hands apps using the same Google account and connection.

## Release notifications

App webhooks (and [Raft channel notifications](store-release-notifications.md)) can subscribe to `google_play:submission_succeeded`,
`google_play:submission_failed`, and `google_play:release_state_changed`.
Submission events come from immutable Hands promotion receipts and include the
package, version code, Hands track, and receipt ID. A successful submission is
not an approval or availability announcement. A release uploaded with
`--changes-not-sent-for-review` carries `action: "promote"` and
`review_requested: false`; `hands releases play-send-for-review` carries
`action: "send-for-review"` and `review_requested: true`. Plain promotions
carry neither field. Failures before Hands can create
a promotion receipt remain API errors rather than release notifications.

Hands reads Google's live release lifecycle for enabled, verified connections
on the configured tracks. Google limits how often an app's release states can be
listed (about 12 calls an hour, one per track, resetting around minute :10), so
each app is read once an hour; the cron runs every five
minutes and handles at most four apps per run; larger sets rotate through
subsequent runs. Hands keeps one count of these calls per app, shared by the
poll, review-status, the stats page, the in-review check before a promotion and
send-for-review. The poll may use 4 of the 12, reads a person or agent asked
for up to 8, and the check before a promotion all 12, so promotions keep 4
reads in reserve. When the poll has no room, or Google says the limit is used up,
Hands skips the app without reporting an access failure and reads it again
just after the reset. `hands quota <app>` shows what is used and left
([CLI reference](cli-reference.md#google-play-read-quota)). The first observation is a
current-state snapshot (`observation: initial_snapshot`); later changed states
are transitions. Unchanged states produce no new notification. State and pending
delivery records commit together. Provider failures leave the previous
observation intact and are retried on a later scheduled run.

`RELEASE_LIFECYCLE_STATE_PUBLISHED` means the version is available on the track;
it may be partially rolled out or halted, and does not mean 100% rollout.
Unknown states are preserved verbatim. A removed or changed connection cannot
publish an old in-flight response. This uses a read-only API, not a Google
webhook, and does not upload, commit an edit, or release a version.

See [Google release lifecycle documentation](https://developers.google.com/android-publisher/api-ref/rest/v3/applications.tracks.releases).
