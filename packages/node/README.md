# `@botiverse/hands-node`

Pure-Node Hands logging and policy-governed log collection.

```ts
import { HandsLogger } from "@botiverse/hands-node";

const logger = new HandsLogger({ name: "worker" });
logger.info("auth", "login completed", { provider: "raft" }, "login_ok");
```

The signed collect-policy, bundle, and redaction contracts are exported from
`@botiverse/hands-node/logs/schema`.
