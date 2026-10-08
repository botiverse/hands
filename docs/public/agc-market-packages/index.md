# Upload HarmonyOS packages for AppGallery

Use an existing signed `.app` build and the app's configured AGC credentials:

```sh
hands agc upload-market raft-ohos BUILD_ID --package-name build.raft.mobile
hands agc market-status raft-ohos BUILD_ID
```

This uploads to **AppGallery package management** (`distributeMode: 2`). It does
not create an invitation-test version, submit review, or publish the app.
`ready` means Huawei finished parsing the package; formal version selection
still enforces Huawei's version and signing requirements.

App administrators can also use:

- `POST /api/apps/{appId}/builds/{buildId}/agc-market-package`, JSON body
  `{ "package_name": "build.raft.mobile" }`.
- `GET /api/apps/{appId}/builds/{buildId}/agc-market-package` to refresh parsing.

Records are independent from invitation tests. Repeating POST returns the
existing record without another upload. A failed upload is retained for
operator reconciliation (a lost response may follow a successful provider
write); repeated POST does not silently retry it. Provider status read failures
retain the last known state and return `sync_error`.

Huawei contract: [Add package](https://developer.huawei.com/consumer/cn/doc/app/agc-help-test-api-add-test-package-0000002236201330).
The existing `hands agc upload` remains invitation testing (`distributeMode: 1`).

## Invitation-test notifications

An app administrator can subscribe to `appgallery:invitation_state_changed`
using the app's webhook settings. This event covers invitation-package upload
completion or failure, parsing completion or failure, review submission, and
subsequent invitation-test state changes. It does not announce a formal store
release. Existing upload and submit commands retain their publishing behavior.

Hands checks up to four submitted invitation versions per five-minute cron
invocation. These provider calls only read status; they never upload packages,
bind a package, submit review, or invite testers. Provider failures retain the
last known state. Unknown provider values remain in the stored status and are
not relabeled as approval or rejection. `ready` can mean withdrawal of review;
provider state `11` is explicitly labeled as developer withdrawal.

The webhook uses a single envelope with `event`, `event_id`, `app_id`, `org_id`,
`delivered_at`, and `payload`. Payload fields include `app` (`id`, `name`, `slug`),
`platform: OHOS`, `lane: invitation_test`, `submission_id`, `build_id`, `version`,
`build_number`, `previous_state`, `state`, `state_label`, `provider_state`, and
`occurred_at`. `groups_display`, when present, explicitly lists selected test
group IDs, not inferred group names. `observation_display` marks cron readbacks
as observations rather than claiming the review changed at that instant.
Provider messages, tester identities, signed upload URLs and credentials are
excluded from the notification. State, local history and notification enqueue
commit together; delivery retries never repeat a provider operation.
