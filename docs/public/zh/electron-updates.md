---
title: "Electron 更新补丁"
description: "让 Hands 上的 electron-updater 应用在 macOS 上下载更小的更新：CI 用 hands electron make-patches 生成二进制补丁，应用用 @botiverse/hands-electron/updater 应用补丁。"
category: "SDKs & API"
order: 20
---

# Electron 更新补丁（macOS）

用 `electron-updater` 和 [Hands 通用更新源](public-api-reference.md)更新的 Electron 应用，在 macOS 上每次要下载整个分架构 zip（常常超过 100 MB），或者它的 blockmap 差分。更新补丁小得多：常规版本一般是几十 KB 到几 MB，升级 Electron 大约 20 MB。

整体流程：

1. **CI** 在构建后运行 `hands electron make-patches`。对渠道上最近的几个版本（默认 3 个）和每个架构，它从该版本的应用到新版本做一个补丁，实际应用一次确认能精确还原新应用，再把补丁写进新的 `latest-mac.yml` 的 `patches`。
2. **发布**时把 `.patch` 文件作为同一个构建的资产上传，和 zip 放在一起。Hands 像其他构建文件一样从 `/electron/<app>/<channel>/<file>` 提供它们。
3. **应用**调用 `@botiverse/hands-electron/updater` 的 `enablePatchUpdates(autoUpdater)`。如果更新源里有从当前运行版本出发的补丁，应用就下载补丁，用已安装的应用重建版本 zip，再交给 Squirrel.Mac。zip 里的应用和签名、公证过的版本逐字节相同，所以 Squirrel 的签名检查照常通过。

出现任何意外都会回退到 electron-updater 自己的下载（blockmap 差分，不行再下完整 zip）。没有集成 SDK 的客户端或旧版 SDK 会忽略 `patches`。

只支持 macOS。Windows 继续用 electron-updater 的 NSIS blockmap 差分。补丁格式也支持单个文件（AppImage），但 CLI 目前不生成 Linux 补丁。

## 前提条件 {#requirements}

- **electron-builder** 为每个架构生成 `zip`（`<name>-<version>-arm64.zip`、`<name>-<version>-x64.zip`）。发布的必须是已签名、已公证并 staple 过的 zip，因为补丁就是从这些字节做出来的。
- publish 配置里关掉多区段请求。Hands 每个请求只响应一个区段，不设置的话，blockmap 回退会悄悄变成完整下载：

  ```yaml
  publish:
    provider: generic
    url: https://hands.build/electron/<appSlug>/<channel>
    useMultipleRangeRequest: false
  ```

