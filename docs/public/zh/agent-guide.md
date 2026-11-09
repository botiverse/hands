---
title: "智能体指南"
description: "AI 智能体如何通过 Raft Agent Login 或部署令牌认证，并管理发布、工单和分享。"
category: "For agents"
order: 2
---

# 智能体指南

Hands 面向智能体设计：操作人员在控制台中可以执行的操作，AI 智能体也可以通过 API 和命令行执行。本指南介绍智能体如何认证和执行标准操作。

## 认证

根据所需范围选择两种方式之一：

| 方式 | 范围 | 用途 |
|---|---|---|
| **Hands 命令行登录** | 组织级角色（`viewer`、`member`、`admin`、`owner`） | 管理操作：创建应用、审核和发布版本、处理工单、管理分享。 |
| **部署令牌** | 单个应用，`viewer` 或 `publisher` 角色 | CI 和范围较窄的自动化：发布构建、为单个应用创建分享。 |

### Hands 命令行登录

安装并认证一次：

```bash
npm install -g @botiverse/hands-cli
hands login
hands apps list
```

在受管理的 Raft 智能体内，`hands login` 通过清单的 `agent-login` 操作交换一次性授权，并保存可刷新的 Hands 会话。用户使用浏览器登录。独立的 Raft 集成会话不会导出为 `HANDS_AUTH_TOKEN`；不要抓取 Cookie 或回调交接数据来连接两者。迁移指南可调用清单中的 `migration-help` 操作。除支持消费者完成命令行迁移前暂时保留的反馈桥接外，其他清单操作已移除。

你的能力由 Hands 组织角色决定。`403` 响应会指出所需角色；请组织所有者在组织设置中调整成员权限。

### 跨服务器应用访问

Hands 账号限定于首次创建该账号的 Raft 服务器身份。当应用管理员与目标主体位于不同 Raft 服务器时，目标可能不会出现在管理员的同组织选择器中。目标应运行 `whoami`，私下发送返回的非秘密 Hands 账号 ID。应用管理员随后可直接授权，无需分享登录令牌：

```bash
hands apps add-member <app> <hands-account-uuid> viewer
hands api GET /api/apps/<app-uuid>/members   # 验证直接授权
```

`hands apps update-member` 修改直接角色；`hands apps remove-member` 只移除直接授权，不改变从组织或服务器继承的访问权限。

### 部署令牌

在应用的**设置 → 部署令牌**界面创建，或在当前身份是应用管理员时通过命令行创建：

```bash
hands deploy-tokens create <app> --name github-ci --role publisher --json
```

原始令牌仅返回一次。应直接送入目标 CI 的密钥存储，然后丢弃响应文件。如果存储失败，请撤销该令牌 ID 并创建替代令牌；不要让未使用的凭据保持有效。

部署令牌限定于单个应用，可以设置过期时间；审计日志将其操作归属为 `deploy-token:<name>@<app>`。CI 优先使用部署令牌，交互式智能体操作优先使用 Agent Login。

### 集成清单的 URL 约定

清单操作路径必须是绝对路径，URL 解析结果必须指向真实 API 路由。正确的 Hands 约定是：

```json
{
  "execution": { "base_url": "https://hands.build" },
  "endpoint": { "path": "/api/apps" }
}
```

不要将 `base_url: https://hands.build/api` 与同样以 `/api` 开头的操作路径组合；清单校验会拒绝重复的 API 基础路径。也不要将这个带子路径的基础地址与 `/apps` 组合：标准 URL 解析会将路径重置为 `https://hands.build/apps`，返回控制台而不是 API。修改清单后，应在生产环境同时验证 `--list-actions` 和一次真实 JSON 操作响应。

## 标准操作

所有命令行命令都接受 `--json`，便于编写脚本。

### 发布流程（先草稿）

CI 创建草稿，智能体审核并发布。**发布前必须审核更新说明；激活前必须取得当前明确的人类授权。**

使用交互式登录或部署令牌运行 Hands 命令行：

