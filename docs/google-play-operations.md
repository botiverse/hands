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

### 先上传、后送审（changes_not_sent_for_review + send-for-review）

适用场景：同一应用已有另一个版本（例如正式轨道的 1.16.1）正在 Google 审核中，此时普通 promote 在 `stage=commit_edit` 被 Google 拒绝（回执 `play_api_error`，`cause.provider_cause` 多为 `EDIT_IN_REVIEW`，也可能因 Google 文案无法识别而是 `reason=unspecified`）。Hands 所有 `edits.commit` 都带 `changesInReviewBehavior=ERROR_IF_IN_REVIEW`，**从不使用 Google 的默认值 CANCEL_IN_REVIEW_AND_SUBMIT**，因此 Hands 永远不会取消别人（或自己上一个版本）正在进行的审核；被拒就是被拒，不重试、不换参数。需要提前把新版本放到 Play 上时，分两步：

1. **上传但不送审**：promote 请求体加 `changes_not_sent_for_review:true`（CLI：`hands releases play-promote <app> <release> --track production --rollout-percent 100 --note ... --changes-not-sent-for-review`）。promote 的全部 edit 都以 `changesInReviewBehavior=ERROR_IF_IN_REVIEW&changesNotSentForReview=true` 提交：新 bundle 路径的 release edit；bundle 已在 Play 时，先提交的 symbols/mapping 单独 edit（`existing_bundle`）与随后的 release edit **都**带该参数——单独 edit 若不带，会把全部待送审更改送审，与请求相反，且在另一版本审核中时同样会被 ERROR_IF_IN_REVIEW 拒绝。bundle、轨道 release、release notes、deobfuscation 文件都保存在 Play，但不送审。门禁、锁、读回校验与普通 promote 完全相同。
   - 回执（`kind:"play-promotion"`, `action:"promote"`）新增 `review`：`{requested:false, changes_not_sent_for_review:true}`；adapter 未回显该标记（旧 adapter 会忽略该参数并**按送审方式**提交）时记为 `{requested:null, changes_not_sent_for_review:true, reason:"not_acknowledged"}`，即"可能已送审"，回执不会假装没送审。不带该参数的 promote 请求、发往 Google 的请求与响应都不变，回执只多出 `review:{requested:true, changes_not_sent_for_review:false}`。
   - 即使带了该参数，Google 仍可能回答"另有更改在审核"。此时返回 409 `code:"edit_in_review"`、`failure_code:"play_edit_in_review"`，写 failed-closed 回执（含 `cause.provider_cause:"EDIT_IN_REVIEW"`），不重试、不改变行为；只能等审核结束。Google 回答无法识别时返回 502 `code:"edit_state_unknown"`（`play_edit_state_unknown`，附 `cause.tried`），不算成功。这一分类只用于带该参数的 promote；普通 promote 的错误码保持原样。
   - 读回：提交后 Hands 照常新开 edit 读取轨道核对版本、状态与比例。这依赖"新 edit 能看到已提交但未送审的更改"（store listing 的 `changes_not_sent_for_review` 读回同样依赖这一点）。若 Google 不是这样，提交已成功但回执为 `play_readback_mismatch`，请到 Play Console 核对，勿直接重跑。