- **electron-updater** 6.3.9 到 6.x。SDK 替换了 `MacUpdater` 的一个私有方法（见[客户端如何接入](#how-the-client-hooks-in)）。
- **Electron** 内置的 Node 需要 22.19+ 或 24.6+。更早的运行时会接受 zstd 字典参数但悄悄忽略。SDK 启动时会检查，运行时不支持就不启用。
- **CI**：Linux 或 macOS runner，Node 22.19+（或 24.6+），有 `unzip` 和 `diff`，以及能读取该应用的 Hands 令牌（viewer 即可）。[GitHub OIDC 受信发布者](cli-reference.md)换来的令牌就够。
- 一个版本要在 Hands 上并带有公证过的 zip，才能作为 base。在 Hands 上发布的第一个版本没有补丁。安装了 **universal** DMG 的用户会回退到完整下载一次（原因 `base_universal`）；这次下载装上的是单架构应用，所以下一次更新就能走补丁。

## 1. 应用 {#1-the-app}

```bash
npm install @botiverse/hands-electron electron-updater
```

```ts
import { autoUpdater } from "electron-updater";
import { enablePatchUpdates } from "@botiverse/hands-electron/updater";

const patches = enablePatchUpdates(autoUpdater, {
  onEvent: (event) => log.info("update_patch", event),
});
// 之后照常使用 autoUpdater（checkForUpdates、downloadUpdate……）
```

在主进程里、第一次下载之前调用一次。CommonJS 项目（TypeScript `module: nodenext` 输出 CJS）用 `await import("@botiverse/hands-electron/updater")` 加载。

SDK 自己不发任何网络请求，也不发遥测。`onEvent` 收到的只有封闭的代码和数字；唯一的自由文本是 `detail`，写的是失败的文件，只用于本地日志：

| `type` | 字段 | 时机 |
|---|---|---|
| `unavailable` | `reason`：`unsupported_platform` 或 `updater_internals` | 启动时：不是 macOS、运行时没有 zstd 字典支持，或者 electron-updater 缺少钩子要用的方法。更新照旧进行。 |
| `started` | `from`、`to`、`arch`、`bytes` | 开始下载补丁。 |
| `built` | `from`、`to`、`arch`、`bytes`、`downloadMs`、`buildMs` | zip 已重建并交给 Squirrel。 |
| `fallback` | `from`、`to`、`arch`、`reason`、`bytesDownloaded`、`detail?` | 没用上补丁，接着走 electron-updater 自己的下载。 |

`reason` 取值：

| 原因 | 含义 |
|---|---|
| `base_universal` | 安装的是 universal 版本。什么都没下载。 |
| `base_version_mismatch` | 补丁不是给这个版本或架构的。 |
| `base_missing`、`base_modified` | 补丁需要的已安装文件不见了或被改过。 |
| `patch_corrupt` | 下载内容和更新源的 `sha512` 不符，或文件损坏。 |
| `verify_failed` | 重建出的文件和版本的 sha256 不符。 |
| `unsupported_format` | SDK 不认识的补丁格式。 |
| `download_failed` | 补丁下载失败。 |
| `install_rejected` | Squirrel.Mac 拒绝了打补丁得到的更新。 |
| `other` | 其他情况，例如交给 Squirrel 时失败。 |

某个版本的补丁失败后，本次运行内不会再试。用户取消下载时按取消处理，不会转成完整下载。

选项：

| 选项 | 默认值 | |
|---|---|---|
| `onEvent` | 无 | 事件回调（见上）。它抛出的异常会被忽略。 |
| `redownloadOnReject` | `true` | Squirrel.Mac 对打补丁的更新报错时，发出 `install_rejected` 并调用 `autoUpdater.downloadUpdate()` 下载完整版本。如果应用自己处理 Squirrel，设为 `false`，然后在重新下载前调用 `patches.reject(version)`。 |
| `version` | `autoUpdater.currentVersion` | 当前运行的版本，和更新源里的 `from` 对应。 |
| `arch` | `process.arch` | |
| `appBundle` | `process.execPath` 所在的 `.app` | 补丁的起点，只读不写。 |
| `isUpdateFile` | 文件名以 `-${arch}.zip` 结尾 | 版本文件里哪个是本架构的 zip。 |

返回的对象有 `enabled`、`patched(version)`、`reject(version)` 和 `dispose()`（恢复 electron-updater 原来的下载）。

### 客户端如何接入 {#how-the-client-hooks-in}

electron-updater 没有为此提供扩展点。SDK 替换更新器实例上的 `doDownloadUpdate`，然后继续使用 electron-updater 自己的步骤：`executeDownload`（缓存目录、进度和事件）、`httpExecutor.download`（拒收和更新源 `sha512` 不符的内容）、`provider.resolveFiles`，以及 `MacUpdater.updateDownloaded`（Squirrel.Mac 从中下载的本地代理）。重建出的 zip 不压缩，所以交给 Squirrel 时用它自己的大小和 sha512 代替版本 zip 的；更新源本身不变。

只要缺少其中任何一个方法，SDK 就发出 `unavailable`（`updater_internals`），不做其他事。测试会用 electron-updater 6.3.9 和 6.8.11 的真实 `MacUpdater` 跑这个钩子。

只有同时满足以下条件的补丁才会被选中：`from` 等于当前版本，`arch` 一致，`url` 是 zip 旁边的纯文件名 `*.patch`（不能是别的主机或目录），`size` 不超过 64 MiB，`sha512` 格式正确。

## 2. CI：生成补丁 {#2-ci-make-the-patches}

在 electron-builder、签名和公证之后，把版本的 `latest-mac.yml` 和 zip 放在一个目录里：

```bash
hands electron make-patches <appSlug> \
  --version-name "$VERSION" \
  --dir release \
  --update-feed release/latest-mac.yml
```

| 选项 | 默认值 | |
|---|---|---|
| `--version-name` | 必填 | 新版本，必须等于 `latest-mac.yml` 里的 `version`。 |
| `--dir` | 必填 | 放 `latest-mac.yml` 和 `<name>-<version>-<arch>.zip` 的目录。每个 zip 必须和 yml 里的 `sha512` 一致。 |
| `--channel` | `main` | base 所在的渠道。 |
| `--from-count` | `3` | 从低于新版本的最近几个版本做补丁（最多 10 个）。 |
| `--from <version>` | 无 | 改为只从这些版本做补丁。可重复。 |
| `--arch` | `arm64,x64` 中 yml 里有 zip 的 | 逗号分隔。 |
| `--name` | 从 zip 文件名推断 | 文件名前缀。 |
| `--out` | 同 `--dir` | `.patch` 文件和 `patches.json` 的输出目录。 |
| `--update-feed` | 无 | 在这个 yml 里加上 `patches`、`previousVersion` 和 `electronVersion`。原子写入，只有生成了补丁才写。 |
| `--max-share` | `0.4` | 补丁超过对应 zip 的这个比例就丢弃。 |
| `--max-bytes` | `64MiB` | 补丁超过这个大小就丢弃。客户端最多只接受 64 MiB。 |
| `--legacy-magic` | 关 | 文件开头用 `RAFTPAT1` 代替 `HANDPAT1`，给只认 Raft Desktop 原始格式的客户端用。magic 之后的字节完全相同。 |
| `--level` | `19` | zstd 压缩级别。 |
| `--json` | 关 | 把 `patches.json` 打印到标准输出。 |

**哪些版本作为 base。** 命令列出渠道上的版本（`GET /api/apps/:appId/releases?channel=<channel>&product_type=desktop-installer`，以及旧名称 `electron-installer`，因为用旧名称发布的版本也能作 base），保留版本号低于新版本的 `active` 和 `superseded` 版本，按 `version_code` 取最新的 N 个。对每个 base，先通过 `GET /api/apps/:appId/releases/:releaseId/electron-metadata/latest-mac.yml` 读取该版本自己的 `latest-mac.yml`（如果有替换文件，返回的是正在提供的替换文件）；再在构建资产里找到对应的 zip，通过 `GET /api/apps/:appId/builds/:buildId/assets/:assetId/download?presign=1` 下载，并和那份 yml 的 `sha512` 比对。请求预签名链接不会增加该资产的 `download_count`（不带 `presign=1` 下载才会）；这些下载也不经过 `/electron` 路由，所以同样不计入[下载统计](#measuring-download-stats)。每次运行最多下载 N × 架构数个 zip。

**每个补丁的处理。** 用 `unzip` 解开两个 zip，生成补丁；补丁大于 `min(--max-share × zip 大小, --max-bytes)` 就丢弃，否则把它应用到 base 应用上，再用 `diff -r --no-dereference` 比较生成的 zip 里的应用和新应用。各架构的 Electron 版本必须一致。

**失败时：**

- 最新的 base 失败：命令以 2 退出，不写补丁，yml 不变。可以不带补丁发布（比如给这一步设 `continue-on-error: true`），或者修好原因。
- 较旧的 base 失败：打印警告，跳过这个 base。
- 没有 base，或者所有补丁都太大：以 0 退出，`patches` 为空，yml 不变。

**输出。** `<out>/<name>-<version>-<arch>-from-<from>.patch`，以及 `<out>/patches.json`：

```json
{
  "previousVersion": "0.1.7",
  "electronVersion": "45.3.2",
  "patches": [
    { "from": "0.1.7", "arch": "arm64", "url": "My-App-0.1.8-arm64-from-0.1.7.patch", "size": 412345, "sha512": "…" }
  ],
  "slots": [
    { "file": "My-App-0.1.8-arm64-from-0.1.7.patch", "artifact_kind": "update-patch", "platform": "darwin", "arch": "arm64",
      "variant": "patch-from-0.1.7", "filetype": "patch",
      "metadata": { "from": "0.1.7", "algorithm": "app-patch-v1", "sha512": "…" } }
  ]
}
```

加了 `--update-feed` 时，yml 会多出同样的 `patches` 条目，以及 `previousVersion` 和 `electronVersion`（两者只作信息）。`files`、`path` 和 `sha512` 不变：

```yaml
patches:
  - from: 0.1.7
    arch: arm64
    url: My-App-0.1.8-arm64-from-0.1.7.patch
    size: 412345
    sha512: …
previousVersion: 0.1.7
electronVersion: 45.3.2
```

## 3. 发布 {#3-publish}

把 `.patch` 文件作为 zip 和更新后的 `latest-mac.yml` 所在的**同一个构建**的资产上传，`patches.json` 的每个 `slots` 条目对应一个：

| 字段 | 值 |
|---|---|
| `artifact_kind` | `update-patch` |
| `platform` | `darwin` |
| `arch` | 补丁的架构 |
| `variant` | `patch-from-<起始版本>` |
| `filetype` | `patch` |
| `metadata_json` | `{ "filename": "<文件>", "from": "<起始版本>", "algorithm": "app-patch-v1", "sha512": "<sha512>" }` |

创建构建时就要声明这些 slot。构建的 slot 在创建时固定，补丁不能事后追加到已发布的构建。`hands builds publish-electron` 目前还没有补丁选项，请在自己的发布步骤里按 `patches.json` 的 `slots` 上传。

## 关闭补丁与回滚 {#turning-patches-off-rolling-back}

补丁不受应用的 `delta_updates_enabled` 设置控制，那个设置只管 Android 增量下载。要停止提供某个已发布版本的补丁，用元数据替换把它 `latest-mac.yml` 里的 `patches` 删掉：

```bash
hands releases electron-metadata get <app> <releaseId> latest-mac.yml > latest-mac.yml
# 删掉 `patches:` 列表，然后：
hands releases electron-metadata set <app> <releaseId> latest-mac.yml --from latest-mac.yml
```

客户端一分钟内看到变化，照旧下载 zip（见 [CLI 参考](cli-reference.md#publish-electron-generic-provider)中“修改已发布版本的更新元数据”）。`revert` 会恢复补丁。要停止生成补丁，跳过 CI 里这一步即可。要回滚版本，取消它，之前版本的更新源就会重新生效。补丁不会让已安装的应用降级。

## 衡量效果：下载统计 {#measuring-download-stats}

Hands 按文件、按 UTC 日统计 `/electron` 路由响应的请求（[详情](public-api-reference.md)）：

```bash
hands api GET "/api/apps/<appId>/stats/electron-downloads?days=14"
```

- 只统计 `.patch` 文件、安装包和 zip、`.blockmap` 文件。检查更新（`latest*.yml`）不计数。
- 每个文件每天三个数：`full_requests`（不带 `Range` 头）、`range_requests`（带 `Range` 头；对 zip 而言通常是 blockmap 差分）和 `sources`，即按天对 IP 地址和 user agent 做哈希后的不同请求方数。原始 IP 不保存。
- 请求不去重：客户端重试会再计一次。要数客户端，用 `sources`。
- 补丁成功的客户端只请求 yml 和 `.patch`；回退的客户端还会出现在 zip 上。所以当天粗略的补丁命中率是：补丁的 `sources` /（补丁的 `sources` + zip 的 `sources`）。
- Hands 看不到客户端为什么回退，这要靠应用自己通过 `onEvent` 上报。

## 补丁格式 {#the-patch-format}

`@botiverse/hands-app-patch`（无依赖，只用 `node:zlib` 的 zstd）包含格式、应用端和生成端。文件以 8 字节 magic `HANDPAT1` 开头，接着是 zstd 压缩的 JSON 清单的长度（小端 u32）、清单本身和数据。读取端同样接受 `RAFTPAT1`，那是 Raft Desktop 发布时用的同一格式。清单列出新 `.app` 的每一项：

- 目录和符号链接；
- 文件，每个文件用三种方式之一构建：`copy`（字节相同的已安装文件）、`patch`（按 8 MB 分块，每块要么等于已安装文件同一位置的字节，要么以已安装文件为字典做 zstd 压缩）、`full`（单独 zstd 压缩）。

每个重建的文件都带 sha256。可信度来自更新源里 `.patch` 文件的 `sha512`（和 zip 一样经 HTTPS 提供）以及 Squirrel 的代码签名检查。被篡改的补丁最多只会导致校验失败，然后走完整下载。这个格式在更新源和资产里的名称是 `app-patch-v1`。
