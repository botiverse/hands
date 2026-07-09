# Hands Account / Organization / Team / Invite Architecture

> **Status: historical design document (frozen).** Written during the
> 2026-06 build-out; several sections describe plans that shipped
> differently. For current behavior see `docs/public/` (served at
> `/docs`), `docs/release-runbook.md`, and the code. Kept for design
> rationale and history. (Banner added 2026-07-04.)

Status: **draft v1, awaiting review** (task #6, @Pi-Worker2)
Author: @Pi-Worker2, 2026-06-28
Scope: long-lived schema and admin UX for organizations, teams, memberships, invites, and role-based access control.

---

## 1. Goals

Hands today authenticates via Login with Raft (migration 0004) — `raft_accounts` + `raft_sessions`. A human account can sign in and operate on any app. **Agents (Raft `type='agent'`) are also first-class principals** — they can log in, get a session cookie, and act on Hands.

What's missing:
- **Organizations** — group of apps owned by one team (humans + agents can co-own)
- **Members** — humans/agents ↔ org association with `org_role`
- **App members** — humans/agents ↔ app association with `app_role` (additive over org)
- **Invites** — onboarding flow: owner emails a teammate → token + role → recipient accepts → account joins team
- **Role-based access control (RBAC)** — currently any signed-in principal can do anything. We need app-level + org-level roles.

### 1.1 Design decision: org boundary = Raft `server_id`

**Key principle:** A Hands organization aligns 1:1 with a Raft server. Every principal (human or agent) that logs in to a given Raft server is automatically a member of that server's org.

Rationale (from @Codex-Kuikly-KMP专家 review):
- Agents in particular benefit — no separate "invite" ceremony needed for every agent; the moment a Raft agent is provisioned to a server, they can act on Hands.
- Same-server login → same org. Cross-server → different org. No manual linking.
- Org identity = `(external_provider='raft', external_id=server_id)`.

```
Single Raft server "acme-corp"      →  One Hands organization
  ├─ human alice@acme.com           →  org_member(role='owner')
  ├─ human bob@acme.com             →  org_member(role='admin')
  ├─ agent  assistant-1              →  org_member(role='member')
  └─ agent  assistant-2              →  org_member(role='viewer')
```

First human to log in is automatically promoted to `owner`. Subsequent principals default to `member` (humans) or `viewer` (agents). Admin can promote/demote.

Reference model: Vercel (Personal Account → Team → Project → Member roles), Supabase (Organization → Project → Member roles), Cloudflare (Account → Workspace → Member roles).

## 2. Hierarchy

```
organizations                       -- top-level container; aligned with Raft server
├ org_role enum: 'owner' | 'admin' | 'member' | 'viewer'   (apply to humans + agents)
└── org_members                    -- principal ↔ org association
    └── (org_role, joined_at, invited_by)

apps                                 -- now scoped to an organization
└── app_members                      -- principal ↔ app association (additive)
    └── (app_role: 'admin' | 'publisher' | 'viewer')

invites                              -- pending memberships (email + token + role + expiry)
└── status: 'pending' | 'accepted' | 'revoked' | 'expired'
```

Key separation: **org members** (can manage org-level resources like billing + team) vs **app members** (can publish/manage a specific app). A principal can be in both — e.g., org admin + app viewer on a specific app.

**Humans and agents are interchangeable in the membership model.** `principal_type` lives in `raft_accounts` (already there from migration 0004) but does NOT affect org membership shape — only default role assignment differs (humans default to 'member', agents default to 'viewer').

## 3. Tables (Phase 5 work — see §7)

### 3.1 `organizations`

```
organizations
  id              TEXT PRIMARY KEY
  slug            TEXT NOT NULL UNIQUE      -- 'acme-corp' (used in URLs)
  name            TEXT NOT NULL             -- 'Acme Corp'
  created_at      INTEGER NOT NULL
  archived        INTEGER NOT NULL DEFAULT 0
```

Hands at install time has a single bootstrap org (`slug='default'`, `name='Default'`). All existing apps and accounts get associated with this org in the Phase 5 backfill migration.

### 3.2 `org_members`

```
org_members
  id              TEXT PRIMARY KEY
  org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE
  account_id      TEXT NOT NULL REFERENCES raft_accounts(id) ON DELETE CASCADE
  org_role        TEXT NOT NULL             -- 'owner' | 'admin' | 'member'
  invited_by      TEXT REFERENCES raft_accounts(id)
  joined_at       INTEGER NOT NULL
  UNIQUE (org_id, account_id)
  INDEX (account_id)                        -- "which orgs am I in?"
  INDEX (org_id, org_role)
```

**Roles**:
- `owner` — can delete org, transfer ownership, manage billing. At least one required.
- `admin` — can invite members, create apps, change app memberships.
- `member` — can access org-level resources (settings, audit log). No app permissions by itself.

### 3.3 `apps.org_id` (column addition)

```
ALTER TABLE apps ADD COLUMN org_id TEXT REFERENCES organizations(id);
ALTER TABLE apps ADD COLUMN archived_at INTEGER;  -- already added in Phase 1, repeated here for completeness
CREATE INDEX idx_apps_org ON apps(org_id, created_at DESC);
```

Each app now belongs to exactly one org. Existing apps get org_id = `default` org in backfill.

### 3.4 `app_members`

```
app_members
  id              TEXT PRIMARY KEY
  app_id          TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE
  account_id      TEXT NOT NULL REFERENCES raft_accounts(id) ON DELETE CASCADE
  app_role        TEXT NOT NULL             -- 'admin' | 'publisher' | 'viewer'
  invited_by      TEXT REFERENCES raft_accounts(id)
  joined_at       INTEGER NOT NULL
  UNIQUE (app_id, account_id)
  INDEX (account_id)                        -- "which apps can I see?"
  INDEX (app_id, app_role)
```

**Roles** (per-app, additive over org membership):
- `admin` — can archive app, manage channels, manage app_members, sign builds
- `publisher` — can upload, edit, enable/disable, release versions
- `viewer` — read-only access to versions, ops logs, audit logs

**Resolution**: `effective_role(app, account) = MAX(app_role IF app_member, org_role IF org_admin, null)`. Implemented as a Worker helper.

### 3.5 `invites`

```
invites
  id              TEXT PRIMARY KEY                       -- uuid (also the public token)
  org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE
  app_id          TEXT REFERENCES apps(id) ON DELETE CASCADE  -- null = org-level invite
  email           TEXT NOT NULL                          -- lowercase + trim
  role            TEXT NOT NULL                          -- org_role OR app_role depending on app_id
  token           TEXT NOT NULL UNIQUE                   -- 32-byte base64url random
  invited_by      TEXT NOT NULL REFERENCES raft_accounts(id)
  status          TEXT NOT NULL DEFAULT 'pending'        -- 'pending' | 'accepted' | 'revoked' | 'expired'
  message         TEXT                                   -- optional personal message
  created_at      INTEGER NOT NULL
  expires_at      INTEGER NOT NULL                       -- created_at + 7 days
  accepted_at     INTEGER
  accepted_by     TEXT REFERENCES raft_accounts(id)
  revoked_at      INTEGER
  revoked_by      TEXT REFERENCES raft_accounts(id)
  UNIQUE (org_id, email, status) WHERE status = 'pending'   -- only one pending invite per email per org
  INDEX (token)                                            -- lookup on /invites/:token
  INDEX (org_id, status, expires_at)                       -- org admin views pending invites
  INDEX (app_id, status, expires_at)                       -- per-app invite views
  INDEX (email)                                            -- "do I have any invites?"
```

**One pending invite per email per org** — prevents spam. Re-invite after expiry/revoke is fine.

### 3.6 `audit_logs.actor_id` (column addition)

```
ALTER TABLE audit_logs ADD COLUMN actor_id TEXT REFERENCES raft_accounts(id);
ALTER TABLE audit_logs ADD COLUMN actor_type TEXT;  -- 'human' | 'agent' | 'system'
```

The existing `actor` TEXT column becomes display name; `actor_id` is the FK. Backfill: `actor_id = (SELECT id FROM raft_accounts WHERE display_name = audit_logs.actor LIMIT 1)` or NULL.

## 4. Invitation flow

### 4.1 Owner creates invite

```
1. Org admin clicks "+ Invite member" → modal:
   - Email: alice@example.com
   - Scope: org-level (Admin role) OR app-level (App + Role)
   - Message: (optional)
   
2. Server:
   - Insert into invites (status='pending', expires_at=now+7d)
   - Generate signed magic-link token: `${invite.id}.${hmac_sha256(secret, invite.id)}`
   - Send email: "You've been invited to Acme Corp. Click here to accept."
     Link: https://quiver.oranix.io/invites/${token}

3. If email not in raft_accounts yet, also send a "sign up to claim invite" hint
```

### 4.2 Recipient accepts invite

```
1. Recipient clicks link → lands on /invites/:token

2. If not signed in to Raft:
   - Redirect to /login/raft/callback?return_to=/invites/:token
   - After OAuth, bounce back to /invites/:token
   
3. Server validates token:
   - HMAC matches
   - Invites row exists, status='pending'
   - Not expired
   
4. Look up raft_accounts by email:
   - If exists → link raft_accounts.id to invite
   - If not exists → create stub raft_accounts row (will be enriched on first login)
   
5. Insert org_member / app_member with role from invite
6. Update invite: status='accepted', accepted_at=now, accepted_by=account_id
7. Redirect to /apps/{appId} or / (org dashboard)
```

### 4.3 Resend / revoke

- **Resend** — owner clicks "Resend" on pending invite → resets expires_at = now+7d, sends new email
- **Revoke** — owner clicks "Revoke" → status='revoked', revoked_at=now, token invalidated
- **Auto-expire** — Worker Cron runs daily, sets status='expired' for pending invites past expires_at

## 5. Authorization middleware

### 5.1 Replace current auth with role-aware auth

Current `authMiddleware` (in `worker/src/middleware/auth.ts`) only verifies Raft session cookie. We need:

```typescript
// After Raft auth succeeds:
const account = c.get("cf_account");  // raft_accounts row
const url = new URL(c.req.url);

// Route guards:
// 1. /api/auth/* — no guard (login flow)
// 2. /api/apps/* — requires org member (any role) for GET, admin for mutations
// 3. /api/apps/:appId/* — requires app member (any role) for GET, app admin for mutations
// 4. /api/organizations/* — requires org member (any role)
// 5. /api/organizations/:orgId/members — requires org admin
// 6. /api/invites/* — requires org admin to create, public to accept

// Implementation: a single helper getEffectiveRole(c, orgId, appId?) that
// runs a single SQL JOIN and returns 'admin' | 'publisher' | 'viewer' | null
```

### 5.2 Role matrix

| Endpoint | Required role |
|---|---|
| `GET /api/apps` | any org member |
| `POST /api/apps` | org admin |
| `GET /api/apps/:id` | app member OR org admin |
| `PATCH /api/apps/:id` (incl. archive) | app admin OR org admin |
| `DELETE /api/apps/:id` | app admin OR org admin |
| `POST /api/apps/:id/channels` | app admin |
| `PATCH /api/apps/:id/channels/:cid` | app admin |
| `DELETE /api/apps/:id/channels/:cid` | app admin |
| `POST /api/parse-apk` | app publisher OR app admin |
| `POST /api/apps/:id/upload` | app publisher OR app admin |
| `POST /api/apps/:id/versions` | app publisher OR app admin |
| `PATCH /api/apps/:id/versions/:vid` | app publisher OR app admin |
| `DELETE /api/apps/:id/versions/:vid` | app admin |
| `GET /api/apps/:id/operations` | app member |
| `POST /api/apps/:id/operations/:oid/retry` | app publisher OR app admin |
| `DELETE /api/apps/:id/operations/:oid` | app admin |
| `POST /api/invites` | org admin |
| `DELETE /api/invites/:id` | org admin |
| `GET /api/invites/:token` | public (with valid token) |

### 5.3 Agent (Raft `type='agent'`) handling

**Agents are first-class principals.** They can log in via Login with Raft the same way humans do, get a session cookie, and act on Hands with the same per-endpoint RBAC checks.

Default role assignment on first login:
- Human: `org_role='member'`, `app_role=null` (not a member of any app yet — must be granted per app)
- Agent: `org_role='viewer'`, `app_role=null`

Admin can promote an agent to `publisher` or `admin` explicitly via the same UI as for humans — there's no separate "agent permissions" page.

Audit log captures `actor_type='agent'` for all agent actions. UI shows an "agent" badge next to the actor's name.

**Why we didn't do "first-class agent permissions" as a separate dimension:** Humans and agents have the same actions in Hands (create app, upload build, release, etc.). The only difference is the default role + UI affordances. A future "automation only" or "agent-token" distinction can be added on top of `actor_type` if needed (e.g., a "machine tokens" page).

## 6. Admin UI changes

### 6.1 Top-bar: org switcher

```
[ Hands ]  [ Acme Corp ▾ ]   [ alice@acme.com ▾ ]
                              ├─ Switch organization…
                              ├─ Org settings
                              ├─ Team members
                              └─ Sign out
```

If user is only in one org, dropdown hidden. If in multiple, dropdown lets them switch.

### 6.2 Org settings page (new)

```
URL: /orgs/:orgId
Tabs: General | Members | Invites | Audit | Billing (later)
```

- **General**: name, slug (read-only after first save), danger zone (delete org)
- **Members**: table (avatar + name + email + role + joined_at + last_seen), edit role, remove
- **Invites**: table of pending invites (email + role + expires + invited_by + actions: resend/revoke)
- **Audit**: filtered view of audit_logs scoped to org (with cross-app aggregation)

### 6.3 App access control tab (new in AppDetail)

```
URL: /apps/:appId → "Access" tab
```

- Members table (per-app): name + email + role + joined_at + actions
- "+ Invite to this app" button → modal: email + role + scope = this-app
- "Move to org" button (admin only) — transfers app to a different org the user is owner of (v2)

### 6.4 Invite acceptance page (public, no auth required initially)

```
URL: /invites/:token
```

- Shows: org/app name, role being granted, inviter, optional message
- Buttons: "Sign in with Raft to accept" (if not signed in), "Decline"
- After accept: redirect to /apps/:appId or /

## 7. Implementation phases

This is a NEW phase (Phase 5), larger than Phase 1-2. Estimated ~3-4 weeks.

### Phase 5.0 — auth context injection (implemented with 5.1) (0.5 day)

Before adding org tables, the auth flow needs to know which org a principal is in. Modify `worker/src/routes/auth.ts`:
- On successful Raft login, after upserting `raft_accounts`, **upsert the org** (idempotent: one org per `(external_provider='raft', external_id=server_id)`).
- Upsert `org_members` row linking `raft_accounts.id` to `org.id`:
  - First principal on a server: role='owner' if human, 'admin' if agent
  - Subsequent principals: default role='member' (human) or 'viewer' (agent)
  - Honor an explicit role in the JWT `server_role` claim if present (e.g., if Raft says the principal is an admin, set Hands org_role='admin' on first join)
- The new session is enriched with `c.get("org_id")` and `c.get("org_role")` for downstream middleware.

This is a small change to `worker/src/routes/auth.ts` that makes org context available everywhere. The required tables are introduced by P5.1, so deployment order is: apply the P5.1 migration first, then deploy the auth-context code.

### Phase 5.1 — schema + bootstrap (1 day)

- Migration `0016_account_org_team.sql` (use 0016+ since 0008-0015 are taken):
  - Create `organizations`, `org_members`, `app_members`, `invites`
  - Add `apps.org_id`, `audit_logs.actor_id`, `audit_logs.actor_type`
  - Backfill: insert default orgs per distinct `server_id` in `raft_accounts`, link all existing raft_accounts to their org, link all existing apps to a 'default' org (Phase 5.0 already linked raft accounts to the right orgs at login time)
- No UI changes yet

### Phase 5.2 — auth helpers (2 days)

- New `worker/src/lib/permissions.ts` with:
  - `getOrgMemberRole(db, orgId, accountId): Promise<'owner'|'admin'|'member'|null>`
  - `getAppMemberRole(db, appId, accountId): Promise<'admin'|'publisher'|'viewer'|null>`
  - `getEffectiveRole(db, orgId?, appId?, accountId): Promise<...>` — MAX of both
  - `requireRole(c, minRole)` — middleware that 403s if effective role < required
- Update existing routes to use `requireRole` middleware instead of just `authMiddleware`
- `currentActor(c)` returns `{id, type, display_name}` (replaces plain string)

### Phase 5.3 — invites + magic link (3 days)

- `worker/src/routes/invites.ts`:
  - `POST /api/organizations/:orgId/invites` (org admin) — create invite, send email
  - `GET /api/invites` (org admin) — list pending invites
  - `DELETE /api/invites/:id` (org admin) — revoke
  - `POST /api/invites/:id/resend` (org admin) — reset expires_at, resend email
  - `GET /api/invites/:token` (public) — show invite details
  - `POST /api/invites/:token/accept` (auth required) — link account, create membership
- Email sender: use Cloudflare Email Service with a transactional template
- Magic link format: `https://quiver.oranix.io/invites/${token}` with HMAC signature

### Phase 5.4 — org settings UI + access tab (3 days)

- New `admin/src/pages/OrgSettings.tsx` (general / members / invites / audit tabs)
- New `admin/src/pages/AcceptInvite.tsx` (public magic link landing)
- AppDetail: new "Access" tab showing app_members + invite-to-app
- Top-bar: org switcher dropdown

### Phase 5.5 — agent permissions + audit (2 days)

- Raft agent accounts default to org_role='viewer', app_role='viewer'
- Org admin can promote via UI
- Audit log all role changes (invite.created, invite.accepted, member.role_changed, member.removed)

### Phase 5.6 — migrations, tests, docs (2 days)

- Migrate `currentActor` callers (audit log actor_id)
- Tests: invite flow, role enforcement, edge cases (expired token, double-accept, cross-org leakage)
- User guide: how to invite team members, role matrix reference

### Phase 5 total: ~13 days (~2.5 weeks)

## 8. Open questions

1. **Multi-org membership** — can a Raft account be in multiple Hands orgs? **Yes** (raft_accounts.org_id is the *primary* org from Login with Raft, but they can be members of many Hands orgs). Implementation: `org_members` already supports this.

2. **Self-hosted vs SaaS** — does this design work for self-hosted? **Yes** — single bootstrap org for self-hosted, multi-org SaaS for cloud. Migration handles both.

3. **Email delivery** — Cloudflare Email Service (worker binding) vs Resend vs SendGrid? Recommendation: Cloudflare Email Service (free, integrated). Fall back to SMTP if missing binding.

4. **Invite link domain** — for self-hosted, the magic link should use the worker's domain. For SaaS, use the vanity domain. The backend now derives the origin from the incoming request instead of a fixed `APP_ORIGIN` env var.

5. **Role hierarchy** — is `org_owner` > `org_admin` > `org_member` enough? Or do we need custom roles (like Discord)? Recommendation: v1 fixed roles; v2 custom role builder if needed.

6. **App transfer** — owner can transfer an app to a different org they own. Out of scope for v1? Recommendation: defer to v2. v1 only allows app deletion + re-creation.

7. **Public apps** — can an app be "public" (no auth required to read latest version)? Recommendation: defer to v2; current public API uses different code path that doesn't need auth.

8. **Two-factor / SSO** — out of scope for v1, but the role system shouldn't preclude it. Use Raft's auth, which handles 2FA.

## 9. References

- Vercel Teams model: https://vercel.com/docs/teams
- Supabase Organizations: https://supabase.com/docs/guides/platform/orgs
- Cloudflare Accounts: https://developers.cloudflare.com/fundamentals/accounts/
- Hands existing auth: `worker/src/middleware/auth.ts` + `migrations/sql/0004_raft_auth.sql`
- Hands audit log: `migrations/sql/0001_init.sql` + `worker/src/routes/audit.ts`

## 10. Tracking

These tasks will be added to `docs/publish-tasks.md` as Phase 5:

- `P5.1` — schema migration + backfill (1 day)
- `P5.2` — auth helpers + role middleware (2 days)
- `P5.3` — invites + magic link (3 days)
- `P5.4` — org settings UI + access tab + accept page (3 days)
- `P5.5` — agent permissions + audit (2 days)
- `P5.6` — tests + docs (2 days)

**Total**: 13 days (~2.5 weeks)

Depends on: existing Login with Raft migration `0004_raft_auth.sql` (the `raft_accounts` + `raft_sessions` tables form the user identity layer this builds on).
