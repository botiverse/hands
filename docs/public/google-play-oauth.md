# 使用 Google 授权连接 Google Play

通过浏览器登录 Google，让 Hands 访问你有权限的 Google Play 应用。无需创建服务账号 JSON 密钥，禁止创建服务账号密钥的组织策略可以保持启用。

接入分为三步：创建 Google OAuth 客户端、由 Hands 运维配置客户端、在应用设置里完成授权。完成连接只代表权限验证成功，实际发布仍需签名产物、验收和发布审批。

## 1. 准备 Google Play 权限

准备一个真人 Google 账号，并在 Play Console 的「用户和权限」中为它授予目标应用的访问权限。至少应能查看应用信息并操作准备使用的测试轨道；正式发布需要对应的正式发布权限。

授权时登录的是这个真人账号。此前邀请的服务账号不会自动把权限转给它。

确认目标应用已在 Play Console 中建立，并记下 Android 包名，例如 com.example.app。Hands 中填写的包名必须完全一致。尚未建立应用或尚未完成 Play 初始设置时，先完成这些步骤。

## 2. 在 Google Cloud 启用 API

打开 Google Cloud Console，选择准备用于接入的项目。

进入「API 和服务 → 库」，搜索并启用 **Google Play Android Developer API**。无需关闭服务账号密钥创建限制。

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
2. 打开 Android 应用的 **Settings / 设置 → Google Play**。
3. 填写 Android 包名，以及内部测试、封闭测试和正式发布轨道名称。名称应与 Play 中的实际轨道一致；封闭测试轨道常有自定义名称。
4. 点击 **Authorize with Google / 使用 Google 授权**。
5. 登录第 1 步中拥有 Play 权限的 Google 账号，授予请求的权限。
6. 返回应用设置，确认显示该 Google 账号、正确包名和已验证的连接状态。
7. 点击 **Test connection / 测试连接**，确认连接仍可用。

授权链接十分钟内有效，回调只能使用一次。切换 Hands 账号、注销、权限被撤回，或授权途中更换、停用、解除绑定，都可能使这次授权失效；从应用设置重新发起即可。

连接测试会创建并删除临时 Play edit，检查包名及所配轨道的访问权限，不提交版本。

## 7. 发布前再检查产物

连接成功不会自动发布。Google Play 发布使用 AAB；这个 AAB 应带正确的上传签名，包名和 versionCode 必须符合目标应用要求。

Hands 中的上传校验通过，仅证明文件和所声明的摘要一致，不能代替 Google Play 的签名、应用初始设置或商店审核。先按现有流程完成产物验收和人工审批，再执行明确的发布操作。

## 常见问题

| 现象 | 检查或处理 |
| --- | --- |
| Google 报 redirect_uri_mismatch | 确认 Web 客户端登记的是完整回调地址，域名、路径和末尾斜杠都一致 |
| Google 拒绝访问或提示应用未验证 | 检查受众、测试用户名单、组织的第三方应用策略和 Google 授权页面要求 |
| 返回 Hands 后授权失败 | 检查真人 Google 账号的目标应用权限、包名及三条轨道名称，再重新授权 |
| 授权链接已过期或已使用 | 从应用设置重新点击「使用 Google 授权」 |
| 过几天连接失效 | 检查测试模式的令牌有效期，以及是否撤销了 Google 授权；重新连接 |
| 有服务账号权限但真人授权仍失败 | 给授权时使用的真人 Google 账号授予对应的 Play 应用权限 |

## 停用、解除绑定与撤销授权

**停用**会阻止该应用通过此绑定执行 Play 发布，并保留加密凭据供重新验证和启用。

**解除绑定**会删除 Hands 为该应用保存的加密凭据和未完成授权。它不会自动撤销 Google 对整个 OAuth 客户端的授权。

若也要撤销 Google 的授权，打开 [Google 账号的第三方连接](https://myaccount.google.com/connections)，找到对应应用并移除。这个操作可能同时影响使用同一 Google 账号和 OAuth 客户端的其他 Hands 应用，操作前确认范围。
