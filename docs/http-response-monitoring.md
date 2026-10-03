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

The collector requests an unfiltered real-time tail (no sampling filter) and stops
after the configured number of hours. It reconnects after disconnection and records connection/parse
 gaps. Raw tail envelopes are never saved. Use a Raft reminder to inspect the
collector and report unexpected 400/5xx groups to the task thread. Reconcile the
collector process and gap records before claiming coverage; a tail has platform
limits and is not a guarantee of every production request. Report rates as
**observed response counts in a stated window**, not total production error rates.
Requests bypassing the business Worker (e.g. static assets) are outside this scope.

This replaces neither persistent Cloudflare logs nor a permanent alert service.
Six public endpoint probes only measure those six requests; they cannot detect
schema errors affecting authenticated user operations.

Use one stable output filename across restarts. The collector keeps the active
file and seven numbered generations, each at most 8 MiB (64 MiB total). Oldest
records are removed when capacity is reached, including old errors; export an
incident receipt separately when needed. Do not put timestamps in the output
filename: separate output families would each have their own cap.
Successful/redirect response counts are summed by status and flushed once per
minute, alongside a heartbeat with the number of observed tail events. Errors
400–599 retain individual records. A stop flushes pending counts; an abrupt
process kill may lose the last minute of counts. Include count records when
calculating an observed denominator. Read all retained generations and detect
retention loss before claiming a continuous window. This local disk cap does not
bound Cloudflare's own log storage or ingestion charges.
