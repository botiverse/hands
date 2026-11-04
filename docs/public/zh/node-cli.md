---
title: "发布 Node 命令行工具"
description: "使用 Hands 构建、发布和更新跨平台 Node 与命令行二进制文件。"
category: "SDKs & API"
order: 17
---

# 发布 Node 命令行工具

Hands 为 Node 命令行工具提供统一的版本化发布约定，涵盖构建元数据、平台目标、渠道、更新说明和公开更新检查。编写 CI 前先选择文件存放方式：

| 分发方式 | 适用场景 | 命令 |
| --- | --- | --- |
| Hands 托管 | Hands 接收并提供所有二进制文件 | `hands builds publish-cli-binary` |
| 外部 CDN | 现有 CDN 托管文件，Hands 发布文件的不可变身份 | `hands builds publish-version`，再创建版本草稿 |

两种方式使用同一个公开 `cli-binary` API。使用方根据 `platform` 和 `arch` 选择文件，跟随 `download_url`，并在安装前验证返回的 `sha256` 和 `size_bytes`。

## 1. 创建应用和 CI 身份

创建一次 Node 应用。应用初始化会创建 `cli-binary` 产品类型，以及 `main`、`preview`、`nightly` 渠道：

```bash
hands apps create \
  --slug my-cli \
  --name "My CLI" \
  --platform node \
  --description "Cross-platform command line client"
```

也可以使用已有 Node 应用。通过以下命令查看其渠道 ID 和 slug：

```bash
hands apps get my-cli
hands channels list my-cli
```

为 CI 创建限定于应用的部署令牌。`publisher` 令牌足够，它包含 `app:read`、`app:publish` 和 `feedback:write`；构建和版本接口使用应用发布者角色。发布任务不需要 `app:admin`。创建或撤销令牌需要应用管理员权限，在 CI 中使用令牌则不需要。

```bash
# 以应用管理员身份运行一次。秘密只显示一次。
hands deploy-tokens create my-cli --name github-ci --role publisher
```

API 也支持为接受显式权限范围的集成配置这些权限，但当前构建和版本接口要求应用发布者角色。此流程不要将发布者角色替换成无角色、仅有权限范围的令牌，否则会被拒绝。发布者角色仍限定于当前应用，不能发布其他应用。

将结果存入 CI 密钥存储，并只暴露给发布任务：

```bash
export HANDS_API=https://hands.build
export HANDS_BEARER_TOKEN="$HANDS_DEPLOY_TOKEN"
```

绝不要将令牌放入源码 URL、安装脚本、更新说明、Shell 历史或构建日志。令牌限定于应用，不能用于发布其他应用。

## 2. 选择版本和目标

使用 SemVer 格式的 `version_name`，如 `1.4.0` 或 `1.4.0-rc.1`。Hands 使用非负数字 `version_code` 排序；省略 `--version-code` 时，命令行会从普通的 `major.minor.patch` 版本派生。版本组合在应用、渠道、产品类型和发布类型范围内必须唯一。已发布版本需要修正时，请使用更高版本号。

支持以下命令行目标：

```text
darwin-arm64  darwin-x64  linux-arm64  linux-x64  win32-arm64  win32-x64
```

同一版本的重试应保持相同目标集合。目标由平台和架构组成；不要在目标名称中编码文件名或可变的构建 ID。

## 3. Hands 托管的二进制文件

每个版本使用一次 `publish-cli-binary` 调用。按相同顺序重复 `--target` 和 `--binary`；一次调用创建一个包含全部目标的构建和一个版本。使用 `--runner` 和 `--sha256sums` 时，也按位置配对。

```bash
hands builds publish-cli-binary my-cli \
  --version-name 1.4.0 \
  --channel main \
  --target darwin-arm64 --binary dist/my-cli-darwin-arm64 \
  --target linux-x64 --binary dist/my-cli-linux-x64 \
  --target win32-x64 --binary dist/my-cli-win32-x64 \
  --source-commit "$GIT_COMMIT" \
  --ci-provider github \
  --ci-run-id "$GITHUB_RUN_ID" \
  --draft
```

