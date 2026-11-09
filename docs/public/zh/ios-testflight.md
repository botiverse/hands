---
title: "iOS 发布与 TestFlight"
description: "iOS 构建如何到达 TestFlight：Hands 使用保存的 App Store Connect 凭据在服务端上传。"
category: "For agents"
order: 6
---

# iOS 发布与 TestFlight

本文介绍 Raft iOS 构建从 CI 到 TestFlight 的流程。关键在于 **Hands 在服务端向 Apple 上传**：App Store Connect 凭据在 Hands 中加密保存，`.p8` 密钥不会离开 Hands。CI 不需要 Apple 上传凭据，也不需要运行 `altool`。

## 流程

```text
iOS Release 工作流             Hands                          Apple
──────────────────             ─────                          ─────
构建并签名 IPA ──────────────▶ 构建和文件存入 R2
                               (publish_hands=true)
                               testflight-upload ────────────▶ Build Upload API
                               （从 R2 流式传输 IPA）          PROCESSING → COMPLETE
                               testflight-publish ───────────▶ VALID 构建
                               测试组和测试说明                内部测试，或
                               测试审核与通知                  外部 Beta 审核
```

1. **构建、签名并发布**：以 `publish_hands=true` 触发 `iOS Release` 工作流（botiverse/mobile）。它使用分发证书构建并签名，将 IPA 和 dSYM 作为一个构建上传到 Hands，通常同时创建版本草稿。
2. **上传到 TestFlight**：对该构建触发服务端上传：

   ```
   POST /api/apps/{app_id}/builds/{build_id}/testflight-upload
   ```

   Hands 将 IPA 从 R2 直接流式传到 Apple 的 Build Upload API（创建 → 注册文件 → 分片 PUT → 提交），并返回初始状态。控制台入口为构建行的 TestFlight 操作。
3. **轮询上传处理状态**：

   ```
   GET /api/apps/{app_id}/testflight-uploads/{build_upload_id}
   ```

   读取嵌套的 `state.state` 字段：`AWAITING_UPLOAD → PROCESSING → COMPLETE | FAILED`。同一对象会保留 Apple 的错误、警告和提示。`COMPLETE` 只表示 Apple 接受了上传事务；分发前还须等待对应构建资源报告 `processingState=VALID`。
4. **列出测试组**：使用已处理的 Hands 构建确定准确的 App Store Connect 应用，并列出稳定的组 ID：

   ```
   GET /api/apps/{app_id}/builds/{build_id}/testflight-groups
   ```

5. **发布到 TestFlight**：将准确的已处理构建分配给组，并写入本地化测试说明：

   ```
   POST /api/apps/{app_id}/builds/{build_id}/testflight-publish
   {
     "distribution": "internal",
     "group_ids": ["<asc-beta-group-id>"],
     "what_to_test": {
       "en-US": "Verify login and Activity.",
       "zh-Hans": "验证登录和活动页。"
     },
     "notify_testers": false
   }
   ```

   内部模式只添加内部组。外部模式只添加外部组，提交 `betaAppReviewSubmissions`，并设置 `buildBetaDetails.autoNotifyEnabled`。外部构建已经批准时，仅当自动通知尚未启用，`notify_testers=true` 才创建官方 `buildBetaNotifications` 资源。
6. **刷新分发状态**：

   ```
   GET /api/apps/{app_id}/builds/{build_id}/testflight-publish?distribution=external
   ```

   响应保留 Apple 的原始处理、过期、内部和外部构建、Beta App 审核、自动通知、已分配组和本地化状态。它区分 `waiting_for_review`、`in_review`、`approved_not_notified`、`testing`、`rejected`、`expired` 和处理失败。
7. **需要停止测试时使准确的测试构建过期**：取得明确的人类授权后，应用管理员从状态响应提供三个独立确认值：

   ```
   POST /api/apps/{app_id}/builds/{build_id}/testflight-expire
   {
     "asc_build_id": "<exact-asc-build-id>",
     "confirm_version": "1.0.0",
     "confirm_build_number": "1000006"
   }
   ```

   Hands 再次解析不可变构建标识组合，拒绝 ASC ID 或版本、构建号不匹配的请求，仅设置 ASC Build 资源的 `expired` 标记，并立即回读同一构建。修改 Apple 前，会保存经过删减的操作意图，包含执行者和精确构建标识；PATCH 与回读成功或失败均会使回执进入终态。对已过期的准确构建重试返回 `200`，不执行操作，`changed=false`，并链接到此前经 PATCH 确认的操作，因此回读或审计响应丢失不会抹去触发修改的执行者。过期会移除 TestFlight 可用性；Apple 仍保留构建记录供审计和查询历史。响应包含 `operation_id`，供支持的查询使用。

这些接口以及对应的命令行命令仅适用于 TestFlight，不会激活 Hands 版本，也不会创建、提交或发布 App Store 正式版本。

## 发布回执与常见误区

上传、审核、测试人员通知和 App Store 正式发布是四个不同边界：

