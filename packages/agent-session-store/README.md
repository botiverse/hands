# @botiverse/agent-session-store

Fail-closed admission for a managed Raft agent, and atomic writes of that agent's
integration session to:

```text
$SLOCK_HOME/agents/<agentId>/integrations/<service>/auth.json
```

This package does **not** implement login, PKCE, or token exchange. Those stay in
each service CLI. The `<service>` slug is supplied by the caller (`hands-4cc7a2`,
`testbed`, …).

A partial agent environment never falls back to the host user's HOME or XDG config.
