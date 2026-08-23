# `@botiverse/hands-node`

Pure-Node Hands logging and policy-governed log collection.

```ts
import { HandsLogger } from "@botiverse/hands-node";

const logger = new HandsLogger({ name: "worker" });
logger.info("auth", "login completed", { provider: "raft" }, "login_ok");
```

The signed collect-policy, bundle, and redaction contracts are exported from
`@botiverse/hands-node/logs/schema`.
# Shared Hands device identity

`getHandsDeviceId()` returns the Hands-owned OS-user scoped UUID v4 shared by
Hands clients. It is a rollout hint, not hardware identity or a credential.
Use `resetHandsDeviceId()` only for deliberate state reset; malformed state
fails with a typed error rather than silently rotating.
