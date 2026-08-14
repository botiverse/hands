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
  0. CLI generates high-entropy code_verifier; code_challenge = base64url(SHA-256(verifier))
  1. raft integration invoke <hands-service> --action agent-login
       input:  { schema:request.v1, code_challenge, code_challenge_method:"S256" }
       result: { schema:grant.v1, service:"hands", grant:<opaque single-use>, expires_at:<=300s }
  2. POST <hands-api>/api/auth/agent/exchange  { schema:exchange.v1, grant, code_verifier }
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

### `agent-login` action (Hands manifest action; reached via `integration invoke`)
- Input: `{ schema:"raft-cli-agent-login-request.v1", code_challenge, code_challenge_method:"S256" }`.
- Hands reads `server/agent/integration/service` **from the authenticated Agent Login
  context of the invoke** (never from the request body).
- Writes a Hands-side grant record (`identity + code_challenge + nonce + issued/expiry`,
  storing the grant digest). Returns `{ schema:"…grant.v1", service:"hands", grant, expires_at (<=300s) }`.

### `POST /api/auth/agent/exchange`
- Body: `{ schema:"raft-cli-agent-login-exchange.v1", grant, code_verifier }`.
- Consume + proof-verify per the Grant interface (atomic single-use; identity from
  the grant binding; `SHA-256(verifier)==code_challenge`). Any failure → fail closed
  with a stable error from the closed set (no token). `code_verifier` is never
  logged/stored.
- On success: mint short access JWT + issue refresh token; persist refresh hash;
  both bound to the proven `identity`.
- Response: `{ access_token, refresh_token, access_expires_at }`.

### `POST /api/auth/agent/refresh`
- Body: `{ refresh_token }`.
- Looks up by hash; if unknown / expired / revoked / **already-rotated (reuse)** →
  fail closed AND revoke the whole rotation chain (reuse = compromise signal).
- On success: rotate (issue new access + new refresh, mark old rotated), persist.
- Response: `{ access_token, refresh_token, access_expires_at }`.

Both endpoints: grant/refresh values never logged; errors carry a stable `code`,
never the secret.

## Server-side storage (CP2 migration)

New D1 tables (next migration number at CP2 time — main is currently at `0065`).

Grant records (Hands owns the grant lifecycle — issue at `agent-login`, consume at
`exchange`, atomically):

```
agent_login_grants(
  grant_digest TEXT PRIMARY KEY,       -- digest only, never the raw grant
  server_id TEXT NOT NULL,             -- all identity fields from the authenticated
  agent_id TEXT NOT NULL,              -- Agent Login context, NOT the request body
  integration TEXT NOT NULL,
  service TEXT NOT NULL,
  code_challenge TEXT NOT NULL,        -- S256; verified against verifier at exchange
  nonce TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,         -- <=300s from issue
  consumed_at INTEGER                  -- set atomically with mint; single-use
)
```

Refresh tokens:

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

## Grant interface — FROZEN (RFC 057 / slock PR #6496, `7b0c8cdf`)

Proof-key (PKCE-style) bound grant — a bare-bearer grant is rejected: stealing the
stdout grant alone must not allow exchange. The CLI generates a high-entropy
`code_verifier` locally; only its S256 challenge reaches Raft; the verifier is sent
only to the Hands exchange endpoint and **never** to Raft, logs, or the store.

Action input:
```json
{"schema":"raft-cli-agent-login-request.v1","code_challenge":"<base64url SHA-256, 32 bytes>","code_challenge_method":"S256"}
```
Action result (strict):
```json
{"schema":"raft-cli-agent-login-grant.v1","service":"hands","grant":"<opaque single-use>","expires_at":"<future RFC3339, <=300s>"}
```
Hands exchange request:
```json
{"schema":"raft-cli-agent-login-exchange.v1","grant":"…","code_verifier":"…"}
```

Grant record (Raft-side) binds authenticated `server/agent/integration/service` +
issued/expiry + `code_challenge` + nonce; stores the grant digest where possible;
consume + used-transition is atomic. Server/agent id are **proven via the grant
binding, never client-self-reported**.

**Exchange error closed-set:** `invalid` / `expired` / `consumed` /
`binding_mismatch` / `grant_proof_mismatch` / `temporarily_unavailable`. Only
`temporarily_unavailable` is bounded-retryable; an ambiguous exchange does NOT retry
the old grant — the CLI acquires a fresh one.

**Consumption locus — CONFIRMED by @XX (RFC 057): fully Hands-local, NO Raft callback
at exchange.**

1. `agent-login` **action is executed by Hands** (the invoke transports the request
   to the Hands service). Hands reads `server/agent/integration/service` identity from
   the authenticated Agent Login context, writes its OWN grant record
   (`identity + code_challenge + nonce + expiry`, storing the grant digest), and
   returns only the opaque `grant` to the CLI.
2. CLI sends `{grant, code_verifier}` to the Hands exchange endpoint.
3. Hands finds its own record by grant digest → checks unexpired/unconsumed/binding
   → verifies `SHA-256(code_verifier)==code_challenge` (mismatch → `grant_proof_mismatch`)
   → in the **same atomic transaction** marks the grant consumed and mints
   access+refresh; session identity comes from the grant record.

Raft/daemon never sees the verifier and is not called at exchange (no Raft online
dependency, no second identity hop). `grant_proof_mismatch` originates only from
Hands's local proof check; `server/agent` id is never client-self-reported.

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
| exchange with valid grant + matching verifier | access + refresh issued; store written 0600, dir 0700 |
| exchange with wrong/absent code_verifier | `grant_proof_mismatch`, no token |
| exchange with expired/consumed/cross-bound grant | `expired`/`consumed`/`binding_mismatch`, fail closed, no token |
| verifier in any Raft-bound payload/log/store | never present (proof stays CLI↔Hands) |
| `temporarily_unavailable` vs ambiguous exchange | former bounded-retry; latter acquires a fresh grant, never retries the old |
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
