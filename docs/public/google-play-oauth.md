# 使用 Google 授权连接 Google Play

通过浏览器登录 Google，让 Hands 访问你有权限的 Google Play 应用。无需创建服务账号 JSON 密钥，禁止创建服务账号密钥的组织策略可以保持启用。

接入分为三步：创建 Google OAuth 客户端、由 Hands 运维配置客户端、在应用集成页完成授权和配置验证。完成授权只代表 Google 账号已连接，实际发布仍需签名产物、验收和发布审批。

## 1. 准备 Google Play 权限

准备一个真人 Google 账号，并在 Play Console 的「用户和权限」中为它授予目标应用的访问权限。至少应能查看应用信息并操作准备使用的测试轨道；正式发布需要对应的正式发布权限。

授权时登录的是这个真人账号。此前邀请的服务账号不会自动把权限转给它。

确认目标应用已在 Play Console 中建立，并记下 Android 包名，例如 com.example.app。Hands 中填写的包名必须完全一致。尚未建立应用或尚未完成 Play 初始设置时，先完成这些步骤。

## 2. 在 Google Cloud 启用 API

打开 Google Cloud Console，选择 **Hands 服务端实际使用的 OAuth 客户端所属项目**。不是仅选择 Android 应用自己的项目；在其他项目启用 API 不会替这个客户端启用。使用 Hands 托管服务时，这一步由管理该 OAuth 项目的 Hands 运维完成。

