---
title: "Android SDK"
description: "为 Android 提供应用内更新检查、分阶段发布、反馈和崩溃报告。"
category: "SDKs & API"
order: 10
---

# Android SDK

`build.hands:hands-android-sdk` 是 Hands 的 Android SDK，负责应用内更新检查和安装、分阶段发布的设备分桶、反馈提交与崩溃报告。

## 安装

可以从**无需令牌的 JitPack** 或**需要 `read:packages` 令牌的 GitHub Packages** 获取 SDK。GitHub Packages Maven 仓库即使对公开包也要求每次请求提供令牌，因此 JitPack 更简单。

### JitPack：无需令牌

```kotlin
// settings.gradle.kts 或模块的 repositories 配置块
repositories {
    maven { url = uri("https://jitpack.io") }
}

dependencies {
    implementation("com.github.botiverse:hands:android-sdk-v0.14.3")
}
```

### GitHub Packages：需要 `read:packages` 令牌

```kotlin
repositories {
    maven {
        url = uri("https://maven.pkg.github.com/botiverse/hands")
        credentials {
            username = providers.gradleProperty("gpr.user").orNull ?: System.getenv("GITHUB_ACTOR")
            password = providers.gradleProperty("gpr.key").orNull ?: System.getenv("GITHUB_TOKEN")
        }
    }
}

dependencies {
    implementation("build.hands:hands-android-sdk:0.14.3")
}
```

配置如下，`BuildConfig` 字段是保存这些值的便捷位置：

| 配置 | 示例 |
|---|---|
| 基础 URL | `https://hands.build` |
| 应用 slug | `raft-android` |
| 渠道 | `main` / `preview` / `nightly` / `debug` |

## 更新检查和安装

`UpdateChecker` 调用公开更新检查接口，比较 `versionCode`，并可选择下载和安装 APK。

```kotlin
val checker = UpdateChecker(
    context = applicationContext,
    baseUrl = BuildConfig.HANDS_BASE_URL,
    appSlug = BuildConfig.HANDS_APP_SLUG,
    installedVersionCode = BuildConfig.VERSION_CODE.toLong(),
    channel = BuildConfig.HANDS_CHANNEL,
    arch = Build.SUPPORTED_ABIS.firstOrNull(),
    // 传入应用选择的语言区域；SDK 不会猜测系统语言。
    languageTag = currentAppLanguageTag,
    eventListener = HandsUpdateEventListener(updateDiagnostics::append),
)

// 幂等操作：只在可重新开始的状态下检查，等待正在执行的工作；
// 从系统安装器返回后，重新打开同一个已验证的 APK。
val status = checker.install()
```

在更新页面或生命周期恢复时调用 `checker.status()`，根据稳定的小写状态更新界面：`idle`、`checking`、`patching`、`downloading`、`ready_to_install`、`installer_opened`、`failed`、`stale` 和 `installed`。只有 PackageManager 观察到完全匹配的目标版本后才进入 `installed`。如果用户返回时未接受系统安装器，状态仍可安装；`reopenPendingInstaller()` 会重新打开同一 APK，不会重复下载。

### 只检查不安装

`checker.check()` 向 Hands 查询更新，但不开始下载。返回的 `HandsUpdateCheck.offer` 包含 `versionName`、`versionCode`、`releaseNotes`（按请求语言挑选的更新日志，没有则用英文，再没有则用普通 changelog）、`downloadSizeBytes`（本机能应用增量补丁时为补丁大小，否则为完整 APK 大小）、`fullSizeBytes`、`forceUpdate` 和 `releasedAt`；`status` 是当前事务状态。先展示这些信息，再调用 `install()`。更新进行中，`HandsUpdateStatus.releaseNotes` 和 `targetVersionName` 保留同一份日志和版本，之后重新打开页面无需再请求。

```kotlin
val check = checker.check()
check.offer?.let { offer ->
    showUpdate(offer.versionName, offer.releaseNotes, offer.downloadSizeBytes)
}
```

### 进度、安装权限与离线安装

