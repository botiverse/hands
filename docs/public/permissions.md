# App roles and permissions

Access to an app is granted two ways, and they are not interchangeable:

- a **role** — `viewer`, `publisher`, or `admin` — held by a person, or, for the
  first two only, by a token;
- a **permission** — `feedback:read`, `app:publish`, and so on — granted explicitly
  to a token.

**They mostly govern different endpoints, and they overlap on six.** Read the
next section before assuming a permission name means what it sounds like.

## The part that surprises people

**Roles govern almost all of the console API.** Publishing a release, managing
members, reading builds — these check a role, never a permission.

**Six feedback endpoints are the exception.** They accept *either* the role or an
explicit permission, so an integration can read and answer feedback without
holding `publisher`, which also ships releases:

| Endpoint | Accepts the role | …or the permission |
|---|---|---|
| List tickets | `viewer` | `feedback:read` |
| Ticket detail | `viewer` | `feedback:read` |
| Ticket attachment | `viewer` | `feedback:read` |
| Material-delta feed | `viewer` | `feedback:read` |
| Update status / assignee | `publisher` | `feedback:triage` |
| Post a **public reply** | `publisher` | `feedback:comment` |
| Post an **internal note** | `publisher` | `feedback:triage` |

The last two are one endpoint, separated by the request body. It admits a token
holding either permission and then checks again against the action actually
requested: `feedback:comment` cannot write an internal note, and
`feedback:triage` cannot reply to the reporter. **Reaching the endpoint is not
the same as being allowed the action.**

The "role" column is not only the app-level role. These endpoints also admit an
organization-level role on the app's organization — `viewer` for the four reads,
`member` for the two writes. **Someone can therefore reach these endpoints
holding no app role and no permission at all.** If you are working out who can
act, that path is easy to forget and it is not visible in an app's member list.

**The binding decides the scope, not the permission name.** A token bound to a
reporter integration is confined to that integration's tickets and is refused
outright on the console endpoints above. An *unbound* token holding the same
`feedback:read` reads the app's whole ticket list. Same permission, different
reach. The permission says what you may do; the binding says what you may do it
to.

## Roles

| Role | Intended for | Who can hold it | Also carries |
|---|---|---|---|
| `viewer` | Reading an app's data | People and tokens | `app:read` |
| `publisher` | CI and release automation | People and tokens | `app:read`, `app:publish`, `feedback:write` |
| `admin` | Managing the app itself | **People only** | `app:read`, `app:publish`, `app:admin`, `feedback:write` |

Roles are cumulative in the order above.

**`admin` cannot be granted to a token as a role.** Issuance rejects it; the role
exists on the membership path only, so an admin-level action needs a person.

Read that as a statement about the role, not about the name. **`app:admin` can
still appear on a token as an explicit scope** — issuance accepts it — but no
route accepts that permission, so it opens nothing.

**Grant only the scopes you need now. Never add one because it currently does
nothing** — it will start working the moment a route accepts it, with no new
issuance, no re-grant, and no audit event against the token. The change is
recorded as a code and deployment change rather than an authorization one, so if
you are ever working out when a token gained an ability, **the answer is in
deploy history, not in grant history.**

**`publisher` and `admin` carry `feedback:write` in their effective set**, so
holders of those roles never need it added separately.

**`feedback:triage` deliberately does not work this way.** No role carries it, so
it is held only where someone chose to grant it — which is the point of having it
separate from `publisher` at all.

Two audit questions look alike here and have different answers:

- **"Who holds `feedback:triage`?"** — the explicit grants are the whole answer,
  precisely because no role bundles it.
- **"Who can triage?"** — the grants are *not* the whole answer. Those endpoints
  accept a role as well, so the list also includes anyone reaching them by role.
  A permission-only audit will under-report who can act.

## Permissions

**Only the `feedback:*` permissions currently open a door on their own.** The six
endpoints listed above are the only ones that accept a permission; every other
console route is guarded by a role. So the `app:*` names below describe what a
role *carries*, and appear in a token's effective set, but **granting one to a
role-free token does not let it do the corresponding thing** — that path is
reached by holding the role.

| Permission | Meaning | Does **not** grant |
|---|---|---|
| `app:read` | Carried by every role; the reading half of app access | Console entry on its own — no route accepts it |
| `app:publish` | Carried by `publisher` and `admin`; builds, releases, distribution assets | Console entry on its own; app settings or member changes |
| `app:admin` | Carried by `admin`; settings, members, credentials, destructive operations | Console entry on its own; anything in another app |
| `feedback:write` | **File a ticket on a user's behalf** from a trusted server proxy. Requires a reporter-integration binding | **Any staff-side handling. This is not a support or triage permission.** |
| `feedback:read` | Read tickets, their detail, attachments and the material-delta feed. Scope follows the token's binding | Any write |
| `feedback:comment` | Post a **public reply** the reporter sees. A **bound** token may also **close** that reporter's own ticket | Internal notes; assignee; reopening; any other status change |
| `feedback:triage` | Change status and assignee, write **internal notes** | Replying to the reporter |
| `feedback:route` | Bind an opaque route subject to a reporter integration. Requires a reporter-integration binding | Reading or writing ticket content |

`feedback:write` is the one most often misread. It means *this server may file a
ticket for a user*. It grants nothing on the staff side.

## How a token's access is computed

A token may carry a role, a list of permissions, or both.

    effective access = the role's permissions ∪ the explicitly granted permissions

**Permissions add to a role; they never narrow one.** Issuing a `publisher` token
"restricted" to `feedback:read` produces a token with everything `publisher` has
*plus* `feedback:read`. To issue a token limited to specific permissions, give it
**no role** and list only those permissions.

One safety rule worth knowing: a token whose permission list is present but
**empty** resolves to no access at all, rather than falling back to its role. An
unreadable or corrupt grant fails closed.

## Choosing a grant

- **CI that publishes releases** — role `publisher`, no extra permissions.
- **A server that files tickets for your users** — no role, permission
  `feedback:write`, **bound to an active reporter integration**. Issuance refuses
  this permission on an unbound token, so the binding is not optional.
- **A reporter integration** — no role, `feedback:read` and `feedback:comment`,
  bound to the integration. **Note that `feedback:comment` also lets it close a
  reporter's own ticket** — see the permission table.
- **Support automation that reads and answers feedback** — no role,
  `feedback:read` + `feedback:comment`, **unbound**. It cannot publish, change
  status, or write internal notes.
- **Automation that triages internally** — no role, `feedback:read` +
  `feedback:triage`. It cannot speak to the reporter.
- **A person who only needs to look** — role `viewer`.

`feedback:comment` and `feedback:triage` are independent, not a hierarchy:
handling a ticket internally does not imply permission to talk to the customer,
and neither implies the other.

Prefer the narrowest that works, and prefer explicit permissions over a role when
the job is narrow: a role brings everything below it, permanently, including
capabilities added to that role later.
