---
title: "公开 API 参考"
description: "公开更新检查、最新版本和客户端集成约定。"
category: "SDKs & API"
order: 16
---

# 公开 API 参考

> **交互式 API 浏览器：**完整请求和响应结构位于 OpenAPI 规范中，可在 [API 浏览器](/api-docs)查看和尝试，也可读取 [openapi.json](https://hands.build/openapi.json)。

Hands 公开 API 允许应用在没有 Hands 管理员会话时检查更新、下载版本文件、提交反馈及查看分享和历史页面。

发布请使用管理 API 或命令行；客户端使用公开 API。

## 基础 URL

```text
https://hands.build
```

自行托管的部署应使用自己的来源地址。

## 检查更新

```http
GET /public/v2/apps/:appSlug/updates/check?channel=main&product_type=android-apk&current_version_code=1000000&platform=android&arch=arm64-v8a&filetype=apk
```

### 查询参数

| 名称 | 必填 | 说明 |
|---|---|---|
| `channel` | 否 | 发布渠道，例如 `main`（默认）、`preview`、`nightly` 或 `debug`。 |
| `current_version_code` | 是 | 已安装客户端的版本号。 |
| `product_type` | 否 | 产品类型，例如 `android-apk`。 |
| `platform` | 否 | 客户端平台，例如 `android`。 |
| `arch` | 否 | 客户端架构，例如 `arm64-v8a`。 |
| `filetype` | 否 | 需要的可安装文件类型，默认为 `apk`。 |
| `lang` | 否 | 首选更新说明语言，例如 `zh-CN` 或 `en`。也可从 `X-Hands-Lang` 或 `Accept-Language` 读取。 |
| `device_id` | 否 | 每次安装稳定的标识符，也可从 `X-Hands-Device-Id` 读取。参与分阶段发布时必填。 |

提供 `arch` 时，Hands 首先选择平台和架构完全匹配的文件；没有精确架构文件时，回退到该平台的通用文件（`arch: null`），例如通用 Android APK。这样上报 ABI 的客户端也可以使用仅以单个通用包发布的版本。

### 分阶段发布

版本可以向一定比例的设备发布。服务端通过对 `(release_id, device_id)` 计算哈希为客户端分桶，因此比例上升时设备保持原分桶。没有发送设备 ID 的客户端只能看到已全量发布的版本；被比例限制排除的客户端回退到前一个活动版本。Android SDK 自动发送该请求头。

要精确指定质量检查或客户设备，发布者可以创建应用级设备组，并使用 `device_group` 发布范围。服务端根据相同的稳定安装 `device_id` 判断成员关系；客户端不会收到或选择组名。非成员回退到前一个匹配的活动版本。设备组使用安装标识符，不使用 IMEI、硬件序列号或账号身份。

单个版本可以包含 `full:all` 及一个或多个 `device_group` 范围。即使百分比分桶超出 `rollout_cohort_count`，组成员仍始终收到该版本。非成员仍受百分比限制；发布达到 100% 之前，匿名客户端使用先前符合条件的全量版本。不要将这两类受众建模为同一版本号的两个版本。

范围写入采用失败即拒绝：创建通用版本时省略 `scopes` 会默认使用 `full:all`；但显式提供 `scopes` 时必须是非空数组，每项均有非空 `scope_type` 和 `scope_value`，重复项会被拒绝。`full:all` 只能与 `device_group` 项组合。发布时传入完整规范集合，例如：

```json
{
  "expected_revision": 4,
  "expected_scopes": [
    { "scope_type": "full", "scope_value": "all" },
    { "scope_type": "device_group", "scope_value": "<group UUID>" }
  ]
}
```

Hands 在受保护的激活操作内再次检查精确集合。范围缺失、格式错误、重复、出现非预期值或发生变化时返回 `409 RELEASE_SCOPE_PRECONDITION_FAILED`。`expected_scope` 是旧版单范围兼容字段；新调用方应始终发送 `expected_scopes`。版本详情还提供整数 `revision`；执行 PATCH、发布、取消、恢复、提高发布比例和强制更新写入时，将该值作为 `expected_revision` 发送。修订号过期返回 `409 RELEASE_REVISION_CONFLICT`，不会更改版本、其范围、回退版本或审计日志。

管理版本 API 对每个应用、渠道、产品、发布类型和版本号只允许一个**未取消**的生命周期。重复创建返回 `409 RELEASE_VERSION_ALREADY_EXISTS` 及当前版本、构建和状态标识。取消会停用该生命周期并释放版本号供修正构建使用，同时保留旧版本、构建、文件和审计历史。只有没有替代版本占用该组合时，回滚接口才恢复已取消记录，否则返回同样的结构化 409。`activated_at` 为 null 的已取消记录从未发布；符合条件的恢复会将其转回 `draft`，并须通过正常发布就绪、精确范围、外部目标和修订号检查。只有此前活动的记录才以新的激活时间恢复为 `active`。复用组合不会使已经收到该版本的客户端安装不同内容；客户端修正应使用更高版本号发布。

要冻结已发布版本而不撤销已有分享链接，可在管理发布控制中将其稳定全量范围的发布比例设为 `0`。这是分发指向变更，不是删除版本或撤销分享：现有 `/share/...` URL 和文件下载仍可用，公开最新版本及更新解析会跳过零比例版本，解析到前一个符合条件的活动版本。修改后请重新读取两个解析响应和已有分享，并在回执中记录版本修订号及前一个符合条件的版本。不要声称发布比例为 `0` 会追溯移除已安装的构建。

每次解析回读都要记录查询客户端版本及是否提供设备 ID。未提供设备 ID 的读取是检查全量发布版本的确定性探测；目标发布比例严格介于 `0` 与 `100` 之间时，单次带设备 ID 的读取不足以证明指向正确，因为结果取决于设备的稳定分桶。

恢复分发时，不要从冻结版本推断目标，也不要盲目恢复到 `100`。版本负责人必须明确选择目标版本或发布记录及百分比，并考虑冻结期间可能创建的更新且符合条件的版本。变更前重新读取目标版本修订号，应用选定比例后再次读取版本、公开最新版本与更新响应以及预期分享 URL。在回执中记录负责人选择的目标、最终修订号和比例，以及解析和分享回读结果。恢复比例本身不能证明公开指向已恢复到正确版本。每次最新版本或更新回读也要记录查询客户端版本及是否提供设备 ID；目标比例严格介于 `0` 与 `100` 之间时，应包含未提供设备 ID 的确定性探测，不能将单次带设备 ID 的结果作为充分证据。

### 有可用更新

```json
{
  "update_available": true,
  "app": { "slug": "raft-android", "platform": "android" },
  "channel": "main",
  "current_version_code": 1000000,
  "latest": {
    "build_id": "…",
    "version": "1.0.1",
    "version_code": 1000100,
    "changelog": "Bug fixes and improvements",
    "release_notes": {
      "en": "Bug fixes and improvements",
      "zh-CN": "修复问题并优化体验"
    },
    "force_update": false,
    "released_at": 1783162273735
  },
  "asset": {
    "platform": "android",
    "arch": "arm64-v8a",
    "filetype": "apk",
    "size_bytes": 29192396,
    "sha256": "9f86d081…",
    "download_url": "https://hands.build/public/r2/…"
  },
  "scoped": { "scope_type": "full", "scope_value": "all", "release_id": "…", "rollout_cohort_count": null }
}
```

`changelog` 已本地化：版本可以包含按语言区分的说明，服务端按精确标签 → 语言前缀 → `en` → 首个可用内容的顺序返回最匹配项。`release_notes` 是结构化的多语言对象，供需要所有可用语言而不解析旧版 `changelog` 字符串的使用方使用。

### 无更新

```json
{ "update_available": false, "current_version_code": 1000100, "latest_version_code": 1000100 }
```

## 最新版本

```http
GET /public/v2/apps/:appSlug/latest?channel=main&product_type=android-apk
```

返回渠道中最新的兼容可安装版本，不受客户端已安装版本影响。接受与更新检查相同的 `lang` 和 `device_id`。渠道可能包含多种产品形式时应传入 `product_type`；不传时，服务端选择所有类型中最新的活动版本。

### 统一文件结构

无论文件字节存放在哪里，`assets` 始终使用同一结构：

```json
{
  "platform": "linux",
  "arch": "x64",
  "variant": null,
  "filetype": "binary",
  "size_bytes": 119437512,
  "sha256": "b1946ac9…",
  "download_url": "https://hands.build/dl/my-cli/releases/rel-…/linux-x64"
}
```

有两种存储来源：

- **上传的文件**（APK、IPA、安装程序）：Hands 存储字节，`download_url` 是限时签名 URL。`filetype` 反映文件类型（`apk`、`dmg` 等）。
- **外部构建**（`cli-binary`，如字节保留在发布者 CDN 上的 Node SEA 或命令行可执行文件）：Hands 充当注册表。发布时发布者声明各目标的来源 URL、大小和 SHA-256；Hands 不可变地记录这些身份，CDN 仍是字节的权威来源。`/latest` 将声明投影为相同结构：`platform` / `arch` 从目标名派生，`filetype` 为 `binary`，`download_url` 是不可变且绑定版本的 `/dl/:appSlug/releases/:releaseId/:target` 路由。它返回 302 指向声明的来源 URL，即使版本已被替代，也继续解析到相同字节。

绑定版本的 `/dl` 路由提供活动版本和已替代版本的下载，所以之前发出的 URL 会一直有效。已替代版本如果被隐藏，或是 QA 构建，返回 `404`。

安装器无需区分来源：按 `platform` / `arch` 选择、下载、验证并安装即可。

## 命令行版本索引

```http
GET /public/v2/apps/:appSlug/versions?channel=alpha&platform=linux&arch=x64&limit=20
```

列出某个渠道和机器目标仍可普遍安装的精确 `cli-binary` 版本。只有发布比例完成的活动和已替代全量范围版本才会包含（`rollout_cohort_count` 为 null 或 100）；部分发布、草稿、已取消、隐藏、未来和目标不兼容的版本均排除。部分发布记录仍由考虑设备的更新解析器处理。已替代的全量版本仍可通过不可变且绑定版本的 `/dl` 路由下载，因此可用于明确回滚。

```json
{
  "schema_version": 1,
  "app": { "id": "…", "slug": "raft-computer-cli", "platform": "desktop" },
  "channel": "alpha",
  "target": { "platform": "linux", "arch": "x64" },
  "truncated": false,
  "versions": [
    {
      "version": "1.0.22",
      "version_code": 1000022,
      "status": "active",
      "published_at": 1788136459536,
      "release_id": "…",
      "sha256": "0f72382c…",
      "size_bytes": 156503232
    }
  ]
}
```

接口验证每个返回目标的身份。如果两个版本声称相同版本号却对应不同字节，或完整性元数据格式错误，请求会失败并拒绝返回部分索引。`limit` 默认 20、上限 100；`truncated: true` 表示有更旧版本因响应限制被省略。

### 使用 `sha256` 验证下载

每个文件条目包含发布时登记的文件字节 SHA-256 小写十六进制值。安装前应据此验证下载的字节：

```sh
curl -fL -o app "$download_url"
echo "$sha256  app" | sha256sum --check --strict
```

这将“Hands 解析的版本”与“CDN 提供的字节”绑定：上传未完成、缓存节点过期、URL 指向错误或对象意外覆盖都会导致校验失败，避免安装错误内容。哈希不能替代传输安全，它与 HTTPS 互补，用于发现传输层无法察觉的内容变化。

## 更新说明 JSON

```http
GET /public/v2/apps/:appSlug/release-notes?version_code=1000100&lang=zh-CN
```

以 JSON 返回公开更新说明，适合不应解析 `/notes/:appSlug` HTML 页面的客户端。应用必须启用公开历史。`version_code` 为可选；提供时响应包含该版本和更旧的未取消版本。只有草稿匹配请求的 `version_code` 时才返回草稿说明，以支持发布前预览。

```json
{
  "app": { "slug": "raft-android", "name": "Raft Android", "platform": "android" },
  "requested_version_code": 1000100,
  "lang": "zh-CN",
  "releases": [
    {
      "release_id": "…",
      "status": "active",
      "channel": "main",
      "version": "1.0.1",
      "version_code": 1000100,
      "released_at": 1783162273735,
      "changelog": "修复问题并优化体验",
      "release_notes": {
        "en": "Bug fixes and improvements",
        "zh-CN": "修复问题并优化体验"
      }
    }
  ]
}
```

经过认证的版本 API 也会在 `GET /api/apps/:appId/releases/:releaseId` 和版本列表行中提供 `release.release_notes`。发布者可以使用 `release_notes` 写入结构化说明：

```http
PATCH /api/apps/:appId/releases/:releaseId
Content-Type: application/json

{
  "release_notes": {
    "en": "Bug fixes and improvements",
    "zh-CN": "修复问题并优化体验"
  }
}
```

`changelog` 仍是本地化显示字符串；`release_notes` 是供需要所有语言的使用方使用的权威结构化对象。

## Electron 通用提供方

使用 `electron-updater` 的 Electron 应用可以将通用提供方指向 Hands：

```ts
autoUpdater.setFeedURL({
  provider: "generic",
  url: "https://hands.build/electron/:appSlug/:channel"
});
```

应用随后直接请求 electron-builder 的标准文件：

```http
GET /electron/:appSlug/:channel/latest.yml
GET /electron/:appSlug/:channel/latest-mac.yml
GET /electron/:appSlug/:channel/latest-linux.yml
GET /electron/:appSlug/:channel/:installerFile
GET /electron/:appSlug/:channel/:installerFile.blockmap
```

Hands 从该渠道的活动 `desktop-installer` 版本提供这些文件（旧名称 `electron-installer` 也同样接受）。Hands 有意原样托管 electron-builder 生成的文件：将 `latest*.yml`、安装程序和 `.blockmap` 文件作为构建文件上传。`latest*.yml` 使用 `artifact_kind = electron-metadata`；在 `variant` 或 `metadata_json.filename` 中使用原始文件名，以保持 yml 中的相对 URL 可解析。

文件约定示例：

| 文件 | `platform` | `arch` | `filetype` | `artifact_kind` |
|---|---|---|---|---|
| `latest.yml` | `win32` | `x64` 或 null | `yml` | `electron-metadata` |
| `latest-mac.yml` | `darwin` | `arm64` 或 `x64` | `yml` | `electron-metadata` |
| `latest-linux.yml` | `linux` | `x64` 或 `arm64` | `yml` | `electron-metadata` |
| `Raft Setup 1.2.3.exe` | `win32` | `x64` | `exe` | `installable` |
| `Raft Setup 1.2.3.exe.blockmap` | `win32` | `x64` | `blockmap` | `electron-blockmap` |

macOS 更新仍要求签名的应用文件。Hands 只托管已构建并签名的文件，不会为 Electron 应用签名。

## 提交反馈

```http
POST /public/v2/apps/:appSlug/feedback
Content-Type: multipart/form-data
X-Hands-Client-Key: qk_...
```

需要应用的**客户端密钥**，采用类似 Sentry DSN 的模型：它标识应用，不是用户秘密。通过 `X-Hands-Client-Key` 请求头或 `client_key` 查询参数传入；缺失或不匹配返回 `401`。为向后兼容，仍接受旧版 `X-Quiver-Client-Key` 请求头。管理员可在应用设置页或通过 `GET /api/apps/:id/client-key` / `POST /api/apps/:id/rotate-client-key` 查看和轮换密钥。

| 字段 | 必填 | 说明 |
|---|---|---|
| `message` | 是 | 反馈文本，最多 10,000 个字符。 |
| `submission_id` | 否 | 客户端生成的 UUID，用于幂等重试；同一草稿保持不变。完全相同的重放返回原工单，相同 ID 使用不同内容返回 `409`（见 [`submission_id` 冲突](#submission-id-conflicts)）。 |
| `kind` | 否 | `feedback`（默认）、`bug` 或 `crash`。 |
| `contact` | 否 | 回复联系方式，例如电子邮件或 Raft 名称。 |
| `metadata` | 否 | JSON 字符串：`version_name`、`version_code`、`channel`、`device_id`、`device_model`、`os_version`、`arch`、`locale` 及自定义键。崩溃工单附加 `crash_exception_class` / `crash_top_frame`（分组签名）。QNC2 Android 原生报告增加 `crash_native_frames`（`{ index, offset, soname, build_id, source }`）、`crash_registers`、崩溃线程字段及 `crash_native_images`；服务端符号化要求每帧 BuildId 与构建的 `native-symbols` 文件完全匹配。API 30 及以上报告还可能包含 `crash_exit_*` 元数据和保留的系统跟踪附件。 |
| `attachments` | 否 | 内联文件（multipart），每个最多 10 MB，总数最多 9 个。 |
| `presigned` | 否 | 已通过下述预签名流程上传的文件组成的 `{ r2_key, filename, content_type, size }` JSON 数组。 |

新工单返回 `201`。完全相同的 `submission_id` 重放返回 `200`、同一工单和 `idempotent_replay: true`。两种响应均在 `id` 中包含完整工单 UUID，并包含可复制的 `reference` 和 `ticket_url`。`attachment_refs` 提供每个附件稳定的 Hands UUID 和文件名；旧版 `attachment_names` 列表仍可使用。新提交和幂等重放返回相同附件引用，例如：

```json
{
  "id": "<ticket UUID>",
  "status": "open",
  "attachment_names": ["diagnostics.zip"],
  "attachment_refs": [
    { "id": "<attachment UUID>", "filename": "diagnostics.zip" }
  ],
  "reference": "raft-android · 1.0.4 (1000400) · ticket <ticket UUID>\nattachments:\n<attachment UUID> · diagnostics.zip",
  "ticket_url": "https://app.hands.build/apps/<appId>/feedback/<ticket UUID>"
}
```

#### `submission_id` 冲突 {#submission-id-conflicts}

重复使用 `submission_id` 返回的 `409` 带有稳定的 `code`。请根据 `code` 分支处理，不要依赖 `error` 文本；为兼容旧客户端，`error` 文本保持不变。旧版服务器可能只返回 `error`。

| Code | 原因 |
| --- | --- |
| `submission_reporter_mismatch` | 该 ID 已为其他报告者身份创建工单（不同的 `X-Hands-Reporter-Id`，或可信与匿名之间）。请使用新的 `submission_id`。 |
| `submission_payload_mismatch` | 该 ID 已为当前报告者创建工单，但消息、类型、联系方式、元数据或附件不同。不要用同一 ID 重试；真正的新报告请使用新 ID。 |

```json
{
  "error": "submission_id already used with a different payload",
  "code": "submission_payload_mismatch",
  "id": "<existing ticket UUID>"
}
```

仅当请求来自已认证的可信报告者（`X-Hands-Reporter-Id` 加 `feedback:write` 令牌）且该报告者拥有已有工单时，`submission_payload_mismatch` 才包含 `id`。匿名提交和 `submission_reporter_mismatch` 从不包含工单 ID。报告人评论在 `submission_id` 对应不同正文或附件集合时也返回相同的 `submission_payload_mismatch`。

速率限制：每个应用和客户端 IP 每小时 10 次提交。工单出现在管理控制台的反馈页；订阅的端点会收到 `feedback:new` Webhook，崩溃工单还可能触发 `crash:new_group` / `crash:spike`。Android SDK 的 `HandsFeedback.submit(...)` 封装了此接口，并自动附加设备元数据。

### 可信服务端代理的限流身份

通过同一个出口 IP 代理大量已登录用户的服务器可以同时发送以下两项，以避免共用全局限流桶：

```http
Authorization: Bearer qvdt_...  # 已授予 feedback:write
X-Hands-Reporter-Id: <stable opaque base64url value>
```

Bearer 必须是未过期、未撤销、无角色且绑定到启用报告人集成的应用令牌。其非空权限集合必须包含 `feedback:write`，并且只能包含 `feedback:write`、`feedback:read`、`feedback:comment` 和 `feedback:route`。可信对话流程在首次提交前绑定不可变路由主体。限定范围的令牌不会继承旧版查看者或发布者角色；除非路由明确要求其命名权限之一，否则不能用于认证 Hands 管理或读取 API。

可选报告人 ID 是集成方选择的外部主体标识，应稳定、不透明且限定于应用和集成，例如存储在集成方账号表中的随机 ID 或带密钥的化名；绝不能使用原始电子邮件地址、用户名或内部数据库 ID。Hands 将它保存为工单的化名所有者，并通过已认证的工单和 Webhook 约定返回；集成方自行决定是否维护反向映射以支持双向沟通。省略 ID 会产生匿名且无法定向的工单。Hands 对应用和报告人 ID 的组合实施每小时 100 次的安全限制；可信代理可实施自己的更低产品限制。发送报告人请求头但没有匹配的应用部署令牌时返回 `401`；普通 SDK 提交省略该请求头后仍使用应用加客户端 IP 的每小时 10 次限制。限流响应包含动态 `Retry-After` 请求头。

### 报告人拥有的对话 API

可信服务端代理只能列出并继续自己报告人的工单：

```http
GET  /api/apps/:appId/reporter-feedback
GET  /api/apps/:appId/reporter-feedback/:ticketId
POST /api/apps/:appId/reporter-feedback/:ticketId/comments
POST /api/apps/:appId/reporter-feedback/:ticketId/close
GET  /api/apps/:appId/reporter-feedback/:ticketId/attachments/:attachmentId
Authorization: Bearer qvdt_...
X-Hands-Reporter-Id: <stable opaque value>
```

令牌必须无角色、绑定到启用的报告人集成、包含路由所需的 `feedback:read` 或 `feedback:comment` 权限，且不得包含非反馈权限。归属是精确的 `(应用, 报告人集成, 报告人 ID)` 组合。列表只返回拥有的工单；指定目标不属于该报告人或工单 UUID 格式错误时返回 `404`，不会暴露其他报告人的数据。

列表和详情响应包含以 Hands 为准的未读状态：每张工单有 `unread` 和 `unread_count`，响应有 `unread_total`（具有未读、可见的工作人员或系统回复的所属工单数）。成功读取详情时，单调递增的已读回执推进至返回评论页中最新的可见回复；并发或之后到达的回复仍为未读。报告人评论和工作人员内部备注不会产生未读状态。后台读取详情可加 `mark_read=false` 避免推进回执；不带参数时保持默认行为。

列表按最近对话活动时间倒序：有可见评论时使用最新可见评论的时间（包括报告人评论），否则使用工单创建时间。每张列表工单还包含 `latest_comment`，即最新可见评论的 `{ author_type, body_preview, created_at }`，其中 `body_preview` 为正文前 280 个字符；没有评论时为 `null`。工作人员内部备注不会改变工单顺序，也不会作为最新评论出现。`latest_comment` 是列表字段，详情响应不包含。旧版按创建时间排序的游标仍然有效，并继续按原顺序分页。

独立的仅限服务端 `GET /api/apps/:appId/reporter-feedback/changes` 使用绑定到启用报告人集成、拥有 `feedback:read` 的反馈令牌协调该集成内的工单变化，不接受单个报告人的短期会话。首次不带游标从当前位置开始，不重放历史。后续返回 `changes`、`next_cursor` 和 `has_more`；每项仅有 `ticket_id`、可为空的 `route_subject`、假名 `reporter_id` 和可为空的 `comment_id`（当前最新公开工作人员／系统回复 ID，不是事件 ID）。内部备注也会产生无正文的信号，同一工单多次变化会合并。请使用 `mark_read=false` 读取全部公开详情页、按公开评论 ID 去重，并在整页处理完成后保存游标。游标加密并绑定应用和集成，反馈审计密钥轮换会使其失效。详见[后台协调约定](server-feedback.md#后台协调反馈变化)。

可信报告人创建首个工单前，使用 `feedback:route` 权限绑定不可变的不透明路由主体：

```http
PUT /api/apps/:appId/reporter-feedback/route-subject
Authorization: Bearer qvdt_EXAMPLE_DO_NOT_USE
X-Hands-Reporter-Id: <stable opaque value>
Content-Type: application/json

{ "route_subject": "rfr_v1_<opaque base64url value>" }
```

新绑定返回 `201`，完全相同的重放返回 `200`；同一归属组合使用不同主体时返回 `409`。缺少绑定的可信提交在保存工单或附件之前返回 `409 route_required`。

报告人评论需要客户端生成 UUID `submission_id`：新评论返回 `201`，完全相同的重放返回 `200`，同一 ID 对应不同的去除首尾空白后的文本或附件字节时返回 `409`，code 为 `submission_payload_mismatch`。纯文本回复仍支持 JSON。Multipart 回复使用 `body`、`submission_id` 和最多三个 `attachments`；每个文件必须是 GIF、JPEG、PNG 或 WebP，且不超过 10 MiB。原始提交附件和报告人评论附件均通过私有、禁止缓存、安全处置及禁止嗅探请求头提供。

#### 可选的短期服务端会话（默认关闭）

Hands 为服务器集成启用报告人会话后，可信代理可以使用部署令牌换取 30 秒会话：

```http
POST /api/apps/:appId/reporter-feedback/session
Authorization: Bearer qvdt_...
X-Hands-Reporter-Id: <stable opaque value>
Content-Type: application/json

{ "scopes": ["feedback:read", "feedback:comment"] }
```

签发仍执行完整的部署令牌、应用、启用的集成和权限检查。成功的 `201` 返回 `session_token`、以 Unix 秒表示的 `expires_at`、精确的 `reporter_integration_id` 和规范化的已授予 `scopes`。集成 ID 是代理会话缓存键的必需组成部分。会话必须留在可信代理中：不要持久化、写日志或返回给浏览器。同一组报告人路由接受该会话作为 Bearer，并仍要求完全相同的 `X-Hands-Reporter-Id`；应用或报告人不匹配时在访问工单前失败。报告人请求头在部署令牌已有的集成权限内选择报告人，本身并非独立的报告人认证。

签发操作按来源令牌、集成和审计 HMAC 报告人化名限流，限流检查失败时拒绝。响应使用 `Cache-Control: private, no-store`。功能关闭时签发路由返回 `404`，报告人路由继续只接受部署令牌。

应用管理员创建 Webhook 的准确请求体、权限及报告人订阅绑定见[服务端与命令行反馈](server-feedback.md#notify-the-products-user-or-agent)。应用端点为 `POST /api/apps/:appId/webhooks`；组织端点即使请求体中提供应用 ID，也需要组织管理员权限。该 `app_id` 必须是此组织拥有的应用，否则返回 `404`。

应用事件（构建、发布、反馈和商店通知）投递给拥有该应用的组织的 Webhook，与调用方当前选择的组织无关；使用部署令牌发出的请求同样如此。

报告人评论和状态 Webhook 在已签名 JSON 正文和 `X-Hands-Event-Id` 中携带稳定的逻辑事件 ID。每个订阅投递还有稳定的 `X-Hands-Delivery-Id`。重试复用完全相同的正文、签名、事件 ID 和投递 ID；尝试时间戳和计数只保存在投递记录中。没有逻辑事件 ID 的旧投递记录会省略 `X-Hands-Event-Id`，但保留现有签名和事件请求头。

纯文本服务端或命令行集成见[服务端与命令行反馈](server-feedback.md)。完整的浏览器 → 可信服务端 → Hands 实现，包括凭据设置、不透明报告人标识、React 传输层及生产检查清单，见 [React 反馈收件箱](feedback-react.md)。

## 接收指标

```http
POST /public/v2/apps/:appSlug/metrics
Content-Type: application/json
X-Hands-Client-Key: qk_...
X-Hands-Device-Id: <stable per-install uuid>
```

轻量级启动或安装请求（客户端限制为每设备每天最多一次）用于活跃设备和版本分布分析。请求体是 JSON 元数据对象（`version_name`、`version_code`、`channel`、`platform`、`arch`、`os_version`、`device_model`、`locale`）。服务端为每个 `(应用, 设备 ID)` 插入或更新一条记录；不包含个人身份信息，设备 ID 是每次安装随机生成的 UUID。需要应用**客户端密钥**（与反馈相同），返回 `202`。旧版 SDK 仍可向 `/public/v2/apps/:appSlug/devices` 发送相同载荷；新 SDK 应使用 `/metrics`。

已认证的管理员和智能体可以通过 `GET /api/apps/:id/analytics/versions?window_days=30` 读取汇总版本视图。它将指标请求与版本更新检查计数、反馈和崩溃工单、文件下载计数结合，报告每个版本的 `active_devices`、`total_devices`、`update_current_count`、`update_offered_count`、`feedback_count`、`crash_count` 和 `download_count` 等指标。近期报告窗口可使用 `window_minutes`，但 SDK 请求受限流，不能视为真实在线状态。

## 预签名附件上传（大文件）

对于过大而不能内联 multipart 提交的附件（最多 **200 MB**），先请求直接上传到 R2 的 URL，用 PUT 上传字节，然后在提交工单时引用已上传对象。

```http
POST /public/v2/apps/:appSlug/feedback/presign
Content-Type: application/json
X-Hands-Client-Key: qk_...
```

请求体：`{ "files": [{ "filename": "...", "content_type": "...", "size": <bytes> }] }`，最多 9 个文件。返回 `{ "uploads": [{ attachment_id, r2_key, upload_url, expires_at }] }`。

1. 使用相同的 `Content-Type`，通过 `PUT` 将每个文件的字节上传至其 `upload_url`。
2. 提交反馈时，将 `presigned` 表单字段设为已上传文件的 `{ r2_key, filename, content_type, size }` JSON 数组。

服务端未配置直接上传时返回 `501`。附件总数（内联加预签名）不能超过 9。

### 提交校验错误

附件引用校验失败时，`POST /public/v2/apps/:appSlug/feedback` 返回 HTTP **400** 和 `{ "code": "<stable_code>", "error": "<human-readable message>" }`。应根据 `code` 分支，不要依赖消息文本。旧服务端可能只返回 `error`。

| 代码 | 原因 |
| --- | --- |
| `presigned_invalid` | `presigned` 不是有效 JSON 数组、数组项无效，或 `r2_key` 不在该应用的 `feedback/{app_id}/presigned/` 前缀下。 |
| `presigned_not_found` | 引用的 R2 对象不存在。 |
| `presigned_size_mismatch` | `size` 缺失、非正数或与存储对象的实际字节大小不一致。 |
| `attachments_limit_exceeded` | 附件总数超过 9 个，包括内联及预签名附件。 |

这些检查在创建工单及其附件记录之前执行；即使较早的附件已通过校验，也不会创建部分工单。如果 `submission_id` 尚未使用，用户可以移除诊断附件并使用新的 `submission_id` 再次提交。如果该 ID 已创建工单，相同校验失败返回 `409` 和 code `submission_payload_mismatch`；不要用该 ID 创建第二张工单。此保证仅适用于上列校验失败，不适用于网络超时或其他响应。

上传 URL 在 15 分钟后过期，但不会使已上传对象过期。未引用对象没有自动清理保证。引用限定于应用，但不绑定报告人，也不限于使用一次。上传引用会作为普通工单附件显示和下载。

无法将文件作为原始请求体发送的纯 ArkTS 客户端可以添加 `"upload_mode": "r2_multipart_proxy"`。响应会包含 `upload_id` 和 `part_size`，而不是 `upload_url`。依次通过 `PUT .../feedback/multipart/part` 上传每个原始分片，在 `POST .../feedback/multipart/complete` 中提供返回的分片 ETag 完成上传，失败时调用 `POST .../feedback/multipart/abort`。服务端将分片大小固定为 5 MiB，并将每个有界分片流式写入 R2，不缓冲整个附件。

## 分享页面

- `GET /share/:token`：单个版本的公开下载页面，包含查看和下载统计、桌面端二维码和本地化更新说明。可选择密码保护；页面显示解锁表单，`POST /share/:token/unlock` 设置限定于该分享的短期 Cookie。
- `GET /share/:token/download`：文件下载，返回 302 指向签名 URL。
- `GET /share/:token/icon`：版本构建的应用图标，必要时回退到应用级图标。

分享链接可在管理控制台的分享页、命令行或 API 中创建，创建后可以续期、撤销和设置密码保护。

## 版本历史

应用启用**设置 → 公开版本历史**后：

- `GET /apps/:appSlug/history`：公开页面，列出已发布版本、本地化更新说明、大小和下载链接。
- `GET /apps/:appSlug/history/:releaseId/download`：按版本下载，返回 302 指向签名 URL。
- `GET /apps/:appSlug/latest`：最新活动版本的页面，包含版本、更新说明和下载；可选 `?channel=`。
- `GET /apps/:appSlug/v/:version`：固定到某个已发布 `version_name` 的同类页面，例如 `/apps/raft-android/v/1.12.0`。已替代版本仍可解析，因此发布公告可以永久链接；草稿、已取消、隐藏和质量检查构建不能解析。多个渠道发布同一版本时可选 `?channel=`，默认优先 `main`。

未启用的应用返回 `404`。

## 应用图标

```http
GET /public/apps/:appSlug/icon
```

返回应用图标。每次构建的图标从上传 APK 中自动提取（aapt）；也可以在管理设置页上传应用级图标作为回退。

## 下载 URL

`download_url` 值是限时签名 URL。客户端应及时使用，过期时重新请求更新检查以获取新 URL。

获取文件时，响应通过 `Content-Disposition` 提供可读的下载文件名。

## 客户端行为

推荐的客户端流程：

1. 发送已安装的 `versionCode`、配置的渠道、系统语言及 SDK 持久化设备 ID。
2. 如果 `update_available` 为 false，不执行操作。
3. 如果为 true，显示版本信息或开始更新流程。
4. 从 `asset.download_url` 下载文件。
5. 如果客户端更新框架支持，验证大小和哈希。
6. 安装或交由平台安装器处理。

## 错误

| 状态 | 含义 |
|---|---|
| `400` | 请求参数缺失或无效。 |
| `404` | 找不到应用、渠道、版本或兼容文件。 |
| `410` | 签名下载 URL 已过期。 |
| `401` | 客户端密钥缺失或无效（反馈提交）。 |
| `429` | 超出速率限制（反馈提交）。 |
| `500` | 服务端错误。请稍后重试或联系 Hands 运营人员。 |

## 兼容性

公开更新检查是只读操作，不需要认证。管理和发布 API 需要 Hands 认证或限定于应用的部署令牌。
