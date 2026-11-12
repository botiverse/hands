---
title: "React 反馈收件箱"
description: "通过安全的服务端 Hands 代理嵌入报告人专属的工单收件箱和对话界面。"
category: "SDKs & API"
order: 15
---

# 在 React 应用中嵌入反馈收件箱

`@botiverse/hands-feedback-react` 提供面向报告人的工单收件箱、对话视图、回复编辑器、附件处理、未读状态和新反馈表单。它是界面及交互状态包；可信服务端仍需负责识别已登录用户并调用 Hands。

本指南介绍从 Hands 凭据到 React 组件的完整接入过程。

## 架构和信任边界

使用三层结构：

1. 浏览器渲染 `FeedbackProvider` 和 `FeedbackWorkspace`。
2. 你的同源服务端认证用户，向浏览器暴露范围受限的反馈接口。
3. 服务端使用应用的报告人集成令牌和稳定的不透明报告人 ID 调用 Hands。

绝不要在浏览器 JavaScript 中放入 Hands 部署令牌、报告人 ID 密钥、Webhook 签名密钥或报告人会话令牌。React 包有意不为这些值提供属性。

Hands 负责工单数据和已读回执。你的应用负责将已登录账号映射到不透明的 Hands 报告人 ID。Hands 的归属边界是精确的 `(应用, 报告人集成, 报告人 ID)` 组合。

## 包状态与安装

React 包目前位于 Hands 仓库中，**尚未发布到 npm**。首次发布到 npm 之前，请固定完整 Hands 提交并使用明确的源码导出。完整提交 SHA 可以让安装结果可复现。

```bash
pnpm add "github:botiverse/hands#<full-commit-sha>&path:packages/feedback-react"
pnpm add react react-dom @botiverse/raft-ui lucide-react
```

```tsx
import {
  FeedbackProvider,
  FeedbackWorkspace,
  FeedbackTransportError,
  type HandsFeedbackTransport,
} from "@botiverse/hands-feedback-react/source";
import "@botiverse/raft-ui/styles.css";
import "@botiverse/hands-feedback-react/source/styles.css";
```

固定源码的路径要求打包工具能够编译 TypeScript 和 TSX 依赖。npm 包发布后，请改为安装并导入已编译的根入口：

```bash
pnpm add @botiverse/hands-feedback-react @botiverse/raft-ui lucide-react
```

```tsx
import {
  FeedbackProvider,
  FeedbackWorkspace,
} from "@botiverse/hands-feedback-react";
import "@botiverse/raft-ui/styles.css";
import "@botiverse/hands-feedback-react/styles.css";
```

如果 Tailwind v4 移除了库中的样式类，请将两个编译后的包都加入扫描源：

```css
@source '../node_modules/@botiverse/raft-ui/dist';
@source '../node_modules/@botiverse/hands-feedback-react/dist';
```

## 一次性 Hands 设置 {#one-time-hands-setup}

你需要：

- 一个 Hands 应用及其应用 ID 和 slug；
- 一个启用的报告人集成；
- 一个绑定该集成且不带角色的部署令牌；
- 代理所需且仅限所需的反馈权限。

对于完整的收件箱、对话、新工单和路由事件流程，请授予全部四项反馈权限：

```json
[
  "feedback:write",
  "feedback:read",
  "feedback:comment",
  "feedback:route"
]
```

不要添加应用角色或无关权限。报告人集成令牌有意限定为仅用于反馈。请将该报告人集成专用于交互式收件箱，仅通过其报告人标识提交 `feedback` 或 `bug` 工单；崩溃和错误采集应使用单独的集成或匿名客户端流程。

应用管理员可以通过已认证的 Hands API 创建集成和令牌。以下设置请求中的 `HANDS_ADMIN_BEARER` 是用户或智能体的管理员会话，不是第二个请求返回的报告人令牌。

```bash
export HANDS_ORIGIN=https://hands.build
export HANDS_APP_ID="APP_UUID"
export HANDS_ADMIN_BEARER="ADMIN_SESSION_TOKEN"

curl --fail-with-body \
  -H "Authorization: Bearer $HANDS_ADMIN_BEARER" \
  -H "Content-Type: application/json" \
  -d '{"name":"my-product-feedback"}' \
  "$HANDS_ORIGIN/api/apps/$HANDS_APP_ID/reporter-integrations"
```

复制返回的集成 `id`，然后创建不带角色的令牌：