`checker.statusUpdates()` 返回供更新页面使用的 `Flow<HandsUpdateStatus>`。它先给出核对后的状态，之后跟随同一应用和渠道下任何 `UpdateChecker` 产生的变化。下载完整 APK（`downloading`）或增量补丁（`patching`）期间每 500 毫秒重新读取一次，`status.progress` 随之更新：`downloadedBytes`、`totalBytes`（未知时为 null）、`percent`，以及 `paused` 和 `pauseReason`（如 `waiting_for_network`）。`status.targetVersionName` 是正在安装的版本名。

```kotlin
lifecycleScope.launch {
    repeatOnLifecycle(Lifecycle.State.STARTED) {
        checker.statusUpdates().collect { status ->
            when {
                status.errorCode == INSTALL_PERMISSION_REQUIRED -> showAllowInstallsPrompt()
                status.progress != null -> showProgress(status.progress)
                else -> render(status)
            }
        }
    }
}
```

当 Android 不允许应用安装软件包（"安装未知应用"未开启）时，已验证的下载保持 `ready_to_install`，`errorCode` 为 `install_permission_required`，不会打开注定被拦截的安装器。先向用户说明更改该设置后 Android 可能重启应用，再启动 `checker.installPermissionSettingsIntent()`，应用回到前台时调用 `checker.reopenPendingInstaller()`。`checker.canInstallUpdates()` 返回当前权限状态。

如果在已有验证过的 APK 时检查更新失败（离线、无法连接 Hands），`install()` 会重新打开该 APK，而不是什么都不做。

下载通知以应用名称和版本为标题。进程内第一次调用 `status()` 时，会移除版本已安装的 SDK 下载记录，同时清掉系统残留的"已下载"通知。无论传入哪个 context，下载完成监听都注册在 Application context 上。

SDK 会持久化一个绑定了包、来源、应用、渠道、产品、平台和架构的事务，包含目标、构建和文件身份、DownloadManager ID 及预期的应用专属文件。它有意不保存签名下载 URL 或认证材料。恢复核对会检查已安装版本、DownloadManager、路径归属、文件大小、提供时的 SHA-256、精确 APK 包和目标版本，以及签名证书。输入缺失、变化或不安全时以 `stale` / `failed` 拒绝，并返回稳定的 `errorCode`。

`HandsUpdateEventListener` 接收结构化事件，覆盖检查、增量下载与应用、验证和回退、完整下载、内容 URI、安装器、恢复核对、失败与清理，可纳入宿主的反馈诊断；Logcat 并不是唯一遥测途径。显式提供的有效 BCP-47 `languageTag` 会通过 `X-Hands-Lang` 和 `Accept-Language` 发送。缺失或格式错误时两个请求头都不发送；不受支持的语言保留服务端英语回退。事件和状态包含请求及解析后的语言标签。

`0.12.4` 及更新版本的 AAR 为 64 位原生崩溃库使用兼容 16 KB 的 ELF `PT_LOAD` 对齐。发布前会同时验证 AAR 和与之匹配的未剥离原生符号压缩包。

SDK 发送每次安装稳定的 ID（通过 `HandsDeviceId` 生成的 `X-Hands-Device-Id`；服务端仍接受旧版 `X-Quiver-Device-Id`），以便服务端为**分阶段发布**分桶。发布比例为 25% 的版本只会安装到匹配的设备；提高比例时，每台设备保留原来的分桶。

SDK 上报 `Build.SUPPORTED_ABIS` 的第一个值。存在针对该 ABI 的 APK 时 Hands 优先选择它，否则回退到通用 APK（`arch: null`）。

如果只需检查而不安装，例如显示自定义“有可用更新”界面，请调用 `HandsClient(baseUrl).checkForUpdate(..., languageTag = ...)` 并处理结果。

### Java 宿主