```bash
hands releases show <app> <releaseId>                 # 检查草稿及原始更新说明
hands releases update <app> <releaseId> \
  --changelog-file zh=zh.md --changelog-file en=en.md  # 已审核，按语言提供
hands releases publish <app> <releaseId>              # 明确上线
hands releases shares <app> <releaseId>
```

分享页面可将草稿交给用户进行设备审核；除非设置有效期，否则链接不会过期。报告发布情况时，始终引用构建 APK 的 SHA-256：二进制哈希才是权威依据，而不是分支头或运行 ID。`403` 表示当前身份缺少应用角色，请应用管理员授权；不要借用凭据。

每次写入之前，都要从同一份最新版本详情中获取 `expected_revision` 和 `expected_scopes`。每次生命周期变更都会递增修订号；使用过期修订号写入会返回 `409 RELEASE_REVISION_CONFLICT`，不会对版本、范围、回退或审计产生任何影响。发布也会原子地比较完整范围集合。若全量版本需要分阶段发布且必须包含验收设备，请保留一个版本，并将 `scopes` 设置为 `full:all` 加各个 `device_group`。组内成员始终收到目标版本，其他有标识的客户端则受百分比限制。随着验证结果增强，可在控制台或通过 `PATCH /api/apps/:id/releases/:releaseId` 提高 `rollout_cohort_count`。版本行会显示 `offered_count` / `current_count`，可用于观察实际覆盖情况。

每个未取消的应用、渠道、产品类型、发布类型和版本组合只能由一个版本占用。重复创建会返回 `RELEASE_VERSION_ALREADY_EXISTS`，并提供已有版本、构建和状态。取消会停用旧生命周期并释放该组合，供修正后的上传使用，但不会删除构建、文件或审计历史。只有没有替代版本占用该版本号时，恢复才会重新启用相同版本 ID。发布命令行会在创建构建前检查冲突，避免已知冲突留下孤立上传文件。如果另一个发布者在预检查之后抢先占用该组合，命令行会将自己的新构建标记为 `failed`，在来源记录中记下冲突版本，并报告新构建 ID，供审计或人工检查。对于已经到达设备的 Android 版本，应使用更高的版本号，以便客户端更新。

需要更完整的按版本视图时，可通过 Agent Login 或具有 `viewer` 能力的应用令牌调用 `GET /api/apps/:id/analytics/versions?window_days=30`。响应为每个有版本记录或仅有遥测数据的版本提供一行，包含所选时间窗口内报告过的设备、已见设备总数、更新检查的当前和已提供数量、反馈与崩溃数量，以及产物下载次数。近期报告窗口也接受 `window_minutes`；但 SDK 指标请求受限流，不能将其称为真正的在线状态。

### TestFlight 上传和分发

使用 `hands testflight --help` 查看上传、处理状态、测试组和分发命令。商店元数据变更默认只预演；只有审核了具体方案后才传 `--commit`。TestFlight 与 Hands 版本及 App Store 正式发布是独立的状态机，`.p8` 凭据始终在 Hands 中加密保存。

### 工单处理（反馈与崩溃）

```bash
hands feedback list <app> --status open --kind crash
hands feedback show <app> <ticketId>
hands feedback update <app> <ticketId> --status in_progress --assignee <name>
hands feedback comment <app> <ticketId> "reproduced; fix in progress"
hands feedback update <app> <ticketId> --status resolved
hands feedback update <app> <ticketId> --status closed --closure-reason completed
```

崩溃工单包含分组签名；如果上传了构建的 `mapping.txt`，评论中还会包含自动还原的堆栈。`GET /api/apps/:id/feedback/crash-groups` 按签名汇总。

处理属于**成员级**操作：读取工单需要 `viewer`，修改状态或负责人以及添加评论需要组织 **member**，或应用 `publisher`（例如发布者部署令牌）。完整角色矩阵见[权限参考](permissions.md)。

### 分享链接

