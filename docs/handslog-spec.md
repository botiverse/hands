# HandsLog — design spec

Status: **Node/desktop track approved — Phase 1 in progress** (2026-07-09)
Owner: CC-Quiver-Owner · Requested by: artin

## Why

Hands already owns the **transport** side of client observability: crash and
feedback ingest, attachments, `/metrics`, and (iOS) automatic bundling of a
diagnostics zip onto crash tickets. What's missing is the **capture** side.

Today every consumer rolls its own log writer — the Slock app ships a bespoke
`slock-diagnostics.jsonl` writer (rotation, JSONL format, ring buffer) that only
it can use. Anyone else adopting Hands needs the same thing. HandsLog makes log
capture a **first-class, generic capability built into the existing Hands
SDKs**, so it flows straight into Hands's transport and closes the loop:

```
Hands.log.*  →  rotating JSONL on disk + in-memory ring
              →  (on crash/feedback) zipped & attached to the ticket   [exists today]
              →  (P2) on-demand pull / remote level / tag-based collection
```

## Scope

Two delivery surfaces for the **same** generic capability:

- **Mobile** — a Log capability **inside** the existing mobile SDKs (`Hands`
  iOS pod, `hands-android-sdk`, ohpm `@botiverse/hands`). No new standalone
  package there; it feeds the crash-diagnostics attach that already exists.
- **Node / desktop** — a **new pure-Node core package `@botiverse/hands-node`**
  (there was no Node SDK before), consumed directly by the `hands` CLI and any
  Node service, and wrapped by an **`@botiverse/hands-electron`** adapter for the
  desktop app. This is the track artin greenlit first (see Architecture below).
- **Generic only** (see the "Hands stays generic" principle): HandsLog is a
  logging *primitive* — levels, structured fields, tags, rotation, ring buffer,
  redaction. It does **not** encode any consumer's log semantics; Slock and
  others layer meaning on top.
- **Out (P1)**: server-assisted distribution/collection and tag "染色" selective
  capture are later phases. This spec designs the P1 surface + the collection
  **contract** so they slot in without breaking changes.

## Architecture (Node / desktop two-layer)