2. **送审**：前一个审核结束后，调用 `POST /api/apps/:appId/releases/:releaseId/distributions/play/send-for-review`，body `{track, expected_revision, approval:{note}}`（CLI：`hands releases play-send-for-review <app> <release> [--track production] --note ... [--json]`，`--track` 默认 production）。
   - 门禁：已认证真人或 agent 且具 publisher 权限；expected_revision CAS（成功调用 adapter 前 revision +1，与 promote 相同）；AAB 已封存且最新验收通过；该 release 的 versionCode 必须已经由 Hands promote 到所请求的轨道（`play_distribution_state`，否则 400 `failure_code:"not_promoted_to_track"`，不调用 Play）；无 live hold；绑定已验证、启用且包名一致。
   - 锁：与 promote 共用 `play_edit_locks`（插入时检查 `play_store_listing_locks` 不存在），即每个包同一时刻只有一个 Hands Play edit；store listing push 进行中时返回 409 `edit_conflict`。
   - adapter：先读一次 `tracks.releases.list` 记录该 versionCode 的生命周期状态（只作证据，失败记 null）→ 开 edit → `edits.bundles.list` 确认 Play 持有该 versionCode 且 sha256 等于验收的 AAB（没有则 409 `play_bundle_not_on_play`，字节不同则 `aab_integrity_mismatch`）→ 读所请求的轨道，确认有 release 含该 versionCode（否则 409 `play_release_not_on_track`）→ **不写入任何更改**，以 `changesInReviewBehavior=ERROR_IF_IN_REVIEW`、**不带** `changesNotSentForReview` 提交 → 再读一次生命周期。提交前任一步失败都会删除 edit；Google 拒绝提交时也删除 edit（ERROR_IF_IN_REVIEW 不使 edit 失效）；提交无应答返回 `play_commit_ambiguous`（502 `edit_state_unknown`），不删 edit。
   - 错误：另有更改在审核 → 409 `edit_in_review`/`play_edit_in_review`；Google 要求在 Play Console 手动送审 → 409 `edit_in_review`/`play_changes_not_sent_for_review`；无法识别或无应答 → 502 `edit_state_unknown`。每次到达 adapter 都写不可变回执。
   - 回执：`release_receipts.kind` 有 CHECK 约束（只允许 `acceptance`、`play-promotion`），为免迁移，复用 `kind:"play-promotion"`，以 `action:"send-for-review"` 区分。成功回执含 `review:{requested:true, changes_not_sent_for_review:false, changes_in_review_behavior:"ERROR_IF_IN_REVIEW", lifecycle_before, lifecycle_after}`、`play.track_release:{status, user_fraction}`（提交前 edit 中该 release 的状态）与 `play.api_readback`（包名、versionCode、轨道，`sha256_match:true` 来自 bundles.list 的摘要比对）。`play_distribution_state` 不变。
   - 通知：这两种非默认操作仍产生 `google_play:submission_succeeded/failed`，payload 额外带 `action`（`promote` / `send-for-review`）与 `review_requested`（`false` / `true`，未确认时 `null`）；普通 promote 的通知 payload 不变。生命周期变化（如 NOT_SENT_FOR_REVIEW → IN_REVIEW）另由 `google_play:release_state_changed` 轮询反映。

**不确定之处（按 Google 文档如实记录，未实测）**：

- Google 文档：`changesNotSentForReview` 表示"本 edit 的更改不会被审核，直到在 Play Console 中显式送审"，并与其他未送审的更改合并；`ERROR_IF_IN_REVIEW` 表示"有更改在审核时返回错误，edit 不提交且保持有效"。文档**没有**说明两者同时使用、且另有更改在审核时是否仍报错。Hands 的处理：照常提交，若 Google 仍报审核中，就按上文返回 `play_edit_in_review` 并写回执，不改用 CANCEL_IN_REVIEW_AND_SUBMIT、不循环重试。
- Google **没有**"送审"API。文档只说未送审的更改要在 Play Console 中送审；"再提交一个不带 `changesNotSentForReview` 的 edit 会把之前保存的未送审更改一并送审"是常见做法，但未见 Google 明文保证；空 edit 的提交是否被接受、是否触发送审同样无文档。因此 send-for-review 不把"提交成功"等同于"已进入审核"：回执记录提交前后的 `lifecycle_before/after`（例如 `RELEASE_LIFECYCLE_STATE_NOT_SENT_FOR_REVIEW` → `RELEASE_LIFECYCLE_STATE_IN_REVIEW`）。若 `lifecycle_after` 仍是 NOT_SENT_FOR_REVIEW（或为 null），请到 Play Console「发布概览」手动送审。
- Google 回答"需在 Play Console 手动送审"（`play_changes_not_sent_for_review`）时，只能在 Play Console 送审。
- 部署顺序：Play adapter（新增 `sendForReview`，promote 接受 `changesNotSentForReview`）→ Worker → CLI。无需迁移。若 Worker 先于 adapter 上线：带该参数的 promote 会被旧 adapter 忽略参数并送审（回执 `reason:"not_acknowledged"`），send-for-review 会以 `play_api_error` 失败并写回执。

### 给已在 Play 上的版本补传 mapping / native symbols（upload-symbols）