```bash
hands releases share <app> <releaseId> --password <pw>   # 密码可选
hands releases shares <app> <releaseId>
hands releases update-share <app> <releaseId> <shareId> --ttl-seconds 1209600
hands releases revoke-share <app> <releaseId> <shareId>
```

分享 URL 只显示一次；令牌以哈希形式存储。

### 应用（组织成员角色）

```bash
hands apps create --slug my-app --name "My App" --platform android
hands apps client-key my-app
```

新应用会自动创建默认渠道（`main`、`preview`、`nightly`）和产品类型，并获得**客户端密钥**（`qk_…`）。客户端提交反馈或崩溃时须通过 `X-Hands-Client-Key` 发送该密钥；旧版 `X-Quiver-Client-Key` 请求头仍可使用：

```bash
curl -H "Authorization: Bearer $HANDS_BEARER_TOKEN" \
  https://hands.build/api/apps/<appId>/client-key          # 读取
curl -X POST -H "Authorization: Bearer $HANDS_BEARER_TOKEN" \
  https://hands.build/api/apps/<appId>/rotate-client-key   # 重新生成
```

轮换会立即使旧密钥失效，必须更新客户端构建以使用新密钥。

## 处理权限错误（403）

Hands 的角色类 403 响应**可供机器读取**，应据此采取行动，不要静默失败：

```json
{
  "error": "insufficient_org_role",       // 或 "insufficient_app_role"
  "required_role": "member",
  "current_role": "viewer",
  "resource": "POST /api/apps",            // 尝试执行的操作
  "org_id": "…", "app_id": null,
  "manage_url": "https://app.hands.build/orgs/{orgId}/members"
}
```

收到此响应后：

1. **不要盲目重试**：缺少 `required_role`，不是暂时性错误。
2. **明确告知用户下一步**，并引用 `manage_url`。例如：“执行 `<resource>` 需要此组织的 **admin** 权限，我当前是 **viewer**。组织管理员可在 `<manage_url>` 提升我的角色，之后我会重试。”
3. 用户确认角色已调整后，**重试同一个请求**。

创建应用（`POST /api/apps`）明确需要**组织 member 或更高角色**，应用成员角色或部署令牌不足。新建 Agent Login 账号通常从组织成员开始；组织管理员可以手动降为仅有读取权限的 `viewer`。如果应用应属于另一个组织，应由该组织的成员或管理员在那里创建，而不是更改你在当前组织的角色。

## 直接上传构建文件的重试

对于文件接收协议 v1，通过 `POST /api/apps/:appId/builds/:buildId/assets/uploads` 声明每个文件，向 `upload.url` 以 PUT 上传声明的字节，再向 `complete_url` 发送 POST。完成操作会同步流式读取并验证完整对象，然后返回 `state: ready`。大文件应设置足够长的完成超时；验证时间取决于对象大小及存储和网络吞吐量，没有固定的每 MB 秒数保证。

保留完全相同的声明请求体和 `idempotency_key` 以便恢复。重复声明返回 HTTP 200、相同文件及其当前状态：

| 状态 | `upload` | 下一步 |
| --- | --- | --- |
| `pending` | PUT 指令 | 如果 PUT 已成功，用现有字节重试完成操作；否则先完成 PUT。 |
| `verifying` | `null` | 等待并重复声明以轮询；验证期间不要再次 PUT。 |
| `ready` | `null` | 文件已完成。重复完成操作也返回 HTTP 200 和 `replayed: true`。 |
| `failed` / `expired` | `null` | 本次尝试已结束，停止轮询。仅凭 `upload` 为 null 绝不表示成功。 |

待处理尝试超过上传有效期后返回 HTTP 410，而不再返回 PUT 指令。客户端超时后，先用完全相同的声明轮询：原完成操作可能已结束、仍在运行或请求生命周期已丢失。如果仍为 `verifying`，延迟后重复完成操作；正在运行的验证器会返回下表中的忙碌响应。上传仍有效时，完成操作可以接管过期的验证租约。验证租约持续 15 分钟，PUT 上传窗口持续一小时。重试应受任务截止时间约束。

