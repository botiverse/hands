---
title: "发布桌面应用"
description: "按操作系统和架构发布任意运行时的桌面应用，支持按文件增量更新。"
category: "SDKs & API"
order: 19
---

# 发布桌面应用

无论桌面应用用什么构建，Hands 都用同一种方式发布：带 Java 运行时的 JVM/Compose 应用、原生应用、Tauri 应用，或任何以一个文件目录形式安装的程序。每个版本在每个机器目标上都包含一个用于首次安装的安装包，以及一份更新载荷，让已安装的副本只下载发生变化的文件。

现有的 `electron` 应用继续使用 `/electron/...` 下的 electron-builder 更新源（见[公开 API 参考](public-api-reference.md)中的 Electron 通用提供方），本页内容不影响它们。

## 模型 {#the-model}

| 概念 | 取值 |
| --- | --- |
| 应用平台 | `desktop` |
| 产品类型 | `desktop-installer`（每个新应用都会预置） |
| 目标 | `<os>-<arch>`：`darwin-arm64`、`darwin-x64`、`win32-x64`、`win32-arm64`、`linux-x64`、`linux-arm64` |
| 运行时 | 可选的应用属性：`jvm`、`electron`、`native`、`tauri` 或 `other` |

运行时只用于描述。Hands 记录并显示它，但不会因此改变应用的发布或更新方式。

```bash
hands apps create --slug raft-desktop --name "Raft" --platform desktop --runtime jvm
```

一个版本就是一个构建和一个版本记录，包含所有目标。目标逐个发布，通常每个目标一个 CI 任务：第一个创建构建和版本，之后的每个把自己的目标加到它们上。一个构建的每个目标包含两类文件。

**安装包**：给人使用的文件，例如 `dmg`、`pkg`、`msi`、`exe`、`AppImage`、`deb`。它是普通的构建文件，`artifact_kind` 为 `installable`。

**更新载荷**：分三部分。

1. 清单（`artifact_kind` 为 `desktop-manifest`，`filetype` 为 `json`），列出应用包或安装目录中的每个文件。
2. 应用包中的每个普通文件，按 SHA-256 在每个应用下只存一份，位置为 `apps/{appId}/files/sha256/{sha256}`。版本之间没有变化的文件（例如内置的 Java 运行时）只上传一次，之后的所有版本都复用它。
3. 应用包的完整压缩包（`artifact_kind` 为 `desktop-archive`，zip 格式），在无法应用增量更新时作为后备。

## 清单格式 {#manifest-format}

```json
{
  "schema": 1,
  "target": "darwin-arm64",
  "root": "Raft.app",
  "files": [
    { "path": "Contents/MacOS/Raft", "sha256": "3f2a…", "size": 123456, "mode": "755", "link": null },
    { "path": "Contents/Frameworks/X.framework/X", "link": "Versions/Current/X" }
  ],
  "total_size": 123456
}
```

| 字段 | 规则 |
| --- | --- |
| `schema` | `1` |
| `target` | 上述目标之一，且必须与上传该清单时声明的目标一致 |
| `root` | 应用包目录名（`Raft.app`、`Raft`），只能是一个路径段 |
| `files[].path` | 相对于 `root`，用 `/` 分隔；不能有空段、`.` 或 `..`，不能以 `/` 开头，不能带盘符、`\` 或控制字符；不能重复 |
| `files[].sha256`、`size` | 仅普通文件：小写十六进制摘要和字节数 |
| `files[].mode` | 仅普通文件：恰好三位八进制数字（`"644"`、`"755"`）；不允许 setuid、setgid 或粘滞位 |
| `files[].link` | 仅符号链接：链接目标，相对于链接所在目录；不带 `sha256` |
| `total_size` | 可选；提供时必须等于所有文件大小之和 |

目录由其下的路径隐含表示。任何条目都不能位于某个文件或符号链接之下。清单最大 8 MiB。

路径按目标文件系统的方式比较：在 `darwin-*` 和 `win32-*` 目标上，只有大小写或 Unicode 规范化形式不同的两个路径视为同一路径，按重复拒绝。在 `win32-*` 目标上，名称不能是保留设备名（`CON`、`PRN`、`AUX`、`NUL`、`COM1`-`COM9`、`LPT1`-`LPT9`，带不带扩展名都算），不能包含 `< > : " | ? *`，也不能以点或空格结尾。