命令行在上传前计算每个本地文件的哈希，通过短期有效的单对象上传 URL 发送，并检查服务端的哈希和字节数。只有所有声明的文件就绪后，Hands 才创建版本。CI 建议使用 `--draft`，将激活保留为明确的审核步骤。

使用相同声明可以安全重试。已就绪文件保留记录的摘要，不会再获得上传 URL。第二次调用若改变不可变元数据会产生冲突；不要通过为同一版本组合创建第二个构建来修复。

明确审核并发布草稿：

```bash
hands releases show my-cli <release-id>
hands releases update my-cli <release-id> \
  --changelog-file en=release-notes/en.md \
  --changelog-file zh=release-notes/zh.md
hands releases publish my-cli <release-id>
```

`releases publish` 在激活前读取当前版本修订号和准确存储的范围。应用要求人工审批时，智能体的发布请求会保持待审批，直到获授权用户批准。

## 4. 外部 CDN 二进制文件

CDN 已提供不可变文件时使用 `publish-version`。Hands 存储来源 URL、原始摘要、字节大小、可选 gzip 传输元数据、Node 版本和来源信息；不会复制文件，也不会创建或激活版本。

计算声明 URL 实际提供的字节的哈希。URL 必须使用 HTTPS、不含凭据，并在版本生命周期内保持稳定。`https://cdn.example.com/my-cli/1.4.0/linux-x64` 等带版本的路径优于可变的 `latest` URL。

使用相同版本名注册所有目标。第一次调用创建外部构建，后续调用将其他目标附加到该构建：

```bash
hands builds publish-version my-cli \
  --version-name 1.4.0 \
  --channel main \
  --target linux-x64 \
  --source-url https://cdn.example.com/my-cli/1.4.0/linux-x64 \
  --raw-sha256 "$LINUX_SHA256" \
  --raw-size "$LINUX_SIZE" \
  --node-version 22.23.2 \
  --source-commit "$GIT_COMMIT" \
  --ci-provider github \
  --ci-run-id "$GITHUB_RUN_ID"

hands builds publish-version my-cli \
  --version-name 1.4.0 \
  --channel main \
  --target darwin-arm64 \
  --source-url https://cdn.example.com/my-cli/1.4.0/darwin-arm64 \
  --raw-sha256 "$MAC_SHA256" \
  --raw-size "$MAC_SIZE" \
  --node-version 22.23.2
```

完全相同的声明属于幂等重放；修改不可变字段会返回冲突。请保留返回的 `build_id`，创建版本草稿时需要它。

注册所有目标后创建版本草稿。`hands api` 是对普通 Hands API 的同源已认证封装，不会绕过基于角色的访问控制：

```bash
hands api POST /api/apps/<app-id>/releases/draft --data '{
  "build_id": "<build-id>",
  "channel_id": "<main-channel-id>",
  "product_type": "cli-binary",
  "release_type": "stable",
  "scopes": [{"scope_type": "full", "scope_value": "all"}],
  "changelog": "My CLI 1.4.0"
}'
```

读取草稿、编写并审核更新说明，然后发布。`cli-binary` 版本必须遵循外部目标约定：发布请求必须列出完整目标集合，版本激活后集合被冻结。请从最新版本详情读取当前 `revision` 和准确存储的范围集合：

```bash
hands api POST /api/apps/<app-id>/releases/<release-id>/publish --data '{
  "expected_revision": 0,
  "expected_scopes": [{"scope_type": "full", "scope_value": "all"}],
  "required_external_targets": [
    "darwin-arm64",
    "linux-x64"
  ]
}'
```

将 `0` 和目标列表替换为紧接写入之前读取的值。如果应用有审批门槛，请求会返回待审批，而不是激活版本。目标集合冻结后，不能再向已发布构建添加目标；请使用完整集合创建新版本。

## 5. 公开下载和更新

最新版本元数据可匿名访问，托管和外部文件使用相同的响应结构：

```bash
curl -fsSL \
  'https://hands.build/public/v2/apps/my-cli/latest?channel=main&product_type=cli-binary'
```

