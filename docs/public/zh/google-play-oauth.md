---
title: "连接 Google Play"
description: "通过 Google 授权连接 Play：创建 Web 客户端、配置、验证和撤销，无需服务账号密钥。"
category: "Console"
order: 7
---

# 连接 Google Play

连接你的 Google 账号，通过 Hands 发布 Android 应用。无需服务账号 JSON 密钥。

## 连接前准备

你需要是 Hands 中该应用的管理员，并拥有一个能访问同一 Play 应用的 Google 账号。应用应已在 Play Console 中创建，该账号需有你准备使用的测试或正式发布轨道权限。

## 连接账号

1. 在 Hands 打开 Android 应用，点击左侧 **Integrations / 集成**。
2. 找到 **Google Play**，点击右侧 **Connect / 连接**。
3. 登录有该 Play 应用权限的 Google 账号，同意请求的访问权限。
4. 返回 Hands 后，展开 Google Play 完成配置。账号已连接但尚未保存设置时，会显示 **Needs configuration / 待配置**。

## 选择应用和轨道

1. 选择 Android 包名。Hands 会从已上传的 Android 构建中提供候选，也可以手动填写；必须与 Play Console 中的应用一致。
2. Hands 会读取该包名可用的真实 Play 轨道。选择内部测试、封闭测试及正式发布轨道。如果有多个封闭测试轨道，例如 alpha 和 beta，请选择你准备使用的那个。
3. 点击 **Save / 保存**。校验成功后连接会启用。

连接和保存设置不会上传或发布版本。之后可用 **Test connection / 测试连接** 检查访问是否仍正常，不会发布版本。

## 发布构建

为 Play 应用准备正确签名的 Android App Bundle（AAB）。完成正常的构建审核和验收后，再通过 Hands 明确提交到目标轨道。建议先提交内部测试，验证安装包后再扩大分发范围。有该应用发布权限的 publisher 可以提交，真人和 agent 均可。

每个新构建使用新的 versionCode。首次上传可以沿用应用的版本编号方案，不必从 1 开始。Google Play 可能要求先完成应用设置或审核才能接受版本。

## 遇到问题

| 现象 | 处理 |
| --- | --- |
| Connect 不可用，提示服务器未配置 Google 授权 | 联系 Hands 管理员启用服务器的 Google Play 集成。 |
| Google 拒绝访问 | 确认登录的是有该 Play 应用权限的账号，并按 Google 页面提示完成访问或验证要求。 |
| 返回 Hands 后连接失败 | 查看 Google Play 行显示的原因，再点击 Connect 重试。 |
| 无法读取轨道 | 检查包名及 Google 账号的应用权限，然后刷新。错误包含 SERVICE_DISABLED 时，请 Hands 管理员为该集成启用 Google Play API。 |
| 账号已连接，但仍待配置 | 展开 Google Play，选择包名和轨道并保存。 |
| 原先正常的连接失效 | 先测试连接；Google 授权过期或被撤销时，重新连接。 |

## 停用或解除绑定

**Disable / 停用**会停止通过此连接发布，并保留设置供以后使用。

**Unbind / 解除绑定**会移除 Hands 为该应用保存的 Google Play 连接。要撤销 Google 账号本身的授权，请打开 [Google 账号连接](https://myaccount.google.com/connections)，移除相应应用。这可能影响其他使用同一 Google 账号和连接的 Hands 应用。
