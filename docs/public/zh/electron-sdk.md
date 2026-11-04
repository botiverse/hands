---
title: "Electron SDK"
description: "使用 @botiverse/hands-electron 为 Electron 主进程和渲染进程上报 Crashpad minidump。"
category: "SDKs & API"
order: 13
---

# Electron SDK

`@botiverse/hands-electron` 为 Electron 应用增加崩溃报告。Electron 内置的 [Crashpad](https://www.electronjs.org/docs/latest/api/crash-reporter) 捕获**主进程和渲染进程**的原生 minidump，并直接上传到 Hands。Hands 将其创建为崩溃工单，并在服务端使用你上传的 Breakpad 符号进行符号化。

与 `@sentry/electron` 一样，SDK 有两个入口，分别在**主进程**和**渲染进程**中导入。

## 安装

```bash
npm install @botiverse/hands-electron
```

`electron` 是由你的应用提供的对等依赖。

## 主进程

在应用就绪之前调用一次 `init()`：

```ts
import { app } from "electron";
import * as Hands from "@botiverse/hands-electron/main";

Hands.init({
  appSlug: "my-desktop-app",   // Hands 应用的 slug
  clientKey: "qk_live_...",    // 公开客户端密钥，可随应用分发
  release: app.getVersion(),   // version_name；默认为 app.getVersion()
  versionCode: 1020300,        // Hands version_code，用于选择符号集
  environment: "stable",       // 渠道
  extra: { deployment: "ga" }, // 每次崩溃附带的静态注释
  onCrash: (info) => {
    // 渲染进程或子进程终止，包括没有生成 minidump 的内存不足或被杀退出。
    // 可以记录日志、显示恢复对话框等。
    console.warn("process gone:", info.processType, info.reason);
  },
});
```

为下一次崩溃附加上下文：

```ts
Hands.setUser({ id: "u_123" });
Hands.setTag("feature", "editor");
Hands.setExtra("open_docs", 3);
Hands.addBreadcrumb({ message: "opened project", category: "ui" });
```

主进程入口会启动 Crashpad，监听 `render-process-gone` 和 `child-process-gone`，并接收渲染进程转发的上下文。

## 渲染进程

渲染进程的崩溃由主进程中的 Crashpad 自动捕获。渲染进程入口只负责管理上下文并通过 IPC 将其转发给主进程：

```ts
import * as Hands from "@botiverse/hands-electron/renderer";

Hands.setTag("route", location.pathname);
Hands.addBreadcrumb({ message: "clicked export" });
```

对于沙箱中的渲染进程（`contextIsolation: true`），请改为从预加载脚本暴露 API：

```ts
// preload.ts
import { exposeHands } from "@botiverse/hands-electron/preload";
exposeHands(); // → window.hands.setTag(...), window.hands.addBreadcrumb(...)
```

## 符号文件

只有 Hands 拥有应用对应 `version_code` 的 Breakpad 符号时，才能将 minidump 转为可读堆栈。在 CI 中：

1. 使用 [`dump_syms`](https://github.com/mozilla/dump_syms) 为应用和 Electron 框架二进制文件生成 `.sym` 文件。
2. 将它们打包为 zip。平铺的 zip 也可以；Hands 会读取每个文件的 `MODULE` 头，将其放入 Breakpad 目录树。
3. 与版本一起上传：

```bash
hands builds publish-electron my-desktop-app \
  --version-name 1.2.3 --version-code 1020300 \
  --installer dist/MyApp-1.2.3.exe \
  --symbols symbols.zip
```

随后每个崩溃工单都会收到一条包含符号化堆栈的评论。没有符号文件时，Hands 仍会记录崩溃，堆栈帧显示模块和偏移量，并提示上传符号文件。

## 发送的数据

每个 minidump 都包含一组类似 Sentry 的注释，服务端会将其合入工单：`product_type=electron`、`version`、`version_code`、`environment`/`channel`、`platform`、`arch`、`process_type`、`electron_version`、`chrome_version`，以及所有 `extra` 和当前用户、标签、操作轨迹。

## 如何发送到 Hands

SDK 将 Electron 的 `crashReporter.submitURL` 指向 `POST /public/v2/apps/<slug>/minidump?client_key=<key>`。Crashpad 以 `upload_file_minidump` 上传 minidump，并将注释放在表单字段中；Hands 将转储存为崩溃工单附件，并执行符号化。崩溃报告不需要接入更新检查或反馈功能。