响应的 `assets[]` 条目包含 `platform`、`arch`、`filetype`、`size_bytes`、`sha256` 和 `download_url`。托管文件的 `download_url` 是限时 Hands URL，会重定向到存储；外部文件使用绑定版本的 Hands URL，重定向到声明的 CDN URL。执行前应跟随重定向并验证字节：

```bash
curl -fL -o my-cli "$DOWNLOAD_URL"
echo "$SHA256  my-cli" | sha256sum --check --strict
test "$(wc -c < my-cli)" -eq "$SIZE_BYTES"
```

对于已安装的命令行工具，使用当前 SemVer 调用更新检查接口：

```text
GET /public/v2/apps/my-cli/updates/check
    ?channel=main
    &product_type=cli-binary
    &current_version=1.3.2
    &platform=linux
    &arch=x64
```

`@botiverse/hands-node` 中的 Node 更新器会调用该接口，选择匹配的目标，跟随下载 URL，并验证 `sha256` 和 `size_bytes`。如需请求某个可用版本，使用 `version=` 代替渠道值：

```text
GET /public/v2/apps/my-cli/updates/check
    ?version=1.3.2
    &product_type=cli-binary
    &current_version=1.2.0
    &platform=linux
    &arch=x64
```

按版本请求会跨渠道搜索符合条件的活动和已被替代版本，仍受可用性和分阶段发布检查约束。

## 6. 使用 Hands 安装

Hands 为 Linux 和 macOS（`x64`、`arm64`）上已发布的自包含命令行二进制文件提供安装器，无需自行编写或上传 `install.sh`。例如，安装 `my-cli` 当前的 `main` 版本：

```sh
curl -fsSL -o install.sh https://hands.build/dl/my-cli/main/install.sh && sh ./install.sh
```

安装器选择平台和架构，只解析一次公开 `cli-binary` 版本，然后下载该版本对应目标。在替换目标文件前会检查字节数和 SHA-256。它需要 `curl`、`sha256sum` 或 `shasum`，以及可写的安装目录。默认安装到 `~/.local/bin/my-cli`，请确保该目录位于 `PATH`。可将 `HANDS_INSTALL_DIR` 设为绝对目录，或将 `HANDS_INSTALL_NAME` 设为简单文件名，以选择其他目标：

```sh
HANDS_INSTALL_DIR="$HOME/bin" HANDS_INSTALL_NAME=my-command sh install.sh
```

可将 URL 中的 `main` 替换为 `preview` 或 `nightly` 等其他渠道。此安装器 URL 中的应用和渠道名称必须以 ASCII 字母或数字开头，只能包含 ASCII 字母、数字、`.`、`_` 或 `-`，且最多 128 个字符。`releases` 是保留的渠道路径。

只有活动、非隐藏、已全量发布且具有 `full:all` 范围的版本符合条件；缺少目标或版本不兼容时会失败，不会安装。目标必须是对应平台和架构的可执行二进制文件，例如 Node 单文件可执行应用；此安装器不会安装 npm 包，也不会替你安装 Node。此 Shell 安装器不支持 Windows 和 PowerShell。

解析出的版本和摘要通过 HTTPS 从 Hands 获取。对于外部构建，声明的 CDN 必须继续通过 HTTPS 提供相同字节；文件被更改或不可用时不会安装。

## CI 检查清单

- 每个目标只构建一次，记录确切字节、摘要和大小。
- 每个版本仅执行一次托管发布调用，或在创建版本草稿前注册所有外部目标。
- 使用限定于应用的 `publisher` 令牌（有效权限包含 `app:read` / `app:publish`），并只放在 CI 密钥存储中。发布任务不需要 `app:admin`。
- 优先使用 `--draft`，审核更新说明和目标覆盖后再发布。
- 将来源 URL 和目标身份视为不可变发布输入。
- 重试相同声明，不要为同一版本组合创建第二个构建。
- 安装前跟随重定向，验证 SHA-256 和字节大小。

命令参数见[命令行参考](cli-reference.md)，完整匿名更新和下载结构见[公开 API 参考](public-api-reference.md)。