```bash
export HANDS_REPORTER_INTEGRATION_ID="REPORTER_INTEGRATION_UUID"

curl --fail-with-body \
  -H "Authorization: Bearer $HANDS_ADMIN_BEARER" \
  -H "Content-Type: application/json" \
  --data "$(jq -nc \
    --arg integration "$HANDS_REPORTER_INTEGRATION_ID" \
    '{
      name: "my-product-feedback-server",
      scopes: ["feedback:write", "feedback:read", "feedback:comment", "feedback:route"],
      reporter_integration_id: $integration,
      expires_in_days: 365
    }')" \
  "$HANDS_ORIGIN/api/apps/$HANDS_APP_ID/deploy-tokens"
```

原始令牌只返回一次，应直接存入服务端密钥管理器。不要提交到代码库、写入日志或发送到浏览器。轮换时先创建替代令牌、更新密钥管理器并验证，再撤销旧令牌。

## 派生不透明报告人标识 {#derive-opaque-reporter-coordinates}

对每个已认证用户，在服务端派生两个限定于应用的不透明值：

- `reporterId`：16–200 个 Base64URL 字符，对同一应用和报告人集成保持稳定；
- `routeSubject`：`rfr_v1_` 加一个 Base64URL 值，对同一标识组合保持稳定且不可变。

不要向 Hands 发送原始电子邮件地址、用户名、Raft 名称或数据库 ID。通过域分离的 HMAC，服务端可以重复派生相同值，而无需在 Hands 中存储反向查找信息：

```ts
import { createHmac } from "node:crypto";

function opaqueHmac(secret: string, domain: string, accountId: string) {
  return createHmac("sha256", secret)
    .update(`${domain}\0${accountId}`, "utf8")
    .digest("base64url");
}

export function handsReporterCoordinates(input: {
  appId: string;
  integrationId: string;
  accountId: string;
}) {
  const secret = process.env.HANDS_REPORTER_ID_SECRET;
  if (!secret) throw new Error("HANDS_REPORTER_ID_SECRET is not configured");
  const scope = `${input.appId}\0${input.integrationId}`;
  return {
    reporterId: opaqueHmac(
      secret,
      `hands-feedback-reporter-v1\0${scope}`,
      input.accountId,
    ),
    routeSubject: `rfr_v1_${opaqueHmac(
      secret,
      `hands-feedback-route-v1\0${scope}`,
      input.accountId,
    )}`,
  };
}
```

HMAC 密钥应按凭据保护。更改它会改变所有报告人标识，因此轮换应作为身份迁移规划，而不是普通的密钥替换。

## 首个工单前绑定路由

可信报告人提交需要路由绑定。在列出、读取详情或创建工单前的反馈初始化过程中完成绑定：

```http
PUT /api/apps/:appId/reporter-feedback/route-subject
Authorization: Bearer <reporter-integration token>
X-Hands-Reporter-Id: <opaque reporter id>
Content-Type: application/json

{ "route_subject": "rfr_v1_<opaque base64url value>" }
```

新绑定返回 `201` 和 `changed: true`；完全相同的重复绑定返回 `200` 和 `changed: false`。同一应用、集成和报告人组合使用不同主体时返回 `409`；应停止并调查，不要悄悄替换。

路由主体会在专用的已签名报告人 Webhook 流程和仅限服务端的集成变化接口中携带。它使服务端可以路由信号，而无需在 Webhook 配置中保存用户数据。

## 代理 Hands 报告人 API

服务端发出的每个上游请求均包含：

```http
Authorization: Bearer <reporter-integration token>
X-Hands-Reporter-Id: <opaque reporter id>
```

通过自己已认证的同源 API 代理以下 Hands 操作：

| 浏览器操作 | Hands 上游操作 |
|---|---|
| 列出工单 | `GET /api/apps/:appId/reporter-feedback?limit=20&cursor=...` |
| 读取工单 | `GET /api/apps/:appId/reporter-feedback/:ticketId?comment_limit=50&comment_cursor=...` |
| 创建工单 | 以 multipart 调用 `POST /public/v2/apps/:appSlug/feedback`，然后读取返回的工单 ID |
| 回复 | 以 JSON 或 multipart 调用 `POST /api/apps/:appId/reporter-feedback/:ticketId/comments` |
| 关闭本人拥有的工单 | `POST /api/apps/:appId/reporter-feedback/:ticketId/close` |
| 下载附件 | `GET /api/apps/:appId/reporter-feedback/:ticketId/attachments/:attachmentId` |

