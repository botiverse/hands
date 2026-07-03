# Public API Reference

Quiver's public API lets apps check for updates and download release artifacts without a Quiver admin session.

Use the admin API or CLI for publishing. Use the public API from clients.

## Base URL

```text
https://quiver.oranix.io
```

Self-hosted deployments should use their own origin.

## Check for Updates

```http
GET /public/v2/apps/:appSlug/update-check?channel=main&current_version_code=1000000&platform=android&arch=arm64-v8a&filetype=apk
```

### Query Parameters

| Name | Required | Description |
|---|---|---|
| `channel` | Yes | Release channel to check, such as `main`, `preview`, `nightly`, or `debug`. |
| `current_version_code` | Yes | Installed client version code. |
| `platform` | No | Client platform, such as `android`. |
| `arch` | No | Client architecture, such as `arm64-v8a`. |
| `filetype` | No | Desired installable file type, such as `apk`. |

### Update Available

```json
{
  "update_available": true,
  "release": {
    "id": "release-id",
    "channel": "main",
    "version_name": "1.0.1",
    "version_code": 1000100,
    "release_notes": "Bug fixes and improvements"
  },
  "asset": {
    "filetype": "apk",
    "size_bytes": 29192396,
    "file_hash": "sha256-hex",
    "download_url": "https://quiver.oranix.io/public/r2/..."
  }
}
```

### No Update

```json
{
  "update_available": false
}
```

## Latest Release

```http
GET /public/v2/apps/:appSlug/latest?channel=main&platform=android&arch=arm64-v8a&filetype=apk
```

This returns the latest compatible installable release for the channel, independent of the client's installed version.

## Download URLs

`download_url` values are signed, time-limited URLs. Clients should use them promptly and request a fresh update check if the URL expires.

The response includes a readable download filename through `Content-Disposition` when the artifact is fetched.

## Client Behavior

Recommended client flow:

1. Send the installed `versionCode` and configured channel.
2. If `update_available` is false, do nothing.
3. If true, show release information or begin the update flow.
4. Download the artifact from `asset.download_url`.
5. Verify size/hash if the client update framework supports it.
6. Install or hand off to the platform installer.

## Errors

| Status | Meaning |
|---|---|
| `400` | Missing or invalid request parameters. |
| `404` | App, channel, release, or compatible artifact was not found. |
| `410` | Signed download URL expired. |
| `500` | Server error. Retry later or contact the Quiver operator. |

## Compatibility

Public update checks are read-only and do not require authentication. Admin and publishing APIs require Quiver auth or an app-scoped deploy token.