Decided 2026-07-09 (artin + KMP + QA + Codex, thread #Hands:c526b5e1):

- **`@botiverse/hands-node`** — the pure-Node core. Logger (JSONL / size+daily
  rotation / ring buffer / retention / redaction), plus compression, upload, and
  the collect-policy executor. Depends only on Node `fs/http/crypto/timers` —
  **no Electron or browser deps** — so the `hands` CLI, any Node service, CI, and
  the Electron main process all import it directly.
  - **Schema is a stable sub-export**, `@botiverse/hands-node/logs/schema`:
    the `types + validators` for the **collect policy**, the **log bundle**, and
    the **redaction contract**. Client SDK, CLI, and the Hands backend all agree
    on this one definition (no per-consumer reinterpretation). Kept as a
    sub-export rather than a separate `@botiverse/hands-log-schema` package —
    split it out only if a cross-language / separate-backend-repo / contract-only
    consumer appears.
- **`@botiverse/hands-electron`** — the desktop adapter. Depends on
  `@botiverse/hands-node`; adds only Electron-runtime context: main/renderer
  **preload + IPC** (the renderer cannot write files, so it logs via IPC to the
  main-process node logger), `windowId` / `process`, `app.getPath('userData')`
  default log dir, crashpad/minidump association, and autoUpdater events. All
  write/rotate/redact/collect/upload logic is reused from the core.

So CLI uses the core, Electron uses the wrapped package, and future Node backends
reuse the same core — one log format, one rotation/redaction, one collection
contract everywhere.

## Non-goals

- Not a general APM/tracing system. Structured tags enable later correlation but
  HandsLog is file-first, best-effort, offline-friendly.
- Never blocks or crashes the host app: all I/O is best-effort and off the hot path.

## Concepts

- **Entry** — one JSONL object per line. The shape is an explicit **superset of
  the existing Slock diagnostics fields**, not a new schema, so current
  server/UI/human `grep` keeps working after migration:
  ```json
  {"ts":"2026-07-09T14:01:02.345+08:00","level":"info","event":"login_ok",
   "tag":"auth","message":"login ok","fields":{"server":"slock-android"},
   "thread":"main","seq":123,"dropped":0,"truncated":false}
  ```
  `ts` (ISO-8601 with offset), `level`, **`event`** (distinct machine key — kept
  separate, **not** folded into `tag`, so filters like
  `event=kuikly_unhandled_exception` / `event=release_notes_open` don't
  regress), `tag` (the 染色 hook), `message`, optional `fields` (flat map),
  optional `thread`, monotonic `seq`, and back-pressure markers `dropped` /
  `truncated`. `event` and `tag` are orthogonal: `event` = what happened, `tag` =
  which stream/color it belongs to.
- **Levels** — `verbose | debug | info | warn | error`. A minimum level gates writes.
- **File sink** — append-only JSONL with rotation (below). Optional console sink in debug builds.
- **Ring buffer** — last N entries kept in memory so a crash-time snapshot needs
  no disk read on the signal path (feeds the existing crash diagnostics provider).
- **Redaction hook** — a consumer-supplied function to scrub fields/patterns
  before an entry is written (tokens, emails, PII).
- **Retention** — bounded by max bytes total, max files, and/or max age.

## Rotation & file naming (answers the `-date` question)

Support **both** schemes, configurable, because the tradeoff is real:

- `rotate: "size"` — `hands-<name>.jsonl`, `.1`, `.2`, … (fixed file count,
  simple). This is what `slock-diagnostics` does today.
- `rotate: "daily"` — `hands-<name>-YYYY-MM-DD.jsonl` (one file per calendar
  day). Trivially correlates to a crash timestamp and to age-based retention;
  costs more files if the app launches many times a day.

**Default: `daily` with a per-file size cap** (roll to `-YYYY-MM-DD.<n>` if a day
exceeds the cap) + total-bytes/age retention. This gives the date-legibility
artin asked for while bounding disk.

## API sketch (cross-platform parity)

Naming/casing adapts per platform; shape is identical.

```
Hands.log.configure({
  dir,                 // defaults to the SDK's diagnostics dir
  minLevel,            // default: info (debug in debug builds)
  rotate,              // "daily" | "size"  (default "daily")
  maxFileBytes,        // per-file cap (default 512 KB)
  maxTotalBytes,       // retention (default ~4 MB)
  maxAgeDays,          // retention (default 7)
  ringSize,            // in-memory entries (default 500)
  redactor,            // optional (entry) => entry | null
})

Hands.log.verbose|debug|info|warn|error(tag, message, fields?)
Hands.log.flush()                 // force pending writes to disk
Hands.log.currentFiles() -> [paths]   // what the crash provider attaches
Hands.log.snapshot() -> [entries]     // ring buffer, for crash-time capture
```

## Integration with existing Hands transport

- **Crash / feedback** — the iOS crash reporter already takes a diagnostics
  provider (`setDiagnosticsProvider`, task #102/#133) that returns file paths the
  SDK zips and attaches. HandsLog simply *becomes that provider's source*:
  `currentFiles()` for the rolling files + a rendered `snapshot()` summary. Same
  for the Android/OHOS crash uploaders (they attach via the feedback client).
- **Metrics** — unaffected.
- **Format** — JSONL stays the shape the server already parses from the
  diagnostics zip, so no server change is needed for P1.

## Migration (slock-diagnostics → HandsLog)

The Slock app's `slock-diagnostics` writer (KMP, task #101) is replaced by
`Hands.log`. Three hard constraints (from KMP review) protect the existing
crash/feedback evidence chain during migration:

1. **Superset entry shape, `event` preserved.** The JSONL fields above are a
   strict superset of today's `slock-diagnostics` (`ts/level/event/tag/message/
   thread/seq/dropped/truncated`). `event` stays a distinct field — do not fold
   it into `tag` — or `event=…` grep/filters regress.
2. **Filename-agnostic attach.** Do not assume the server keys off filenames.
   P1 defaults to `hands-<name>-YYYY-MM-DD.jsonl`, but the crash/feedback
   attach must keep a compatibility entry: **either** `currentFiles()` also
   returns a legacy `slock-diagnostics*.jsonl` alias/manifest, **or** the server
   is confirmed to parse by JSONL *content*, not filename. Pin this in the spec —
   it's the most likely "zip has files but nobody can see them" break.
3. **Slock-side adapter, not a rewrite.** Slock keeps its call sites and red
   lines (app-owned logs only; never read system logcat/hilog; redact sensitive
   fields first) behind a thin `SlockDiagnosticsSink → Hands.log` adapter.
   HandsLog owns only disk/rotation/ring/`currentFiles`/`snapshot`. This keeps
   P1 a minimal swap instead of touching business call sites on all three
   platforms at once.

Verify end-to-end (trigger a crash → confirm the ticket's diagnostics zip
contains the HandsLog files and the backend/UI still renders them) before
removing the bespoke writer/rotation.

## Server-assisted collection — contract & governance

Backend-driven collection ("下发日志采集") is **pull-based**, reusing the poll the
client already does (update-check / metrics): the server includes a **collect
policy** in the poll response; the client matches locally, packages a **log
bundle**, and uploads it to a **log-ingest endpoint** decoupled from the business
API. Both `collect policy` and `log bundle` are defined by
`@botiverse/hands-node/logs/schema`. Governance constraints (must be enforced in
the core, so every consumer inherits them):

- **Signed + versioned + expiring policy.** The client verifies the policy's
  signature, schema version, and expiry; expired / downgraded / bad-signature
  policies **fail closed** and write an audit entry — never collect on a stale or
  tampered policy.
- **Hard budgets.** Per-collection max bytes, per-day max bytes, upload
  concurrency cap, and weak-network backoff. Hitting a limit must not affect the
  host app / CLI main flow.
- **Redaction is mandatory and re-applied at upload.** Secrets / tokens / JWTs /
  API keys / env / `Authorization` / cookies are redacted by default; the bundle
  is scrubbed again just before upload. No plaintext secret may appear in a
  bundle.
- **Decoupled + non-blocking.** The log-ingest endpoint is separate from the
  business API; ingest failure must not affect the app.
- **Opt-out.** Org- and user-level switches; enterprise environments can disable
  remote collection entirely.

## Phasing

Node / desktop track (artin greenlit, thread #Hands:c526b5e1):

- **Phase 1** — `@botiverse/hands-node` core: logger (levels, tags, structured
  JSONL, size+daily rotation, ring buffer, redaction, retention) +
  `logs/schema` sub-export (policy/bundle/redaction types + validators) + **CLI
  integration** (the `hands` CLI writes structured logs via the core; a
  `hands logs collect` scaffold that packages locally against a policy).
- **Phase 2** — server: log-ingest endpoint + a `collect` policy in the poll
  response + admin UI (start a collection / view returned bundles / opt-out
  switches). Enforces the governance contract above.
- **Phase 3** — `@botiverse/hands-electron` adapter over the core (IPC/window/
  crashpad/autoUpdater/userData context).

Mobile track (original P1/P2, unchanged):

- **Mobile P1** — core capture inside the mobile SDKs + wire into the existing
  crash-diagnostics attach; migrate `slock-diagnostics` via the adapter above.
  **iOS + Android must-do**; OHOS same batch if its SDK writes to disk reliably,
  else interface-placeholder + wire attach right after.
- **Mobile P2** — the same server-assisted distribution/collection + 染色, built
  on the contract above.

### Phase 1 acceptance criteria (QA)

- CLI writes JSONL rolling logs via `@botiverse/hands-node`; append/rotate resume
  correctly after a restart.
- `policy` / `bundle` / `redaction` schemas are exported from
  `@botiverse/hands-node/logs/schema`; CLI fixtures validate against them.
- Redaction by default covers token / JWT / API key / env / `Authorization` /
  cookies; no plaintext secret appears in an upload bundle.
- A collect policy is verified for signature / version / expiry; expired,
  downgraded, and bad-signature policies all **fail closed** and write an audit
  log.
- Budget hard-limits (per-collection size, per-day size, concurrency, weak-net
  backoff) are testable and, when hit, do not affect the CLI main flow.

## Open questions for review

1. Default rotation — `daily`+size-cap as proposed, or size-only to match today?
2. Ring buffer default size (500?) and default retention (7 days / 4 MB?).
3. ~~Electron in P1 or P2?~~ **Resolved**: Node core (`@botiverse/hands-node`) +
   CLI is Phase 1; Electron adapter is Phase 3, built over the core.
4. P2 remote-level control: per-device vs per-cohort, and does it reuse the
   `/metrics` device identity or a new channel?
