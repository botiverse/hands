# QuiverLog — design spec

Status: **draft for review** (2026-07-09)
Owner: CC-Quiver-Owner · Requested by: artin

## Why

Quiver already owns the **transport** side of client observability: crash and
feedback ingest, attachments, `/metrics`, and (iOS) automatic bundling of a
diagnostics zip onto crash tickets. What's missing is the **capture** side.

Today every consumer rolls its own log writer — the Slock app ships a bespoke
`slock-diagnostics.jsonl` writer (rotation, JSONL format, ring buffer) that only
it can use. Anyone else adopting Quiver needs the same thing. QuiverLog makes log
capture a **first-class, generic capability built into the existing Quiver
SDKs**, so it flows straight into Quiver's transport and closes the loop:

```
Quiver.log.*  →  rotating JSONL on disk + in-memory ring
              →  (on crash/feedback) zipped & attached to the ticket   [exists today]
              →  (P2) on-demand pull / remote level / tag-based collection
```

## Scope

- **In**: a Log capability **inside** the existing packages — `@oranix/quiver`
  (iOS pod), `@oranix/quiver-android`, `@oranix/quiver` (ohpm), and
  `@oranix/quiver-electron`. No new standalone package.
- **Generic only** (see the "Quiver stays generic" principle): QuiverLog is a
  logging *primitive* — levels, structured fields, tags, rotation, ring buffer,
  redaction. It does **not** encode any consumer's log semantics; Slock and
  others layer meaning on top.
- **Out (P1)**: remote distribution/collection and tag "染色" selective capture
  are **P2**. This spec designs the P1 surface so P2 slots in without breaking
  changes.

## Non-goals

- Not a general APM/tracing system. Structured tags enable later correlation but
  QuiverLog is file-first, best-effort, offline-friendly.
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

- `rotate: "size"` — `quiver-<name>.jsonl`, `.1`, `.2`, … (fixed file count,
  simple). This is what `slock-diagnostics` does today.
- `rotate: "daily"` — `quiver-<name>-YYYY-MM-DD.jsonl` (one file per calendar
  day). Trivially correlates to a crash timestamp and to age-based retention;
  costs more files if the app launches many times a day.

**Default: `daily` with a per-file size cap** (roll to `-YYYY-MM-DD.<n>` if a day
exceeds the cap) + total-bytes/age retention. This gives the date-legibility
artin asked for while bounding disk.

## API sketch (cross-platform parity)

Naming/casing adapts per platform; shape is identical.

```
Quiver.log.configure({
  dir,                 // defaults to the SDK's diagnostics dir
  minLevel,            // default: info (debug in debug builds)
  rotate,              // "daily" | "size"  (default "daily")
  maxFileBytes,        // per-file cap (default 512 KB)
  maxTotalBytes,       // retention (default ~4 MB)
  maxAgeDays,          // retention (default 7)
  ringSize,            // in-memory entries (default 500)
  redactor,            // optional (entry) => entry | null
})

Quiver.log.verbose|debug|info|warn|error(tag, message, fields?)
Quiver.log.flush()                 // force pending writes to disk
Quiver.log.currentFiles() -> [paths]   // what the crash provider attaches
Quiver.log.snapshot() -> [entries]     // ring buffer, for crash-time capture
```

## Integration with existing Quiver transport

- **Crash / feedback** — the iOS crash reporter already takes a diagnostics
  provider (`setDiagnosticsProvider`, task #102/#133) that returns file paths the
  SDK zips and attaches. QuiverLog simply *becomes that provider's source*:
  `currentFiles()` for the rolling files + a rendered `snapshot()` summary. Same
  for the Android/OHOS crash uploaders (they attach via the feedback client).
- **Metrics** — unaffected.
- **Format** — JSONL stays the shape the server already parses from the
  diagnostics zip, so no server change is needed for P1.

## Migration (slock-diagnostics → QuiverLog)

The Slock app's `slock-diagnostics` writer (KMP, task #101) is replaced by
`Quiver.log`. Three hard constraints (from KMP review) protect the existing
crash/feedback evidence chain during migration:

1. **Superset entry shape, `event` preserved.** The JSONL fields above are a
   strict superset of today's `slock-diagnostics` (`ts/level/event/tag/message/
   thread/seq/dropped/truncated`). `event` stays a distinct field — do not fold
   it into `tag` — or `event=…` grep/filters regress.
2. **Filename-agnostic attach.** Do not assume the server keys off filenames.
   P1 may default to `quiver-<name>-YYYY-MM-DD.jsonl`, but the crash/feedback
   attach must keep a compatibility entry: **either** `currentFiles()` also
   returns a legacy `slock-diagnostics*.jsonl` alias/manifest, **or** the server
   is confirmed to parse by JSONL *content*, not filename. Pin this in the spec —
   it's the most likely "zip has files but nobody can see them" break.
3. **Slock-side adapter, not a rewrite.** Slock keeps its call sites and red
   lines (app-owned logs only; never read system logcat/hilog; redact sensitive
   fields first) behind a thin `SlockDiagnosticsSink → Quiver.log` adapter.
   QuiverLog owns only disk/rotation/ring/`currentFiles`/`snapshot`. This keeps
   P1 a minimal swap instead of touching business call sites on all three
   platforms at once.

Verify end-to-end (trigger a crash → confirm the ticket's diagnostics zip
contains the QuiverLog files and the backend/UI still renders them) before
removing the bespoke writer/rotation.

## Phasing

- **P1** — core capture: levels, tags, structured JSONL, size+daily rotation,
  ring buffer, redaction, retention; wire into the existing crash-diagnostics
  attach; migrate `slock-diagnostics` via the adapter above. Platforms: **iOS +
  Android are must-do**; OHOS ships the same batch if its SDK writes to disk
  reliably, otherwise interface-placeholder now + wire attach right after.
  (Electron: P2, unless the website/Electron story is wanted immediately.)
- **P2** — server-assisted **distribution/collection** (on-demand log pull,
  remote minimum level per device/cohort) and **染色 / tag-based selective
  capture** (mark a tag/session for verbose capture + eager upload). Needs new
  server endpoints; designed to layer on P1's tag + level model.

## Open questions for review

1. Default rotation — `daily`+size-cap as proposed, or size-only to match today?
2. Ring buffer default size (500?) and default retention (7 days / 4 MB?).
3. Electron in P1 or P2?
4. P2 remote-level control: per-device vs per-cohort, and does it reuse the
   `/metrics` device identity or a new channel?
