# Raft App Template

Quiver is a concrete example of a Raft-native operational app: humans use the
browser console, agents use the same authenticated API and CLI, and the public
site documents the contract. This template extracts the reusable shape for new
Raft apps.

Use it when starting a product that should be operated by humans and AI agents
inside Raft, not just a standalone web console.

## Template goals

| Goal | Required pattern |
|---|---|
| Human access | Login with Raft as the production login path. |
| Agent access | Raft Agent Login returns a Bearer token usable against `/api/*`. |
| API contract | OpenAPI is generated from route definitions and served at `/openapi.json`. |
| Agent usability | Common workflows have CLI or documented curl equivalents with JSON output. |
| Public docs | User and agent docs are served by the app, not only stored in the repo. |
| Auditability | Mutations record actor identity, actor type, and scoped permissions. |
| Release discipline | CI creates drafts or previews; humans/agents explicitly publish production changes. |

## Repository layout

Keep the app boring and easy for agents to inspect:

```text
worker/                 # API, auth, storage, OpenAPI generation
admin/                  # Browser console and static docs shell
docs/public/            # Public docs served at /docs
packages/cli/           # Agent/CI-friendly command line client
migrations/             # Append-only database migrations
AGENTS.md               # First-page repository guide for agents
.github/workflows/      # Build, publish, deploy, and preview automation
```

For smaller apps, `packages/cli` can start as a thin wrapper over REST calls.
Do not wait for a full SDK before documenting the API and agent flow.

## Auth and identity

### Browser login

Production browser login should use Raft only:

- `GET /api/auth/login` starts Login with Raft.
- `GET /login/raft/callback` exchanges the code server-side.
- The app stores an HttpOnly session cookie.
- Browser JavaScript never sees Raft client secrets or session tokens.

### Agent login

Expose a Raft Agent Login manifest:

```http
GET /.well-known/raft-agent-manifest.json
```

Minimum shape:

```json
{
  "schema": "slock-agent-manifest.v0",
  "service": "my-service",
  "docs_url": "https://example.com/",
  "execution": {
    "mode": "http_api",
    "base_url": "https://example.com/api"
  },
  "context_check": {
    "url": "https://example.com/api/auth/me",
    "method": "GET"
  }
}
```

The callback path should return JSON for agents:

```json
{
  "ok": true,
  "token_type": "Bearer",
  "access_token": "...",
  "expires_at": 1780000000000,
  "account": {
    "principal_type": "agent",
    "display_name": "Codex"
  }
}
```

Agents then call admin APIs with:

```bash
Authorization: Bearer <access_token>
```

## Permissions

Model permissions around product resources, not raw routes.

| Scope | Example role | Use |
|---|---|---|
| Organization | `viewer`, `admin`, `owner` | Cross-app read, app creation, membership. |
| App | `viewer`, `publisher` | App-specific read and mutation. |
| Deploy token | `viewer`, `publisher` | CI or narrow automation for one app. |

Return `403` with the required role in the response. Agents should be able to
understand whether they need an org owner, app publisher role, or a deploy
token.

## API and OpenAPI

Generate the OpenAPI document from route definitions, not a hand-maintained
JSON file. The useful minimum:

- `GET /openapi.json` returns OpenAPI 3.1.
- `/api-docs` renders the same document.
- Auth endpoints, public endpoints, and admin endpoints are all represented.
- Error responses include stable `error` strings.
- Mutating routes document required roles in descriptions or response text.

For Hono apps, Quiver's pattern is:

```ts
const docs = new OpenAPIHono();
registerAuthRoutes(docs.openAPIRegistry);
registerPublicRoutes(docs.openAPIRegistry);
registerAppRoutes(docs.openAPIRegistry);

export const openApiDocument = docs.getOpenAPI31Document({
  openapi: "3.1.0",
  info: { title: "My App API", version: "0.1.0" },
});
```

## Agent-friendly CLI

An agent CLI should optimize for repeatable operations and parseable output:

- Read server URL and Bearer token from environment variables.
- Support `--json` for list/show/update commands.
- Accept stable slugs as well as UUIDs where possible.
- Print created resource ids and URLs exactly once.
- Keep secrets in env vars, not command arguments, when feasible.

Minimum command groups:

```text
myapp whoami
myapp resources list
myapp resources show <id>
myapp resources update <id> ...
myapp comments add <id> "..."
```

Document the no-action case clearly. If the Raft manifest is `http_api`,
`raft integration invoke --service <service> --list-actions` may return no
actions; agents should use Agent Login plus CLI or REST instead.

## Documentation set

Serve docs from the product origin. A practical first set:

| Page | Audience | Contents |
|---|---|---|
| Agent Guide | Agents | Login, token export, standard workflows, safety rules. |
| CLI Guide | Agents and CI | Install, auth env vars, commands, JSON mode. |
| Public API Reference | SDK/client authors | Public endpoints, request fields, errors. |
| Admin User Guide | Humans | Console workflows and role model. |
| Template/Architecture Guide | Maintainers | The reusable Raft app contract and checklist. |

Keep internal planning docs out of the public docs build unless they are meant
for users and third-party agents.

## Operational checklist

Before calling a Raft app "agent-native", verify:

- `raft integration login --service <service>` succeeds on a fresh agent.
- The returned Bearer token works with `/api/auth/me`.
- A non-admin agent receives useful `403` errors.
- `GET /openapi.json` covers the routes agents need.
- The docs site links agent auth, CLI, and API explorer from `/docs`.
- `AGENTS.md` tells repository agents where to start and how to validate.
- CLI commands can list, show, update, and comment on the main work item.
- Audit logs distinguish `human`, `agent`, `deploy-token`, and `system`.
- CI deploys docs and API changes together.
- Production-changing actions require explicit human/agent review.

## Implementation phases

- **Foundation**: Login with Raft, Agent Login manifest, `/api/auth/me`, session cookie, Bearer auth, basic roles.
- **Contract**: generated OpenAPI, API docs page, stable error shapes, public docs shell.
- **Agent operations**: CLI with `whoami`, list/show/update, JSON output, and an Agent Guide.
- **Governance**: audit logs, scoped deploy tokens, draft-first release or approval flow for production changes.
- **Polish**: public docs curation, examples, E2E smoke covering the main human/agent path.

Quiver currently implements this pattern for release management, feedback,
crash triage, share links, and app-scoped deploy tokens. New Raft apps should
copy the contract shape, not the Quiver domain model.
