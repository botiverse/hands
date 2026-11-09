---
title: "智能体命令行：反馈处理"
description: "使用 @botiverse/hands-cli 从命令行读取和处理反馈与崩溃工单。"
category: "For agents"
order: 3
---

# 智能体命令行：处理反馈和崩溃

本指南面向需要从命令行**读取并处理反馈和崩溃工单**的智能体。更完整的认证模型及发布、分享操作见[智能体指南](agent-guide.md)；所有命令见[命令行参考](cli-reference.md)。

## 选择正确的认证方式

`@botiverse/hands-cli` 是交互式智能体、管理员操作和 CI 支持的工具。Raft 清单仅保留 `agent-login` 和 `migration-help`，以及支持消费者迁移到此命令行流程期间暂时需要的五个反馈操作。其他清单操作不再公开；其 HTTP API 路由保持不变。

Raft Agent Login 会话和命令行会话有意保持分离。不要通过抓取 Cookie 或回调交接数据来连接两者。在受管理的 Raft 智能体内，`hands login` 使用清单中的 `agent-login` 操作，并保存可刷新的 Hands 会话供后续命令使用。用户使用浏览器登录；CI 使用显式部署令牌。

## 1. 认证命令行

```bash
npm install -g @botiverse/hands-cli
hands login
hands whoami
```

对于限定于应用的 CI 自动化，应用管理员也可以创建部署令牌：

```bash
hands deploy-tokens create <app> --name agent-cli --role publisher --json
```

将只显示一次的原始令牌存入私有密钥管理器，再导出为命令行使用的 `HANDS_AUTH_TOKEN`。只读处理使用 `viewer` 令牌；只有脚本必须修改工单或版本时才使用 `publisher`。如果首次写入密钥管理器失败，请撤销并替换令牌。

## 2. 运行命令行

无需全局安装：

```bash
npm exec --package @botiverse/hands-cli -- hands whoami
```

如需可复现结果，可通过 `@botiverse/hands-cli@0.3.2` 固定版本。以下所有命令都接受 `--json`，便于编写脚本。

## 处理命令

第一个参数是**应用 slug**（或 ID），例如 `raft-android`。

```bash
# 列出工单，最新的排在前面（可以筛选）
hands feedback list raft-android --status open --kind crash
hands feedback list raft-android --kind crash --crash-type system_kill
hands feedback list raft-android --kind bug

# 对已启用外部报告分流的 iOS 应用：
hands feedback list raft-ios --build-scope external

# 查看工单的描述、设备信息、附件和评论。
# 使用提交工单的响应或引用中的完整 UUID。
hands feedback show raft-android 389d855b-0000-0000-0000-000000000000

# 处理：修改状态、关闭原因和（或）重新分配负责人
hands feedback update raft-android 389d855b-0000-0000-0000-000000000000 --status in_progress --assignee me
hands feedback update raft-android 389d855b-0000-0000-0000-000000000000 --status resolved
hands feedback update raft-android 389d855b-0000-0000-0000-000000000000 --status closed --closure-reason not_planned
hands feedback update raft-android 389d855b-0000-0000-0000-000000000000 --closure-reason duplicate --duplicate-of 11111111
hands feedback update raft-android 389d855b-0000-0000-0000-000000000000 --assignee none   # 移除负责人

# 公开回复报告人（他们可以在反馈对话中看到）
hands feedback comment raft-android 389d855b-0000-0000-0000-000000000000 "reproduced on SGT-AL10; fix in progress"

# 仅工作人员可见的内部备注（需要 feedback:triage 或 publisher 角色）
hands feedback comment raft-android 389d855b-0000-0000-0000-000000000000 "root cause: null listItemId in badge render" --internal
```

状态流程：`open → in_progress → resolved → closed`。关闭工单时必须传入 `--closure-reason`（`completed`、`not_planned`、`cannot_reproduce`、`duplicate` 或 `no_longer_needed`），原因为 `duplicate` 时还需传入 `--duplicate-of <ticketId>`。负责人与状态相互独立。

应用启用外部 iOS 报告分流后，默认列表保留已配置和未知来源的报告。`--build-scope external` 显示不匹配的报告；`--build-scope all` 显示全部报告。上报的 bundle ID 来自客户端，仅供处理时参考，并非身份凭证。

