# quiver

**Open-Source APK distribution platform** — Cloudflare Native (Workers + Container + D1 + R2 + Pages).

Reference feature set inspired by [Zealot (tryzealot/zealot)](https://github.com/tryzealot/zealot).

The "quiver" metaphor: admins load APK arrows into channels; clients pick the right one for their channel.

## Architecture

```
┌────────────────────────────────────────────────────────┐
│ User / Admin / CI                                     │
└──────┬──────────────────────────┬─────────────────────┘
       │ upload / list / download │
       ▼                          │
┌────────────────────────────────────────────────────────┐
│ Cloudflare Worker (quiver)                            │
│ - API routes                                           │
│ - Auth (Cloudflare Access / API Token)                 │
│ - Signed URL issuance for R2                           │
│ - D1 read/write for metadata                           │
└──────┬───────────────────────────┬────────────────────┘
       │ multipart upload          │ parse APK
       ▼                           ▼
┌─────────────────┐         ┌────────────────────────────────┐
│ R2 Bucket       │         │ Cloudflare Container           │
│ (raw APK + icon)│ ◀────── │ (apk-parser)                   │
└─────────────────┘   icon  │ - aapt/apksigner               │
       ▲                   │ - returns metadata + icon      │
       │                   └────────────────────────────────┘
       │                              │
       │                              ▼
       │                     ┌─────────────────┐
       └─────────────────────│ D1 Database     │
                             │ apps/versions/  │
                             │ channels/audit  │
                             └─────────────────┘
                                      ▲
                                      │
                             ┌─────────────────┐
                             │ Admin UI (SPA)  │
                             │ Cloudflare Pages│
                             └─────────────────┘
```

## Modules

- `worker/` — Cloudflare Worker (Hono) — API routes, auth, D1 CRUD, R2 signed URLs
- `container/` — Cloudflare Container — APK metadata parser (aapt + apksigner)
- `admin/` — Cloudflare Pages SPA (React + Vite + Tailwind) — admin upload UI
- `migrations/` — D1 SQL schema migrations
- `docs/` — design notes + API contract

## Quick start

```sh
# install
pnpm install

# local worker dev (D1 + R2 local emulators)
pnpm --filter @oranix/quiver-worker dev

# local admin UI
pnpm --filter @oranix/quiver-admin dev

# local container (Docker required)
docker build -t apk-parser container/
```

## Status

🚧 Initial scaffold. See `docs/architecture.md` (TODO) for design notes.