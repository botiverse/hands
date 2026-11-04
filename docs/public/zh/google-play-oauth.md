---
title: "连接 Google Play"
description: "无需服务账号密钥即可连接、配置、验证和撤销 Google Play 授权。"
category: "Console"
order: 7
---

# 连接 Google Play

连接你的 Google 账号，通过 Hands 发布 Android 应用。无需服务账号 JSON 密钥。

## 连接前准备

你需要是 Hands 中该应用的管理员，并拥有一个能访问同一 Play 应用的 Google 账号。应用应已在 Play Console 中创建，该账号需有你准备使用的测试或正式发布轨道权限。

## 连接账号

1. 在 Hands 打开 Android 应用，点击左侧 **集成**。
2. 找到 **Google Play**，点击右侧 **连接**。
3. 登录有该 Play 应用权限的 Google 账号，同意请求的访问权限。
4. 返回 Hands 后，展开 Google Play 完成配置。账号已连接但尚未保存设置时，会显示 **待配置**。

## 选择应用和轨道

1. 选择 Android 包名。Hands 会从已上传的 Android 构建中提供候选，也可以手动填写；必须与 Play Console 中的应用一致。
2. Hands 会读取该包名可用的真实 Play 轨道。选择内部测试、封闭测试及正式发布轨道。如果有多个封闭测试轨道，例如 alpha 和 beta，请选择你准备使用的那个。
3. 点击 **保存**。校验成功后连接会启用。

连接和保存设置不会上传或发布版本。之后可用 **测试连接** 检查访问是否仍正常，不会发布版本。

## 发布构建

为 Play 应用准备正确签名的 Android App Bundle（AAB）。完成正常的构建审核和验收后，再通过 Hands 明确提交到目标轨道。建议先提交内部测试，验证安装包后再扩大分发范围。有该应用发布权限的发布者可以提交，无论是用户还是智能体。

每个新构建使用新的 版本号（versionCode）。首次上传可以沿用应用的版本编号方案，不必从 1 开始。Google Play 可能要求先完成应用设置或审核才能接受版本。

## 遇到问题

| 现象 | 处理 |
| --- | --- |
| 连接按钮不可用，提示服务器未配置 Google 授权 | 联系 Hands 管理员启用服务器的 Google Play 集成。 |
| Google 拒绝访问 | 确认登录的是有该 Play 应用权限的账号，并按 Google 页面提示完成访问或验证要求。 |
| 返回 Hands 后连接失败 | 查看 Google Play 行显示的原因，再点击连接重试。 |
| 无法读取轨道 | 检查包名及 Google 账号的应用权限，然后刷新。错误包含 SERVICE_DISABLED 时，请 Hands 管理员为该集成启用 Google Play API。 |
| 账号已连接，但仍待配置 | 展开 Google Play，选择包名和轨道并保存。 |
| 原先正常的连接失效 | 先测试连接；Google 授权过期或被撤销时，重新连接。 |

## 停用或解除绑定

**停用**会停止通过此连接发布，并保留设置供以后使用。

**解除绑定**会移除 Hands 为该应用保存的 Google Play 连接。要撤销 Google 账号本身的授权，请打开 [Google 账号连接](https://myaccount.google.com/connections)，移除相应应用。这可能影响其他使用同一 Google 账号和连接的 Hands 应用。

## 发布通知

应用 Webhook 可以订阅 `google_play:submission_succeeded`、`google_play:submission_failed` 和 `google_play:release_state_changed`。提交事件来自不可修改的 Hands 推送回执，包含包名、版本号、Hands 轨道和回执 ID。提交成功并不代表审核通过或已可下载。使用 `--changes-not-sent-for-review` 上传的版本包含 `action: "promote"` 和 `review_requested: false`；`hands releases play-send-for-review` 对应 `action: "send-for-review"` 和 `review_requested: true`。普通推送不包含这两个字段。Hands 在创建推送回执之前发生的失败仍是 API 错误，不会生成发布通知。

对于已启用且经过验证的连接，Hands 会读取所配置轨道的 Google 实时发布生命周期。查询每五分钟运行一次，每次最多处理四个应用；应用更多时，会在后续轮次依次处理。第一次观察是当前状态快照（`observation: initial_snapshot`），此后状态变化才生成转换事件。状态不变不会产生新通知。状态与待投递记录一同提交；服务商请求失败时会保留上一次观察结果，并在后续定时运行中重试。

`RELEASE_LIFECYCLE_STATE_PUBLISHED` 表示版本在该轨道上可用；它可能仍处于部分发布或暂停状态，并不表示已全量发布。未知状态原样保留。连接被移除或修改后，不会发布先前尚未完成请求的响应。这里使用只读 API，而不是 Google Webhook；不会上传文件、提交编辑或发布版本。

参阅 [Google 发布生命周期文档](https://developers.google.com/android-publisher/api-ref/rest/v3/applications.tracks.releases)。