每个符号链接都按文件系统的方式依据清单解析，途中会跟随其他符号链接，且每一步都必须留在应用包内。因此 `d/up -> ..` 可以接受，而 `l -> d/up/../..` 会被拒绝，因为跟随 `d/up` 之后它会越出根目录。超过 40 层的链接链或循环链接会被拒绝。

清单上传完成封存时，Hands 会解析它，并检查其中每个 `sha256` 都已以相同大小存储在该应用下。任一检查失败时，上传以 `DESKTOP_MANIFEST_INVALID` 或 `DESKTOP_MANIFEST_FILES_MISSING` 失败（后者最多列出 50 个缺失的摘要），构建保持待处理状态，不会发布任何内容。

## 在 CI 中发布 {#publish-from-ci}

```bash
hands builds publish-desktop raft-desktop \
  --target darwin-arm64 \
  --channel main \
  --version-name 1.4.0 \
  --version-code 1004000 \
  --bundle build/Raft.app \
  --archive build/Raft-1.4.0-darwin-arm64.zip \
  --installer build/Raft-1.4.0.dmg \
  --notes-file notes.md \
  --draft
```

该命令会：

1. 遍历应用包但不跟随符号链接，以流式方式计算每个普通文件的摘要，并记录每个符号链接的目标；遇到绝对路径或指向应用包外部的符号链接时停止；
2. 询问 Hands 哪些摘要尚未存储，只上传这些文件，直接写入存储，每次并发四个，失败时重试；
3. 让 Hands 校验每个已上传的文件；
4. 创建一个待处理构建，其必需文件槽为该目标的清单、压缩包和安装包，并上传它们；
5. 将构建标记为成功并创建版本（使用 `--draft` 时为草稿）。

命令会输出文件数量、上传的文件数及其大小，以及复用的文件数。`--json` 以 JSON 输出结果（目标被加到已有版本时 `appended` 为 `true`）。压缩包请用构建工具生成，例如在 macOS 上使用 `ditto -c -k --keepParent Raft.app Raft.zip`。

### 多个目标 {#several-targets}

每个目标运行一次命令，使用相同的 `--version-name` 和 `--version-code`。如果该版本在渠道上已有版本记录，命令会把这个目标的安装包、压缩包和清单加到该版本的构建上，版本记录本身保持不变（其更新说明和强制更新标记由第一个目标设置）。清单最后上传：在已发布的版本上，目标的清单一旦封存就会立即上线。

- 目标的清单封存后不能再修改。用相同的文件再次发布不会有任何变化；用不同的文件发布会以 `DESKTOP_TARGET_EXISTS` 失败，请发布新版本。
- 只有草稿或有效的版本可以添加目标；已被取代或已取消的版本会以 `DESKTOP_RELEASE_NOT_APPENDABLE` 失败。
- 与所有发布命令一样，智能体和部署令牌必须传入 `--draft`，且只能在版本仍是草稿时添加目标。向有效版本添加目标只能由人操作（否则返回 `AGENT_ACTIVE_RELEASE_FORBIDDEN`）。常见流程是：用 `--draft` 发布所有目标，审核后执行 `hands releases publish`。
- 两个任务同时开始发布同一版本时会自动协调：竞争失败的一方把自己的目标加到胜出方的版本上。

以有效状态发布新版本会取代渠道上的上一个版本，因此新版本尚未包含的目标在被添加之前不会收到更新。先以草稿发布，最后一个目标完成后再激活，可以避免这段空档。

## 检查更新 {#check-for-an-update}

```http
GET /public/v2/apps/:slug/desktop/update?target=darwin-arm64&channel=main&current_version_code=1003000
X-Hands-Device-Id: 2f1c…
```