为每个新工单草稿或回复生成一个 UUID 作为 `submission_id`，并在重试时保持不变。新写入返回 `201`，完全相同的重放返回 `200`，相同 ID 用于不同内容返回 `409`。

不要接受浏览器提供的报告人 ID、集成 ID、Hands 令牌或任意上游 URL；所有权限都应由服务端已认证会话确定。构造上游路径前验证工单和附件 UUID；尽可能以流式方式传递附件正文而不缓冲整个文件，并保留 Hands 返回的 `Content-Type`、`Content-Disposition`、`Cache-Control` 和 `X-Content-Type-Options` 响应头。

Hands 可选支持仅用于服务端、有效期为 30 秒的报告人会话。它们可以减少重复读取和评论时长期令牌的验证工作，但仍是服务端凭据，默认关闭。普通集成可以直接使用仅用于反馈的部署令牌调用报告人接口。

Hands 对单个报告人和单个集成都实施安全限制：

| 操作 | 每位报告人 | 每个集成 |
|---|---:|---:|
| 列表 | 60 次/分钟 | 600 次/分钟 |
| 详情 | 120 次/分钟 | 1,200 次/分钟 |
| 附件 | 120 次/小时 | 1,200 次/小时 |
| 评论 | 30 次/小时 | 300 次/小时 |
| 可信工单提交 | 100 次/小时 | — |

通过代理转发 `429` 和 `Retry-After`。保留用户草稿，仅在指定延迟后重试；不要立即循环重试，也不要更换 `submission_id` 来绕过限制。

## 实现 React 传输层

包要求宿主提供 `HandsFeedbackTransport`。传输层应指向同源代理，绝不要直接指向 Hands。

以下辅助代码展示这一边界。请将接口名称改为你的服务端接口，并将其 JSON 映射为 SDK 导出的类型。

```tsx
import {
  FeedbackProvider,
  FeedbackTransportError,
  FeedbackWorkspace,
  type HandsFeedbackTransport,
} from "@botiverse/hands-feedback-react/source";

async function readJson(response: Response) {
  if (response.ok) return response.json();
  const code =
    response.status === 400 ? "invalid" :
    response.status === 401 || response.status === 403 ? "unauthorized" :
    response.status === 404 ? "not_found" :
    response.status === 409 ? "conflict" :
    response.status === 429 ? "rate_limited" : "unavailable";
  throw new FeedbackTransportError(code);
}

const transport: HandsFeedbackTransport = {
  async listTickets({ cursor, limit, signal }) {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    return readJson(await fetch(`/api/feedback/tickets?${query}`, { signal }));
  },

  async getTicket({ ticketId, commentCursor, commentLimit, signal }) {
    const query = new URLSearchParams({
      comment_limit: String(commentLimit),
    });
    if (commentCursor) query.set("comment_cursor", commentCursor);
    return readJson(await fetch(
      `/api/feedback/tickets/${encodeURIComponent(ticketId)}?${query}`,
      { signal },
    ));
  },

  async createTicket({ kind, message, submissionId, attachments, signal }) {
    const form = new FormData();
    form.set("kind", kind);
    form.set("message", message);
    form.set("submission_id", submissionId);
    for (const file of attachments) form.append("attachments", file);
    return readJson(await fetch("/api/feedback/tickets", {
      method: "POST",
      body: form,
      signal,
    }));
  },

  async addComment({ ticketId, body, submissionId, attachments, signal }) {
    const form = new FormData();
    form.set("body", body);
    form.set("submission_id", submissionId);
    for (const file of attachments) form.append("attachments", file);
    return readJson(await fetch(
      `/api/feedback/tickets/${encodeURIComponent(ticketId)}/comments`,
      { method: "POST", body: form, signal },
    ));
  },
};

export function FeedbackPage() {
  return (
    <FeedbackProvider
      transport={transport}
      locale="zh-CN"
      onUnreadChanged={({ total }) => updateFeedbackBadge(total)}
    >
      <FeedbackWorkspace />
    </FeedbackProvider>
  );
}
```

代理可以直接返回 SDK 使用的驼峰命名 DTO。如果它原样转发 Hands JSON，请将 `created_at`、`updated_at`、`attachment_count`、`comment_count`、`unread_count`、`author_type`、`content_type`、`size_bytes`、`next_cursor`、`next_comment_cursor` 和 `unread_total` 映射为 SDK 中对应的驼峰字段。将列表工单的 `latest_comment` 映射为 `latestComment`（`{ authorType, bodyPreview, createdAt }` 或 `null`）：每行会将其显示在标题下方。如果代理没有该字段，则不传 `latestComment`，该行就不会显示预览。

