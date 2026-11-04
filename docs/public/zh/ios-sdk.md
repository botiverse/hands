---
title: "iOS SDK"
description: "通过 Hands CocoaPod 在 iOS 上提交反馈并在下次启动时上报崩溃。"
category: "SDKs & API"
order: 11
---

# iOS SDK

`Hands` 是 Hands 的 iOS SDK，通过 Hands 服务器的公开反馈接口提交应用内**反馈工单**和**崩溃报告**。它使用 Objective-C 编写，无依赖，支持 iOS 14.1 及以上版本。

## 安装（通过 Git 使用 CocoaPods）

```ruby
pod 'Hands', :git => 'https://github.com/botiverse/hands.git', :tag => 'ios-v0.2.2'
```

## 配置和启动

所有配置均为运行时参数；SDK 本身不包含特定应用的配置。在 Hands 控制台中打开应用的**设置**页获取客户端密钥。它采用类似 Sentry DSN 的模型：用于标识应用，会随应用包分发；泄漏时可在控制台轮换。

```swift
import Hands

Hands.install(with: HandsConfig(
    baseUrl: "https://hands.build",
    appSlug: "my-app",
    channel: "main",          // Hands 发布渠道路由字段
    clientKey: "qk_…"
))
```

`install(with:)` 会安装崩溃处理程序，并在启动几秒后上传待处理的崩溃报告。请尽可能早地调用它，例如在应用初始化时。

## 反馈

```swift
Hands.submitFeedback(
    "Feed doesn't refresh after login.",
    kind: "bug",                      // "feedback" | "bug" | "crash"
    attachmentPaths: [logFilePath],   // 最多 3 个文件，每个 10 MB
    extras: nil
) { ticketId, error in … }
```

设备元数据（版本、型号、操作系统、架构、语言区域和每次安装生成的设备 ID）会自动附加。

`Hands.install(with:)` 还会按限流规则发送启动或安装指标，用于活跃设备和版本分布分析。除每次安装随机生成的 Hands 设备 ID 及构建、操作系统元数据外，它不包含个人身份信息，也不应视为实时在线心跳。

## 崩溃报告

`Hands.install(with:)` 会捕获未处理的 `NSException` 和致命信号，上传为 `kind=crash` 工单，并在控制台按特征分组，无需额外接线。

崩溃工单中的版本、构建号和提交记录来自发生崩溃时的构建，即使报告由后续启动（可能是更新后的构建）上传也是如此。0.2.2 之前的 SDK 存储的报告没有记录构建信息，上传时不会填写版本字段，也不会借用上传它的构建信息。

## 说明

- 客户端密钥（`qk_…`）用于认证反馈和崩溃提交。它随应用包分发（类似 Sentry DSN，是应用标识而非用户秘密），不会写入日志或诊断导出。
- 设备 ID 是随机 UUID，不是硬件标识；重新安装后会重置。