每个挂起调用都有在主线程回调的对应方法：`checkAsync`、`installAsync`、`statusAsync`、`reopenPendingInstallerAsync`，以及对应 `statusUpdates()` 的 `observeStatus(listener)`。它们都返回 `Closeable`，关闭即取消（关闭 `installAsync` 只是不再等待，更新本身继续）。构造函数为有默认值的参数提供了 Java 重载。

```java
UpdateChecker checker = new UpdateChecker(context, "https://hands.build", "my-app", BuildConfig.VERSION_CODE, "main");
checker.checkAsync((check, error) -> {
    if (check != null && check.getOffer() != null) showUpdate(check.getOffer());
});
Closeable watching = checker.observeStatus(status -> render(status));
```

## 反馈

`HandsFeedback` 将用户反馈及附件提交到 Hands 工单系统，并自动附加应用和设备元数据及设备 ID。

```kotlin
val ticketId = HandsFeedback(
    context = applicationContext,
    baseUrl = BuildConfig.HANDS_BASE_URL,
    appSlug = BuildConfig.HANDS_APP_SLUG,
    versionName = BuildConfig.VERSION_NAME,
    versionCode = BuildConfig.VERSION_CODE.toLong(),
    channel = BuildConfig.HANDS_CHANNEL,
    clientKey = BuildConfig.HANDS_CLIENT_KEY,   // 应用设置 → 客户端密钥
).submit(
    message = "Feed doesn't refresh after login.",
    kind = "bug",                       // "feedback" | "bug" | "crash"
    contact = "user@example.com",       // 可选
    attachments = listOf(screenshot),   // 最多 9 个文件，每个 200 MB（大文件通过预签名 URL 直接上传到存储）
)
```

工单出现在应用的**反馈**页，可通过管理控制台或命令行（`hands feedback ...`）处理。

## 崩溃报告

`Hands.install(...)` 捕获未处理的 JVM 异常和 NDK/原生崩溃，上传为 `kind=crash` 工单，在控制台按签名分组并符号化。

```kotlin
class App : Application() {
    override fun onCreate() {
        super.onCreate()
        Hands.install(
            context = this,
            baseUrl = BuildConfig.HANDS_BASE_URL,
            appSlug = BuildConfig.HANDS_APP_SLUG,
            versionName = BuildConfig.VERSION_NAME,
            versionCode = BuildConfig.VERSION_CODE.toLong(),
            channel = BuildConfig.HANDS_CHANNEL,
            clientKey = BuildConfig.HANDS_CLIENT_KEY,
            // 可选：附加应用特定的上下文（如最近的日志）
            extraContext = { myDiagnostics.recentText() },
        )
    }
}
```

要在控制台获得可读的反混淆堆栈，请在发布版本时上传 R8/ProGuard `mapping.txt`；对于 NDK 崩溃，还需上传未剥离的 `.so` 压缩包。Hands 会自动符号化对应 `versionCode` 的崩溃报告。Java/Kotlin 崩溃反混淆后，Hands 会按反混淆后的异常类和第一条栈帧（跳过 `throwIllegalArgumentException` 这类抛出辅助函数）重新分组，同一个问题跨版本保持同一组；这些版本的崩溃通知会等反混淆完成后再判定分组。QNC2 原生报告保留崩溃线程的 PC/LR/SP、寄存器、线程身份及已加载映像的 ELF BuildId。符号化严格遵循失败即拒绝原则：崩溃帧的 BuildId 必须与所上传压缩包中的 ELF 完全匹配；Hands 不会根据版本或文件名猜测。

在 Android 11 及以上版本，如果操作系统保留了匹配的 `ApplicationExitInfo` 跟踪和退出描述，SDK 也会附加它们，提供受支持的 tombstone 或中止消息等效信息，无需读取 `/data/tombstones`。匹配要求已记录的进程 ID、原生崩溃原因和较窄的时间窗口；保留的证据一对一分配并持久化，以便确定性重试，而不是猜测最近的应用退出。

### 同一进程只出一张票

