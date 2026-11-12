---
title: "命令行参考"
description: "在本地脚本或 CI 中安装和使用 @botiverse/hands-cli。"
category: "SDKs & API"
order: 9
---

# 命令行参考

发布和安装自包含的 Node 命令行二进制文件，请参阅[发布 Node 命令行工具](node-cli.md)。

`@botiverse/hands-cli` 是 Hands 的命令行客户端，可在本地脚本或 CI 中用于查看应用、上传 Android 构建和发布版本。

## 安装

全局安装：

```bash
npm install -g @botiverse/hands-cli
```

也可以不永久安装而直接运行：

```bash
npm exec --package @botiverse/hands-cli@0.5.15 -- hands --help
```

在 CI 中应固定版本，使发布脚本可复现。

## 认证

命令行从环境变量读取 Hands API 服务器和 Bearer 令牌：

```bash
export HANDS_API=https://hands.build
export HANDS_BEARER_TOKEN=<deploy-token>
```

未设置 `HANDS_API` 时默认使用 `https://hands.build`。`HANDS_AUTH_TOKEN` 也可作为 `HANDS_BEARER_TOKEN` 的别名。

旧版 `QUIVER_*` 名称仍可使用：每个变量先读取 `HANDS_<name>`，再读取 `QUIVER_<name>`，因此现有 CI 无需更改。

CI 应使用限定于应用的部署令牌。通过下文的 `hands deploy-tokens create` 或应用设置页创建，选择所需的最低角色，并将原始令牌存入 CI 密钥存储。

Raft Agent Login 会话不会导出给此命令行。`raft integration login` 用于认证 `raft integration invoke`，不会填充 `HANDS_AUTH_TOKEN`。需要为 CI 初始化凭据的管理员智能体应先运行 `hands login`，再用 `hands deploy-tokens create` 创建令牌，将只返回一次的令牌直接写入 CI 密钥存储，随后由命令行使用该部署令牌。

## 部署令牌

限定于应用的令牌供 CI 发布（`publisher`）或读取（`viewer`）。管理令牌需要**应用管理员**权限；没有权限时，命令行会打印可操作的错误，说明所需角色、谁可以授予，以及管理员可以代为操作。

```bash
# 为 CI 创建发布者令牌（仅显示一次，请立即保存）
hands deploy-tokens create raft-android --name github-ci --role publisher

# 可选过期时间，并输出供脚本使用的机器可读结果
hands deploy-tokens create raft-android --name github-ci --expires-in-days 90 --json

# 列出应用令牌（仅元数据，绝不包含秘密）
hands deploy-tokens list raft-android

# 按 ID 撤销
hands deploy-tokens revoke raft-android <tokenId>
```

创建的令牌应在 CI 中设置为 `HANDS_BEARER_TOKEN`。服务端只保存哈希，因此令牌丢失后只能撤销并重新创建，无法恢复原值。

## 基本命令

显示安装版本：

```bash
hands version
```

在当前 Hands 组织中创建应用，需要组织成员或更高角色：

```bash
hands apps create \
  --slug hands-example-web \
  --name "Hands Example Web" \
  --platform web \
  --description "Hands web app example"
```

列出当前令牌可见的应用：

```bash
hands apps list
```

明确读取应用公开 SDK 客户端密钥，需要应用管理员权限；不会轮换密钥，也不会返回部署令牌：

```bash
hands apps client-key hands-example-web
```

列出应用的构建：

```bash
hands builds list raft-android
```

## 注册外部 Node / CLI 文件

对于平台为 `node` 的应用，`builds publish-version` 记录一个外部托管目标，不会将文件复制到 Hands 存储：

```bash
hands builds publish-version raft-computer \
  --version-name 0.72.13 \
  --target linux-x64 \
  --source-url https://cdn.raft.build/computer/0.72.13/linux-x64 \
  --raw-sha256 "$RAW_SHA256" --raw-size "$RAW_SIZE" \
  --gzip-sha256 "$GZIP_SHA256" --gzip-size "$GZIP_SIZE" \
  --node-version 22.23.1 \
  --source-commit "$GIT_COMMIT"
```

每个目标运行一次命令。Hands 在同一应用和版本的构建下保存 URL、原始及 gzip 哈希与大小、Node 版本和来源信息。完全相同的声明会成功重放；修改版本级或目标级不可变字段会返回冲突。此命令不会上传字节或激活版本、渠道指向。

## 发布 Hands 托管的命令行二进制文件

`builds publish-cli-binary` 将一个或多个平台二进制文件直接上传到 Hands 存储，只有每个声明的文件均通过验证后才创建一个版本：

```bash
hands builds publish-cli-binary raft-computer \
  --version-name 1.0.33 \
  --channel main \
  --target darwin-arm64 --binary ./raft-computer-darwin-arm64 \
  --target linux-x64 --binary ./raft-computer-linux-x64
```

`--target` 与 `--binary` 按位置配对。使用可选的 `--runner` 和 `--sha256sums` 时，也要为每个目标依次重复提供。

命令创建待处理构建，冻结其完整文件槽位集合，将各文件流式传至短期单对象上传 URL，并请求 Hands 验证精确 SHA-256 摘要和字节大小。所有冻结槽位均就绪后，Hands 才将构建标记为成功并创建版本。中断后可以重放相同声明：待处理文件保留声明的摘要和大小，已就绪文件不再返回上传 URL。客户端不会收到 R2 存储桶凭据。

配置 R2 签名后，`/dl/:slug/releases/:releaseId/:file` 下的托管版本 URL 会重定向到短期、对象级 R2 下载 URL。渠道 URL `/dl/:slug/:channel/:file` 首先重定向到不可变版本 URL。下载客户端必须跟随重定向，例如使用 `curl -L`，并照常验证声明的摘要。请保留 Hands 版本 URL 供后续下载；最终 R2 URL 会过期。HEAD 请求获得针对 HEAD 签名的 URL，GET 请求获得针对 GET 签名的 URL。重定向使用 `Cache-Control: no-store`，这不保证 CDN 缓存对象字节。未配置 R2 签名的自托管实例继续通过 Hands 流式传输。

## 发布 Android

使用 `builds publish-android` 上传 APK 并创建版本。根据发布规则，CI 应传入 `--draft`，使用户或智能体在版本上线前审核更新说明。

```bash
hands builds publish-android raft-android \
  --apk ./androidApp-release.apk \
  --channel preview \
  --version-name 1.0.0 \
  --version-code 1000000 \
  --changelog-file ./changelog.txt \
  --draft
```

服务端自动从 APK 提取包 ID、SDK 级别和启动图标，无需额外参数。

有辅助文件时一并添加：