适用场景：某个 versionCode 已经在 Play 上（例如已上线正式轨道），但它的 R8/ProGuard `mapping.txt` 或 native debug symbols 当时没有传到 Play（例如事后才用 `hands builds attach-symbols` 封存到该 build）。promote 要求 versionCode **大于**轨道最大值，所以不能用来补传；这个接口专门做这件事，**不改动任何轨道、rollout、bundle 或 release notes**，`play_distribution_state` 也不变。

- 接口：`POST /api/apps/:appId/releases/:releaseId/distributions/play/upload-symbols`，body `{mode?: "dry_run" | "commit", kinds?: ["proguard" | "nativeCode"], expected_revision, approval:{note}}`。`mode` 默认 `dry_run`；`kinds` 默认是该 release 的 build 上所有已封存的 deobfuscation 文件（mapping = `proguard`，native symbols zip = `nativeCode`）。
- CLI：`hands releases play-upload-symbols <app> <release> [--kinds proguard,nativeCode] --note ... [--commit] [--json]`。**默认是 dry run**：只开 Play edit、确认该 versionCode 在 Play 上、再删除 edit，打印计划并说明什么都没写；加 `--commit` 才真正上传。CLI 自己读取 release 当前 revision 作为 `expected_revision`。
- 门禁（同 send-for-review）：已认证真人或 agent 且具 publisher 权限（**deploy token 一律拒绝**，403）；expected_revision CAS；approval note 必填；AAB 已封存（其 sha256 就是 Play 上该 versionCode 必须持有的 bundle）；所请求的文件都已封存且不超过 Google 上限 2,097,152,000 字节（`mapping_not_sealed` / `symbols_not_sealed` / `mapping_too_large` / `symbols_too_large`）；build 上没有可上传文件，或 `kinds` 指定了不存在的类型 → 400 `gate_failed`、`failure_code:"no_symbols"`；无 live hold；绑定已验证、启用且包名一致；与 promote / store listing 共用包级 Play edit 锁。**不检查** versionCode 与轨道最大值的关系，因此任何已在 Play 上的 versionCode 都可以补传。
- adapter：`edits.insert` → `edits.bundles.list` 确认 Play 持有该 versionCode 且 sha256 等于 release 的 AAB（没有 → 409 `gate_failed`/`version_not_on_play`；字节不同 → `aab_integrity_mismatch`）→ dry run 到此 `edits.delete` 返回 → commit 时按 `nativeCode`、`proguard` 顺序 `edits.deobfuscationfiles.upload`（`apkVersionCode`=该 versionCode），adapter 逐字节核对 sha256 和大小 → `edits.commit`（`changesInReviewBehavior=ERROR_IF_IN_REVIEW`，**不带** `changesNotSentForReview`）。**任一步失败都会删除 edit**（提交无应答时也尝试删除：若提交其实已生效，Google 不允许删除已提交的 edit，删除无副作用），不会留下半提交或泄漏的 edit。
- dry run：不读 R2 文件内容（只 `head` 核对对象大小），不写回执，revision 不变。返回 `{mode:"dry_run", version_code, package_name, files:[{type, sha256, size_bytes}], version_on_play:true}`。
- commit：调用 adapter 前 revision +1（与 send-for-review 相同）；Worker 直接把 R2 流交给 adapter（不 tee、不在 Worker 里二次哈希，避免数百 MB 的 mapping 在 Worker 内存里缓冲；完整性由 adapter 在提交前核对）。成功回执复用 `kind:"play-promotion"`、`action:"upload-symbols"`、`track` 为空，含 `files:[{type, sha256, size_bytes, uploaded:true, provider_ack}]`、`play:{edit_id, play_version_code, version_on_play:true, track_changed:false, commit, provider_uploads}`；任何失败都写 failed-closed 回执。返回 `{mode:"commit", receipt_id, edit_id, version_code, files, revision}`。
- 错误：另有更改在审核 → 409 `edit_in_review`/`play_edit_in_review`（edit 已删除，稍后重跑）；提交无应答或无法识别 → 502 `edit_state_unknown`（`play_commit_ambiguous` / `play_edit_state_unknown`），先到 Play Console 的「App bundle 浏览器」核对；其他 Google 拒绝 → 502 `play_api_error`。
- 通知：仍产生 `google_play:submission_succeeded/failed`，payload 带 `action:"upload-symbols"`，成功时 `state_label` 为「符号文件已上传到 Google Play（未改动轨道）」，`track` 为 null。
- 可安全重跑：同一 versionCode 同一类型的文件再次上传会替换旧文件。