- Build Upload `COMPLETE` 和 ASC 构建 `VALID` 只能证明 Apple 已接受并处理二进制文件。
- 测试组分配、测试说明、`BETA_APPROVED` 或 `approved_not_notified` 只能证明符合条件，不能证明测试人员已收到通知。
- `auto_notify_enabled` 是调度策略字段，不是事件日志。手动通知之前或之后都可能为 `false`，不能据此证明没有通知。
- TestFlight 测试人员通知不会激活 Hands 版本，也不会发布 App Store 正式版本。

对于必须通知测试人员的外部发布，请保留两份独立回执：

1. `testflight-publish` 的修改响应必须包含 `notification=sent` 或 `notification=already_sent`。
2. 单独重新读取 `testflight-status`，必须显示精确 ASC 构建的 `external_build_state=IN_BETA_TESTING`。

生成回执的命令行调用不要加 `--wait`。当前 `testflight-publish --wait --json` 输出最终轮询的 GET 状态，而不是原 POST 响应；GET 状态不包含 POST 的 `notification` 或 `operation_id`。请不带 `--wait` 执行发布、保存 JSON，再单独通过 `testflight-status` 轮询。

`notification` 枚举的含义如下：

| 值 | 含义 | 通知完成？ |
| --- | --- | --- |
| `not_requested` | 未请求通知 | 否 |
| `scheduled` | 自动通知等待审核或测试 | 否 |
| `sent` | 手动通知操作成功 | 是，仍须重新确认 `IN_BETA_TESTING` |
| `already_sent` | 幂等重放发现通知已完成 | 是，仍须重新确认 `IN_BETA_TESTING` |

首次修改返回 `scheduled` 时，等待准确构建进入 `IN_BETA_TESTING`，然后不带 `--wait` 重放相同发布。保留预期的 `already_sent` 回执，再重新读取一次准确状态。有限次数的复查后仍缺少任一回执，应报告通知未验证，而不是声称构建已发布或通知已发送。

## 一次性设置（应用管理员）

将 App Store Connect API 凭据存入 Hands：控制台 → 应用 → 集成 → TestFlight（`PUT /api/apps/{app_id}/asc-credentials`）。在 App Store Connect → 用户与访问 → 集成中生成密钥（App Manager 角色）；需要 Key ID、Issuer ID 和 `.p8` 文件。凭据存储时加密，可以在不暴露凭据的情况下验证（`POST .../asc-credentials/verify`）。同一凭据也用于 App Store 审核状态接口（`GET /api/apps/{app_id}/appstore-review`）。Hands 是凭据的唯一保存位置；CI 不需要副本，因此轮换只需维护一个来源。

Hands 角色有意分离：上传构建到 Apple 和分发构建都要求应用发布者权限（上传是自己应用的发布操作，限定为发布者的 CI 令牌必须能够执行）；使准确的测试构建过期需要应用管理员权限；读取状态和测试组需要应用查看者权限。保存的密钥仍受 Apple 自身角色限制：外部测试需要 Account Holder、Admin 或 App Manager；内部测试也允许 Developer 或 Marketing。

首次外部测试前，App Store Connect 必须具备所需 Beta App 描述、反馈邮箱、联系信息和出口合规答案。缺少前置条件时，Hands 会拒绝操作并返回 Apple 提供的可操作状态或错误。Apple 每次只允许一个版本中的一个构建处于 Beta App 审核中，24 小时内最多提交六个构建。

## 版本规则

- **营销版本**（如 `1.0.0`）可以在多次上传中重复使用。
- 同一营销版本的**构建号**（`versionCode`，如 `1000004`）必须唯一且递增；Apple 会拒绝重复构建号。Hands 构建历史可以快速查看上次使用的编号。
- TestFlight 访问在上传 90 天后过期。
- 外部分发采用失败即拒绝：Apple 必须明确返回 `build_audience_type=APP_STORE_ELIGIBLE`。`INTERNAL_ONLY`、缺失值或未来的未知受众值会在任何本地化、分组、审核或通知修改前被拒绝。

## 命令行和 API

命令行：

```sh
hands builds testflight-groups <app> <hands-build-id>
hands builds testflight-publish <app> <hands-build-id> \
  --distribution external \
  --group-id <asc-beta-group-id> \
  --what-to-test en-US="Verify the release candidate." \
  --notify-testers \
  --json > testflight-publish-receipt.json
hands builds testflight-status <app> <hands-build-id> \
  --distribution external \
  --json
```

智能体使用 Hands 命令行或 API，传入 Hands 应用和构建 ID 及稳定的测试组 ID；二者都不会返回已保存的 `.p8` 凭据。

Beta App 描述是应用级邀请文案，使用 `betaAppLocalizations.description`，不是构建级测试说明字段（`betaBuildLocalizations.whatsNew`）。专用更新 API 保留未提供的语言，只有 Apple 回读完全一致后才算成功。

## App Store 发布（版本、商店详情、截图、审核） {#app-store-release-version-listing-screenshots-review}

Hands 使用已保存的 App Store Connect 密钥执行受支持的提交步骤。有些修改（包括 App Information 和 Duo 截图写入）目前仍需在 App Store Connect 完成，限制见下文。命令行中，所有会修改 Apple 数据的步骤默认只预演，只有传入 `--commit` 才执行。