### 页面标题

收件箱可放在你自己的页面标题下：传入 `hideHeaderTitle` 后，收件箱从筛选栏开始。工单和新反馈各有独立页面及 56px 标题栏（返回、标题、工单状态），因此工作区进入这些页面时应隐藏你的页面标题，避免两个标题栏叠加。通过 `onRouteChange` 跟踪视图，无论是否由你控制 `route`，它都会触发：

```tsx
const [view, setView] = useState<FeedbackWorkspaceRoute["view"]>("inbox");

{view === "inbox" && <MyPageHeader title="反馈" />}
<FeedbackWorkspace
  hideHeaderTitle
  onRouteChange={(route) => setView(route.view)}
/>
```

### 收件箱提示

`FeedbackWorkspace` 和 `FeedbackInbox` 的 `inboxNotice` 可将宿主提供的提示放在工具栏和工单列表之间，位于列表滚动区域；进入工单或新建反馈时它被隐藏但保持挂载。传入 `cond ? <Notice /> : null`，不要用 `cond && <Notice />`：数字 `0` 仍会显示。列表使用覆盖式滚动区域，滚动条不占内容宽度，继续支持 `@botiverse/raft-ui` 0.20.0 或以上、1.0.0 以下版本。工具栏、提示和工单内容的左右边缘统一：窗口宽度至少 48rem 且主指针为鼠标时是 16px，其他情况是 20px。

工作区负责列表分页、焦点和滚动位置恢复、回复草稿、输入法安全的回车处理、附件进度及重试和取消、可恢复的游标页面，以及接近底部时跟随对话。宿主应用不要再实现一套相同的状态机。

## 本地化和主题

内置语言为英语和简体中文。显式设置的 `locale` 优先；否则包会将浏览器的 `zh*` 语言映射到 `zh-CN`，其他语言回退到英语。宿主可以覆盖单条文案和格式化函数：

```tsx
<FeedbackProvider
  transport={transport}
  locale={appLocale}
  messages={{
    newFeedback: t("feedback.new"),
    attachmentUnsupported: t("feedback.attachmentUnsupported"),
  }}
  formatDate={(date, { locale }) => appDateFormatter(date, locale)}
  formatFileSize={(bytes, { locale }) => appFileSizeFormatter(bytes, locale)}
>
  <FeedbackWorkspace />
</FeedbackProvider>
```

所有部分均由 `@botiverse/raft-ui`（Raft 设计系统）绘制，使用同一套外观并支持浅色和深色，没有主题属性。所有可见文案、错误文案、日期、文件大小和无障碍标签均使用最终确定的 SDK 语言。

## Webhook 和未读状态

Webhook 对收件箱的正确性是可选的。Hands 是工单内容和未读状态的权威来源；列表和详情响应包含 `unread_total`。成功读取详情时，Hands 的已读回执只会推进到该页返回的、报告人可见的工作人员或系统回复。

需要推送通知时，使用专用的报告人集成 Webhook。使用原始请求字节验证签名，根据稳定的事件 ID 去重，并仅根据不透明路由主体确定接收方。重试复用相同的请求体、签名、事件 ID 和投递 ID。

## 生产环境检查清单

- 令牌不带应用角色，且只具有所需反馈权限范围。
- 令牌、报告人 ID 的 HMAC 密钥和 Webhook 密钥只存于服务端。
- 首次路由初始化返回 `201`，完全相同的重放返回 `200`。
- 新工单返回 `201`；相同提交重试返回 `200` 和同一工单。
- 列表和详情只返回当前登录报告人的工单。
- 跨报告人的工单、评论和附件访问返回 `404`。
- 回复重试是幂等的；同一 UUID 下修改内容返回 `409`。
- `429` 会保留草稿并遵守 `Retry-After`。
- 附件类型、数量或大小校验失败时保留草稿。
- 浏览器响应、日志、源码映射、HAR 或错误报告中均不包含 Hands 令牌或服务端报告人标识。

完整接口约定、限制和响应行为见[公开 API 参考](public-api-reference.md)和交互式 [API 浏览器](https://hands.build/api-docs)。

无需 React 的纯文本服务端或命令行集成请参阅[服务端与命令行反馈](server-feedback.md)。
