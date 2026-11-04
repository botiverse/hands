---
title: "HarmonyOS SDK"
description: "使用 @botiverse/hands ohpm 包在 HarmonyOS 上提交反馈和崩溃报告。"
category: "SDKs & API"
order: 12
---

# HarmonyOS SDK

`@botiverse/hands` 是 Hands 的 HarmonyOS SDK（ArkTS HAR），通过 Hands 服务器的公开反馈接口提交**反馈工单**和**崩溃报告**，功能与 Android 和 iOS SDK 对应。

如果软件包仓库的版本落后于源码发布版本，请从 [Hands 仓库](https://github.com/botiverse/hands)中的 `clients/ohos` 构建所需版本的 HAR。

## 安装

```bash
ohpm install @botiverse/hands
```

## 配置和启动

所有配置均为运行时参数；SDK 不包含特定应用的配置。在 Hands 控制台中打开应用的**设置**页获取客户端密钥。它采用类似 Sentry DSN 的模型，用于标识应用；泄漏时可在控制台轮换。

```ts
import { Hands } from '@botiverse/hands';

// 在 UIAbility 的 onCreate 中传入 context，以启用内部启动逻辑
// （受限流的设备分析请求及待处理崩溃上传）。
Hands.install({
  baseUrl: 'https://hands.build',
  appSlug: 'my-app',
  channel: 'main',          // Hands 发布渠道路由字段
  clientKey: 'qk_…',
}, this.context);
```

请尽可能早地调用它，例如在 UIAbility 的 `onCreate` 中。应用需要在 `module.json5` 中声明 `ohos.permission.INTERNET` 权限。传入 context 后，`install` 会自动处理设备分析和待处理崩溃上传，无需另行调用。

## 反馈

```ts
import { HandsFeedbackClient } from '@botiverse/hands';

const ticketId = await HandsFeedbackClient.submit(
  context,                    // common.UIAbilityContext
  'Feed does not refresh',    // 反馈内容
  'bug',                      // 'feedback' | 'bug' | 'crash'
  [logFilePath],              // 最多 9 个文件
  [],                         // extras: Array<{ key, value }>
);
```

设备元数据（版本、型号、操作系统、ABI、语言区域和每次安装生成的设备 ID）会自动附加。最大 10 MB 的文件使用 multipart 请求；较大的文件按不超过 5 MiB 的分片读取，通过 R2 分片上传会话上传，与 Android 和 iOS 一样，每个文件上限为 200 MB。整个文件不会一次性分配为一个 ArkTS `ArrayBuffer`。

## 崩溃报告

`Hands.install(config, context)` 会捕获未处理的 ArkTS 错误，以及系统的 `APP_CRASH` / `APP_FREEZE` 事件，包括进程内 ArkTS 观察器无法收到的原生 C/C++ 故障，无需其他操作。

原生故障采用先存储、后发送的方式：进程退出后 HarmonyOS 保留故障记录，Hands 在下次启动时读取。待上传的崩溃文件会保留到工单创建成功，最多保留五个。一条格式错误的系统事件不会阻止同一批次后续事件的处理。

对于已处理的错误和诊断上下文：

```ts
Hands.addBreadcrumb('member-detail', 'opened from thread');
await Hands.captureException(context, error, 'Could not open member detail');
```

## 设备分析

`Hands.install(config, context)` 还会自动上报活跃设备和版本分布指标，不包含个人身份信息，只包含每次安装随机生成的设备 ID 以及构建、操作系统元数据。请求受限流，不是真正的在线心跳，无需另行调用。
