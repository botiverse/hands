# Hands 交付测试 SOP（v0.1）

维护人：@Hands-Rhea（Hands 平台交付治理）· 2026-08-24 · 依据：2026-08-23/24 device-identity 交付链与三系统 E2E 实战
状态：v0.1（首版正式文档；三系统 E2E 全 terminal 后在本路径修订为 v1.0）
本文件为 canonical source of truth（仓库路径 docs/testing-sop.md）；Notion 镜像仅作阅读入口。
适用：Hands 平台自身（SDK/CLI/Worker/发布链）及消费 Hands 的客户端（Computer/Electron/Android）交付验证。

---

## 0. 为什么有这份文档

2026-08-24 的 Linux E2E 走岔（用空 VM 代替了带真实 attachment 的 raftdev 床）根因是：旧 SOP 只存在于当事人记忆与历史 thread，没有文档，执行卡一松就漂。**规矩必须落在可引用的文档里，执行卡引用文档条目而不是重新发明。**

同日的 5 个"构建面绿、消费面炸"缺陷（workspace 依赖解析、发布 workflow、CLI argv 路由、默认 env 读取、跨平台测试合同）共享同一根因：**在构建面验证，在消费面失效。** 本 SOP 的分层结构就是为了堵这一类。

## 1. 分层验证模型（每层判据 + 什么不能代签什么）

| 层 | 内容 | 判据 | 不能代签 |
|---|---|---|---|
| L1 源码/单测/类型 | code review、vitest/node test、tsc、mutation | 全绿 + 右因 mutation RED | 任何更高层 |
| L2 安装态真实入口 | pack → 临时前缀安装 → 真实 binary/argv 执行 | 真实命令输出断言（含 stderr 空、JSON 可解析） | 真实环境行为 |
| L3 真实环境副作用 | 真实进程 env（不注入）、实际落盘位置/权限、注册表 | 位置断言而非仅输出断言 | 网络/服务端行为 |
| L4 非生产 fixture API matrix | 真实服务端 + 真实 SDK，隔离测试 app | 每臂独立探测 PASS/FAIL/NOT_RUN；owner 预探不代签 QA | 真机闭环 |
| L5 三系统真机闭环 E2E | 选版→下载→校验→暂存→重启→health/ACK→回滚 | 每 OS 独立 PASS，真实 attachment，零 mock | 生产 |

规则：**低层绿不推高层绿；高层红必须回溯到具体层定位。** 发布类变更（npm publish、workflow、CLI 面）至少走到 L2+L3；更新链变更走到 L5。

## 2. Exact 冻结与评审规矩

1. **Frozen packet**：review/QA 只绑定完整坐标闭集——B/H/T=tree(H)/M/parents/merge tree/merge-base/canonical three-dot binary patch SHA-256/逐字 changed paths/Hosted terminal + 实际 checkout OID。缩写 SHA、"大概是这个版本"一律打回。
2. **作者/评审/QA/fixture 四席分离**：作者证据只记 author-stage；评审自己复算坐标、复放右因 mutation；QA 不继承任何人的期望值，独立探测比对。
3. **右因 mutation**：每颗承重守卫至少一次"删掉它→恰好对应牙精确变红→恢复全绿"的实跑记录。
4. **诚实 NOT_RUN**：造不出来的状态（如 ingest 层拒绝使入径不可表示）记 `NOT_RUN / UNCONSTRUCTABLE`，可用其它层证据**合取**关闭计划覆盖，**永不回填成 live PASS**。
5. **Landing 收口**：squash 后验 parent==press-time base、landed tree==reviewed T、reviewed→landed stable patch-id 相等；评审席独立回读。
6. **发布终态**：registry version/gitHead/tarball shasum/integrity/provenance/exports + **install-back**（从 registry 装回真实产物执行断言）。"CI 绿 ≠ 发得出去；合了 ≠ 用户拿到了。"
7. **不可变注册表写入**：每个字段都是身份（含 source_commit 等"元数据"）——不填错、不猜、不占位，探测行也一样。

## 3. 非生产 fixture 规矩（L4）

- 专用测试 app（命名 `qa-*`，描述标注非生产/关联任务/可清理），绝不用生产 app。
- artifact 用**不可变真实字节**（commit-pinned URL 或 staging 快照），本地算 SHA-256/size 后注册；声明版本必须等于产物自报版本（E2E 用产物尤其如此）。
- 图谱设计覆盖：main/alpha 分流、pinned exact、跨渠道 pin、显式 pinned-downgrade、up_to_date、superseded/absent/未发布 target/draft 不可见等负臂。
- fixture 交付 = frozen packet（app/channel/release/build id、每 target file/size/SHA、每臂预期、清理回执），交付后冻结，仅 owner 在授权 amend 下可写。
- 已知平台坑：app 创建者初始 role=none（需 org 面授权）；`/members` 读数滞后——**权威角色读回 = RBAC 执行点本身**；发布需显式 release create(draft)+publish 且带 `required_external_targets` 完整性声明；target 词汇 `win32-*`。

## 4. 三系统真机 E2E 运行手册（L5）

**前置门（硬性）**：真实可销毁环境 + **同机非生产 raftdev + 正常 login → 创建专用测试 Server → attach → start**。禁止用空 VM/无 attachment 环境替代（`NO_ATTACHMENT` fail-closed 是产品正常行为，不是测试证据）；禁止伪造 attachment；机器 TTL≤2h。

每 OS 独立执行（同一 frozen packet）：
1. 绑定 packet/app/endpoint 与目标 SEA 的 version/target/URL/size/SHA-256；确认资源可回收。
2. 受管登录 attach 非生产测试 Server；启动 exact 基座 SEA，记录 service PID/startId/attestation/health。
3. main/alpha/pinned 三臂 checkUpdate：同 deviceId、channel/version 关系、唯一产物映射；禁止首条命中/跨 target。
4. K 下载→size/SHA 校验→atomic stage；无二次下载、无 legacy fallback；记录 operation/slot/.ready 回执。
5. 重启 staged 服务；回读 version/startId/health/ACK 与新旧 slot 关系。
6. 失败臂：坏 size/SHA、断网/截断、health 超时——必须 fail-closed、保留旧 stable、生成 rollback 回执并恢复。
7. 重启后同 deviceId 复用；pinned downgrade 仅显式允许，非 pinned 永不降级。
8. 清理：删除 attachment/collaborator/Computer home/runner/raftdev 数据/VM（或 Bed tombstone），回读零残留；全部 OS terminal 后统一 archive 测试 app、撤发布权限并回读。

## 5. 资源授权与清理回执模板

**授权请求**（发给资源 owner，一次一问，二选一句式）：目的、资源种类（disposable VM/Bed/attachment）、TTL、边界（0 生产/0 用户机器/0 正式发布）、清理承诺。
**清理回执**：资源清单逐项"已删除+回读证据"、权限回收项（含 org 级授权提醒）、遗留物（应为零，非零需说明与 owner 确认）。

## 6. 通信与决策规矩（保障 SOP 被执行）

- 执行卡必须引用本 SOP 的条目号；偏离需卡面显式声明理由并经 DRI 接受。
- 状态断言不得超出已验证坐标（"已验证"必须能指向具体收据）。
- 发现与修复分席记录；错误第一时间自认并转成自动化牙。
- 阻塞即报（BLOCKED + 精确缺面 + 建议选项），不用降级证据冒充通过。

---
修订记录：v0.1 首版（2026-08-24, Rhea）。待 v1.0：吸收三系统 E2E 实测修订、macOS 资源获取路径、Windows Testbed Bed 全流程实录。