**不确定之处（未实测）**：Google 文档未说明只含 deobfuscation 文件的 edit 提交是否需要审核、在另一更改审核中时是否会被 `ERROR_IF_IN_REVIEW` 拒绝；若被拒，按上文 `edit_in_review` 处理，等审核结束后重跑。"重复上传替换同类型文件"来自 Google 对 deobfuscationfiles.upload 的描述，未在本仓库实测。

### 商店详情（store listing）文字与图片接口

`POST /api/apps/:appId/distributions/play/store-listing` 让具备应用 publisher 权限的真人或 agent 通过 Hands 修改 Play 商店详情文字，CLI 为 `hands store-listing push`（见公开 CLI 文档）。只开放白名单的 androidpublisher v3 端点：`edits.details.get`（读 defaultLanguage）、`edits.listings.list/update/delete`、`edits.validate`、`edits.commit`、`edits.delete`；不提供通用 path+body 代理，不触碰轨道、release 或 bundle。请求体 `listings[]` 的字段与 Google `Listing` 资源逐字一致（language、title、shortDescription、fullDescription、video，discovery revision 20261027）。

- **校验先于 Play 调用**：language 必须是 Play 商店详情语言（86 个标签，来源 Play Console 帮助 answer/9844778，大小写精确，例如 `iw-IL`、`es-419`，`zh-Hans` 会提示 `zh-CN`）；title ≤30、shortDescription ≤80、fullDescription ≤4000 个字符（answer/9859152，按 Unicode code point 计，全角半角相同），超限拒绝不截断。adapter 在自己的边界再查一遍形状与上限。
- **一次 push 一个 edit**：开 edit → 读 defaultLanguage 与现有 listings → 计划 diff → 对 create/update 写 `edits.listings.update`（PUT 合并后的完整资源：未提供的字段保留 Play 现值，Google 回应必须原样回显）→ `edits.validate`。`mode:"dry_run"` 随后删除 edit，什么都不改变；`mode:"commit"` 用 `changesInReviewBehavior=ERROR_IF_IN_REVIEW` 提交，再开新 edit 读回核对。全部相同时返回 `no_changes`，不提交。`mode` 必填，无默认值；CLI 默认 dry run，`--commit` 才提交。
- **审核中**：提交时若 Google 报已有更改在审核，返回 409 `code:"edit_in_review"`、`failure_code:"play_edit_in_review"`，未提交，edit 已删除（Google 说明 ERROR_IF_IN_REVIEW 不会使 edit 失效）。Hands 从不使用默认的 CANCEL_IN_REVIEW_AND_SUBMIT 去取消别人的审核。Google 要求手动送审时返回 `play_changes_not_sent_for_review`；显式传 `changes_not_sent_for_review:true` 会带 `changesNotSentForReview=true` 提交，之后需在 Play Console 送审。提交无应答（网络错误）返回 `play_commit_ambiguous`，不删除 edit，先到 Play Console 核对。
  - “审核中 / 需手动送审”的识别顺序：先看 Google 的结构化标识（`error.status`、`errors[].reason`、`details[].reason` 即 ErrorInfo，名称含 NOT_SENT_FOR_REVIEW / IN_REVIEW 即命中，与文案语言无关），再回退到英文文案匹配。两层都**先查 NOT_SENT_FOR_REVIEW（需手动送审）、后查 IN_REVIEW（另有更改在审核）**：前者措辞更具体，后者的模式较宽。**同一条消息两者都提到时（如 “Changes not sent for review because another edit is in review.”）按可行的处置判为 IN_REVIEW**：另有更改在审核时手动送审也会失败，能推进的只有等待。单独的 `REVIEW` 两者都不命中。此顺序同样适用于 promote 的错误分类。Google 未公开这两种情况的固定 reason，所以两层都只是尽力识别。
  - **识别不了就不算成功**：validate 或 commit 被拒且以上模式都不命中（例如德文文案、无结构化 reason），返回 502 `code:"edit_state_unknown"`、`failure_code:"play_edit_state_unknown"`，并写 failed-closed 回执；请到 Play Console 核对。commit 返回 2xx 但响应不是本 edit 的 AppEdit（id 不符、空对象、非 JSON）同样记为 `play_edit_state_unknown`（`provider_cause:"MALFORMED_RESPONSE"`），且不删除 edit。错误详情 `cause.tried` 按匹配顺序列出两层尝试过的模式，由实际正则生成并带层前缀，例如 `structured:/NOT_?SENT_?FOR_?REVIEW/i -> CHANGES_NOT_SENT_FOR_REVIEW`、`text:/in review|…/i -> EDIT_IN_REVIEW`，并附 Google 原文的 `message_sha256` 与 `message_length` 供与运维日志对照；Google 原文本身从不跨出 adapter，也不写入日志或回执。新的文案出现时，把对应模式加到 `play-adapter/src/provider_errors.ts` 即可。