API 中的 `mode` 默认值有意不同：

- 准备（`POST .../app-store/versions`）为了向后兼容默认 `commit`。写入可逆：版本字符串、构建和发布类型均可通过再次准备修改。
- 商店详情文本和截图没有默认 `mode`：它们会覆盖线上商店内容，调用方必须明确指定 `dry_run` 或 `commit`。
- 发布也没有默认 `mode`，因为发布不可逆。

```sh
# 1. 版本和构建：创建、复用或重命名（见下文）
hands app-store prepare raft-ios --version-name 1.17.0 --build <asc-build-id>            # 预演
hands app-store prepare raft-ios --version-name 1.17.0 --build <asc-build-id> --commit
# 2. 按语言提交商店详情文本
hands app-store localizations push raft-ios --version-name 1.17.0 --file listing.json   # 预演
hands app-store localizations push raft-ios --version-name 1.17.0 --file listing.json --commit
# 3. 截图：shots/<locale>/<display_type>/NN.png
hands app-store screenshots push raft-ios --version-name 1.17.0 --dir shots              # 预演
hands app-store screenshots push raft-ios --version-name 1.17.0 --dir shots --commit
# 4. 审核：先进行只读检查，再提交
hands app-store preflight raft-ios --version-name 1.17.0
hands app-store submit raft-ios --version-name 1.17.0 --commit
hands app-store status raft-ios --version-name 1.17.0
hands app-store withdraw raft-ios --version-name 1.17.0 --commit
# 5. 批准后（MANUAL 发布类型）：发布不可逆
hands app-store release raft-ios <asc-version-id> --version-name 1.17.0 --build <asc-build-id>            # 预演
hands app-store release raft-ios <asc-version-id> --version-name 1.17.0 --build <asc-build-id> --commit
```

### 提交前检查：版本是否可以审核？

`GET /api/apps/{appId}/app-store/versions/{versionId}/preflight`（应用查看者权限）是只读操作：Hands 对 App Store Connect 的每次调用都是 GET。命令行 `hands app-store preflight <app> --version-name 1.17.0 [--json]` 发现任何错误时以状态 1 退出；不带 `--commit` 的 `hands app-store submit` 也会打印错误。提交操作本身不会因此被阻止。

响应为 `{version_id, version_string, state, ready, findings, checked, not_checkable}`。每个发现包含 `severity`（`error`、`warning`、`info`）、`check`、可选的 `locale` / `display_type`、`resource`、`message` 和 `fix`。`resource` 使用 Apple 在拒绝提交时关联错误所用的路径，例如 `/v1/appStoreVersionLocalizations/<id>`；缺失字段采用 Apple 原始措辞，例如要求提供 `supportUrl`。

| 检查 | 严重级别 |
| --- | --- |
| `version_state`：可编辑（`PREPARE_FOR_SUBMISSION`、`DEVELOPER_REJECTED`、`REJECTED`、`METADATA_REJECTED`、`INVALID_BINARY`） | 其他状态为错误；`WAITING_FOR_REVIEW` / `IN_REVIEW` 为提示 |
| `build`：已附加、`VALID`、未过期 | 错误 |
| `build`：构建版本字符串与 App Store 版本不同 | 警告 |
| `export_compliance`：构建未设置 `usesNonExemptEncryption` | 警告 |
| `copyright` 为空 | 警告 |
| `localization_required_fields`：每种语言的 description、keywords、supportUrl | 错误 |
| `localization_whats_new`：whatsNew 为空（除首个版本外必填） | 提示 |
| `localization_lengths`：description 4000、keywords 100、promotionalText 170、whatsNew 4000 | 警告 |
| `app_info_localizations`：每种版本语言都有应用名；主语言有隐私政策 URL | 错误（其他语言缺少隐私 URL 为警告） |
| `screenshots`：主语言有 6.9 英寸或 6.5 英寸 iPhone 截图组（`APP_IPHONE_67` / `APP_IPHONE_65`）；每张截图均为 `COMPLETE` | 错误 |
| `screenshots`：其他语言没有截图时回退到主语言 | 提示 |
| `screenshots`：存在 iPad 截图组，但主语言没有 13 英寸组（`APP_IPAD_PRO_3GEN_129`） | 警告；Hands 无法判断应用是否运行于 iPad 时为提示 |
| `review_detail`：联系人姓名、电话和邮箱；`demoAccountRequired` 时还需演示账号名和密码 | 错误 |
| `age_rating`：没有年龄分级声明 | 警告 |
| `review_submission`：另一版本占有未关闭的提交（`WAITING_FOR_REVIEW`、`IN_REVIEW`、`UNRESOLVED_ISSUES`） | 错误；本版本自己的提交或草稿为提示 |

Apple 拒绝返回的资源会产生 `unreadable:<what>` 警告，包含 Apple 状态、代码和详情；需要该资源的规则列在 `not_checkable` 中。只有没有错误、没有不可读取资源且所有规则均已执行时，`ready` 才为 true。App 隐私答案不在公开 App Store Connect API 中，价格与可用性、内容权利和类别目前也不会读取，因此始终列在 `not_checkable` 中。

