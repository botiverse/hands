# HTTP response monitoring

The business Worker emits `hands_http_response` for final `/api/` responses,
including OpenAPI validation, authentication refusals, and handler failures.
The record contains method, route template, status, duration, timestamp and
Cloudflare request ID. It contains no bodies, full URLs, query strings,
account identities or credentials. Successful responses provide the denominator.

Run the agent-side collector with the deployed production configuration:

```sh
node scripts/monitoring/collect-http-responses.mjs \
  worker/node_modules/wrangler/wrangler-dist/cli.js \
  /path/to/production-config.json /path/to/private/http-responses.jsonl 24
```

The collector requests real-time tail sampling at 1 and stops after the configured
number of hours. It reconnects after disconnection and records connection/parse
 gaps. Raw tail envelopes are never saved. Use a Raft reminder to inspect the
collector and report unexpected 400/5xx groups to the task thread. Reconcile the
collector process and gap records before claiming coverage; a tail has platform
limits and is not a guarantee of every production request. Report rates as
**observed response counts in a stated window**, not total production error rates.
Requests bypassing the business Worker (e.g. static assets) are outside this scope.

This replaces neither persistent Cloudflare logs nor a permanent alert service.
Six public endpoint probes only measure those six requests; they cannot detect
schema errors affecting authenticated user operations.
