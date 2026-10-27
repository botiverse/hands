# Google Play integration operations and API runbook

Internal repository reference for Hands operators and release engineers. The public user guide is docs/public/google-play-oauth.md.

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

1. `POST /api/apps/:appId/android-release-artifacts` 声明同一构建的一份 AAB 和一份 APK，可选再加一份 native debug symbols zip（kind:"symbols"，filename 以 .zip 结尾，size_bytes 上限 2,097,152,000，即 Google deobfuscationFiles mediaUpload 上限）。请求包含 source（repository、commit_sha、ci_run_id）、package_name、version_name、version_code、upload_key_cert_sha256，以及 artifacts（kind、filename、size_bytes、sha256）。不带 symbols 的请求保持 v1 契约与响应逐字节不变；声明 symbols 后 schema 升为 v2。
2. 按响应中每项 `artifacts[].upload` 的 method、url、headers 上传文件，再调用 `POST /api/apps/:appId/android-release-artifacts/:buildId/assets/:assetId/complete` 校验并封存。`GET /api/apps/:appId/android-release-artifacts/:buildId` 返回的 bundle 应为 ready，全部已声明 artifacts（含 symbols）的 status 均应为 sealed；声明了 symbols 但未封存时 bundle 不会 ready，promote 会在 immutable_binding 门 fail-closed，不会静默跳过。
3. 为该 build 创建 release。完成真实验收后，调用 `POST /api/apps/:appId/releases/:releaseId/receipts/acceptance`，提交 AAB 的 artifact_id、verdict:pass、matrix_ref 与 expected_revision；验收结果必须对应这份已封存 AAB。成功写入验收会增加 release revision，下一步先重新读取。
4. 由已认证且具有应用 publisher 权限的真人或 agent 调用 `POST /api/apps/:appId/releases/:releaseId/distributions/play/promote`，body 包含 `track:"internal"`、最新 expected_revision 和 `approval:{"note":"验收和提交说明"}`。internal 使用绑定中配置的真实内部测试轨道；closed 才使用选择的封闭测试轨道，例如 alpha 或 beta。已封存的 symbols zip 会在同一个 Google edit 内、轨道更新之前自动上传到 `deobfuscationFiles/nativeCode`；上传失败则删除 edit、整体 fail-closed，不会半提交。成功回执包含 symbols 的 sha256/size；Google 对 deobfuscation 文件没有事后 GET，回执中的 provider 确认仅为 edit 内上传响应（post_commit_get:false）。
   - **R8/ProGuard mapping**：build 上已封存的 `proguard-mapping` 资产（`hands builds publish-android --mapping` 或 `hands builds attach-symbols <app> <build> mapping.txt`）会在同一 edit 内、native symbols 之后、轨道更新之前上传到 `deobfuscationFiles/proguard`（symbolType proguard），Google 必须回应 `symbolType=proguard`，否则 fail-closed（`play_mapping_malformed`）。mapping 按原样（未压缩的 mapping.txt）流式上传；上限沿用 Google discovery 文档的 mediaUpload.maxSize 2,097,152,000 字节，超限在 promote 前以 `mapping_too_large` 拒绝。存在但未封存的 mapping 以 `mapping_not_sealed` fail-closed。回执的 `mapping` 字段记录 sha256/size、`uploaded` 与 provider 确认；没有 mapping 时记为 `{present:false, reason:"no_mapping_asset"}`。
   - **release notes**：release 的 changelog 若为 JSON 语言对象，会作为新轨道 release 的 `releaseNotes` 提交。Hands key 通过显式表映射为 Play BCP-47 标签：zh/zh-cn/zh-hans→zh-CN，zh-tw/zh-hant→zh-TW，zh-hk→zh-HK，en/en-us→en-US，en-gb→en-GB，ja/ja-jp→ja-JP，ko/ko-kr→ko-KR。表外的 key（如 `fr`）不会阻止 promote：该语言不提交，原始 key 记入回执 `release_notes.skipped`；全部 key 都在表外时照常 promote、不带 notes（`sent:[]`）。两个 key 映射到同一 Play 语言时，文本相同则去重（保留第一个），文本不同属于数据歧义，以 `play_release_notes_locale_duplicate` 拒绝。Play 显示纯文本，提交前去掉 Markdown 加粗标记 `**`（保留 `- ` 列表和换行）；转换后每种语言超过 500 个字符（按 Unicode code point 计）以 `play_release_notes_too_long` 拒绝，绝不截断。以上错误都在 `release_notes` 门、任何 Play 调用之前返回 400（`failure_code` 给出具体原因），release revision 不变。changelog 为空或为纯文本（无语言）时照常 promote、不带 notes，回执 `release_notes` 记为 `{present:false, reason}`。changelog 为 JSON 语言对象时回执为 `{present:true, sent:[adapter 确认提交的 Play 标签], skipped:[表外原始 key], requested:[...], chars:{...}}`；adapter 未确认全部 requested 时附带 `reason:"not_acknowledged"`。
   - 同一 versionCode 再次 promote（如 internal → production）时 Google 已持有该 bundle，bundle 不会重传（回执 `play.bundle_uploaded:false`），但"bundle 已在 Play"不代表"mapping 已在 Play"（例如 bundle 在 Hands 支持 mapping 之前已推送）。Google 没有查询 deobfuscation 文件的 GET，无法先查后传，因此 native symbols 与 mapping **仍会上传**：在 bundle 查询所用的 edit 里单独上传并提交，之后再新建 edit 做轨道更新与提交。单独 edit 保证被拒的上传不会影响 release edit 的提交；放在 release 之前，是因为提交任一 edit 会使更早打开的 edit 失效，且 release 提交后再提交可能因自己刚提交的 release 处于审核中而触发 ERROR_IF_IN_REVIEW。此路径为 fail-soft：Google 拒绝上传或拒绝该 edit 的提交时，promote 照常完成，回执记录拒绝。新 bundle 路径保持 fail-closed（mapping/symbols 被拒则删除 edit、promote 失败）。两条路径上，字节与 Hands 封存身份不符都会 fail-closed。release notes 每次 promote 都会随新轨道 release 提交。
   - 回执 `symbols` / `mapping` 的状态：`{present:true, uploaded:true, provider_ack}`（Google 确认 symbolType）；`{present:true, uploaded:false, attempt:"rejected", stage, error_code, http_status, provider_reason, provider_cause}`（已尝试、Google 拒绝；`provider_reason` 为 Google 文档化的 reason 标识原样，`provider_cause` 为对 Google 文本的分类，Google 原文不入回执）；`{present:true, uploaded:false, attempt:"not_acknowledged"}`（adapter 未报告，如旧版 adapter）；`{present:false, uploaded:false, skipped_reason:"no_symbols_asset"|"no_mapping_asset"}`（没有该资产）。`edit` 为 `promotion`（随新 bundle 的 release edit）或 `existing_bundle`（单独 edit）。
   - 部署顺序：先部署 Play adapter，再部署 Hands Worker。旧 adapter 会忽略 mapping 与 notes，此时回执诚实记为 `not_acknowledged`。