### 准备：每个平台只能有一个未发布版本

Apple 每个平台只允许一个尚未发布的 App Store 版本。已撤回版本（例如现在处于 `DEVELOPER_REJECTED` 的 1.12.0）仍会占用该位置，因此创建 1.17.0 会收到 Apple 的 409，提示当前状态不能创建新版本。准备操作读取该平台所有版本（`include=build`）后决定：

| Apple 当前状态 | 准备操作 | `action` |
| --- | --- | --- |
| 存在所请求版本字符串，且可编辑 | 附加构建 | `reused` |
| 存在所请求版本字符串，但不可编辑 | 409 `VERSION_NOT_EDITABLE` | — |
| Apple 正持有另一未发布版本（`WAITING_FOR_REVIEW`、`IN_REVIEW`、`PENDING_DEVELOPER_RELEASE` 等） | 409 `VERSION_IN_FLIGHT` 并指出该版本；应先撤回 | — |
| 恰好一个可编辑且从未发布的版本（`PREPARE_FOR_SUBMISSION`、`DEVELOPER_REJECTED`、`REJECTED`、`METADATA_REJECTED`、`INVALID_BINARY`） | 在一次 PATCH 中重命名为请求的版本字符串并附加构建 | `renamed`，包含 `previous_version_string` |
| 只有已发布版本 | 创建版本后附加构建 | `created` |

若版本状态未被 Hands 识别，或存在两个可编辑版本，操作会拒绝并返回 409 `VERSION_STATE_UNKNOWN` / `MULTIPLE_EDITABLE_VERSIONS`，而不是猜测。写入后 Hands 回读版本（`GET /v1/appStoreVersions/{id}?include=build`）；版本字符串或构建不匹配时返回 502 `READBACK_MISMATCH`。先前写入后发生失败时返回 502 `PREPARE_PARTIALLY_APPLIED` 及 `completed_steps`。重命名会保留版本已有本地化内容和截图。

`release_type`（`MANUAL` 或 `AFTER_APPROVAL`）适用于所有操作。复用或重命名版本时，仅当 `releaseType` 与 Apple 当前值不同时才发送，并与重命名和构建放在同一次 PATCH 中；回读必须显示该值，否则返回含 `release_type` 的 502 `READBACK_MISMATCH`。省略 `release_type` 时，新版本使用 `MANUAL`，已有版本保留 Apple 当前值；准备操作不会重置它。`SCHEDULED` 会返回 400 `RELEASE_TYPE_SCHEDULED_UNSUPPORTED`，因为 Apple 需要 Hands 不会设置的 `earliestReleaseDate`。响应（包括预演）包含 `changes: { version_string, build, release_type }`；每项为 `{from, to}`，未变化时为 `null`。`release_type` 是 Apple 的值（提交后回读），`requested_release_type` 是请求值（省略时为 `null`）。

### 发布已批准版本

发布类型为 `MANUAL` 时，已批准版本停留在 `PENDING_DEVELOPER_RELEASE`。发布是**不可逆**操作：

`POST /api/apps/{appId}/app-store/versions/{versionId}/release`（应用发布者权限），请求体为 `{ "mode": "dry_run" | "commit", "version_string": "1.17.0", "asc_build_id": "<optional>" }`。

- `mode` 必填；`dry_run` 只读取。
- `version_string` 及提供时的 `asc_build_id` 必须与 Apple 保存的该版本信息一致，否则返回 409 `RELEASE_CONFIRMATION_MISMATCH`，不会发送修改。
- 只有 `PENDING_DEVELOPER_RELEASE` 可以发布。已经上线（`READY_FOR_SALE` / `READY_FOR_DISTRIBUTION` 或已退役）的版本返回 409 `ALREADY_RELEASED`，不视为成功。其他状态返回包含状态的 409 `NOT_RELEASABLE`。
- 提交时 Hands 首先记录操作回执（类型 `app-store-release`）和 `app_store.release_intent` 审计行；任一记录失败时不会向 Apple 发送请求，返回 500 `RELEASE_INTENT_NOT_RECORDED`。随后发送 `POST /v1/appStoreVersionReleaseRequests`，并在约 30 秒内回读版本。结果记录为 `app_store.release` 或 `app_store.release_failed`。
- 只有 Apple 显示 `READY_FOR_SALE` / `READY_FOR_DISTRIBUTION` 时才返回 `200` 和 `outcome: "released"`。否则返回 `202`、`outcome: "release_requested"` 和 `observed_state`：Apple 异步发布，应稍后通过 `hands app-store status` 检查。
- Apple 的发布请求资源不能列出，因此通过版本状态和 Hands 回执防止重复：已接受请求的 6 小时内再次调用会返回 `202 release_requested` 及 `prior_operation_id`，不会发送新请求；另一发布调用仍在运行时返回 409 `RELEASE_IN_PROGRESS`。

发布后的状态变化通过现有 `app_store:version_state_changed` 事件到达 Webhook。

