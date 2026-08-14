# Hands CLI agent login — first reference instance (CP1 contract draft)

Status: **proposed design (CP1)**. No runtime, schema, or production change is
authorized by this document. It freezes the Hands-side shape so CP2 (Worker) and
CP3 (CLI) implement to a reviewed contract. Hands is the **first instance** of the
generic `CLI agent login` capability; there is **no Hands-special-casing** — the
same recipe applies to any service that adopts the generic contract.

Cross-refs: generic contract owned by @XX (Raft-side, task #1); this is the Hands
instance (#joint-hands task #2). Security review lands in `#proj-hands` with
@Sentinel; CLI/client owner review with @Volta.

## Scope

- Let an **agent** run `hands login` with no browser, obtaining a short-lived
  Hands access token + a revocable refresh token, stored per-agent.
- **Humans / CI paths are unchanged, byte-for-byte** (browser login, `--token`,
  `HANDS_AUTH_TOKEN`/`HANDS_BEARER_TOKEN`, `~/.config/quiver/auth.json`).

## Non-goals

- No daemon-held service credential / proxy (XX's census: existing Raft transport
  suffices; deferred heavier "daemon holds all" is out of scope).
- No hard isolation between same-OS-user agents (see Threat model).
- No change to the human/CI login or to `hands api` (#448).

## Environment detection (agent path gate)

The agent path is taken **only when ALL of these hold**:

1. `SLOCK_CLI_TRANSPORT_DIR` is set,
2. `raft` is on PATH and executable,
3. `SLOCK_HOME` is set,
4. `SLOCK_AGENT_ID` is set.

Any one missing → fall through to the existing human/CI login unchanged. Detection
never mutates state.

## Flow

```
hands login  (agent env)
  1. raft integration invoke <hands-service> --action agent-login
       -> one-time grant   (format/TTL/binding/errors = XX's frozen contract; see "Grant interface")
  2. POST <hands-api>/api/auth/agent/exchange   { grant }
       -> { access_token, refresh_token, access_expires_at }
  3. store at $SLOCK_HOME/agents/$SLOCK_AGENT_ID/integrations/hands/auth.json
  4. subsequent calls use access_token; auto-refresh (below)
```

The final Hands tokens are exchanged by the **Hands CLI ↔ Hands API** directly;
they are never handed back to Raft/daemon and never appear in the `invoke` output.

## Token model

- **access token** = reuse the existing Hands JWT signer (`worker/src/routes/auth.ts`,
  `hands-auth-jwt-v1` HMAC), but **short TTL** (proposed 15m; final TTL aligned to
  the existing human-JWT TTL — to be read from source at CP2, not guessed).
- **refresh token** = NEW opaque high-entropy secret; only its hash is stored
  server-side; revocable + rotated on every use; bound to `(agent_id, server_id,
  service)`.

## Worker endpoints (CP2)

### `POST /api/auth/agent/exchange`
- Body: `{ grant }`.
- Validates the grant per the Grant interface (single-use, unexpired, bound to the
  calling agent/server/service). On any failure → fail closed (401/400, no token).
- On success: mint short access JWT + issue refresh token; persist refresh hash.
- Response: `{ access_token, refresh_token, access_expires_at }`.

### `POST /api/auth/agent/refresh`
- Body: `{ refresh_token }`.
- Looks up by hash; if unknown / expired / revoked / **already-rotated (reuse)** →
  fail closed AND revoke the whole rotation chain (reuse = compromise signal).
- On success: rotate (issue new access + new refresh, mark old rotated), persist.
- Response: `{ access_token, refresh_token, access_expires_at }`.

Both endpoints: grant/refresh values never logged; errors carry a stable `code`,
never the secret.

## Refresh-token storage (CP2 migration)

New D1 table (next migration number at CP2 time — currently main is at `0065`):

```
agent_refresh_tokens(
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,     -- hash only, never the raw token
  agent_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  service TEXT NOT NULL,
  app_scope TEXT,                      -- if the access is app-scoped
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  rotated_from TEXT,                   -- prior token id in the chain
  revoked_at INTEGER
)
```

Additive/backward-compatible; index on `token_hash`. Revocation = set `revoked_at`
(and cascade the chain on reuse). Admin revoke path (revoke all for an agent).

## CLI auth store (CP3)

- Path: **`$SLOCK_HOME/agents/$SLOCK_AGENT_ID/integrations/hands/auth.json`**.
- Write: **atomic replace** (write temp in same dir + `rename`); file mode `0600`,
  directory mode `0700`.
- Contents: `{ access_token, refresh_token, access_expires_at }` (+ api base).
- Never written to env; never logged; never printed to stdout/stderr.

## Auto-refresh (CP3)

- Refresh proactively shortly **before** `access_expires_at`, and reactively **once**
  on a `401`.
- Concurrency: single-flight refresh (lock/temp file) so parallel `hands` invocations
  don't double-rotate; crash mid-rotate must not lock the agent out (recover from the
  last durably-persisted token).
- `expired / reused / revoked` refresh → clear the store and require a fresh
  `hands login`.

## Grant interface (depends on XX's frozen `agent-login` action contract — task #1)

Pending from XX: the one-time grant's **fields, TTL, binding (agent/server/service),
single-use/replay guarantee, and error codes**, plus **how Hands validates/consumes
it** (call back to Raft to consume, or verify a signed grant + Raft tracks single-use).
CP2's `exchange` validation is written to exactly this contract; until frozen, the
validation is an interface stub, not a guessed protocol.

## Threat model (honest)

- `0600`/`0700` + the per-agent path prevent **accidental cross-agent sharing** and
  reads by **other OS users**.
- They do **NOT** hard-isolate agents running as the **same OS user** (they can read
  each other's files at the OS level). Hard isolation would need a daemon proxy /
  per-agent OS identity — deferred future hardening, explicitly out of scope here.
- Blast radius: leaked access token dies in minutes; leaked refresh token is
  revocable server-side and rotation makes replay detectable.

## Security invariants

1. Grant and tokens never printed, never in env, never in error/log output.
2. Cross-`agent_id` / cross-`server_id` / cross-`service`, replay, and expiry all
   fail closed with no side effect.
3. Human/CI login path is byte-for-byte unchanged; agent path is additive.
4. Refresh reuse (a rotated token used again) revokes the whole chain.
5. No arbitrary-argv / no self-made Raft protocol — CLI calls only the frozen
   `agent-login` manifest action.

## Test matrix (CP2/CP3)

| Scenario | Required result |
| --- | --- |
| All 4 daemon markers present | agent login path taken |
| Any one marker missing / `raft` not executable | human/CI path, unchanged |
| Human/CI (no markers) | existing login byte-for-byte identical |
| exchange with valid grant | access + refresh issued; store written 0600, dir 0700 |
| exchange with expired/replayed/cross-bound grant | fail closed, no token, stable code |
| refresh happy path | rotates; old refresh no longer valid |
| refresh reuse (rotated token) | fail closed + chain revoked |
| refresh expired / revoked | store cleared, re-login required |
| access 401 mid-session | single auto-refresh, then retry |
| parallel invocations | single-flight refresh, no double-rotate |
| crash mid-rotate | recover from last persisted token, no lockout |
| any output (stdout/stderr/json/error) | contains no grant/token |

## Checkpoints

- **CP1** (this doc): freeze Hands-side shape; align with XX; Sentinel security
  pre-read (in `#proj-hands`).
- **CP2**: Worker PR — refresh table migration + `exchange`/`refresh` endpoints
  (grant validation to XX's frozen contract).
- **CP3**: CLI PR — detection + `hands login` agent branch + store + auto-refresh.