从 `0.13.2` 起，每条原生崩溃记录都带上崩溃进程的 `HandsNativeCrash.processEventId`（每个进程一个随机 UUID）和 `processStartAt`（进程启动时间，毫秒），并用这个 ID 作为 `submission_id` 上传。App 如果也会为同一次进程退出自己报一张票（例如读 `ApplicationExitInfo`），在启动时把这两个值和自己的启动记录存在一起，报票时用同一个 ID：

```kotlin
HandsFeedback(context, baseUrl, appSlug, clientKey = key).submitReport(
    message = "Process exited: ${exit.reason}",
    kind = "crash",
    extras = exitFields,
    submissionId = launch.eventId, // 启动时存下的 HandsNativeCrash.processEventId
)
```

后到的一方会合并进第一张票：崩溃类型和分组签名以原生记录为准，退出票的字段一并保留，两边不一致的值记在票元数据的 `crash_merge` 里。若这张票原先被当作"后台被系统结束"自动关闭，原生记录证明是真崩溃后会重新打开。

从 `0.14.2` 起，`HandsNativeCrash.install(context)` 还会记下当前进程的版本名和版本号，所以即使上传时已经装了更新的版本，原生崩溃工单也会标出真正崩溃的那个版本。用更早 SDK 的进程留下的记录没有版本信息，工单的版本保持为空；App 自己的退出报告合并进来时，Hands 会用它补上。

这个版本文件在调用线程之外写入，目录大小也有上限：没有待传记录的版本文件会在 install 和每次 `uploadPending` 时删掉，只留最新的几个（同一个 App 的其他进程可能还在用自己的那个）。`0.14.2` 只在有待传记录时才清理，所以没有原生崩溃、或从不调用 `uploadPending` 的 App 每启动一次就多一个文件；`0.14.3` 会把它们清掉。

`HandsNativeCrash.uploadPending(...)` 为每条记录返回一个 `NativeCrashUpload`：`UPLOADED`（带 `ticketId`）、`MERGED`（匿名客户端拿不到 `ticketId`）、`FAILED_WILL_RETRY`（记录保留，下次重试）或 `DISCARDED`（记录损坏或超出保留上限）。每条都带 `pid`、`processStartAt`、`processEventId`、`crashAt` 和匹配到的 `exitTimestamp`；0.13.2 之前写下的记录没有进程 ID 和启动时间。

### ANR

从 `0.13.0` 起，SDK 在 Android 11 及以上版本（API 30）还会上报 ANR（应用无响应导致的终止）。系统从外部杀死进程，进程内不会有代码运行；下次启动时，SDK 读取带 `REASON_ANR` 的 `ApplicationExitInfo` 条目，并将选中的记录提交为 `kind=crash`、`crash_type=anr` 工单。系统 ANR 线程转储会作为附件，并像 Java 崩溃日志一样通过 R8 映射还原。工单按 `ANR@<主线程的第一个应用堆栈帧>` 分组，因此相同卡死可跨构建聚合，也不会与同一帧上的 Java 异常混合。控制台的崩溃页面可按异常、原生崩溃和 ANR 筛选。

服务端接受工单后，SDK 推进持久化水位，上传失败时会在下次启动重试；永久性客户端拒绝会被跳过。如果服务端已接受但响应丢失、水位尚未推进，可能产生重复工单。首次使用此 SDK 启动时回溯 7 天，每次启动最多发送最新的 3 条 ANR；水位推进后，超出上限的较早记录会被跳过。向 `Hands.install(...)` 传入 `captureAnrs = false` 可关闭此功能；低于 API 30 时不执行任何操作。

在 Android 11 及以上版本，启用 ANR 捕获后，`HandsCrash.install` 会将已安装应用包的版本写入 Android 最多 128 字节的进程状态摘要。请在上报进程中尽早调用 `Hands.install`。如需覆盖内容提供器启动前的阶段，或某个进程不运行上报器，可在 `Application.attachBaseContext` 中提前调用：

```kotlin
override fun attachBaseContext(base: Context) {
    super.attachBaseContext(base)
    HandsCrash.stampAnrBuild(base)
}
```