### 商店详情文本

调用 `POST /api/apps/{appId}/app-store/versions/{versionId}/localizations`，请求体为 `{ "mode": "dry_run" | "commit", "localizations": { "<locale>": { ... } } }`。字段是 Apple 的 `appStoreVersionLocalizations` 属性：`description`（最多 4000 字符）、`keywords`（100）、`promotionalText`（170）、`whatsNew`（4000）、`marketingUrl`、`supportUrl`（http 或 https）。只写入提供的字段；已有语言仅修补变化字段，缺失语言则创建。创建语言需要 `description`、`keywords` 和 `supportUrl`：Apple 虽然接受缺少它们的创建请求，之后会拒绝审核；缺少时计划项以 `missing_required_fields` 阻止，并列出 `missing_fields`。更新说明接口（`.../notes`）只更新已有语言，语言不存在时返回 409 `LOCALIZATION_MISSING`。Apple 持有版本期间只能修改 `promotionalText`，其他字段返回 409 `LOCALIZATION_PLAN_BLOCKED`。提交后回读每个请求字段；Apple 保存的值不一致时以 `READBACK_MISMATCH` 失败。应用名称、副标题和主类别单独位于 `appInfos` / `appInfoLocalizations`，可按下文 App Information 章节预演或提交。

### App Information（名称、副标题、主类别）

App Information 由应用各平台共享，不属于所选版本。版本仅用于上下文和安全检查，**不保证**修改只影响该版本。Apple 描述待发布信息在下一次版本发布时生效；送审前请在 App Store Connect 确认影响范围及已有审核。

创建只包含所需字段的 `app-info.json`，例如：

```json
{
  "primary_category": "PRODUCTIVITY",
  "localizations": {
    "en-US": { "name": "Example App", "subtitle": "Stay in touch" },
    "ja": { "name": "Example App", "subtitle": "Connect with your team" }
  }
}
```

```sh
hands app-store app-info push raft-ios --version-name 1.22.0 --file app-info.json
# 加 --commit 写入（需 @botiverse/hands-cli >= 0.5.44）。
# 可选：--version-id <ASC-version-id>、--platform <platform>、--json
```

仅应用发布者可调用 `POST /api/apps/{appId}/app-store/versions/{versionId}/app-info`；请求必须明确指定 `mode` 和精确的 `version_string`（CLI 默认发送 `dry_run`），`commit` 还须包含 `commit_contract_version: 1`（旧版 CLI 会在任何 Apple 调用或加锁前以 `409 APP_INFO_CLIENT_UPGRADE_REQUIRED` 被拒绝）。预演只使用 Apple GET，展示已有值、请求值、类别、观察到的平台和语言差异；它**不会**检查或预留名称，也不写入或提交审核。所选版本须属于该应用且可编辑，并须只有一个明确的待发布 AppInfo；存在其他活跃或未知状态的版本、或出现未知平台时会阻止计划。类别仅按 Apple 版本记录中观察到的平台检查：记录可能遗漏新加的平台，也可能不一致。请求新建的 App Information 语言还须存在于所选版本；这是 Hands 的保守限制，**不是**宣称 Apple 要求语言集合完全相同。已有语言差异会报告供检查。

传入 `--commit` 时，Hands 会获取应用级 `apple_app_info` 操作锁，复核快照未发生漂移，记录 `app_store.app_info.attempt` 审计条目（仅存 SHA-256 和字符长度，不存明文），仅修补或新建请求变更的多语言字段及 `primary_category`，然后回读所选 AppInfo 并复核一致性。若任何写入失败、结果不确定或回读不一致，Hands 会保留操作锁并返回 `recovery_required: true`，防止二次调用盲目重放；请按 store-product 恢复手册在 App Store Connect 中核实状态后再解锁。Hands 不会自动送审。

### 截图

调用 `POST /api/apps/{appId}/app-store/versions/{versionId}/screenshots`，使用 multipart：一个 `request` JSON 部分为 `{ "mode": "dry_run" | "commit", "sets": [ { "locale": "en-US", "display_type": "APP_IPHONE_67", "images": [ { "part": "img1", "sha256": "<hex>" } ] } ] }`，每张图片另有一个文件部分，每次推送的图片总量最多 24 MiB。

任何 Apple 调用之前会检查每个部分的 SHA-256、PNG 或 JPEG 格式、无透明度（带 alpha 通道或 tRNS 块的 PNG 会被拒绝，应先合并图层）、每组 1–10 张图片，以及与显示类型完全匹配的像素尺寸（纵向或横向）：

