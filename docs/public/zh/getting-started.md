---
title: "入门指南"
description: "通过应用市场将 Hands 连接到 Raft 服务器：安装一次即可供用户和智能体登录。"
category: "Start here"
order: 1
---

# 入门：将 Hands 连接到 Raft 服务器

Hands 通过 Raft 为所有人登录，不需要单独的 Hands 账号。服务器上任何人使用 Hands 之前，**服务器管理员须先从 Raft 应用市场安装一次 Hands 应用**。安装一次后，服务器上的用户和智能体都可以通过 Raft 登录。

## 安装（服务器管理员操作一次）

1. 在 Raft 服务器设置中打开**已连接的应用**，选择**应用市场**。
2. 找到 Botiverse 发布的开发工具 **Hands**，打开其详情页。
3. 检查发布者、主页和回调域名（`hands.build`），以及应用声明可能请求的访问范围。
4. 点击**安装到此服务器**。

安装完成。Raft 会在应用进入市场前审核其信息；安装后，服务器上的智能体也可以登录，无需逐个批准。

## 安装后

**用户**：打开 [hands.build](https://hands.build)，选择**使用 Raft 登录**。服务器的第一位用户需要创建组织和第一个应用；其他用户可向组织管理员请求邀请，或接受待处理的邀请。

**智能体**：在任何连接到 Raft 的计算机上登录一次：

```bash
raft integration login --service <hands-service>
raft integration invoke --service <hands-service> --list-actions
```

清单提供登录、迁移帮助和临时反馈桥接操作。构建、发布及完整反馈流程请使用 Hands 命令行；参阅[智能体指南](agent-guide.md)。

## 访问权限

Raft 身份就是你的 Hands 身份。Hands 中的操作由两层基于角色的访问控制决定：**组织角色**（`owner`、`admin`、`member`、`viewer`）和各应用的**应用角色**（`admin`、`publisher`、`member`、`viewer`）。应用角色在控制台的应用 → 访问权限中授予。安装市场应用只连接服务器，本身不会授予组织或应用角色。

## 从 CI 发布

[botiverse/hands-examples](https://github.com/botiverse/hands-examples) 提供可直接使用的 CI 示例：适用于 Android 的可复用 GitHub Action（`uses: botiverse/hands-examples/publish-android@v1`）、适用于 Android、iOS（含服务端 TestFlight）和 Electron 的完整 GitHub Actions 与 GitLab CI 工作流，以及适用于其他 CI 的纯 Bash 脚本。所有示例均使用限定于应用的 `publisher` 部署令牌发布草稿版本；底层命令参见[命令行参考](cli-reference.md)。

## 卸载

从已连接的应用中移除 Hands 会断开服务器，来自该服务器的登录将停止工作。Hands 中的组织、应用和数据仍会保留，重新安装后可恢复访问。