- **删除语言**：默认不动文件外的语言；`delete_unlisted_languages:true` 才对其调用 `edits.listings.delete`，默认语言永不删除（`listing_default_language_delete`）。
- **锁与回执**：与 promote 共享“每个包同一时刻只有一个 Hands Play edit”（`play_store_listing_locks` 与 `play_edit_locks` 互相排斥，listing 锁 15 分钟后视为崩溃残留）。每次到达 adapter 的 push 都写入不可变的 `play_store_listing_receipts`（0084 迁移，禁止 UPDATE/DELETE）：操作者、时间、edit id、dry_run/commit、结果、每种语言的动作与变更字段，以及每个字段的 sha256 与字符数（不保存原文、不含凭据）。`GET .../store-listing/receipts` 读取。
- **图片（edits.images）**：同一个 POST 以 `multipart/form-data` 提交：`request` 部分为上述 JSON，另加 `images:[{language, imageType, images:[{part, sha256, aiGeneratedState?}]}]`，每张图一个文件部分。选择 multipart 而不是先传 R2 再流式转发：商店图片小（设计稿 51 张共 9.4 MB）、不需要在 Hands 长期保存（回执只记 sha256/尺寸），省去暂存、封存和清理生命周期；代价是单次 push 图片总量上限 24 MiB（Worker 内存与 RPC 消息大小），更大的集合用 `--locales` 分批。imageType 接受 Google 完整枚举（9 个），`appImageTypeUnspecified` 返回 `image_type_not_supported`。所有约束在打开 edit 前检查：每张 ≤15,728,640 字节（discovery mediaUpload.maxSize）；截图为 JPEG 或 24 位 PNG（无 alpha，含 tRNS 也拒绝），边长 320–3840 px、长边不超过短边 2 倍，每类最多 8 张，phone 至少 2 张；Wear 1:1 且 ≥384；featureGraphic 1024×500；icon 512×512 的 32 位 PNG 且 ≤1024 KB；tvBanner 1280×720（answer/9866151）。adapter 再核对 sha256、大小、数量与枚举；某语言没有 listing（且本次也不创建）时返回 `image_language_has_no_listing`。每个集合与 Play 报告的 sha256 序列完全相同才跳过，否则 `deleteall` 后按顺序 `upload`。fail-closed 的完整性检查只针对 Hands 自己的数据：声明的 sha256 必须等于上传的文件部分（Worker 与 adapter 各查一次，`image_integrity_mismatch`）。Google 返回的 `Image.sha256` 是否为上传字节的摘要并无文档，因此只作记录：回执每张图记 `sha256`（Hands 的）、`provider_sha256`（Google 的）与 `sha256_match: true|false|null`（null 为 Google 未返回摘要），不一致时列入 `image_warnings`（`provider_sha256_mismatch`），不会使 push 失败。commit 后新开 edit 读回，只以张数不符为失败（`play_image_readback_mismatch`），sha256 一致性同样只记录在 `readback`。`aiGeneratedState` 原样传给 upload。旧 adapter 不回 `image_changes` 时 Worker 以 `play_images_not_acknowledged` fail-closed。
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