```bash
hands builds publish-android raft-android \
  --apk ./androidApp-release.apk \
  --mapping ./mapping.txt \
  --symbols ./native-symbols.zip \
  --metadata ./metadata.json \
  --channel preview \
  --version-name 1.0.0 \
  --version-code 1000000
```

公开更新检查只使用可安装文件。映射文件、原生符号和元数据仍可通过已认证的管理 API 获取。

向已有构建添加符号时，使用 `hands builds attach-symbols <app> <build-id> <file> --kind <kind>`。类型为 `proguard-mapping`、`native-symbols` 或 `dsym`；命令也会根据文件名推断类型。原生符号压缩包根据构建的 Android、HarmonyOS 或 iOS 产品类型选择平台；产品类型未知时必须明确传入 `--platform`。附件只能新增，不会替换同一槽位的已有文件。

## Google Play：现在上传，稍后送审

Google Play 一次审核一组变更。应用的另一版本正在审核时，`hands releases play-promote` 在 `stage=commit_edit` 失败：Hands 对每个 Play 编辑使用 `changesInReviewBehavior=ERROR_IF_IN_REVIEW` 提交，绝不会取消正在进行的审核。若仍需将下一版本上传到 Play，可将上传与送审分开：

```bash
# 1. 上传：将应用包、轨道版本、更新说明和映射或符号保存到 Play，
#    设置 changesNotSentForReview=true，不送审
hands releases play-promote raft-android <release> --track production \
  --rollout-percent 100 --note "upload 1.17.0" --changes-not-sent-for-review

# 2. 另一审核结束后：将待处理变更送审
hands releases play-send-for-review raft-android <release> --track production \
  --note "1.16.1 review done"
```

- 两步均需要应用 **publisher** 角色，并使用与推送和 `hands store-listing push` 相同的按包 Play 编辑锁。
- 推送回执记录 `review: {requested: false, changes_not_sent_for_review: true}`；普通推送为 `requested: true`。如果服务端无法确认该标记（较旧 Play 适配器），回执为 `requested: null, reason: "not_acknowledged"`，命令行会警告版本可能已经送审。
- `play-send-for-review` 只适用于 Hands 曾推送到该轨道的版本。它检查 Play 是否持有已接受的 AAB（SHA-256）以及轨道是否包含该版本号，然后提交不带 `changesNotSentForReview` 的编辑。回执（`play-promotion` / `send-for-review`）记录前后的发布生命周期，例如 `RELEASE_LIFECYCLE_STATE_NOT_SENT_FOR_REVIEW → RELEASE_LIFECYCLE_STATE_IN_REVIEW`。Google 没有文档保证此类提交会送审先前保存的变更；如果生命周期没有进入审核，请在 Play Console 中送审。
- 如果另一变更仍在审核，任一步骤都会以 `edit_in_review` / `play_edit_in_review` 失败，不会自动重试；应等待后再次运行。Hands 无法分类的响应以 `edit_state_unknown` 失败，请先检查 Play Console。

API：`POST /api/apps/:appId/releases/:releaseId/distributions/play/promote`，传入 `changes_not_sent_for_review: true`；以及 `POST /api/apps/:appId/releases/:releaseId/distributions/play/send-for-review`，传入 `{track, expected_revision, approval: {note}}`。参阅 OpenAPI。

之后再次推送同一版本时，如果先前成功回执确认精确文件且 Play 仍持有相同 AAB，Hands 可以省略映射上传。新回执引用旧回执作为历史证据；Play 不提供映射文件回读，因此这不能验证其当前内容。没有该证据时 Hands 会继续尝试上传。要明确替换映射，请使用下文的 `play-upload-symbols`。

## Google Play：为线上版本补传映射或原生符号

`hands releases play-promote` 只接受高于轨道最大值的版本号，因此不能为已经在 Play 上的版本附加映射。`play-upload-symbols` 为版本对应的版本号上传构建中已封存的 R8/ProGuard 映射（`proguard`）和（或）原生调试符号 zip（`nativeCode`）；该版本号必须已经存在于 Google Play。它不会更改轨道、发布比例、应用包或更新说明。

```bash
# 预演（默认）：打开临时 Play 编辑并检查版本号，
# 删除编辑并打印将要上传的内容，不会上传文件。
hands releases play-upload-symbols raft-android <release> --note "backfill mapping"

# 上传并提交（此示例仅上传映射）
hands releases play-upload-symbols raft-android <release> --kinds proguard \
  --note "backfill mapping" --commit
```

- 需要以已登录用户或智能体身份拥有应用 **publisher** 角色；部署令牌会被拒绝。使用与推送相同的按包 Play 编辑锁。
- `--kinds` 默认包括映射及 Android 发布包声明的原生压缩包。使用 `builds attach-symbols` 添加的通用原生压缩包仅在明确指定 `--kinds nativeCode` 时选中；此类压缩包可能只覆盖应用的一部分。推送同样排除通用原生附件；没有随包声明的压缩包时记录 `attached_native_requires_explicit_selection`。
- 上传原生压缩包会**替换**该版本已有的 Play 原生符号。明确选择前，请检查其覆盖所有需要符号化的原生库和 ABI，否则可能丢失覆盖。Hands 无法回读已有 Play 符号文件进行比较。
- 明确选择原生符号时，如果构建上存在内容不同的多个原生压缩包，会以 `symbols_ambiguous` 失败，而不是任选一个。`--kinds proguard` 不受影响。没有选中文件时返回 `no_symbols`；只有通用原生附件时返回 `native_symbols_selection_required`。
- Play 必须已经持有该版本号及该版本的 AAB，否则上传以 `version_not_on_play` 失败。即使 AAB 存在，Play 仍可能拒绝文件；请检查返回的错误，不要假设重试会成功。
- 失败时适配器会尝试删除尚未提交的 Play 编辑。响应丢失或清理失败时，结果可能不确定，包括提交是否完成；重试前先检查 Play 和 Hands 回执。再次上传会替换该版本号相同类型的文件。
- `--commit` 写入回执（`play-promotion` / `upload-symbols`）；预演不写回执，也不改变版本修订号。但即使不提交，创建临时 Play 编辑也可能使同一 Google 用户已有的编辑失效。

API：`POST /api/apps/:appId/releases/:releaseId/distributions/play/upload-symbols`，请求体 `{mode?: "dry_run" | "commit", kinds?, expected_revision, approval: {note}}`。参阅 OpenAPI。

## Google Play 商店详情

通过 Hands 更新 Play 商店详情文本（应用名称、简短和完整描述、宣传视频）及图片（截图、宣传图、图标），无需手动编辑 Play Console。Hands 保存应用 Google 凭据；命令行不会看到它。需要应用 **publisher** 角色及经过验证并启用的 Google Play 绑定。

