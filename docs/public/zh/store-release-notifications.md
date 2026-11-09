---
title: "商店发布状态自动推到 Raft 频道"
description: "将 Google Play、App Store、TestFlight 和 AppGallery 的提审、处理与审核上架状态自动推送到 Raft 频道，并驱动智能体后续工作流。"
category: "Console"
order: 18
---

# 商店发布状态自动推到 Raft 频道

Hands 支持通过应用的受管 Raft App Bot，将 Google Play、App Store、TestFlight 和 AppGallery 的提审、构建处理与审核上架状态自动推送到指定的 Raft 频道。频道里的人类和智能体无需反复刷新各个商店后台，就能在同一条时间线上看到上传进度、审核流转和线上可用状态。

## 1. 怎么开启 {#how-to-enable}

把一个 Hands 应用和一个 Raft 频道连接起来，只需完成三步：在 Raft 中授权机器人、在 Hands 中绑定频道与事件、以及为对应平台启用商店集成。

### 所需权限一览

| 步骤 | 操作人 | 所需角色与权限 |
| --- | --- | --- |
| 在 Raft 服务器上为 Hands 授权 App Bot | Raft 服务器所有者或管理员 | Raft 服务器 `owner` 或 `admin` |
| 将机器人拉入目标 Raft 频道 | 频道成员（公开频道）或频道/服务器管理员（私有频道） | 目标频道（如 `#proj-mobile-release`）的添加成员权限 |
| 在 Hands 中连接 App Bot 并配置频道订阅 | Hands 应用管理员 | Hands 应用 `admin`（或组织 `owner` / `admin`） |
| 在 Hands 中配置商店凭据与 Webhook | Hands 应用管理员 | Hands 应用 `admin` + 对应商店后台权限（见下文） |

### 第一步：连接 App Bot 并绑定 Raft 频道

1. 请 Raft 服务器的所有者或管理员在 Raft 中为已安装的 Hands 应用授予 App Bot 权限。
2. 打开 Hands 管理控制台，进入目标应用的 **设置 → Raft 通知**（对应接口 `GET / POST /api/apps/:appId/raft-notifications`）。
3. 点击 **连接应用机器人**（`POST /api/apps/:appId/raft-notifications/connect`）。Hands 会为每个 Raft 服务器安装生成并加密保存一份机器人凭据；同一 Raft 服务器下的其他 Hands 应用连接时会直接复用该凭据，不会触发轮换。
4. 在 Raft 中将连接好的机器人账号（例如 `@hands-4cc7a2`）加入目标频道（例如 `#proj-mobile-release`）。
5. 回到 Hands 的 **设置 → Raft 通知**，在 **目标频道** 中输入 `#proj-mobile-release`，勾选需要推送的事件，点击 **添加目标**。
6. 点击该目标行的 **测试**（`POST /api/apps/:appId/raft-notifications/:subscriptionId/test`），确认机器人可以正常往频道发消息。
7. （可选）点击 **使用状态卡片**。开启后，受支持的商店与发布事件会以结构化状态卡片发送；同一版本或构建后续状态变化时，既会原地更新原卡片，也会在频道补发一张新卡片，无需专门跟进线程即可看到最新状态。

一个 Hands 应用可以同时绑定多个 Raft 频道（分别订阅不同事件集），多个 Hands 应用（例如 `raft-ios` 和 `raft-android`）也可以共用同一个发布频道。

### 第二步：启用对应应用商店的状态来源

频道订阅决定了「发到哪里」，还需要确保对应商店的集成已启用，Hands 才能收到或观测到商店侧的状态变化：