| 参数 | 必需 | 含义 |
| --- | --- | --- |
| `target` | 是 | 已安装副本的目标 |
| `current_version_code` | 是 | 已安装的版本号（非负整数） |
| `channel` | 否 | 渠道标识，默认 `main`；公开别名 `latest` 解析为 `main` |
| `installer_filetype` | 否 | 同一目标有多个安装包时，优先选择该文件类型 |
| `X-Hands-Device-Id` | 否 | 每次安装稳定不变的标识；接收分阶段发布时需要 |

Hands 选择版本的方式与[公开 API 参考](public-api-reference.md)中的“最新版本”相同：先匹配最具体的范围，再选最新激活的版本，分阶段发布按设备标识放行。它只考虑未隐藏、已到可用时间、且构建带有该目标清单的有效版本。只提供经直接上传协议封存的文件（字节已校验，清单所列文件也已检查）；桌面清单和压缩包无法通过其他方式登记。

有更新版本时：

```json
{
  "update_available": true,
  "channel": "main",
  "target": "darwin-arm64",
  "current_version_code": 1003000,
  "release": {
    "id": "6c0e…",
    "version": "1.4.0",
    "version_code": 1004000,
    "notes_url": "https://hands.build/apps/raft-desktop/v/1.4.0",
    "force_update": false,
    "released_at": 1795000000000
  },
  "manifest": { "url": "https://hands.build/public/r2/…", "sha256": "…", "size": 48211 },
  "full_archive": { "url": "https://hands.build/public/r2/…", "sha256": "…", "size": 201326592 },
  "installer": { "url": "https://hands.build/public/r2/…", "sha256": "…", "size": 210763776, "filetype": "dmg" },
  "files_url_template": "https://hands.build/public/v2/apps/raft-desktop/files/{sha256}",
  "expires_in": 3600
}
```

构建在该目标上没有压缩包或安装包时，`full_archive` 和 `installer` 为 `null`。各 `url` 已签名，在 `expires_in` 秒后过期；请在检查后尽快下载，或重新检查。

否则：

```json
{ "update_available": false, "channel": "main", "target": "darwin-arm64", "current_version_code": 1004000, "latest_version_code": 1004000 }
```

该目标没有任何符合条件的版本时，`latest_version_code` 为 `null`。应用或渠道不存在时返回 404；`target` 或 `current_version_code` 无效时返回 400。

## 下载文件 {#download-a-file}

```http
GET /public/v2/apps/:slug/files/:sha256
```

返回 `302`，指向该文件的短期签名 URL。只有当经过校验的清单引用了这个摘要，且该清单属于该应用一个成功的构建、其版本有效或已被取代、未隐藏、不是 QA 且已到可用时间时，Hands 才会响应；其他摘要或属于其他应用的摘要返回 `404`。

## 应用更新 {#applying-an-update}

客户端通常：

1. 下载清单并校验其 `sha256`；
2. 与已安装的文件比较，从文件接口下载每个变化或新增的 `sha256`，并校验每个文件的摘要和大小；
3. 在已安装的应用包旁组装新应用包（设置 `mode`，创建符号链接），然后替换；
4. 第 2 或第 3 步失败时改用 `full_archive`，同样校验其 `sha256`。

## Kotlin 客户端 {#kotlin-client}

`build.hands:hands-desktop-updater`（源码在 `clients/desktop-jvm`，尚未发布首个版本）为 JVM 应用（例如用 jpackage 打包的 Compose Desktop 应用）在 macOS 和 Linux 上实现了上述步骤。它需要 JDK 17+（jlink 生成的运行时需包含 `java.net.http` 模块），只依赖 `kotlinx-serialization-json`。