| `display_type` | 尺寸（纵向） |
| --- | --- |
| `APP_IPHONE_DUO`（只读） | 1398x2034、2007x2853 |
| `HANDS_IPHONE_DUO_OUTER`（旧 Hands 选择器；只读） | 1398x2034 |
| `HANDS_IPHONE_DUO_INNER`（旧 Hands 选择器；只读） | 2007x2853 |
| `APP_IPHONE_67`（6.9 和 6.7 英寸） | 1320x2868、1290x2796、1260x2736 |
| `APP_IPHONE_65` | 1242x2688、1284x2778 |
| `APP_IPHONE_61`（6.3 和 6.1 英寸） | 1206x2622、1179x2556、1170x2532、1125x2436、1080x2340 |
| `APP_IPHONE_55` | 1242x2208 |
| `APP_IPAD_PRO_3GEN_129`（13 英寸） | 2064x2752、2048x2732 |
| `APP_IPAD_PRO_3GEN_11` | 1488x2266、1668x2420、1668x2388、1640x2360 |
| `APP_IPAD_PRO_129` | 2048x2732 |

`display_type` 通常使用 Apple 的 `ScreenshotDisplayType`；没有尺寸表的其他 Apple 值会被拒绝。已在 Apple 的只读响应中观察到一个 `APP_IPHONE_DUO` 截图组同时包含内屏和外屏图片。混合截图组应使用这一个类型，可混用横竖尺寸。已有组完整、校验和与顺序完全一致时可报告未变化；组为空、类型缺失、重复或数据不完整时会阻止确认。Apple 返回的 `imageAsset` 尺寸可能缺失（包括图片处理中），不能保证始终可用或代表原图尺寸。

此前的 `HANDS_IPHONE_DUO_OUTER` 和 `HANDS_IPHONE_DUO_INNER` 是仅供兼容保留的 Hands 选择器，无法表示混合截图组。即使是预演，创建、重新排序或替换 Duo 截图组也会被阻止：在响应中看到类型并不能证明 API 写入可用。在写入行为经过验证前，请继续通过 App Store Connect 修改 Duo 截图。

对于普通 Apple 显示类型，如果已有截图组为空、组内图片尺寸缺失或为 Duo 尺寸，修改该截图组的计划也会被阻止。同一语言中若有截图组未返回 Apple 显示类型，该语言的计划也会被阻止。这只能防止已知风险，不保证能检测所有碰撞，也可能阻止以前可以执行的更新；遇到阻止时可检查截图组或使用 App Store Connect。

只读检查已有版本的截图组：

```bash
hands app-store screenshots inspect raft-ios --version-name 1.17.0 --locale en-US
```

检查结果原样报告 Apple 返回的显示类型和图片尺寸；缺失值显示为不可用。该操作只读取数据，不能证明后续 API 上传会被 Apple 接受。

每个截图组要求版本已经具有相应语言，请先在商店详情文本步骤创建。已有截图按 MD5 比较，这是 Apple 在 `sourceFileChecksum` 中保存的值：

- 文件和顺序相同且均为 `COMPLETE`：`unchanged`，不写入，可以安全重新运行推送。
- 文件相同但顺序不同：仅执行 `reorder`。
- 其他情况：`replace`（或 `upload` / `create_set_and_upload`），先删除该组截图，再为每张图片预留位置、执行 Apple 上传、使用 MD5 提交、轮询 `assetDeliveryState` 直到 `COMPLETE`、设置顺序并回读截图组。

每组独立提交，一组失败不会阻止其他组。只有会影响所有组的错误才停止运行，例如 Apple 以 401/403 拒绝 API 密钥、404、限流、Apple 5xx、版本状态相关 409，或无法明确归因于某一组的错误；后续组标记为 `not_attempted`。每组最终为：

- `ok`：已上传、达到 `COMPLETE`、排序并回读。
- `failed`：图片最终为 `FAILED`、Apple 拒绝该组请求或回读不一致。
- `uploaded_pending`：所有图片已上传并提交，均未被拒绝，但轮询时间耗尽时 Apple 仍在处理至少一张。这不是成功：尚未完成排序和回读。
- `not_attempted`：因会停止整个运行的错误而跳过。

响应列出 `failed_sets` 和 `pending_sets`。任何失败或未尝试的组都会返回 502 `SCREENSHOTS_FAILED`，优先于待处理结果；否则只要有待处理组，就返回 202 `SCREENSHOTS_PENDING` 和 `ok: false`。两种情况下命令行都以非零状态退出并打印代码。对于待处理组，Apple 仍在处理截图。稍后再次预演：若每组均为 `unchanged`，则文件和顺序已确认；若某组显示 `reorder` 或 `replace`，再次使用 `--commit`。不会自动重试。替换先删除再上传，失败可能使截图组只填入一部分；请修复原因后重新推送。

每次准备、商店详情和截图调用（包括预演）都记录在应用审计日志中（`app_store.prepare_version`、`app_store.localizations`、`app_store.screenshots`）；商店详情文本只记录 SHA-256 和长度。

## Apple 参考资料

