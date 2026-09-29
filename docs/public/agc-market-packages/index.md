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