5. 用 `GET /api/apps/:appId/releases/:releaseId/distributions/play` 及 `/receipts` 核对 Google 的包名、版本、轨道和摘要回执，再交给测试人员。读取轨道成功不等于版本上传成功。

提交要求候选 AAB 的 versionCode **大于目标轨道已有最大值，且不超过 2100000000**；空轨道不要求从 1 开始。准备签名候选前先核目标轨道的已有版本，避免产物做好后才发现冲突。完整请求结构见 [公开 API](../public-api-reference/) 和 [OpenAPI](https://hands.build/openapi.json)。

### 商店详情文字（store listing）接口

`POST /api/apps/:appId/distributions/play/store-listing` 让具备应用 publisher 权限的真人或 agent 通过 Hands 修改 Play 商店详情文字，CLI 为 `hands store-listing push`（见公开 CLI 文档）。只开放白名单的 androidpublisher v3 端点：`edits.details.get`（读 defaultLanguage）、`edits.listings.list/update/delete`、`edits.validate`、`edits.commit`、`edits.delete`；不提供通用 path+body 代理，不触碰轨道、release 或 bundle。请求体 `listings[]` 的字段与 Google `Listing` 资源逐字一致（language、title、shortDescription、fullDescription、video，discovery revision 20261027）。

- **校验先于 Play 调用**：language 必须是 Play 商店详情语言（86 个标签，来源 Play Console 帮助 answer/9844778，大小写精确，例如 `iw-IL`、`es-419`，`zh-Hans` 会提示 `zh-CN`）；title ≤30、shortDescription ≤80、fullDescription ≤4000 个字符（answer/9859152，按 Unicode code point 计，全角半角相同），超限拒绝不截断。adapter 在自己的边界再查一遍形状与上限。
- **一次 push 一个 edit**：开 edit → 读 defaultLanguage 与现有 listings → 计划 diff → 对 create/update 写 `edits.listings.update`（PUT 合并后的完整资源：未提供的字段保留 Play 现值，Google 回应必须原样回显）→ `edits.validate`。`mode:"dry_run"` 随后删除 edit，什么都不改变；`mode:"commit"` 用 `changesInReviewBehavior=ERROR_IF_IN_REVIEW` 提交，再开新 edit 读回核对。全部相同时返回 `no_changes`，不提交。`mode` 必填，无默认值；CLI 默认 dry run，`--commit` 才提交。
- **审核中**：提交时若 Google 报已有更改在审核，返回 409 `code:"edit_in_review"`、`failure_code:"play_edit_in_review"`，未提交，edit 已删除（Google 说明 ERROR_IF_IN_REVIEW 不会使 edit 失效）。Hands 从不使用默认的 CANCEL_IN_REVIEW_AND_SUBMIT 去取消别人的审核。Google 要求手动送审时返回 `play_changes_not_sent_for_review`；显式传 `changes_not_sent_for_review:true` 会带 `changesNotSentForReview=true` 提交，之后需在 Play Console 送审。提交无应答（网络错误）返回 `play_commit_ambiguous`，不删除 edit，先到 Play Console 核对。
  - “审核中 / 需手动送审”的识别顺序：先看 Google 的结构化标识（`error.status`、`errors[].reason`、`details[].reason` 即 ErrorInfo，名称含 NOT_SENT_FOR_REVIEW / IN_REVIEW 即命中，与文案语言无关），再回退到英文文案匹配。两层都**先查 NOT_SENT_FOR_REVIEW（需手动送审）、后查 IN_REVIEW（另有更改在审核）**：前者措辞更具体，后者的模式较宽。**同一条消息两者都提到时（如 “Changes not sent for review because another edit is in review.”）按可行的处置判为 IN_REVIEW**：另有更改在审核时手动送审也会失败，能推进的只有等待。单独的 `REVIEW` 两者都不命中。此顺序同样适用于 promote 的错误分类。Google 未公开这两种情况的固定 reason，所以两层都只是尽力识别。
  - **识别不了就不算成功**：validate 或 commit 被拒且以上模式都不命中（例如德文文案、无结构化 reason），返回 502 `code:"edit_state_unknown"`、`failure_code:"play_edit_state_unknown"`，并写 failed-closed 回执；请到 Play Console 核对。commit 返回 2xx 但响应不是本 edit 的 AppEdit（id 不符、空对象、非 JSON）同样记为 `play_edit_state_unknown`（`provider_cause:"MALFORMED_RESPONSE"`），且不删除 edit。错误详情 `cause.tried` 按匹配顺序列出两层尝试过的模式，由实际正则生成并带层前缀，例如 `structured:/NOT_?SENT_?FOR_?REVIEW/i -> CHANGES_NOT_SENT_FOR_REVIEW`、`text:/in review|…/i -> EDIT_IN_REVIEW`，并附 Google 原文的 `message_sha256` 与 `message_length` 供与运维日志对照；Google 原文本身从不跨出 adapter，也不写入日志或回执。新的文案出现时，把对应模式加到 `play-adapter/src/provider_errors.ts` 即可。
- **删除语言**：默认不动文件外的语言；`delete_unlisted_languages:true` 才对其调用 `edits.listings.delete`，默认语言永不删除（`listing_default_language_delete`）。
- **锁与回执**：与 promote 共享“每个包同一时刻只有一个 Hands Play edit”（`play_store_listing_locks` 与 `play_edit_locks` 互相排斥，listing 锁 15 分钟后视为崩溃残留）。每次到达 adapter 的 push 都写入不可变的 `play_store_listing_receipts`（0084 迁移，禁止 UPDATE/DELETE）：操作者、时间、edit id、dry_run/commit、结果、每种语言的动作与变更字段，以及每个字段的 sha256 与字符数（不保存原文、不含凭据）。`GET .../store-listing/receipts` 读取。
- **设计上可拆分**：adapter 内部的“计划/应用到给定 edit/validate/commit”是独立步骤，以后可增加“复用已有 edit id”的 API，而不改变本接口。
- **部署顺序（唯一依据，以此为准）：0084 迁移 → Play adapter → Worker → CLI。** 原因：新 Worker 中 promote 的加锁语句会读取 `play_store_listing_locks`，没有 0084 时 promote 会以 `no such table: play_store_listing_locks` 失败，因此迁移必须先于 Worker。
  1. 先应用 0084 迁移（只新增表）。必须在 Worker 之前：新 Worker 的 promote 加锁语句会读取 `play_store_listing_locks`，表不存在时 promote 会以 `no such table` 失败。迁移需按部署工作流提供 owner handshake。
  2. 再部署 Play adapter（新增 `readStoreListings` / `pushStoreListings`，旧 Worker 不调用它们）。
  3. 再部署 Worker。若 adapter 仍是旧版本，Worker 返回 `play_adapter_unavailable`，不会写任何东西到 Play。
  4. 最后发布 CLI（`hands store-listing`）。

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