进入「API 和服务 → 库」，搜索并启用 **Google Play Android Developer API**（androidpublisher.googleapis.com）。也可打开 [API 启用页面](https://console.developers.google.com/apis/api/androidpublisher.googleapis.com/)，先核对页面顶部选中的项目再点击启用。无需关闭服务账号密钥创建限制。

如果轨道读取返回 SERVICE_DISABLED，先完成这一项并等待 Google 配置生效，再用原来的授权重试读取，无需重新连接 Google。阻塞在 create_edit 时尚未读取轨道，因此不能据此判断应用权限；API 启用后再按真实返回检查。参见 [Google 官方接入步骤](https://developers.google.com/android-publisher/getting_started#enable_the_api)。

## 3. 配置 Google 授权页面

进入 **Google Auth Platform**，完成界面要求的应用名称、支持邮箱、受众和联系信息。

在数据访问权限中配置：

| 权限 | 用途 |
| --- | --- |
| https://www.googleapis.com/auth/androidpublisher | 访问 Google Play 发布 API |
| openid | 识别授权账号 |
| email | 展示已授权的 Google 账号 |

受众按实际使用范围选择。使用外部应用的测试模式时，把准备授权的真人 Google 账号添加为测试用户。测试模式的刷新令牌可能在七天后过期，长期自动发布前应完成适合正式使用的受众、发布状态和 Google 要求的审核。参见 [Google 对刷新令牌的说明](https://developers.google.com/identity/protocols/oauth2#expiration)。

## 4. 创建 Web 应用客户端

进入 Google Auth Platform 的 **Clients / 客户端** 页面，选择「创建客户端」。

1. 应用类型选 **Web application / Web 应用**。
2. 名称可填 Hands Google Play。
3. 在 **Authorized redirect URIs / 已获授权的重定向 URI** 添加下面这个完整地址。
4. 创建后保存 Client ID 和 Client secret。

Hands 托管服务的回调地址：

https://hands.build/api/google-play/oauth/callback

地址必须完全一致，不加末尾斜杠。这个地址填写在重定向 URI 栏，不能只填进 JavaScript 来源栏。其他 Hands 部署使用自己的 BUSINESS_ORIGIN，加上同一个路径。

客户端密钥只供服务端使用。请保存到受控的密钥存储，不要发到聊天、上传公共附件或写入源码。Google 页面只在创建时显示密钥时，应当场安全保存。参见 [Google 的 Web 客户端创建说明](https://developers.google.com/identity/protocols/oauth2/web-server#creatingcred)。

## 5. 由 Hands 运维接入客户端

使用 Hands 托管服务时，由运维完成这一节；应用管理员不需要自行部署 Worker。

在 Hands 仓库的 GitHub Actions 密钥中配置以下两项，或配置在业务 Worker 部署使用的环境中：

| GitHub Actions secret | 内容 |
| --- | --- |
| HANDS_GOOGLE_PLAY_OAUTH_CLIENT_ID | 上一步创建的 Client ID |
| HANDS_GOOGLE_PLAY_OAUTH_CLIENT_SECRET | 同一客户端的 Client secret |

两项必须一起配置。普通变量和前端构建变量不用于保存客户端密钥。

业务 Worker 的部署工作流会把它们写入 GOOGLE_PLAY_OAUTH_CLIENT_ID 和 GOOGLE_PLAY_OAUTH_CLIENT_SECRET。部署需要同时具备现有的私有 Play 适配器、加密密钥配置和 OAuth 数据库迁移；先部署支持 OAuth 的适配器，再部署业务 Worker。已有加密密钥不能随意重置。

如果控制台显示「此服务器尚未配置 Google 授权」，应检查上述配置和部署结果，而不是改用服务账号密钥或关闭组织策略。

## 6. 在 Hands 完成授权

1. 用真人账号登录 Hands，该账号需是目标应用的管理员。
2. 打开 Android 应用的 **Integrations / 集成**，点击 Google Play 行右侧的 **Connect / 连接**。无需先填写包名或轨道，也无需服务账号 JSON 文件。
3. 登录拥有 Play 权限的 Google 账号，授予请求的权限。
4. 返回 Integrations，确认连接器显示该 Google 账号。此时尚未配置的连接保持停用、待验证，不能用于发布。
5. 展开 Google Play 连接器，配置包名与内部测试、封闭测试、正式发布轨道。下拉框会列出已上传 Android 构建中的包名及其来源；主渠道只有一个候选时会自动带入。上传声明不等于 APK 解析验证，仍需核对它对应的 Play 应用；也可手动填写包名。选好包名后，Hands 自动从 Play 读取真实轨道，内部测试与正式发布轨道在存在时自动带入；封闭测试从返回的轨道中选择，不需要手填 ID。读取失败可以刷新重试，未读取到的轨道不能保存。
6. 保存配置。Hands 使用已保存的授权校验包名与轨道，成功后连接变为已验证、启用，无需再次登录 Google。
7. 后续可使用 **Test connection / 测试连接** 检查连接仍可用。

授权链接十分钟内有效，回调只能使用一次。切换 Hands 账号、注销、权限被撤回，或授权途中更换、停用、解除绑定，都可能使这次授权失效；从 Integrations 重新发起即可。

连接测试会创建并删除临时 Play edit，检查包名及所配轨道的访问权限，不提交版本。

## 7. 发布前再检查产物

连接成功不会自动发布。Google Play 发布使用 AAB；这个 AAB 应带正确的上传签名，包名和 versionCode 必须符合目标应用要求。

Hands 中的上传校验通过，仅证明文件和所声明的摘要一致，不能代替 Google Play 的签名、应用初始设置或商店审核。先按现有流程完成产物验收和人工审批，再执行明确的发布操作。

### AAB 上传与内部测试提交接口

以下管理 API 的 appId 使用完整应用 UUID，需使用拥有对应应用角色的 Hands 会话或部署令牌。上传、验收与 Google Play 提交都要求应用 publisher 权限。真人或 agent 均可明确提交；应用部署令牌还需具备该发布操作所需权限。CI 上传产物不会自动触发 Play 发布，提交说明与真实验收仍需明确提供。

1. `POST /api/apps/:appId/android-release-artifacts` 声明同一构建的一份 AAB 和一份 APK。请求包含 source（repository、commit_sha、ci_run_id）、package_name、version_name、version_code、upload_key_cert_sha256，以及两项 artifacts（kind、filename、size_bytes、sha256）。
2. 按响应中每项 `artifacts[].upload` 的 method、url、headers 上传文件，再调用 `POST /api/apps/:appId/android-release-artifacts/:buildId/assets/:assetId/complete` 校验并封存。`GET /api/apps/:appId/android-release-artifacts/:buildId` 返回的 bundle 应为 ready，两个 artifacts 的 status 均应为 sealed。
3. 为该 build 创建 release。完成真实验收后，调用 `POST /api/apps/:appId/releases/:releaseId/receipts/acceptance`，提交 AAB 的 artifact_id、verdict:pass、matrix_ref 与 expected_revision；验收结果必须对应这份已封存 AAB。成功写入验收会增加 release revision，下一步先重新读取。
4. 由已认证且具有应用 publisher 权限的真人或 agent 调用 `POST /api/apps/:appId/releases/:releaseId/distributions/play/promote`，body 包含 `track:"internal"`、最新 expected_revision 和 `approval:{"note":"验收和提交说明"}`。internal 使用绑定中配置的真实内部测试轨道；closed 才使用选择的封闭测试轨道，例如 alpha 或 beta。
5. 用 `GET /api/apps/:appId/releases/:releaseId/distributions/play` 及 `/receipts` 核对 Google 的包名、版本、轨道和摘要回执，再交给测试人员。读取轨道成功不等于版本上传成功。

当前提交门禁要求候选 AAB 的 versionCode **等于目标轨道最大 versionCode + 1**。准备签名候选前先核目标轨道的已有版本，避免产物做好后才发现冲突。完整请求结构见 [公开 API](../public-api-reference/) 和 [OpenAPI](https://hands.build/openapi.json)。

## 常见问题

| 现象 | 检查或处理 |
| --- | --- |
| 轨道读取报 502 / play_api_rejected，含 403、create_edit、SERVICE_DISABLED | 在 Hands OAuth 客户端所属项目启用 androidpublisher.googleapis.com，等待生效后用原授权重试；不要在另一个项目启用，也不要先改 Play 应用权限 |
| Google 报 redirect_uri_mismatch | 确认 Web 客户端登记的是完整回调地址，域名、路径和末尾斜杠都一致 |
| Google 拒绝访问或提示应用未验证 | 检查受众、测试用户名单、组织的第三方应用策略和 Google 授权页面要求 |
| 返回 Hands 后授权失败 | 查看连接行保留的失败原因，再点击重试；尚未配置包名时不会检查 Play 应用权限 |
| 换取 Google 令牌失败、读取 Google 账号失败或保存授权失败 | 重新发起授权；持续失败时联系 Hands 运维核对服务端的授权失败记录，无需发送回调链接、令牌或密钥 |
| 未获得离线授权或发布权限 | 重新连接，在 Google 授权页面同意请求的权限；仍失败时检查该 Google 账号的第三方应用策略 |
| 授权链接已过期或已使用 | 从应用 Integrations 重新点击 Connect |
| 过几天连接失效 | 检查测试模式的令牌有效期，以及是否撤销了 Google 授权；重新连接 |
| 有服务账号权限但真人授权仍失败 | 给授权时使用的真人 Google 账号授予对应的 Play 应用权限 |

## 停用、解除绑定与撤销授权

**停用**会阻止该应用通过此绑定执行 Play 发布，并保留加密凭据供重新验证和启用。

**解除绑定**会删除 Hands 为该应用保存的加密凭据和未完成授权。它不会自动撤销 Google 对整个 OAuth 客户端的授权。

若也要撤销 Google 的授权，打开 [Google 账号的第三方连接](https://myaccount.google.com/connections)，找到对应应用并移除。这个操作可能同时影响使用同一 Google 账号和 OAuth 客户端的其他 Hands 应用，操作前确认范围。

### 自动读取轨道 API

应用管理员可调用 `POST /api/apps/:appId/google-play-binding/tracks`，JSON body 为 `{"package_name":"com.example.app"}`。使用已有 Hands 会话鉴权，服务端复用该应用已保存的 Google 授权，返回 `package_name` 与真实轨道 ID 的 `tracks` 数组。读取不保存配置或发布版本；服务端创建临时 Play edit，读取后删除。尚未配置包名的连接也可以调用。

当前流程从 Hands 的构建与渠道选择包名，再验证对应的 Play 应用；并不声称列出了 Google 账号下全部应用。只有没有已知包名时才需补充包名。Google 的 [tracks.list](https://developers.google.com/android-publisher/api-ref/rest/v3/edits.tracks/list) 需要包名与临时 edit ID。