```bash
# 以推送接受的格式导出线上商店详情
hands store-listing pull raft-android --out listing.json

# 预演（默认）：Hands 打开 Play 编辑，应用文本，
# 执行 Google 的 edits.validate，删除编辑并打印计划
hands store-listing push raft-android --listing listing.json

# 发布同一变更
hands store-listing push raft-android --listing listing.json --commit

# 仅使用文件中的部分语言
hands store-listing push raft-android --listing listing.json --locales en-US,ja-JP --commit

# 审计记录
hands store-listing receipts raft-android
```

`listing.json` 以 Play 语言标签为键，使用 Google 的 `Listing` 字段名：

```json
{
  "en-US": { "title": "Raft", "shortDescription": "Chat with your agents", "fullDescription": "…" },
  "zh-CN": { "title": "Raft", "shortDescription": "…", "fullDescription": "…" },
  "ja-JP": { "title": "Raft", "shortDescription": "…", "fullDescription": "…", "video": "https://www.youtube.com/watch?v=…" }
}
```

也接受 Google 的列表形式 `{ "listings": [ { "language": "en-US", "title": "…" } ] }`。拉取详情和预演会打开临时 Play 编辑；即使不提交，创建它也可能使同一 Google 用户已有的编辑失效。

- **语言**必须是 Play 商店详情标签，拼写与 Play 列表完全一致，例如 `en-US`、`zh-CN`、`zh-TW`、`zh-HK`、`ja-JP`、`ko-KR`、`es-ES`、`fr-FR`、`de-DE`、`pt-BR`、`iw-IL`（希伯来语）、`es-419`、`fil` 等，共 86 个，来源为 Play Console 帮助中的应用翻译和本地化说明。`zh-Hans`、`en` 或 `en-us` 会在调用 Play 前被拒绝，并给出建议，例如 `zh-Hans (did you mean zh-CN?)`。
- **长度限制**（Play Console 帮助中的应用创建和设置说明）：`title` 30、`shortDescription` 80、`fullDescription` 4,000 个字符；中文及其他中日韩文字与拉丁文字均逐字符计数。超长文本以 `listing_field_too_long` 拒绝，不会截断。
- **省略的字段保留当前 Play 值。** Play 上尚不存在的语言需要 `title`、`shortDescription` 和 `fullDescription`。`video: ""` 会清除视频。
- Play 上存在而文件中未列出的语言**保持不变**，除非传入 `--delete-unlisted-languages`；应用默认语言绝不会被删除，该参数不能与 `--locales` 组合。
- **审核中：**Hands 使用 `changesInReviewBehavior=ERROR_IF_IN_REVIEW` 提交，绝不取消正在审核的其他变更。存在审核中变更时，推送以 `play_edit_in_review` 失败，不提交任何内容；等待审核后再次推送。Hands 首先根据 Google 的结构化错误原因识别，其次根据消息识别。如果 Google 响应两者都不匹配（例如本地化消息），或提交返回意外响应，推送以 `play_edit_state_unknown` 失败，绝不报告为完成；再次推送前请检查 Play Console。
- `--changes-not-sent-for-review`（与 `--commit` 一起使用）发送 `changesNotSentForReview=true`：对于必须手动送审变更的应用，编辑会加入待处理变更，由你在 Play Console 中送审。没有该参数时，此类应用以 `play_changes_not_sent_for_review` 失败。

### 商店详情图片

`--images <dir>` 在与文本相同的 Play 编辑中替换截图和图片；先处理文本，确保新语言在处理图片前已存在。可单独使用或与 `--listing` 一起使用；默认预演，使用 `--commit` 发布。

```bash
# 可以直接使用设计师导出的目录结构
hands store-listing push raft-android --listing listing.json --images ./shots/play
hands store-listing push raft-android --listing listing.json --images ./shots/play --commit
```

支持两种目录结构。文件按文件名顺序上传，并识别数字顺序，因此依次为 `01-…`、`02-…` 至 `10-…`：

```text
<dir>/<device>/<language>/NN-name.png      device first (designer export)
<dir>/<language>/<imageType>/NN-name.png   language first
```

| 设备目录 | Play imageType | 调用 Play 之前检查的规则 |
| --- | --- | --- |
| `phone` | `phoneScreenshots` | 2–8 张，JPEG 或 24 位 PNG（无 alpha），边长 320–3840 像素，长边不超过短边的 2 倍 |
| `tablet-7` | `sevenInchScreenshots` | 1–8 张，其余截图规则相同 |
| `tablet-10` | `tenInchScreenshots` | 1–8 张，其余截图规则相同 |
| `tv` | `tvScreenshots` | 1–8 张，其余截图规则相同 |
| `wear` | `wearScreenshots` | 1–8 张，1:1，至少 384×384 |
| `feature-graphic` | `featureGraphic` | 恰好 1 张，1024×500，JPEG 或 24 位 PNG |
| `icon` | `icon` | 恰好 1 张，512×512，32 位 PNG（带 alpha），不超过 1024 KB |
| `tv-banner` | `tvBanner` | 恰好 1 张，1280×720，JPEG 或 24 位 PNG |

每张图片最多 15,728,640 字节（Google 上传限制），一次推送最多携带 24 MiB 图片；更大的集合应使用 `--locales` 拆分。Google 的 `appImageTypeUnspecified` 会以 `image_type_not_supported` 拒绝。

语言目录使用 Play 标签（`en-US`、`zh-CN` 等）或明确支持的别名：`en`→`en-US`、`zh-Hans`→`zh-CN`、`zh-Hant`→`zh-TW`、`ja`→`ja-JP`、`ko`→`ko-KR`。`default` 目录适用于该图片类型没有专属目录的每个目标语言；目标语言来自 `--listing`、其他语言目录或 `--locales`。

每个列出的 `(语言, imageType)` 集合都会**替换** Play 当前内容：先执行 `edits.images.deleteall`，再按顺序上传。Play 已有内容逐字节相同（SHA-256 序列相同）时跳过。未列出的图片类型保持不变。Hands 会检查每个上传文件与声明的 SHA-256 一致，不一致时拒绝。Google 自身的 `Image.sha256` 也会记录在旁边，并标记 `sha256_match: true|false|null`；不同之处列入 `image_warnings`，但不会导致推送失败。提交后会回读，图片数量必须匹配。`--ai-generated-state <aiGeneratedStateNotAiGenerated|aiGeneratedStateAiGeneratedDeveloperAttested|aiGeneratedStateUnspecified>` 会作为每张图片的 Google `aiGeneratedState` 传入。回执记录每张图片的 SHA-256、Google SHA-256 和是否匹配、大小、类型、像素尺寸及 Google 图片 ID。

