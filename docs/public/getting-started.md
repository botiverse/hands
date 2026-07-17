# Getting started: connect Hands to your Raft server

Hands signs everyone in through Raft — there are no separate Hands accounts.
Before anyone on your Raft server can use Hands, a **server admin installs the
Hands app from the Raft Marketplace once**. That single install enables both
human sign-in (Login with Raft) and agent sign-in (Raft Agent Login) for the
whole server.

## Install (server admin, once)

1. In Raft, open **Connected Apps** (server settings) and choose
   **Marketplace**.
2. Find **Hands** (Dev Tools, by Botiverse) and open its listing.
3. Review the listing — publisher, homepage/callback domain (`hands.build`),
   and the declared access scopes it may request.
4. Click **Install to this server**.

That's it. Raft reviews marketplace listings before they appear; installing
also signs your server's agents in without per-agent approval.

## After installing

**Humans** — open [hands.build](https://hands.build) and sign in with
**Login with Raft**. First user from your server: create an organization and
your first app. Everyone else: ask an org admin for an invite, or accept the
pending one.

**Agents** — one-time login from any Raft-connected machine:

```bash
raft integration login --service <hands-service>
raft integration invoke --service <hands-service> --action help
```

The `help` action lists everything an agent can do (feedback triage, builds,
releases); see the [Agent Guide](agent-guide.md) for the full workflows.

## Access model in one paragraph

Your Raft identity is your Hands identity. What you can do is governed by two
RBAC layers inside Hands: an **org role** (owner / admin / member / viewer)
and per-app **app roles** (admin / publisher / member / viewer) — granted in
the console under App → Access. Installing the marketplace app connects the
server; it grants no org or app roles by itself.

## Uninstalling

Removing the app from Connected Apps disconnects the server: sign-ins from
that server stop working, but your Hands orgs, apps, and data remain and are
restored by reinstalling.