| 完成操作的响应 | 恢复方式 |
| --- | --- |
| HTTP 503、`ASSET_UPLOAD_SEAL_INTENT_FAILED`、`retryable: true` | 遵守 `Retry-After`（秒），然后重试同一完成操作。现有暂存字节会保留。 |
| HTTP 409、`ASSET_UPLOAD_BUSY`、`retryable: true` | 遵守 `Retry-After` 并轮询声明。`state: verifying` 表示租约被持有，但不能证明持有者仍在运行；`state: pending` 表示竞争验证器已释放租约，可使用现有字节重试完成。避免再次 PUT。 |
| HTTP 409、`ASSET_UPLOAD_TERMINAL`、`retryable: false` | 停止重试本次尝试。 |
| 其他 HTTP 409，包括非暂时性的封存意图错误 | 解决冲突，不要不加区分地重试。 |
| HTTP 410 / 422 | 上传过期或完整性校验失败，停止本次尝试。 |

也可读取 `GET /api/apps/{appId}/builds/{buildId}/assets/{assetId}/upload` 进行轮询，无需重放声明。它返回 `state`、`verification_started_at`、`verifier_lease_expires_at`、`upload_expires_at`（Unix 毫秒）、`can_retry_complete` 以及失败尝试持久保存的 `verification_error`。响应为 `no-store`，接口要求应用发布者角色。重放声明和忙碌的完成响应也包含这些字段。

验证租约不会续期：到达 15 分钟期限后，再次调用同一完成操作，使用现有暂存字节接管。其他验证器接管租约后，先前验证器不能提交。一小时上传有效期仍然适用；不承诺按文件大小计算的固定验证时长。

`503 ASSET_UPLOAD_STORAGE_FAILED` 包含 `retryable:true`、`Retry-After` 和 `phase`（`staging_head`、`seal_head`、`staging_read`、`staging_stream`、`seal_stream`、`seal_write` 或 `seal_readback`）。应重试同一完成操作，无需再次 PUT。尝试会回到待处理状态并保留暂存字节；后续验证器使用新的不可变封存代次。流操作被拒绝时会取消其他流分支，避免它们永久等待失败的消费者。运行时突然终止仍可能使验证租约保持到截止时间。

完整性失败仍是终止状态，并包含 `reason` 及可获得的预期和实际测量值。SHA-256 不匹配会包含两个哈希和大小；大小不匹配会包含预期和观察到的大小。即使对象清理后，`GET .../upload` 仍保留终止原因。

对于已终止的尝试，请创建新的待处理构建并使用新声明重试发布。已标记为 `failed` 的构建不能恢复上传。仅更改幂等键不会释放已占用的文件槽位。验证停止后，中止接口可以丢弃已放弃的待处理上传；失败或过期的尝试可能已由清理流程接管。在每个必需文件都就绪之前，不要将构建标记为成功。

## 智能体规则

1. **先建草稿**：CI 不完成发布；发布必须是经过审核的明确步骤（见仓库中的发布手册）。
2. **更新说明面向用户**：按语言编写（`{"en": …, "zh-CN": …}`），客户端收到与其语言区域对应的版本。
3. **操作必须可归属**：使用自己的智能体登录或为该用途创建的令牌，绝不复用用户的浏览器会话。
4. **不要在频道中发送秘密**：绝不要将 Bearer 令牌或部署令牌粘贴到共享聊天中；审计日志已经记录操作归属。

### 应用标识符和直接授权

原始 `/api/apps/:appId/...` 请求和控制台 `/apps/:appId/settings` 链接使用完整应用 UUID。通过 `hands apps get <slug> --json` 解析 slug 并使用返回的 `id`；名称或 slug 不是应用 ID。

添加应用成员时，如有必要还会创建组织 `viewer` 成员关系。这不会降低应用角色：应用管理员即使仍是组织查看者，也可以管理该应用。即使会话当前选择的是其他组织，直接应用授权也会出现在应用列表中；直接授权不会暴露该组织的其他应用。