每次到达 Google 的推送都会写入不可变回执：执行者、时间、编辑 ID、预演或提交、按语言的计划，以及每个字段的 SHA-256 和长度。API：`GET|POST /api/apps/:appId/distributions/play/store-listing`、`GET /api/apps/:appId/distributions/play/store-listing/receipts`。参阅 OpenAPI。

## 发布 iOS / TestFlight

CI 应上传 macOS/Xcode 导出的**已签名 IPA**，不要上传未签名的中间 IPA。Hands 存储 IPA 和 dSYM；Apple 签名证书、描述文件和密码留在 CI 密钥边界内。用于服务端上传和分发的独立 App Store Connect API 密钥在 Hands 中加密保存，绝不会复制到 CI 或智能体。

在 `xcodebuild archive` 和 `xcodebuild -exportArchive` 后使用 `builds publish-ios`：

```bash
hands builds publish-ios raft-ios \
  --ipa ./build/Raft.ipa \
  --dsym ./build/Raft.dSYM.zip \
  --channel main \
  --version-name 1.0.0 \
  --version-code 1000000 \
  --changelog-file zh=./changelog.zh.md \
  --changelog-file en=./changelog.en.md \
  --source-commit "$GITHUB_SHA" \
  --ci-provider github-actions \
  --ci-run-id "$GITHUB_RUN_ID" \
  --ci-url "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID" \
  --export-method app-store \
  --appstore-build-number 42 \
  --draft
```

`--version-code` **必须与应用报告的值**（`CFBundleVersion`）一致，否则 iOS 崩溃无法使用正确的 dSYM 符号化。`--dsym` 文件是归档中 `*.dSYM` 包组成的 `.dSYM.zip`；没有它时该版本的 iOS 崩溃只显示原始堆栈帧。`--export-method`、`--appstore-build-number` 和 `--testflight-status` 记录为构建元数据。`publish-ios` 创建 Hands 构建和版本，本身不会上传到 Apple 或启用 TestFlight 测试。

随后应用发布者通过 Hands 控制台、API 或命令行启动**服务端上传**。命令行可使用 `hands api POST /api/apps/<app-uuid>/builds/<build-id>/testflight-upload`，再通过上传状态 API 轮询返回的 Apple Build Upload ID，直到 `COMPLETE` 或 `FAILED`（`response.state.state`；旁边保留 Apple 的错误、警告和提示）。此阶段只上传并处理二进制文件，绝不会分配测试组、通知测试人员、激活 Hands 版本或提交 App Store 正式版本。

Apple 将准确构建显示为 `VALID` 后，列出稳定测试组 ID：

```bash
hands builds testflight-groups raft-ios <hands-build-id>
```

分发给内部测试人员：

```bash
hands builds testflight-publish raft-ios <hands-build-id> \
  --distribution internal \
  --group-id 11111111-2222-3333-4444-555555555555 \
  --what-to-test en-US="Verify login and Activity." \
  --what-to-test zh-Hans="验证登录和活动页。" \
  --wait
```

外部分发使用同一已处理构建，但会提交 TestFlight Beta App 审核。`--notify-testers` 在审核通过后启用 Apple 自动通知；对于已批准且没有待处理自动通知的构建，Hands 会立即发送官方测试版构建通知。

```bash
hands builds testflight-publish raft-ios <hands-build-id> \
  --distribution external \
  --group-id aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee \
  --what-to-test-file en-US=./testflight.en.txt \
  --what-to-test-file zh-Hans=./testflight.zh.txt \
  --notify-testers \
  --json > testflight-publish-receipt.json
```

请保留该修改响应：`notification=sent` 或 `already_sent` 是通知操作回执。生成回执的调用不要加 `--wait`。使用 `--wait --json` 时，命令行打印后续轮询的 GET 状态，而不是原始 POST 响应，因此不会保留 `notification` 和 `operation_id`。

外部审核可能超过普通命令行会话的时长，请单独检查实时状态：

```bash
hands builds testflight-status raft-ios <hands-build-id> \
  --distribution external \
  --json
```

如果适合使用 `--wait` 且验收条件不要求 POST 操作回执，可用 `--poll-interval-seconds` 和 `--timeout-seconds` 调整有界轮询，默认分别为 15 和 3600 秒。终态失败、拒绝或过期会使命令失败。外部模式要求已有或提供测试说明的本地化内容；所有所选组 ID 必须符合请求的内部或外部模式。

通知值包括 `not_requested`、`scheduled`、`sent` 和 `already_sent`。只有 `sent` / `already_sent` 加上重新读取的精确构建 `external_build_state=IN_BETA_TESTING`，才能证明通知完成。如果首次响应为 `scheduled`，等待该精确构建进入测试状态，不带 `--wait` 重放相同发布以保留 `already_sent`，然后再次重新读取状态。`VALID`、组分配、`BETA_APPROVED` 和 `auto_notify_enabled=false` 都不是通知回执。

Hands 遵循 Apple 的角色边界：上传 IPA 和 TestFlight 测试组分发均需要 Hands 应用发布者权限。保存的 App Store Connect 密钥必须具有 Apple 允许执行所请求操作的角色：外部测试为 Account Holder、Admin 或 App Manager；内部测试也允许 Developer 或 Marketing。Apple 将测试构建限制为 90 天，并且每次只允许一个版本中的一个构建处于 Beta App 审核中。

Apple 官方参考资料：