```kotlin
import build.hands.desktop.*
import kotlin.io.path.Path

val stateDir = Path(System.getProperty("user.home"), "Library/Application Support/Raft/hands-updates")
// jpackage 启动器会把 jpackage.app-path 设为 .../Raft.app/Contents/MacOS/Raft
val installRoot = Path(System.getProperty("jpackage.app-path")).parent.parent.parent

val updater = HandsDesktopUpdater(
    appSlug = "raft-desktop",
    currentVersionCode = 1004000,       // 本构建的 --version-code
    installRoot = installRoot,
    stateDir = stateDir,
    deviceId = loadOrCreateDeviceId(),  // 每个安装生成并保存一次的 UUID
)

fun main() = application {
    Window(onCloseRequest = ::exitApplication, title = "Raft") {
        var ready by remember { mutableStateOf<PreparedUpdate?>(null) }
        LaunchedEffect(Unit) {
            updater.markLaunchSucceeded()   // 窗口已显示：这个版本可用
            ready = withContext(Dispatchers.IO) {
                updater.loadPrepared() ?: when (val check = updater.checkForUpdate()) {
                    is UpdateCheck.Available -> updater.prepare(check) { /* 进度 */ }
                    is UpdateCheck.NoUpdate -> null
                }
            }
        }
        ready?.let { update ->
            Button(onClick = { updater.installAndRestart(update); exitApplication() }) {
                Text("重启以更新到 ${update.release.version}")
            }
        }
    }
}
```

| 调用 | 时机 | 作用 |
| --- | --- | --- |
| `checkForUpdate()` | 启动时及定期，在 UI 线程之外 | 即[检查更新](#check-for-an-update)；返回 `NoUpdate` 或 `Available`（含 `forceUpdate`） |
| `prepare(update, progress)` | 拿到 `Available` 后立即调用（其 URL 会过期） | 用已安装的未变文件加下载的文件构建并校验 `stateDir/staging/<version_code>/<root>`；失败时删除它并抛出异常，已安装的应用不受影响 |
| `installAndRestart(prepared)` | 用户同意重启时；随后退出应用 | 启动一个独立的辅助脚本：等应用退出，把安装目录移到 `stateDir/backup/`，移入新目录树并重新启动；新版本 60 秒内未确认则回滚 |
| `markLaunchSucceeded()` | 每次启动、应用确认可用后（首个窗口显示时） | 向辅助脚本确认启动成功；清理旧的暂存目录和备份 |

`stateDir` 归应用所有，存放暂存的目录树、上一版本的一份备份、辅助脚本及其日志：macOS 上用 `~/Library/Application Support/<App>/hands-updates`，Linux 上用 `~/.local/state/<app>/hands-updates`；它必须在安装目录之外，最好与安装目录在同一卷上，这样替换只是一次重命名。用户必须有权重命名安装目录。在 Linux 上，除非正在运行的可执行文件位于安装目录内，否则需要给 `installAndRestart` 传入 `launcher`（例如 `bin/Raft`）。Windows 上可以检查和准备更新，但 `installAndRestart` 尚未实现。

## 完整性与签名 {#integrity-and-signing}

每个文件都按 SHA-256 寻址和校验：上传内容与声明的摘要不符时 Hands 会拒绝，客户端也会按清单校验每次下载。Hands 不会对桌面应用签名或公证。代码签名（Developer ID 与公证、Authenticode、安装包签名）由你的构建负责：发布前先签名应用包，这样 Hands 存储的就是已签名的文件。

## 发布方 API {#publisher-api}

CLI 使用以下接口；拥有该应用发布者角色的任何客户端或部署令牌都可以调用。

```http
POST /api/apps/:appId/desktop/files/missing
{"files":[{"sha256":"…","size":123}]}
```

最多 1,000 项；应用包较大时请分批询问。返回 `{"missing":[{"sha256","size","upload_url","headers","expires_at"}],"present_count":N}`；请在一小时内用给定的 `content-type` 头把每个缺失文件 PUT 到对应的 `upload_url`。URL 过期（`403`）时，为该摘要重新询问。从未完成的上传会留在暂存区，直到应用被删除时随应用的其他文件一起移除。

```http
POST /api/apps/:appId/desktop/files/complete
{"files":[{"sha256":"…","size":123}]}
```

最多 100 项。Hands 把每个已上传的文件复制到按内容寻址的存储中，拒绝摘要或大小不符的文件，并返回 `{"ok","stored","present","failed","results":[{"sha256","size","status","retryable"}]}`。`status` 为 `stored`、`present`（已存储）、`missing_upload`、`size_mismatch`、`sha256_mismatch` 或 `storage_error`（`retryable: true`）。重复完成是安全的。

清单、压缩包和安装包通过普通的直接构建文件上传协议上传（见 [CLI 参考](cli-reference.md)），`platform` 和 `arch` 取自目标。