这个提前调用只写入当前进程的摘要，不安装崩溃处理器，也不启动上报。请只在一个进程运行上报器：Android 各进程的偏好设置缓存不能提供跨进程协调，多个上报器可能重复提交。写入前发生的 ANR 或从未写入摘要的进程可能没有版本。每张工单读取各自退出记录中的摘要；旧记录、摘要缺失、无效或被覆盖时，版本保持未知，不会使用上传时安装的版本。版本名称放不下时只记录完整的版本号（version code），不会提交截断的名称。SDK 也识别 Raft 临时上报器的常规长度 `raft-build:1` 摘要；已提交的旧工单不会因此改变。

Android **每个进程只有一个共享摘要槽**：之后调用的代码可能覆盖 Hands 标记，Hands 也会覆盖之前的摘要。如果宿主应用已使用这个槽，请在每个进程提前写入摘要或安装 Hands 之前关闭版本标记；ANR 上报仍然启用：

```kotlin
HandsCrash.setAnrBuildStampingEnabled(false)
Hands.install(/* ... */)
```

不要同时启用 SDK ANR 上报和独立的应用侧 ANR 上报器。SDK 继续使用原有的 Hands 水位；请协调切换，因为两套独立保存的水位不一致或服务端响应丢失时，重启后仍可能产生重复工单，并不保证恰好一次。`channel`、manifest 中的构建提交和设备元数据来自上传进程，不是历史退出记录中原构建的证据。

## 发布健康状况

`Hands.install(...)` 自动跟踪前台会话。应用在后台持续 30 秒后会话结束；快速 Activity 或配置切换仍属于同一会话。开始、结束和崩溃事件在投递前提交到设备本地，并在网络或进程失败后重试。

应用概览根据这些事件按版本和渠道展示无崩溃会话及无崩溃设备。只有宿主应用有意退出发布健康遥测时，才应向 `Hands.install` 传入 `trackSessions = false`。

## 延后上传

App 在确认允许上报之前什么都不能发时（例如用户的服务器开了隐私模式），仍然在启动时安装，这样崩溃照常记录，只关掉启动时的网络请求：

```kotlin
Hands.install(
    context = this,
    baseUrl = "https://hands.build",
    appSlug = "my-app",
    uploadOnLaunch = false,         // 崩溃和 ANR 报告先留在设备上
    reportDeviceAnalytics = false,  // 不发启动 ping
    trackSessions = false,          // 发布健康会话是实时发送的
)
```

确认允许上报后，在后台线程用同样的参数上传：

```kotlin
HandsCrash.uploadPending(context, baseUrl, appSlug, versionName, versionCode, channel, clientKey)
HandsAnr.uploadPending(context, baseUrl, appSlug, versionName, versionCode, channel, clientKey)      // 0.13.3+，suspend
HandsNativeCrash.uploadPending(context, baseUrl, appSlug, versionName, versionCode, channel, clientKey) // suspend
HandsAnalytics.reportDevice(context, baseUrl, appSlug, versionName, versionCode, channel, clientKey)    // suspend
```

报告在设备上等待，受原有保留上限约束（JVM 崩溃保留最近 5 条；ANR 来自系统的退出记录，首次使用时回看 7 天）。

## 设备分析

`Hands.install(...)` 已发送轻量级启动或安装指标请求，每次安装每天最多一次，用于控制台的活跃设备及版本分布视图，无需另行调用。这不是真正的在线心跳，不包含个人身份信息，仅包含每次安装随机生成的设备 ID 以及构建和操作系统元数据。传入 `reportDeviceAnalytics = false` 可关闭。

## 说明

- 所有网络调用都是挂起函数；请在主线程之外调用。
- 设备 ID 是存储在 SharedPreferences 中的随机 UUID，不是硬件 ID；重新安装或清除数据后重置，适合用于分阶段发布分组。
- 客户端密钥（`qk_…`）用于认证反馈和崩溃提交。它随 APK 分发，采用类似 Sentry DSN 的模型，是应用标识而非用户秘密。请从应用设置页获取并放入 `BuildConfig`。
