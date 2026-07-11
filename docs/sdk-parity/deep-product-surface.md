# Sentry 产品面深度对比：告警 / 集成 / 仪表盘 / 配额 / 反馈 / AI

对 Sentry 2025–26 产品面(以 docs.sentry.io 为准逐项核实,2026-07-09)与
Hands 服务端现状的逐域对比。SDK 层对比见 [README.md](README.md) 及各平台
文件;本文只覆盖**服务端产品面**:告警、集成、仪表盘/查询、配额、用户反馈、
AI 能力。

评级:**关键**(不做会流失核心场景)/ **重要**(明显差距,应排期)/
**可后置**(有价值但不紧急)/ **不追**(与我们的模型不符,或我们的路线更优)。

**总立场**:Sentry 的告警/集成体系本质是"把信号推给人,再让人去各个工具里
操作"。Hands 的差异化是 **agent-native**:信号直接进到 AI agent 的工作环境
(CLI/API,Raft 聊天即席),由 agent 完成分诊甚至修复。所以很多领域
我们不该抄 Sentry 的"人肉 UI",而是补齐**信号生成层**(规则、阈值、聚合),
把"消费层"留给 agent。

---

## 1. 告警(Alerting)

### Sentry 机制

Sentry 2025 年底把告警重构为 **Alerts + Monitors** 双层模型
(<https://docs.sentry.io/product/alerts/>,
<https://docs.sentry.io/product/monitors-and-alerts/monitors/>):

- **Alerts(原 issue alerts)**——基于 issue 状态的规则引擎:
  - **触发器(when)**:全部基于 issue 状态变化——新 issue 创建、被指派、
    升级(escalates)、resolved→unresolved 回归等;多触发器为 ANY 逻辑。
  - **过滤器(if)**:severity、指派团队、来源项目/monitor 等,支持
    ANY/ALL 分组。
  - **动作(then)**:聊天通知(Slack/Teams/Discord)、邮件、on-call
    (PagerDuty/Opsgenie)、建单(Jira/Azure DevOps/Linear)、webhook、
    自定义集成。经典配置里还有"动作频率上限"(同一 issue 最多每 N 分钟
    执行一次动作),这是防噪的核心旋钮。
  - 规则按项目配置,可限定 environment,默认跨全部环境。
- **Monitors(原 metric alerts + crons + uptime)**——周期评估数据流并
  **生成 issue**(再由 Alerts 层通知):
  - **Metric Monitors**:对 errors、spans、logs、releases、应用指标设阈值
    (如 crash rate > 1%),可配检查间隔、优先级、auto-resolve、按
    ownership 规则自动指派。
  - **检测方式三种**:固定阈值、百分比变化(相对历史基线)、
    **动态/异常检测**——用 Matrix Profile + Prophet 两个开源算法学习
    季节性(昼夜/工作日)与长期趋势,阈值由 Sentry 托管不可手调,只暴露
    低/中/高三档"响应度";仅 Business/Enterprise/Trial 可用
    (<https://blog.sentry.io/anomaly-alerts-open-beta-smarter-monitoring-fewer-false-alarms/>)。
  - **Cron Monitors**(check-in 宽限、最大时长、失败容忍)与
    **Uptime Monitors**(HTTP 探测)。
  - 内置默认 monitor(Issue Stream / Error Monitor)开箱即用。
- 注意:计费侧的 **spike protection 不是告警功能**,是配额保护(见 §4);
  但"事件量异常上涨"这个用户诉求,Sentry 靠 anomaly-detection monitor 覆盖。

### Hands 现状

- 只有 **webhooks**:`crash:new_group`、`crash:spike` 两个事件类型 +
  投递记录/清理(reaping)管理端。没有规则 UI、没有 environment/严重度
  过滤、没有频率上限旋钮、没有指标阈值(crash-free rate 目前因 SDK 无
  session 采集而算不出,见 README)。
- `crash:spike` 说明我们已有最朴素的量突增检测,但无基线学习、无季节性。

### 差距:**关键**(信号生成层)/ **可后置**(规则 UI)

- **关键**的是"可配置的信号生成":哪怕消费端全是 agent,agent 也需要
  服务端先产出**语义化事件**——新组、回归(resolved→unresolved)、量级
  升级、阈值越界。这层不做,agent 只能轮询原始数据自己算,浪费且不实时。
  最小集:① 回归检测(resolve 后再现即触发,Sentry 触发器里最有价值的
  一个);② 阈值规则(表驱动即可:指标 + 窗口 + 阈值 → webhook);
  ③ 每规则频率上限(防噪,Sentry 经验证明这是必需品)。
- **可后置**:告警规则的图形化 UI。我们的消费者是 agent 和 CLI 用户,
  规则用 CLI/API/配置文件表达反而更顺(版本可控、可 review),这正是
  agent-native 优于 Sentry 表单式规则编辑器的地方。
- **可后置**:Prophet 级异常检测。自托管、单租户、数据量小,先做
  "7 天同时段均值 × 系数"的轻量基线即可覆盖 80% 场景;Sentry 也是先有
  固定阈值多年后才补异常检测。
- **不追**:Uptime/Cron monitors——不是崩溃平台的本职,Raft 生态另有位置。

---

## 2. 集成(Integrations)

### Sentry 机制

- **聊天(notify + act)**(<https://docs.sentry.io/organization/integrations/notification-incidents/slack/>):
  Slack 通知卡片上可直接 **Resolve / Archive / Assign**,`/sentry link`
  绑定个人账号收工作流通知,团队频道订阅,metric issue 带历史图表并在
  thread 里更新状态,链接自动 unfurl;2025–26 新增 **@sentry 唤起 Seer
  Agent 在 Slack 里直接调试**、Seer 开启时可从 Slack 触发"Fix"。
  Discord/Teams 同类但略弱。
- **issue 同步**(<https://docs.sentry.io/organization/integrations/issue-tracking/>):
  Jira/Linear/GitHub/GitLab/Azure DevOps/Bitbucket + 十余家小厂;以
  GitHub/Jira 为例是**双向同步**:指派、评论、状态(对端关单 → Sentry
  resolve),支持用户映射;可手动关联或由告警动作自动建单。
- **on-call**:PagerDuty/Opsgenie 作为告警动作,分级(critical/warning)
  路由。
- **VCS(GitHub 为例)**(<https://docs.sentry.io/organization/integrations/source-code-mgmt/github/>):
  - **commit 追踪 → suspect commits**:分析 stack trace 中文件的最近改动,
    commit 作者自动成为建议指派人;
  - commit/PR message 写 `fixes <SHORT-ID>`,随 release 发布即自动 resolve;
  - **stack trace linking**:code mapping 把栈帧文件链到仓库对应行
    (出错时的精确版本或默认分支);
  - **CODEOWNERS 导入**自动指派与路由(Business+);
  - **PR comments**:Sentry 主动在 PR 上评论——疑似引入 issue 的已合并
    PR、以及开放 PR 所触碰文件上的未解决 issue。

### Hands 现状

- 无任何 chat-ops 集成;无 issue tracker 同步;无 VCS 集成(无 commit
  追踪、无 suspect commit、无栈帧链接)。
- 但:**Raft 聊天平台是我们的原生栖息地**。Sentry 花大力气把自己
  "嵌进" Slack;我们的 agent 本来就活在 Raft 对话里,通过 CLI/API 直接
  读写 crash 组和 feedback 工单——"在聊天里 resolve" 对我们不是集成,
  是本体。

### 差距:**关键**(Raft 集成 + suspect commit)/ **重要**(issue 同步)

- **关键:Raft 原生集成**。把 webhook 事件接入 Raft 频道(新组/回归/
  尖峰卡片,附 agent 可执行的动作清单),等价于 Sentry 的 Slack 集成但
  **更进一步**:Sentry 在 Slack 里只有固定按钮 + 刚起步的 Seer Agent,
  我们频道里坐着的是全功能 agent,能查符号化栈、翻设备分布、改状态、
  开工单、甚至提修复 PR——这是我们**领先而非追赶**的一域,应最优先做实。
  (参照 raft-agent-manifest 的 actions[] 模式暴露可调用动作。)
- **关键:suspect commit(轻量版)**。这是 Sentry VCS 集成里对分诊增益
  最大的一项,而且对 agent 消费尤其有价值:agent 拿到"疑似引入提交 +
  作者"后可以直接去读 diff。最小实现:上传 release 时带 commit SHA
  (CLI 已在发布链路上,顺手),服务端对栈帧文件做 `git log` 归因。
- **重要:GitHub/Gitea issue 单向建单 + 状态回写**(从 crash 组/feedback
  工单建 issue,对端关闭时回写)。双向评论同步可后置。
- **重要:stack trace → 仓库行链接**(release 带 SHA 后近乎免费,agent
  与人都受益)。
- **可后置**:PR comments(需要 GitHub App 常驻,收益在团队规模大时才
  显现);CODEOWNERS 自动指派。
- **不追**:PagerDuty/Opsgenie、Slack/Teams/Discord 官方集成矩阵。webhook
  已是通用逃生门,on-call 编排交给下游;我们的重心是 Raft。

---

## 3. 仪表盘 / Discover 查询

### Sentry 机制

- **Discover**(<https://docs.sentry.io/product/explore/discover-queries/>):
  跨项目的事件查询引擎——自选列 + 聚合、搜索语法、图表/表格/tag 汇总,
  预置查询(All Events / Errors by Title / Errors by URL),**保存查询**
  为组织级、可分享 URL、可嵌入 dashboard;正逐步被新的 Explore/Trace
  Explorer 取代。issue 流另有**saved searches**。
- **Dashboards**(<https://docs.sentry.io/product/dashboards/>):
  widget 化(表格/时序图/大数字),可画错误、性能、Web Vitals、session
  健康;全局过滤(项目/环境/时间/release);预置模板(前端/后端/移动/AI)
  + 自定义;2025–26 起支持**自然语言 AI 生成 dashboard**、编辑历史与回滚;
  widget 可下钻回 Discover/Issues。

### Hands 现状

- 管理端有**设备/版本分析仪表盘**(固定视图),无自定义查询、无保存
  搜索、无 widget 化 dashboard。
- 但 agent 通过 CLI/API 可以拿到原始数据自行聚合——Sentry 用户要靠
  Discover UI 回答的问题("这个错误集中在哪个版本/机型?"),我们的
  用户直接**问 agent**,agent 现查现答并给出解释。

### 差距:**重要**(查询 API)/ **不追**(dashboard builder)

- **重要:结构化查询/聚合 API**。agent 替代的是 Discover 的 *UI*,替代
  不了 *查询引擎*——目前 agent 只能拉列表自己数,数据量一大就不可行。
  需要一个 `group by X, filter Y, count/uniq over 时间窗` 的服务端聚合
  端点(D1 上做物化或直接 SQL)。这同时是未来一切告警阈值、分析视图的
  地基。**Sentry 的 AI 生成 dashboard 恰好佐证了我们的判断:连 Sentry
  都承认自然语言才是查询的正确入口——而我们全平台本来就是这个入口。**
- **可后置**:保存查询(agent 侧记在 memory/脚本里即可;等有 Web 端
  多人共享需求再做服务端保存)。
- **不追**:widget/dashboard builder、拖拽编辑器。固定管理端视图 +
  agent 即席查询覆盖需求;做 builder 是给自己造 Sentry 的包袱。

---

## 4. 配额 / 尖峰保护 / 保留期

### Sentry 机制

- **配额**(<https://docs.sentry.io/pricing/quotas/>):按类别计量
  (errors/spans/replays/logs/attachments),预留量 + **pay-as-you-go
  预算**;管理手段分层:spike protection → 配额调整 → rate limit /
  inbound filter → SDK 采样(`beforeSend`、sample rate)。
- **Spike protection**(<https://docs.sentry.io/pricing/quotas/spike-protection/>):
  动态算法按项目建阈值——取"配额推导的最小事件数"与"过去 168 小时
  加权投影(含日/时季节性)"中较高者,尖峰期间每小时重算;触发后对
  项目动态限流丢弃事件,24–48h 衰减回落;通知默认关闭,可发
  email/Slack/PagerDuty。
- **Per-key rate limit**(<https://docs.sentry.io/pricing/quotas/manage-event-stream-guide/>):
  每项目多把 DSN key,各配独立限流(分/时/天粒度),超限回 429 +
  `Retry-After`,客户端应丢弃不重试;Business+ 才有。
- **Inbound filters**:限流与计量之前的服务端过滤(浏览器扩展、
  localhost、老浏览器、爬虫;IP/release/错误消息过滤要 Business+)。
- **保留期**(<https://docs.sentry.io/security-legal-pii/security/data-retention-periods/>):
  事件 **90 天**(免费计划 30 天),到期删除事件,组内事件全删则 issue
  一并删除;附件 30/90 天,debug 文件 90 天 TTI。**90 天是硬顶,不可
  付费延长**——这是用户对 Sentry 的长期抱怨点。

### Hands 现状

- 自托管、自有基础设施,**无配额、无计费**;保留期无上限(D1/R2)。
- 无 ingest 侧限流、无 inbound filter;`crash:spike` webhook 提供告知
  但不限流。

### 差距:**重要**(ingest 自保护)/ **不追**(计费配额)

- **不追**:计费配额、pay-as-you-go、spike protection 的"省钱"语义——
  那是 SaaS 多租户计费的产物,与自托管模型无关。
- **重要:ingest 自保护限流**。动机不同但机制要有:一个 SDK bug 或
  崩溃风暴可以打爆 D1/Workers 或刷满 R2。最小集:每 app(或每 key)
  的滑动窗口限流 + 429,以及服务端丢弃计数(可观测被丢了多少)。
  Sentry 的经验(429 + 不重试、限流在计量之前)可直接抄。
- **可后置**:inbound filter(按版本/消息/设备过滤噪声源)——量大后
  再做;分级存储/归档(热 D1 冷 R2)——真到规模再说。
- **领先项**:**保留期无限**是我们相对 Sentry 90 天硬顶的直接卖点,
  文档和营销里应明说。

---

## 5. 用户反馈(User Feedback)

### Sentry 机制

(<https://docs.sentry.io/product/user-feedback/>)

- **常驻 widget**:网页任意处嵌入,收文字 + 截图 + email,自动关联
  session replay(前 60 秒)与页面 URL。
- **Crash-report modal**:报错后自动弹出,反馈**直接挂在错误事件上**,
  面板里可预览并跳转对应 issue。
- 反馈可一键建/关联外部 issue(GitHub/Jira,自动填标题描述)。
- **AI 汇总**:归纳共性情绪、自动打分类标签供过滤。
- **ML 反垃圾**:疑似 spam 移入单独文件夹并抑制其告警。
- 可对新反馈配告警(通知或自动建单)。

### Hands 现状

- 反馈工单是**一等公民**且强于 Sentry:状态流转、指派、评论、≤200 MB
  附件(截图/日志),CLI/agent 直接分诊——Sentry 的 feedback 只是挂在
  issue 侧的轻量列表,没有工单生命周期。README 已将其列为护城河。
- 缺:反馈与 crash 组的**自动关联**(crash 后引导提交、提交时带上
  最近 crash/事件 ID);无 AI 汇总/去重;无反垃圾(自托管场景暂不痛)。

### 差距:**重要**(crash↔feedback 关联)/ **可后置**(其余)

- **重要:crash-linked feedback**。Sentry 这招把"用户说的"和"机器
  看到的"接在一起,是 crash 分诊质量的倍增器。我们 SDK 已同时有 crash
  与 feedback 两条通道,补一个"crash 后提示反馈 + 工单携带 crash 组
  引用"的闭环成本低、收益高;工单 ↔ crash 组的双向引用也让 agent 分诊
  时能一次拿全上下文。
- **可后置**:AI 汇总/自动分类——我们的 agent 分诊本来就在做这件事,
  且是即席、带追问的,比 Sentry 的静态标签强;只在工单量大到 agent
  逐条看不过来时,才值得做服务端预聚合。
- **不追**:ML 反垃圾(自托管 + 实名分发渠道,垃圾反馈不是威胁模型)。

---

## 6. Seer / AI 能力(2025–26 现状)

### Sentry 机制

(<https://docs.sentry.io/product/ai-in-sentry/seer/>)

- **Autofix + 根因分析**:issue 进入时自动判断可否分析,结合代码上下文
  与遥测在 issue 页给出初步判断;可继续生成修复 PR/MR(GitHub/GitLab
  云版),支持自然语言补充上下文。
- **外部 coding agent 委托**:Seer 做完根因与方案后,可把落地实现交给
  Claude Code、Cursor Cloud Agents、GitHub Copilot。
- **Seer Agent(open beta)**:跨错误/span/日志/trace/代码的交互式问答,
  可在 Slack 里 @sentry 唤起,对话线程可分享。
- **AI Code Review**:在 PR 上预测缺陷。
- issue summaries、AI 生成 dashboard、feedback AI 汇总散布各产品面。
- 商业化:付费 add-on,按"活跃贡献者"计费(当月在启用项目建 ≥2 个
  PR 即计费);默认不用客户数据训练模型。

### Hands 现状

- 平台自身无内置 AI,但**架构即 AI**:agent 经 CLI/API 对 crash 组、
  符号化栈、设备/版本分布、feedback 工单有全量读写权,在 Raft
  里即席完成 Seer 的全部用例(总结、根因、修复 PR、问答)——且用户
  自带模型和 agent,无 add-on 计费、无数据出域。

### 差距:**不追**(内置 AI)/ **关键**(把 agent 通路做顺)

- **不追**:自研 Seer 式内置 AI。Sentry 的方向恰恰在向我们收敛——
  Seer 最新的卖点是"委托给 Claude Code 等外部 agent"和"在 Slack 里
  对话",即承认**通用 agent 是终局形态**。Sentry 是从封闭产品向 agent
  开口子;我们生来就是开的。复制 Seer 等于放弃身位。
- **关键**(承接 §1–3):让 agent 用得顺的三块地基——语义化事件推送
  (告警信号直达 Raft)、聚合查询 API(不用拉全量)、suspect commit /
  栈-仓库链接(根因分析的原料)。Seer 强是因为 Sentry 给它喂了这些
  结构化输入;我们要喂给用户自己的 agent。
- **可后置**:文档层面的 agent 引导(MCP 清单 / actions[] 声明已有
  方向,见 raft-agent-manifest 备忘)。

---

## 结论:优先借鉴 Top-5

1. **回归检测 + 阈值规则引擎(§1,关键)**——resolved→unresolved 触发、
   表驱动指标阈值、每规则频率上限;这是所有下游信号的源头。
2. **Raft 原生告警卡片 + 可执行动作(§2,关键)**——对标并超越 Sentry
   Slack 集成:事件卡片进频道,全功能 agent 就地分诊;我们唯一该
   "重仓"的集成。
3. **Suspect commit + 栈帧→仓库行链接(§2,关键)**——release 携带
   commit SHA,服务端做栈帧文件归因;对 agent 根因分析是杠杆最大的
   单项输入。
4. **聚合查询 API(§3,重要)**——group/filter/count 的服务端聚合端点,
   替代 Discover 引擎(不抄其 UI),兼作告警阈值与分析视图的地基。
5. **Crash-linked feedback + ingest 自保护限流(§5/§4,重要)**——
   crash 组 ↔ 反馈工单互相引用;per-app 滑动窗口限流 + 429 防崩溃风暴
   打爆自有基础设施。

不追清单(明确止损):dashboard builder、PagerDuty/Teams/Discord 集成
矩阵、计费配额与 spike protection、ML 反垃圾、内置 Seer 式 AI、
Uptime/Cron monitors。

*来源:docs.sentry.io(alerts、monitors-and-alerts/monitors、
organization/integrations/{notification-incidents/slack, issue-tracking,
source-code-mgmt/github}、product/{dashboards, explore/discover-queries,
user-feedback, ai-in-sentry/seer}、pricing/quotas{,/spike-protection,
/manage-event-stream-guide}、security-legal-pii/security/data-retention-periods)、
blog.sentry.io(anomaly alerts open beta),核实日期 2026-07-09。*