- **Google Play**：在应用左侧 **集成 → Google Play** 中连接 Google 账号，选择 Android 包名以及 `internal`（内部测试）、`closed`（封闭测试）和 `production`（正式发布）轨道并保存，使连接处于已启用且已验证（`verified`）状态。详见[连接 Google Play](google-play-oauth.md)。
- **App Store 与 TestFlight**：
  1. 在 **集成 → TestFlight** 中保存 App Store Connect API 密钥（`PUT /api/apps/:appId/asc-credentials`）。
  2. 为应用创建并注册 App Store Connect Webhook，让 Apple 在审核或构建状态变化时主动回调 Hands：
     ```bash
     hands api POST /api/apps/<app-uuid>/apple-webhook -d '{"apple_app_id":"<App-Store-Connect-数字应用ID>"}'
     hands api POST /api/apps/<app-uuid>/apple-webhook/register
     ```
     详见 [iOS 发布与 TestFlight — App Store Connect Webhook 通知](ios-testflight.md#app-store-connect-webhook-通知)。

---

## 2. 推哪些事件 {#which-events-are-pushed}

每个频道目标都可以按需勾选以下商店、发布、构建与反馈事件。

### Google Play 事件

| 事件名称 | 触发条件与包含的状态 |
| --- | --- |
| `google_play:submission_succeeded` | 通过 Hands 执行的 Google Play 操作已完成并生成不可变回执：向轨道提交版本（`Release submitted`）、仅保存更改暂不送审（`--changes-not-sent-for-review` → `Release saved; not sent for review`）、将已有更改正式送审（`hands releases play-send-for-review` → `Review request sent`），或上传原生调试符号（`Symbols uploaded`）。消息包含包名、版本号、`version_code`、目标轨道及请求放量比例。 |
| `google_play:submission_failed` | 通过 Hands 发起的 Play 提交或送审在生成操作回执后失败或被拦截。消息会附带错误原因代码、可识别的 Play 失败诊断说明，以及直达 Google Play Console 的链接。 |
| `google_play:release_state_changed` | 已配置轨道（`internal`、`closed`、`production`）上的 Google Play 发布生命周期状态发生变化。涵盖状态包括：<br>• `RELEASE_LIFECYCLE_STATE_DRAFT`（*Draft*，草稿）<br>• `RELEASE_LIFECYCLE_STATE_NOT_SENT_FOR_REVIEW`（*Not sent for review*，未送审）<br>• `RELEASE_LIFECYCLE_STATE_IN_REVIEW`（*In review*，审核中）<br>• `RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED`（*Approved; waiting for release*，审核通过待发布）<br>• `RELEASE_LIFECYCLE_STATE_NOT_APPROVED`（*Review rejected*，审核被拒）<br>• `RELEASE_LIFECYCLE_STATE_PUBLISHED`（*Available on track (may be partially rolled out or paused)*，已在轨道上架可用） |

### App Store 与 TestFlight 事件

| 事件名称 | 触发条件与包含的状态 |
| --- | --- |
| `app_store:version_state_changed` | App Store 正式版本的提审或发布状态发生变化。涵盖状态包括：<br>• `PREPARE_FOR_SUBMISSION`（*Preparing for submission*，准备提交）<br>• `WAITING_FOR_REVIEW`（*Waiting for review*，等待审核）<br>• `IN_REVIEW`（*In review*，正在审核）<br>• `PENDING_DEVELOPER_RELEASE`（*Approved; waiting for developer release*，审核通过，等待开发者手动发布）<br>• `PENDING_APPLE_RELEASE`（*Waiting for Apple release*，等待 Apple 发布）<br>• `READY_FOR_SALE` / `READY_FOR_DISTRIBUTION`（*Ready for distribution*，已上架可供分发）<br>• `REJECTED`（*Review rejected*，审核被拒）/ `METADATA_REJECTED`（*Metadata rejected*，元数据被拒）<br>• `DEVELOPER_REJECTED`（*Withdrawn by developer*，开发者自行撤回）/ `INVALID_BINARY`（*Build is invalid*，二进制无效）<br>Hands 会尽力查询并附带可读的营销版本号（如 `1.22.0`）以及 App Store Connect 链接。 |
| `app_store:build_upload_state_changed` | Apple 构建上传处理状态变化：`AWAITING_UPLOAD`（等待上传）、`PROCESSING`（处理中）、`COMPLETE`（*Upload processed*，构建处理完成）、`FAILED`（*Upload processing failed*，处理失败）。 |
| `testflight:upload_processing` | Hands 将 IPA 上传至 App Store Connect，且 Apple 即时回读状态为 `PROCESSING`（构建正在处理）。 |
| `testflight:internal_distribution_ready` | Hands 将构建分发给内部 TestFlight 测试组，并验证 Apple 回读已进入 `IN_BETA_TESTING`（*Ready for internal testing*，可供内部测试）。消息包含测试组名称、本地化测试说明（`What to test`）以及对应的 Git `source_commit`。 |
| `testflight:external_state_changed` | 外部 TestFlight 构建审核或测试状态变化。涵盖状态包括：<br>• `WAITING_FOR_BETA_REVIEW`（*Waiting for beta review*，等待 Beta 审核）/ `IN_BETA_REVIEW`（*In beta review*，Beta 审核中）<br>• `BETA_APPROVED`（*Approved for beta testing*，Beta 审核通过）/ `BETA_REJECTED`（*Beta review rejected*，Beta 审核被拒）<br>• `READY_FOR_BETA_SUBMISSION` / `READY_FOR_BETA_TESTING` / `IN_BETA_TESTING`（*Beta testing*，外部测试进行中）<br>• `MISSING_EXPORT_COMPLIANCE`（缺少出口合规信息）/ `IN_EXPORT_COMPLIANCE_REVIEW`<br>• `PROCESSING_EXCEPTION`（*Build processing failed*）/ `EXPIRED`（*Build expired*，构建已过期）<br>Hands 会尽力补充营销版本号、构建号（`version_code`）、测试说明和 `source_commit`。 |
| `testflight:crash_submission_created` | 测试人员在 TestFlight 提交了崩溃反馈。Hands 会幂等创建崩溃工单、保存 `.ips` 附件，并在频道推送含 `hands feedback show <app> <ticket>` 命令的通知（不会在聊天中暴露原始崩溃日志）。 |

### AppGallery、Hands 自有发布、构建与反馈事件

除 Google Play 与 Apple 商店事件外，同一频道还可以按需订阅：

- **AppGallery Connect（华为应用市场）**：`appgallery:package_state_changed`（`uploading`、`processing`、`ready`、`failed`）与 `appgallery:invitation_state_changed`（`uploading`、`processing`、`ready`、`testing_review`、`testing_scheduled`、`testing_active`、`rejected`、`stopped`）。
- **Hands 发布渠道与构建**：`release:draft_created`、`release:new`、`release:published`、`release:superseded`、`release:rolled_back`、`release:cancelled`、`release:channel_emptied`、`build:succeeded`、`build:failed`。
- **用户反馈与崩溃告警**：`feedback:new`、`feedback:comment_created`、`feedback:status_changed`、`crash:new_group`、`crash:spike`、`error:new_group`、`error:spike`。

---

## 3. 什么时候推：实时回调还是定时轮询？ {#when-events-are-pushed}

Hands 会根据各家应用商店是否提供原生的状态回调，结合**操作回执实时推送**、**商店 Webhook 实时推送**和**定时只读轮询**三种机制：

| 事件来源 | 覆盖事件 | Hands 如何感知变化 | 推送时机与频率 |
| --- | --- | --- | --- |
| **Hands 操作回执** | `google_play:submission_succeeded`<br>`google_play:submission_failed`<br>`testflight:upload_processing`<br>`testflight:internal_distribution_ready`<br>`release:*`、`build:*` | 通过 Hands CLI 或 API 执行提交、分发或发布时，服务端在确认回读后与数据库回执原子提交。 | **变化当下立即推送**：写入后立即进入 Cloudflare Queues 投递队列，通常数秒内到达 Raft 频道。 |
| **App Store Connect Webhook** | `app_store:version_state_changed`<br>`testflight:external_state_changed`<br>`app_store:build_upload_state_changed`<br>`testflight:crash_submission_created` | Apple 在审核状态或构建上传状态变化时，主动向 `/api/apps/:appId/apple-webhook` 发送带 `x-apple-signature` 签名的 HTTP POST 回调。 | **商店状态变化后立即推送**：Hands 收到 Apple 回调并完成验签后立即入队投递，无需等待轮询。 |
| **Google Play 生命周期轮询** | `google_play:release_state_changed` | Google Play 不提供版本审核/上架生命周期 Webhook。Hands 通过 Cloudflare Worker 定时任务（Cron Trigger）以只读方式调用 Android Publisher API 查询已配置的 `internal`、`closed`、`production` 轨道。 | **每 5 分钟定时检查一次**（每个 5 分钟周期按序轮询最多 4 个已验证应用 / 12 个轨道）。轨道上首次观测到的版本会标注 `First observation; this may not be a recent change`（`initial_snapshot`）；此后只有当生命周期状态真正发生变化时才会推送转换通知（`transition`），状态未变不会重复刷屏。 |
| **AppGallery Connect 状态轮询** | `appgallery:invitation_state_changed`<br>`appgallery:package_state_changed` | Hands 发起的操作在完成时立即记录；后台包体编译与邀请测试审核进展由 Worker 定时任务只读查询。 | Hands 操作触发的变化**立即推送**；后台编译与审核状态**每 5 分钟定时检查一次**（每轮最多检查 4 条处理中记录）。 |

### 失败自动重试与手动补发

所有通知都经过 D1 的持久化 `webhook_deliveries` 队列表。首次投递由 Cloudflare Queues 立即触发；如果遇到网络抖动或暂不可达，每 5 分钟运行的定时清理任务会按 `5 分钟 → 30 分钟 → 2 小时` 退避重试。若自动重试次数耗尽，应用管理员可在 **设置 → Raft 通知** 页面底部查看失败记录并点击 **重试**（保持原幂等键与事件内容）。

---

## 4. 智能体（Agent）拿到通知后能做什么 {#what-agents-can-do}

因为 Hands App Bot 直接把结构化的版本、构建号（`version_code`）、轨道和状态卡片发进 Raft 频道，加入该频道的 AI 智能体会由 Raft 自动唤醒，无需在后台挂起轮询脚本或人工盯盘。

在 `#proj-mobile-release` 等发布频道中，智能体收到通知后可以立即串联以下工作流：

1. **审核一过或正式上架，第一时间通知负责人**
   - 当频道收到 `google_play:release_state_changed` 显示 `production` 轨道变为 `Available on track`（`RELEASE_LIFECYCLE_STATE_PUBLISHED`），或收到 `app_store:version_state_changed` 显示版本变为 `PENDING_DEVELOPER_RELEASE` / `READY_FOR_DISTRIBUTION` 时，负责发布的智能体可以直接读取消息中的版本号、`version_code` 和轨道，第一时间向发布负责人汇报（例如 Google Play `1.22.0` 正式轨审核通过上架后，智能体立即发消息通知 `artin`）。
2. **自动衔接多阶段发布流水线**
   - **iOS 构建处理完自动转入下一步**：智能体调用 `hands builds testflight-upload` 上传 IPA 后即可结束当前回合；等频道弹出 `📦 Upload processed`（`app_store:build_upload_state_changed` → `COMPLETE`）或 `✈️ Ready for internal testing`（`testflight:internal_distribution_ready`）时自动被唤醒，继续执行外测提审或 `hands app-store prepare` + `submit`。
   - **手动发布（`MANUAL`）版本的批准后确认**：当 App Store 版本进入 `PENDING_DEVELOPER_RELEASE`（*Approved; waiting for developer release*）时，智能体可以主动在频道或私信中提醒负责人确认上架时机，获得明确授权后立即执行 `hands app-store release <app> <version-id> --version-name <ver> --commit`。
3. **遇到拒审或提交失败时立即介入排查**
   - 当收到 `app_store:version_state_changed` 的 `REJECTED` / `METADATA_REJECTED`、`google_play:release_state_changed` 的 `Review rejected`（`RELEASE_LIFECYCLE_STATE_NOT_APPROVED`），或 `google_play:submission_failed`（附带失败原因码）时，智能体可以立即在发布线程中告警，并自动运行 `hands app-store preflight`、`hands app-store status` 检查阻塞项，准备修复方案，不必等人工去翻商店后台。
4. **带着上下文直接分诊 TestFlight 崩溃与用户反馈**
   - 当 `testflight:crash_submission_created` 或 `feedback:new` 推送到频道时，通知末尾自带可直接执行的 CLI 命令（`hands feedback show <app> <ticket>`）。智能体拿到工单号后即可立即拉取反混淆后的堆栈或截图附件，定位问题并提交修复 PR。