应用发布者在至少为一个渠道配置 bundle ID 后，可以在 iOS 应用设置中启用此功能。新报告的 ID 不匹配时，不会创建普通反馈或崩溃通知卡片；专用报告人通知仍然有效。报告和已有排队投递不会被删除。

经过认证的 `/api/apps/:appId/feedback/material-delta` 流保留所有报告和原有游标语义。启用时其 `build_origin` 为 `configured`、`external` 或 `unknown`，停用时为 `null`。消费者可以跳过外部报告，但只能在处理完整页后推进游标。渠道变化会立即影响分类，却不会为旧报告创建新增量；需要重新考虑这些报告时，请扫描列表，或从较早的游标以幂等方式重新扫描。

## 通过反馈 ID 快速查找

用户粘贴 Hands 反馈 ID 时，先确定应用 slug。Raft Android/mobile 通常使用 `raft-android`。

新的 Hands 反馈响应在 `id` 和可复制的 `reference` 字段中都包含完整 UUID，例如：

```text
raft-android · 1.0.4 (1000400) · ticket 389d855b-0000-0000-0000-000000000000
```

直接使用该 UUID：

```bash
TICKET_ID=389d855b-0000-0000-0000-000000000000
APP=raft-android

hands feedback show "$APP" "$TICKET_ID"
```

命令行的人类可读输出现在会打印完整 UUID。也可以传入**短 ID 或任意唯一前缀**；反馈读取、详情和附件接口会自动解析为完整工单 ID。前缀不唯一时返回 `409`，请使用更长的前缀或完整 UUID：

```bash
hands feedback show raft-android 389d855b   # 可使用 8 位短 ID
```

排查诊断信息时首先查看 `show` 输出：其中包含用户消息、版本和渠道、设备信息、评论及全部附件 ID。存在映射或符号文件时，崩溃反混淆或符号化结果会作为内部评论附加。

脚本应保留原始 JSON：

```bash
hands feedback show "$APP" "$TICKET_ID" --json > ticket.json
```

## 崩溃

崩溃工单（`--kind crash`）有一个用于分组的**特征签名**（异常类加顶部堆栈帧）。上传构建的 `mapping.txt`（Java/R8）或 `native-symbols` 压缩包后，自动反混淆或符号化的堆栈会作为内部评论附加，可通过 `feedback show` 查看。要跨设备按签名汇总，请直接调用 API：

```bash
curl -s -H "Authorization: Bearer $HANDS_BEARER_TOKEN" \
  https://hands.build/api/apps/<appId>/feedback/crash-groups
```

## 附件（诊断压缩包和日志）

`feedback show` 列出每个附件的 ID、文件名和大小。通过命令行下载时，可以使用应用 slug 和工单短 ID 或前缀：

```bash
hands feedback download-attachment raft-android 389d855b <attachmentId>
# → 已保存 445539 字节到 raft-feedback-....zip（使用 -o 选择路径）
```

Hands 会**原样保存原始字节**，不会解压或解释内容。Hands 不定义应用诊断压缩包内的文件，只负责存储并提供附件；生成附件的应用负责日志格式和压缩包结构。如何打开特定应用的压缩包应查看该应用仓库中的文档。

也可以直接通过 REST 获取附件和工单详情。API 路径使用应用 **UUID**，而不是 slug：

```bash
APP_ID="$(hands apps get "$APP" --json \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"

curl -s -H "Authorization: Bearer $HANDS_BEARER_TOKEN" \
  "https://hands.build/api/apps/$APP_ID/feedback/$TICKET_ID"                       # 工单详情
curl -s -H "Authorization: Bearer $HANDS_BEARER_TOKEN" \
  "https://hands.build/api/apps/$APP_ID/feedback/$TICKET_ID/attachments/<attachmentId>" \
  -o diagnostics.zip                                                                     # 原始附件
```

## 其他环境选项

- `HANDS_API`：将命令行指向非生产 Worker，默认指向生产地址。
- `--json`：每个命令都可输出机器可读结果，适合需要解析结果的智能体。