- [App Store Connect API：预发布版本和测试人员](https://developer.apple.com/documentation/appstoreconnectapi/prerelease-versions-and-beta-testers)
- [构建测试版通知](https://developer.apple.com/documentation/appstoreconnectapi/build-beta-notifications)
- [添加内部测试人员](https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers/)
- [邀请外部测试人员](https://developer.apple.com/help/app-store-connect/test-a-beta-version/invite-external-testers/)
- [提供测试信息](https://developer.apple.com/help/app-store-connect/test-a-beta-version/provide-test-information/)
- [TestFlight 概览](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/)
- [App Store Connect API：App Store 版本发布请求](https://developer.apple.com/documentation/appstoreconnectapi/app-store-version-release-requests)
- [App Store Connect API：App Store 版本本地化](https://developer.apple.com/documentation/appstoreconnectapi/app-store-version-localizations)
- [App Store Connect API：应用截图](https://developer.apple.com/documentation/appstoreconnectapi/app-screenshots)
- [上传资源到 App Store Connect](https://developer.apple.com/documentation/appstoreconnectapi/uploading-assets-to-app-store-connect)
- [截图规格](https://developer.apple.com/help/app-store-connect/reference/screenshot-specifications/)

## App Store Connect Webhook 通知

当 App Store 版本审核状态、TestFlight 构建外部审核状态或构建上传处理状态发生变化时，Apple 可以通知 Hands。这里使用 [App Store Connect Webhook](https://developer.apple.com/help/app-store-connect/manage-your-team/manage-webhooks/)，而不是应用内购买的服务端通知。

应用管理员使用 **Hands 应用 UUID** 创建接收配置：

```http
POST /api/apps/{app_id}/apple-webhook
Authorization: Bearer <Hands session>
Content-Type: application/json

{"apple_app_id":"<numeric App Store Connect app ID>"}
```

响应包含 `payload_url`、`secret`（仅显示一次）和 `event_types`。

如果应用已经在 Hands 中保存 App Store Connect 凭据，应用管理员可以注册此回调，无需复制密钥或签名秘密：

```sh
hands api POST /api/apps/{app_id}/apple-webhook/register
```

Hands 使用已保存凭据调用 Apple，创建前先查找完全相同回调 URL 的已有订阅，再回读以验证 URL、启用状态和全部四种事件类型。结果不暴露秘密。如果 Apple 拒绝操作，响应会指出失败阶段和上游状态；请使用有权管理 Webhook 的 App Store Connect 密钥。仅完成注册不能证明真实审核通知已到达团队。

秘密使用现有 ASC 凭据加密密钥加密存储；不要将其放入聊天、日志或 Shell 参数。为已有配置再次创建会返回 409，不会轮换秘密。同一路径的 `GET` 只返回元数据，`DELETE` 会使 URL 失效。重新创建将生成新的 URL 和秘密；之前的事件回执在轮换后仍保留。

在 App Store Connect 中打开**用户与访问 → 集成 → 其他 → Webhook**，创建 Webhook，粘贴返回的 URL 和秘密，并选择 `apple_app_id` 指定的**同一个 Apple 应用**。选择以下四个触发器：

| Apple 触发器 | Hands 对外事件 |
| --- | --- |
| `APP_STORE_VERSION_APP_VERSION_STATE_UPDATED` | `app_store:version_state_changed` |
| `BUILD_BETA_DETAIL_EXTERNAL_BUILD_STATE_UPDATED` | `testflight:external_state_changed` |
| `BUILD_UPLOAD_STATE_UPDATED` | `app_store:build_upload_state_changed` |
| `BETA_FEEDBACK_CRASH_SUBMISSION_CREATED` | `testflight:crash_submission_created` |

选择**测试**，在 Apple 的近期投递记录中检查成功的 HTTP 响应。经过认证的测试请求及不支持的事件类型会被确认，但不会产生审核通知。测试请求只能证明 Apple 能访问接收端，不能证明真实审核事件已到达聊天频道。

让现有应用级或组织级 Hands Webhook（或 [Raft 频道通知](store-release-notifications.md)）订阅上述对外事件。现有队列会立即发送通知，并通过常规投递记录重试失败。聊天转发程序必须支持这些事件类型，并根据稳定的 `event_id` 去重。创建接收配置本身不会配置聊天目标。

对外 `payload` 包含 `apple_event_id`、`apple_app_id`、`app`（`id`、`slug`、`name`）、`resource`（`type`、`id`）、`previous_state`、`state`、`occurred_at` 和 `app_store_connect_url`。状态为 Apple 原始值。Apple 构建上传事件可能省略先前状态和时间戳，此时字段为 null。资源 ID 标识 Apple 版本或构建，不是 Hands 构建 ID，也不是可读版本号。不会转发凭据或完整 Apple 载荷。显示事件时间和状态转换；乱序投递不能覆盖推定的当前状态。

对于 `testflight:crash_submission_created`，`resource` 标识崩溃提交，`state` 和 `occurred_at` 包含 Apple 的 `createdDate`，`previous_state` 为 null。Hands 沿提交的 `build` 关系查询，尽力附加与其他 TestFlight 事件相同的 `build` 身份。它还会在普通反馈处理界面中幂等创建崩溃工单，并将 `.ips` 日志作为内部附件存储，最大 2 MiB。对外载荷包含 `ticket_id`，绝不包含崩溃日志正文。崩溃提交代表某位测试人员选择分享，并不代表该构建的崩溃总数。

补录已有提交时，应用管理员可以调用 `POST /api/apps/{appId}/testflight-crashes/backfill`，使用与拉取接口相同的可选 `build`、`version` 和 `limit` 筛选。它使用同一个幂等接收流程，返回 `ticket_ids` 和 `failed_submission_ids`；重复运行不会创建重复工单。这是恢复历史记录和之前接收失败的提交的受支持方式。

Hands 使用精确的请求字节验证 `x-apple-signature`，将请求体限制为 64 KiB，并原子地提交事件回执及匹配的对外投递。重放事件 ID 不会创建额外投递；相同 ID 使用不同字节返回 409。签名无效返回 401，受支持事件格式错误返回 400。Apple 支持在投递历史中手动重新投递。依赖未来通知前请先配置 Webhook；它不会重放配置之前发生的审核变更。

### 上传处理和内部 TestFlight 通知

Apple 目前提供外部 TestFlight 状态 Webhook，但不提供内部 TestFlight 状态 Webhook。对于通过 Hands 执行的操作，Hands 还会根据 Apple 已验证的操作回读发送两个事件：

- `testflight:upload_processing`：上传响应报告 `PROCESSING`。
- `testflight:internal_distribution_ready`：内部发布回读报告 `IN_BETA_TESTING`，并确认所有请求的内部组均可访问。

在应用或组织 Webhook 中订阅这些事件。它们使用现有 `event` / `event_id` / `payload` 封装。载荷包含 `source: hands_operation_receipt`、`operation_id`、应用和 Apple 资源身份、版本、构建号、平台、状态及 App Store Connect 链接。内部分发还包含所选组和 `auto_notify_enabled`。可选字段 `groups_display` 是包含所有所选组名的完整中文通知行，例如 `测试组：Botiverse、Team B`；未命名组回退为其 ID。上传事件和 Apple 回调事件不包含该字段，因此标量通知模板可以让该行留空。内部分发还包含 `what_to_test` 和 `source_commit`，见[测试说明和源码提交](#test-notes-and-source-commit)。

这确认内部可用性，并不证明测试人员收到邮件。操作成功回执与投递记录原子提交；重复相同操作回执不会产生重复投递。

这些事件独立于 Apple 回调事件。上传回读已进入终态时，不会虚构先前的 `PROCESSING` 转换。在 App Store Connect 中直接进行的更改不包含在这些 Hands 操作事件内。

### Apple 回调事件中的 `build`

Apple 的 Webhook 封装仅通过 `buildBetaDetails` ID 标识受影响构建，不包含版本或构建号。因此对于 `testflight:external_state_changed`，Hands 会查询一次 `buildBetaDetails/{id}/build` 并在载荷中添加 `build` 字段：

```json
"build": { "version": "1.14.0", "version_code": "11400009" }
```

`version` 是营销版本（Apple 侧的 `preReleaseVersion.version`），`version_code` 是构建号（`builds.version`）。App Store Connect 将两者保存在不同资源中，不能互换。

此字段**尽力获取，绝不会阻止通知**。应用没有 App Store Connect 凭据、Apple 响应缓慢（超过 5 秒）或报错、或响应结构异常时，`build` 为 `null`，事件仍会投递，其他字段不变。`build` 键本身始终存在，因此消费者必须将 `null` 视为“版本未知，请打开链接”，而不是字段缺失。资源不是构建的事件，例如 `app_store:version_state_changed`，始终报告 `build: null`。

### 测试说明和源码提交 {#test-notes-and-source-commit}

`testflight:external_state_changed` 和 `testflight:internal_distribution_ready` 还携带两个键，用于渲染“可供测试”卡片：

```json
"what_to_test": { "zh-Hans": "测试登录流程", "en-US": "Check the login flow" },
"source_commit": "0123456789abcdef0123456789abcdef01234567"
```

`what_to_test` 将语言区域映射到构建的 TestFlight **测试说明**文本，每种语言最多截取 1000 个字符，空白语言会被移除。外部事件中，Hands 对 `build` 查询确定的构建读取 `GET /v1/builds/{id}/betaBuildLocalizations`，时间预算为 5 秒。内部事件使用发布回读，必要时回退到发布请求中的 `what_to_test`，不会额外调用 Apple。

`source_commit` 来自具有相同构建号的 Hands iOS 构建的 `provenance_json.source_commit`；内部事件优先使用实际发布的 Hands 构建。通过 `--source-commit` 上传构建时会设置该值。

两者均为尽力获取，绝不会阻止投递：上述两个事件始终包含这些键；无法读取构建、本地化内容或匹配的 Hands 构建时，值为 `null`。其他事件类型不携带这两个键。

### 版本状态事件中的 `version_string`

`app_store:version_state_changed` 还携带 `appStoreVersions` 资源的营销版本，通过一次 `GET /v1/appStoreVersions/{id}?fields[appStoreVersions]=versionString` 读取：

```json
"version_string": "1.17.0", "version_lookup": "ok"
```

约定与 `build` 相同：尽力获取、时间预算 5 秒、绝不阻止投递。应用没有 App Store Connect 凭据或读取失败时，事件仍投递，但包含 `"version_string": null, "version_lookup": "failed"`。其他事件类型不携带这些键。
