# Hands SDK ↔ Sentry parity analysis & roadmap

Source-level audit of all four Hands client SDKs against Sentry's 2025–26
capability set (task #120, 2026-07-09). Per-platform detail lives in
[android.md](android.md), [ios.md](ios.md), [ohos.md](ohos.md),
[electron.md](electron.md); the execution plan is in [roadmap.md](roadmap.md).

Four deep dives compare mechanism-by-mechanism against Sentry's actual docs,
each rating every gap 关键/重要/可后置/不追 with a top-5 borrow list:

- [deep-sdk-architecture.md](deep-sdk-architecture.md) — scopes/hub, envelope
  disk queue, beforeSend, rate-limit protocol, client reports, sampling,
  PII scrubbing, session modes, config surface
- [deep-issue-pipeline.md](deep-issue-pipeline.md) — grouping/fingerprinting,
  issue states, debug-ids, gradle/xcode auto symbol upload, sourcemaps,
  suspect commits, ownership, environments
- [deep-product-surface.md](deep-product-surface.md) — alert rules/anomaly
  detection, chat-ops (vs our Raft-native model), VCS integrations,
  dashboards/query API, quotas/retention, crash-linked feedback, AI/Seer
- [deep-mobile.md](deep-mobile.md) — ANRv2/tombstones, Mach/App Hangs/
  watchdog/MetricKit, app start/TTID/frames, 30s session threshold, offline
  envelope queue, screenshots/view hierarchy, mobile replay

## Positioning

Hands SDKs are **crash + feedback-ticket + device-stats + update-distribution
clients** attached to a release platform. Sentry is **full-stack
observability** (error monitoring, distributed tracing, continuous profiling,
session replay, logs, release health, alerting). The gap is therefore not
uniform lag — it is a different coverage shape, with several capabilities
Sentry does not have at all (see "Moats").

## Capability matrix

| Capability | Android | iOS | OHOS | Electron | Sentry |
|---|---|---|---|---|---|
| Crash capture | ✅ JVM + NDK signals | ✅ NSException + signals | ⚠️ ArkTS `errorManager` only | ✅ Crashpad minidumps, all processes | ✅ deeper |
| Crash-capture depth | ❌ no ANR | ❌ no Mach / watchdog / all-threads dump | ❌ no native (faultLogger) | ❌ no JS errors (main + renderer) | ✅ ANR / hangs / MetricKit |
| Symbolication | ⚠️ server-side (mapping via CLI) | ⚠️ client emits binary images; server resolver not rolled out | ❌ none | ✅ minidump + breakpad .sym; ❌ no JS sourcemaps | ✅ automatic end-to-end |
| Breadcrumbs | ❌ (logcat tail as stand-in) | ❌ (app's own JSONL log as stand-in) | ❌ | ⚠️ API exists, crash-scope only | ✅ |
| Handled errors (`captureException`) | ❌ | ❌ | ❌ | ❌ | ✅ core API |
| Sessions / release health | ❌ 24h device ping only → **crash-free rate uncomputable** | same | same | same | ✅ signature feature |
| Performance (transactions/spans/startup/frames) | ❌ | ❌ | ❌ | ❌ | ✅ |
| User feedback + attachments | ✅ ≤200 MB presigned | ✅ | ✅ ≤200 MB, bounded ArkTS/R2 multipart | ❌ in SDK (tickets exist server-side) | ⚠️ weaker than ours |
| Log capture | crash-time logcat tail | host-provided via diagnostics provider | ❌ | ❌ | ✅ Logs GA |
| Session replay / profiling / crons / uptime | ❌ | ❌ | ❌ | ❌ | ✅ |
| **In-app update distribution + staged rollout** | ✅ full (hash bucketing, force-update, installer) | ❌ | ❌ | ⚠️ CLI publishes electron-updater artifacts | ❌ **Sentry has none** |

## Moats to keep (Sentry can't follow)

1. **Update distribution + staged rollout** — device-hash bucketing,
   force-update, channels; integrated with the release platform. This is the
   core differentiation.
2. **Feedback tickets** — attachments to 200 MB (screenshots/logs), status
   flow, comments, CLI/agent triage. Stronger than Sentry User Feedback.
3. **Agent-native** — CLI + API let AI agents triage crashes/feedback
   directly (Sentry only started AI/MCP work in 2025).
4. **Self-hosted, Cloudflare-native**, crash ↔ build ↔ release in one
   database — correlation is free.

## Strategy

Deepen our own closed loop — **crash → symbolication → release health →
feedback → update** — rather than chasing Sentry's APM breadth. Priorities are
defined in [roadmap.md](roadmap.md): P0 = sessions/crash-free rate, unified
`captureException`, unified breadcrumbs; P1 = crash-capture depth +
symbolication completion + SDK hygiene; P2 = selective (logs via HandsLog,
app-start + hang-rate only); P3 = explicitly not pursued (replay, continuous
profiling, crons/uptime).