- [预发布版本和测试人员](https://developer.apple.com/documentation/appstoreconnectapi/prerelease-versions-and-beta-testers)
- [添加内部测试人员](https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers/)
- [邀请外部测试人员](https://developer.apple.com/help/app-store-connect/test-a-beta-version/invite-external-testers/)
- [TestFlight 概览](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/)

### TestFlight 崩溃报告和截图反馈

使用应用保存的 App Store Connect 密钥拉取测试人员从 TestFlight 提交的内容，应用查看者权限即可。拉取不会更改 Apple 侧的任何内容。

```bash
# 崩溃：某个构建最新的 20 条，每条崩溃日志保存为 .ips
hands testflight crashes raft-ios --build 11200001 --download ./crashes
# 截图反馈：测试人员文本、设备、构建和截图
hands testflight feedback raft-ios --build 11200001 --download ./shots
# 同时固定营销版本，并输出 JSON 供脚本使用
hands testflight crashes raft-ios --build 11200001 --app-version 1.12.0 --json
```

Apple API 只提供测试人员在 TestFlight 提示中选择分享的崩溃。未分享的崩溃只出现在 Xcode Organizer 中，因此空列表不能证明构建从未崩溃。部分已分享崩溃在 Apple 侧没有日志（`CRASH_LOG_NOT_AVAILABLE`）。截图 URL 由 Apple 签名并会过期（`expires_at`）。不会返回测试人员电子邮件地址。

**关闭是单独的明确步骤。** 处理后可以在 Apple 侧关闭条目。此操作调用 Apple 官方 TestFlight 反馈 API，而 Apple 对提交项唯一的解决方式是删除：崩溃或截图反馈会从 App Store Connect 的 TestFlight 反馈中移除。需要应用发布者角色或 `feedback:triage` 权限。

```bash
hands testflight close raft-ios crash <crashId>
hands testflight close raft-ios feedback <feedbackId>
```

API：

| 操作 | 请求 |
| --- | --- |
| 列出崩溃 | `GET /api/apps/<appId>/testflight-crashes?build=&version=&limit=` |
| 崩溃日志 | `GET /api/apps/<appId>/testflight-crashes/<id>/log`（text/plain） |
| 列出截图反馈 | `GET /api/apps/<appId>/testflight-feedback?build=&version=&limit=` |
| 关闭崩溃 | `DELETE /api/apps/<appId>/testflight-crashes/<id>` |
| 关闭截图反馈 | `DELETE /api/apps/<appId>/testflight-feedback/<id>` |

对于原始 CI 草稿，单个 `--changelog-file ./changelog.txt` 仍然有效。对于已审核说明，优先使用可重复的 `lang=file` 项，例如 `--changelog-file zh=zh.md --changelog-file en=en.md`。

## App Store 发布

`hands app-store` 通过 Hands 管理 App Store 提交。每个写入 Apple 的命令默认预演，除非传入 `--commit`。详情、准备操作决策表和截图尺寸表见 [iOS 发布与 TestFlight](ios-testflight.md#app-store-release-version-listing-screenshots-review)。

```bash
hands app-store status raft-ios --version-name 1.17.0
# 创建、复用或重命名版本（已撤回的 1.12.0 改为 1.17.0）
hands app-store prepare raft-ios --version-name 1.17.0 --build <asc-build-id> [--commit]
# 商店详情文本：{ "en-US": { "description": "...", "keywords": "...", "promotionalText": "...",
#                 "whatsNew": "...", "supportUrl": "...", "marketingUrl": "..." } }
# 版本新增加的语言需要 description、keywords 和 supportUrl
hands app-store localizations push raft-ios --version-name 1.17.0 --file listing.json [--commit]
# 截图：shots/<locale>/<display_type>/NN.png，例如 shots/en-US/APP_IPHONE_67/01.png
hands app-store screenshots push raft-ios --version-name 1.17.0 --dir shots [--locales en-US,ja] [--commit]
# 只读就绪检查；发现任何错误时以状态 1 退出
hands app-store preflight raft-ios --version-name 1.17.0 [--json]
hands app-store submit raft-ios --version-name 1.17.0 [--commit]
hands app-store withdraw raft-ios --version-name 1.17.0 [--commit]
# 批准后（PENDING_DEVELOPER_RELEASE）：发布不可逆
hands app-store release raft-ios <asc-version-id> --version-name 1.17.0 [--build <asc-build-id>] [--commit]
```

除非每个截图组都为 `ok`，否则 `screenshots push --commit` 以非零状态退出：任一组失败，或因认证等全局错误而未尝试时为 `SCREENSHOTS_FAILED`；否则 Apple 仍在处理已上传截图时为 `SCREENSHOTS_PENDING`。待处理时稍后再次预演：每组均为 `unchanged` 表示文件和顺序已确认；若某组为 `reorder` 或 `replace`，再次运行 `--commit`。

`preflight` 是只读操作（查看者角色；Hands 只向 Apple 发送 GET）。它按错误、警告和提示分组打印发现，每项包含检查、语言或显示类型、Apple 资源路径（与 Apple 拒绝提交时关联错误中使用的路径相同）和修复方式。存在任何错误时以状态 1 退出。不带 `--commit` 的 `submit` 也会运行检查并打印错误。

`prepare` 的 `--release-type MANUAL|AFTER_APPROVAL` 适用于创建、复用或重命名的版本；省略时，已有版本保留 Apple 的发布类型。

除非 `--version` 及提供时的 `--build` 与 Apple 保存的版本信息匹配，否则 `release` 会拒绝。只有 Apple 回读 `READY_FOR_SALE` 时才打印 `Released`；否则报告 `Release requested` 和 Apple 当前状态，因为 Apple 异步发布。已经上线的版本返回错误 `ALREADY_RELEASED`，不视为成功。

所有命令默认预演，除非传入 `--commit`。API 为向后兼容，准备操作默认 `mode: "commit"`，其写入可逆；商店详情文本、截图和发布没有默认 `mode`，因为它们会覆盖线上商店内容或无法撤销。

推送命令可使用 `--version-id <asc-version-id>` 代替 `--version`。截图文件按名称的数字顺序排序，`2-` 在 `10-` 前。与 Apple 完全相同的截图推送（MD5 和顺序均相同）不会写入。推送被拒绝或失败时，错误前会打印每组或每种语言的计划；`--json` 打印完整响应。

## 发布 HarmonyOS / OHOS

CI 组装并签名 App Pack 后使用 `builds publish-ohos`。命令在同一构建上保存两种分发路径：用于 AppGallery 的 `.app` 和供用户直接安装的独立签名 `.hap`。

```bash
hands builds publish-ohos raft-ohos \
  --app ./raft-ohos-1.0.0-1000000.app \
  --hap ./raft-ohos-entry-1.0.0-1000000.hap \
  --symbols ./ohos-symbols-1.0.0-1000000.tar.gz \
  --metadata ./ohos-release-metadata.json \
  --channel main \
  --version-name 1.0.0 \
  --version-code 1000000 \
  --source-commit "$GITHUB_SHA" \
  --ci-provider github-actions \
  --ci-run-id "$GITHUB_RUN_ID" \
  --ci-url "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID" \
  --draft
```

`.app` 和 `.hap` 都是可安装文件，具有不同文件类型和分发元数据。公开更新使用方可请求 `filetype=app` 或 `filetype=hap`；已认证构建视图分别显示两个文件。签名证书、描述文件、P12 文件和密码保留在 CI 中，绝不会上传到 Hands。

### AppGallery 邀请测试（OHOS）

Hands 可以将构建中已签名的 `.app` 推送到 AppGallery Connect，作为**邀请测试**（Huawei App Testing，`releaseType=6`）。商店详情提交和分阶段发布尚未自动化，请在 AppGallery Connect 中完成。应用需要 AGC Service Account 凭据（设置 → AppGallery），渠道的 `bundle_id` 需设置为 HarmonyOS 包名。

命令行（0.5.30 及以上版本，需要应用管理员角色）：

```bash
hands agc groups raft-ohos
hands agc upload raft-ohos <buildId> --package-name build.raft.mobile \
  --test-desc "1.12.0 (11200003)" --wait
hands agc submit raft-ohos <submissionId> --group <groupId>
hands agc status raft-ohos <submissionId> --events   # 或使用：<buildId> --build
```

`upload` 会复用该构建尚未结束的尝试。状态为 `failed`、`rejected` 或 `stopped` 后再次调用会开始新的尝试（新的 AGC 测试版本）；先前提交保留其历史。失败响应可能留下不确定的提供方操作；再次上传前请先检查提交记录和 Huawei。`hands agc market-status` 也可能记录市场包的最终状态并将通知加入队列，因此收到 401 后不会自动重发。

通过 `hands api` 使用管理 API 执行相同流程：

```bash
APP=/api/apps/<appId>
# 1. 上传构建的 .app 并创建测试版本（复用尚未结束的尝试）。
hands api POST $APP/builds/<buildId>/agc-invitation-test \
  --data '{"package_name":"build.raft.mobile","test_desc":"1.12.0 (11200003)"}' --json
# 2. 轮询至状态为 "ready"（Huawei 编译应用包，约 1–3 分钟）。
hands api GET $APP/agc-submissions/<submissionId> --json
# 3. 列出测试组，然后提交到一个或多个组。
hands api GET $APP/agc-test-groups --json
hands api POST $APP/agc-submissions/<submissionId>/submit \
  --data '{"group_id":"<groupId>"}' --json
# 4. 重新读取 Huawei 审核结果。
hands api GET $APP/agc-submissions/<submissionId> --json
```

应用有多个测试组时，`submit` 需要明确的 `group_id` / `group_ids`；只有一个组时自动使用该组。提交结果仍未终结时，每次 `GET` 都会重新读取 Huawei；如果包已完成编译，该 GET 还可能将包绑定到 Huawei 的测试版本。CLI 收到 401 后不会自动重发这一状态请求；若结果不确定，重试前请检查提交记录和 Huawei。存储状态会跟随 AppGallery：

| Hands `state` | Huawei 测试 `releaseState` |
| --- | --- |
| `processing` | 应用包仍在编译（`successStatus` 1） |
| `ready` | 编译并绑定完成；`7` 准备提交 / `11` 撤销审核 |
| `testing_review` | `4` 正在审核 / `12` 预审中 |
| `testing_scheduled` | `3` 待生效 |
| `testing_active` | `0` 正在测试 |
| `rejected` | `1` 审核不通过 / `13` 预审不通过（`provider_state.audit_opinion` 包含 Huawei 原因） |
| `stopped` | `2` / `10` 已失效 |
| `failed` | 上传错误，或 Huawei 无法编译应用包（`successStatus` 2）；再次上传以重试 |

原始 `release_state`、`audit_opinion` 和测试窗口保存在 `provider_state`。无法连接 Huawei 时，响应仍返回已存储提交及 `sync_error`。

## 发布 Electron（通用提供方） {#publish-electron-generic-provider}

Hands 可以托管使用 `electron-updater` 通用提供方的 Electron 应用：

```ts
autoUpdater.setFeedURL({
  provider: "generic",
  url: "https://hands.build/electron/raft-desktop/main"
});
```

Hands **原样**托管 electron-builder 输出。使用 `builds publish-electron` 将 `dist/` 中的文件作为 `desktop-installer` 构建和版本的文件上传（旧名称 `electron-installer` 也可使用），然后创建版本草稿供审核：

```bash
hands builds publish-electron raft-desktop \
  --channel main \
  --version-name 1.2.3 \
  --version-code 10203 \
  --platform win32 \
  --arch x64 \
  --metadata dist/latest.yml \
  --installer "dist/Raft Setup 1.2.3.exe" \
  --blockmap "dist/Raft Setup 1.2.3.exe.blockmap" \
  --changelog-file ./changelog.txt \
  --draft
```

`--metadata`、`--installer` 和 `--blockmap` 可以重复使用。跨平台 Electron 应用应按平台和渠道各运行一次命令，使每个版本有明确的 `platform` / `arch` 组合。命令通过 `variant` 和 `metadata_json.filename` 保留原始文件名，使 `latest*.yml` 中的相对 URL 保持可解析。

必需文件取决于目标操作系统：

| 目标 | 必需文件 |
|---|---|
| Windows NSIS | `latest.yml`、安装程序 `.exe`，可选 `.exe.blockmap` |
| macOS | `latest-mac.yml`、用于自动更新的已签名 `.zip`，可选用于下载的 `.dmg`，以及生成时的 `.blockmap` 文件 |
| Linux | `latest-linux.yml`、`AppImage` 或其他配置的目标，以及生成时的 `.blockmap` 文件 |

需要自定义编排的 CI 系统也可以直接调用构建、文件和版本 API，使用相同字段登记原始文件名：

| 文件 | `platform` | `arch` | `filetype` | `artifact_kind` | 文件名字段 |
|---|---|---|---|---|---|
| `latest.yml` | `win32` | `x64` 或 null | `yml` | `electron-metadata` | `variant` 或 `metadata_json.filename` |
| `latest-mac.yml` | `darwin` | `arm64` 或 `x64` | `yml` | `electron-metadata` | `variant` 或 `metadata_json.filename` |
| `latest-linux.yml` | `linux` | `x64` 或 `arm64` | `yml` | `electron-metadata` | `variant` 或 `metadata_json.filename` |
| `Raft Setup 1.2.3.exe` | `win32` | `x64` | `exe` | `installable` | `metadata_json.filename` |
| `Raft Setup 1.2.3.exe.blockmap` | `win32` | `x64` | `blockmap` | `electron-blockmap` | `metadata_json.filename` |

与 Android 一样遵循先草稿规则：CI 创建 Electron 版本草稿，用户或智能体审核更新说明后明确发布。macOS 更新文件必须在上传前签名；Hands 托管已签名文件，但不会为 Electron 应用签名。

## 审核并发布（草稿流程）

CI 创建草稿；审核更新说明后，发布是单独的明确步骤：

```bash
# 检查草稿（状态、发布比例、更新说明）
hands releases show raft-android <release-id>

# 写入审核后的更新说明；可重复提供 [lang=]file
hands releases update raft-android <release-id> \
  --changelog-file zh=changelog.zh.md \
  --changelog-file en=changelog.en.md

# 正式发布
hands releases publish raft-android <release-id>
```

双语更新说明按语言保存；客户端收到与其语言区域匹配的内容（`zh` 规范化为 `zh-CN`；普通单值更新说明原样提供）。

### 精确设备组发布

创建命名组，添加 Hands 更新 SDK 上报的稳定安装 ID，然后将版本草稿绑定到该组：

```bash
hands device-groups create raft-android --name "Artin test devices"
hands device-groups add-member raft-android <group-id> \
  --device-id <installation-device-id> --label "Huawei test tablet"
hands device-groups update raft-android <group-id> \
  --name "Artin test tablets" --description "Physical acceptance devices"
hands releases update raft-android <release-id> --device-group <group-id>
hands releases publish raft-android <release-id> --device-group <group-id>
```

最终发布仍是明确授权步骤。命令行首先读取版本详情，将所有已存储范围规范化，并将完整集合以 `expected_scopes` 与该详情的 `expected_revision` 一同发送。更新命令在 PATCH 前也会重新读取并发送修订号。范围为空、重复、格式错误或不受支持时会在本地拒绝，不发送发布请求。可重复的 `--device-group` 用于断言已保存的精确设备组子集。如果从读取详情到服务端受保护转换之间范围或修订号发生变化，激活返回 `409`。

只有精确匹配的组成员收到该版本，其他设备回退到先前活动版本。使用 `hands device-groups list <app>` 列出组，使用 `device-groups remove-member` 移除成员，使用 `device-groups update` 重命名或更改操作备注。不要使用 IMEI 或硬件序列号。

### 百分比发布并强制包含设备组

一个版本可以结合受百分比限制的 `full:all` 范围，以及始终包含其成员的设备组：

```bash
hands releases update raft-android <release-id> \
  --full \
  --rollout-percent 25 \
  --always-include-group <acceptance-group-id> \
  --always-include-group <qa-group-id>

hands releases publish raft-android <release-id> \
  --device-group <acceptance-group-id> \
  --device-group <qa-group-id>
```

`--always-include-group` 可重复使用，并隐含 `full:all`；单独使用 `--full` 会将范围重置为仅全量。`--rollout-percent` 接受 0–100 的整数，其中 100 存储为不受限制的全量发布。旧版更新形式 `--device-group <id>` 仍会将范围替换为单个精确设备组发布，不能与全量发布选项组合。

每个应用、渠道、产品、发布类型和版本号组合只能有一个未取消的版本。发布命令在创建构建或上传文件前预检查该组合。取消会停用旧版本并释放版本号供修正上传使用，同时保留构建、文件和审计历史。只有没有替代版本占用该版本号时，恢复才重新激活旧版本。少见的冲突若在命令行预检查后抢先发生，会将新构建标记为 `failed`、将冲突身份写入来源记录，并在终态错误中包含构建 ID。对于已经到达设备的 Android 版本，请使用更高版本号发布修正，以便客户端更新。

## 分享链接

```bash
hands releases share raft-android <release-id> --password <pw>   # 密码可选
hands releases shares raft-android <release-id>                   # 列出
hands releases update-share raft-android <release-id> <share-id> --ttl-seconds 1209600
hands releases revoke-share raft-android <release-id> <share-id>
```

`--password` 也可以从 `HANDS_SHARE_PASSWORD` 读取，旧版 `QUIVER_SHARE_PASSWORD` 仍然有效，以避免密码进入 Shell 历史。分享 URL 仅在创建时打印一次；令牌以哈希形式保存。

## 反馈工单

智能体可以完全通过命令行处理反馈和崩溃工单：读取需要查看者角色，修改需要发布者角色。

```bash
hands feedback list raft-android --status open --kind crash
hands feedback list raft-android --kind crash --crash-type system_kill
hands feedback list raft-ios --build-scope external
hands feedback show raft-android <ticket-id>
hands feedback update raft-android <ticket-id> --status in_progress --assignee me
hands feedback comment raft-android <ticket-id> "已复现，修复中"
hands feedback update raft-android <ticket-id> --status resolved
hands feedback update raft-android <ticket-id> --status closed --closure-reason completed
hands feedback update raft-android <ticket-id> --closure-reason duplicate --duplicate-of <canonical-ticket-id>
```

`--assignee none` 移除负责人。关闭工单时必须提供 `--closure-reason`（`completed`、`not_planned`、`cannot_reproduce`、`duplicate` 或 `no_longer_needed`），重复工单还需提供 `--duplicate-of <ticket-id>`。所有子命令都接受 `--json`，便于编写脚本。对于启用外部报告分流的 iOS 应用，`--build-scope` 接受 `standard`、`external` 或 `all`；默认包含已配置和未知来源。Bundle ID 由客户端上报，不能用于验证身份。

## 应用 Webhook

应用管理员可以为单个应用的事件订阅端点，无需组织管理员权限。服务端将这些 Webhook 限定于应用；组织范围的 Webhook（全部应用）仍仅限组织管理员管理，不列在这里。

```bash
# 生成秘密并显示一次：
hands webhooks create my-app --url https://example.com/hands --events release:new,build:failed
# 或使用自己的秘密（绝不要放在命令参数中）：
printf %s "$HOOK_SECRET" | hands webhooks create my-app --url https://example.com/hands --secret-stdin
hands webhooks list my-app
hands webhooks deliveries my-app <webhook-id>
hands webhooks update my-app <webhook-id> --disable
printf %s "$NEW_SECRET" | hands webhooks update my-app <webhook-id> --secret-stdin
hands webhooks delete my-app <webhook-id>
```

`release:new` 载荷包含 `release_id`、`app_id`、`build_id`、`channel_id`，以及 `version_name`、`version_code`、`app_slug` 和 `channel`（slug）。使用方无需调用 API 即可链接到固定公开页面 `https://hands.build/apps/<app_slug>/v/<version_name>`。

省略 `--events` 会订阅所有事件。投递包含 `X-Hands-Signature: sha256=<hex>`，即使用秘密对原始正文计算的 HMAC-SHA256。REST：`/api/apps/:appId/webhooks`（列出、创建）、`/api/apps/:appId/webhooks/:id`（PATCH / DELETE）、`/api/apps/:appId/webhooks/:id/deliveries`。

## 直接访问 API（`hands api`）

此功能方便高级用户和脚本直接调用 Hands API 端点，使用与专用子命令**相同**的服务端角色控制、审计和各端点保护。它不会绕过权限，也不是执行任意 SQL 的途径；每次写入仍经过相同服务端路由。

```bash
# 使用可重复的查询参数执行 GET
hands api GET /api/apps --param platform=android

# 使用内联 JSON 请求体执行 PATCH。注意：路径参数是原始值，<appId> 是应用
# UUID，不是 slug；`hands api` 原样传递路径，不会解析 slug。
hands api PATCH /api/apps/<appId>/releases/<releaseId>/shares/<shareId> \
  --data '{"expires_at":null}'

# ……或使用 @path 从文件读取同一请求体
hands api PATCH /api/apps/<appId>/releases/<releaseId>/shares/<shareId> \
  --data @body.json

# 二进制或同源流式响应：将原始字节写入文件
hands api GET /api/apps/<appId>/feedback/<ticketId>/attachments/<attachmentId> \
  --output attachment.bin

# 机器可读：仅打印响应体（不打印状态行）
hands --json api GET /api/apps
```

- **原始路径参数。** `<appId>` 及其他 ID 是资源 UUID，不是 slug。`hands api` 原样传递路径，不会像专用子命令那样解析 slug。
- **收到 401 不自动重发。** 直接 API 请求只发送一次，即使是 GET 也是如此，因为某些读取会创建提供方编辑。托管智能体的凭据仍会在发送前主动刷新。如果 401 或响应丢失导致结果不确定，请先检查当前状态再重试。
- **仅限同源 `/api/*`。** `<path>` 根据当前 Hands API 基础地址解析，并遵守根级 `--api` 参数。接受相对路径或**同源绝对 URL**；跨源绝对 URL、`//` 协议相对主机及逃出来源的 `../` 路径遍历均被拒绝，因此认证 Bearer 令牌不会离开 Hands 来源。
- **绝不跟随重定向。** `3xx` 会被报告，不会继续请求；跟随跨源重定向会泄露 Bearer 令牌。
- **认证与角色控制不变。** 复用现有命令行登录或令牌；服务端执行与其他调用相同的角色检查。
- 参数：`--param key=value`（可重复）、`--data <json|@file>`、`--output <file>`（二进制响应时必填）。全局 `--api` 和 `--json` 均有效。

### App Store 分析报表

Apple 只有在应用存在「分析报表请求」后才会生成 App Store 分析报表（安装、删除、会话、活跃设备），而请求只能通过 API 创建。应用管理员执行一次即可：

```bash
hands api POST /api/apps/<appId>/stats/app-store/analytics-report-requests
```

Hands 按 main 渠道的 bundle id 找到对应的 App Store Connect 应用，创建持续每日生成的 `ONGOING` 请求和回溯历史的 `ONE_TIME_SNAPSHOT` 请求。已有的请求会直接复用，重复执行是安全的；被 Apple 因长期未下载而停止的 `ONGOING` 请求会重新创建。返回结果列出每个请求以及是否新建。Apple 一般在一到两天内生成第一批报表。App Store Connect API 密钥需要能读取分析报表的角色，例如「管理」。

报表生成后，Hands 会自动下载：定时任务每隔几小时检查一次配置了 App Store Connect 密钥的应用，每份新的每日报表只读取一次。应用管理员也可以立即执行一次同样有上限的读取：

```bash
hands api POST /api/apps/<appId>/stats/app-store/ingest
```

之后 `hands stats <app>` 会显示一行 App Store Analytics 汇总以及最近若干天的表格；`hands stats <app> --json`（或 `GET /api/apps/<appId>/stats`）在 `stores.app_store.daily`、`stores.app_store.totals`、`stores.app_store.analytics_ingest` 和 `stores.app_store.analytics_note` 中返回这些数据。数据来自 Hands 自己的存储，所以使用 `--no-live` 时同样会返回。

| 字段 | Apple 报表 | 含义 |
|---|---|---|
| `downloads_first_time` | App Downloads Standard | 首次下载（`Download Type` 为 First-time download） |
| `downloads_redownload` | App Downloads Standard | 曾经拥有该应用的用户重新下载。更新和恢复不计入 |
| `installations` / `deletions` | App Store Installation and Deletion Standard | 安装与删除事件 |
| `sessions` | App Sessions Standard | 应用会话数 |
| `active_devices` | App Sessions Standard | 报表各行 Apple `Unique Devices` 的合计 |

这些数字的含义与局限：

- **数字偏低。** 安装、删除、会话和设备数只包含同意与开发者共享分析数据的用户；低于 Apple 隐私阈值的行（如小地区、少见版本）会被 Apple 去掉。因此会低于 App Store Connect 自己显示的总数。
- **数据有延迟。** Apple 在一到两天后才发布某一天的报表，最近几天一开始会缺失。
- **`active_devices` 是估计值。** 同一天出现在多行中的设备（例如使用了两个应用版本）会被重复计算，且不能跨天相加。因此 `totals` 给出的是单日最高值 `active_devices_peak_daily`，而不是合计。需要集成了 Hands SDK 的构建的精确活跃设备数时，请看 `direct.devices`。
- **缺失值是 `null` 而不是 0**：表示当天没有报表覆盖该指标。
- 如果 Apple 改变了报表的列，Hands 会在 `analytics_ingest.warnings` 中记录警告（例如 `missing_column Unique Devices`），并让该指标留空，而不是猜测。

## CI 环境变量

每个变量先读取 `HANDS_<name>`，再读取旧版 `QUIVER_<name>`，因此现有 CI 无需更改。

| 变量 | 必填 | 用途 |
|---|---|---|
| `HANDS_API` | 否 | Hands 业务 API 基础 URL，默认为 `https://hands.build`。如果设置了 `HANDS_CLI_API`，后者优先。 |
| `HANDS_BEARER_TOKEN` | 是 | 限定于应用的 CI 部署令牌。 |
| `HANDS_AUTH_TOKEN` | 否 | `HANDS_BEARER_TOKEN` 的别名，优先尝试。 |

旧版对应变量 `QUIVER_API`、`QUIVER_BEARER_TOKEN` 和 `QUIVER_AUTH_TOKEN` 仍可使用。

## CI 示例

[botiverse/hands-examples](https://github.com/botiverse/hands-examples) 提供基于这些命令、可直接复制的流水线：

- 可复用 GitHub Action：`uses: botiverse/hands-examples/publish-android@v1`。
- Android、iOS（发布及服务端 [TestFlight 上传](ios-testflight.md)）和 Electron（通用提供方按平台使用渠道）的完整 GitHub Actions 与 GitLab CI 工作流。
- 适用于 Jenkins、Buildkite 或任何拥有 Bash 和 npm 的运行器的纯 Bash 脚本。

## 版本编号建议

Android 发布中，APK `versionCode` 和 Hands `version_code` 应保持一致。只有服务端版本号高于已安装应用时，客户端才会更新。

一种常见方案：

```text
versionCode = major * 1_000_000 + minor * 10_000 + patch * 100 + build
versionName = major.minor.patch[-suffix]
```

例如：`1.0.3-rc2` 转为 `versionName=1.0.3-rc2` 和 `versionCode=1000302`。

## 安全

不要将部署令牌、包令牌、签名密码或密钥库数据粘贴到公开聊天、问题评论、日志或更新说明中。应存入 CI 密钥存储，并通过环境变量传给 Hands。

## 商店订阅商品

使用 `hands store-products apply <app> --file products.json` 预览订阅变更，审核后添加 `--commit`。文件格式、价格及激活行为和恢复步骤见[商店订阅商品](./store-products.md)。
