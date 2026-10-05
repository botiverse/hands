import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { createCipheriv, publicEncrypt, randomBytes, constants } from 'node:crypto';
const sites = ['authenticateReporter', 'loadDeployToken', 'handleListReporterFeedback', 'handleBindReporterRouteSubject', 'consumeRateLimit', 'computeReporterAuditHash', 'auditReadStatement', 'httpResponseTelemetry', 'reporterHash', 'authorize'];
const tables = ['app_reporter_integrations', 'app_reporter_routes', 'app_deploy_tokens', 'feedback_reporter_rate_windows', 'feedback_reporter_access_audits', 'feedback_reporter_ticket_reads', 'feedback_tickets', 'feedback_comments', 'feedback_attachments', 'apps', 'audit_logs'];
const properties = ['results', 'changes', 'batch', 'prepare', 'message', 'scopes', 'meta', 'id', 'first', 'trim'];
function strings(value, depth = 0) {
  if (depth > 8) return [];
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(v => strings(v, depth + 1));
}
function requestReference(event) {
  const id = event?.$metadata?.requestId;
  return typeof id === 'string' && /^[a-f0-9-]{16,64}$/i.test(id) ? { request_id: id } : {};
}
export function summarizeResponse(event) {
  const m = event?.$metadata ?? {};
  if (m.statusCode !== 500 || typeof m.url !== 'string') return null;
  let url; try { url = new URL(m.url); } catch { return null; }
  const route = /^\/api\/apps\/[^/]+\/reporter-feedback$/.test(url.pathname) ? 'reporter_list'
    : /^\/api\/apps\/[^/]+\/reporter-feedback\/route-subject$/.test(url.pathname) ? 'reporter_route_subject' : null;
  if (!route) return null;
  return { ...requestReference(event), route, status: 500, origin: url.hostname === 'hands.build' ? 'production' : url.hostname === 'hands.test' ? 'test' : 'other', ...(Number.isSafeInteger(event.timestamp) ? { timestamp: event.timestamp } : {}) };
}
export function summarizeEvent(event) {
  const metadata = event?.$metadata ?? {};
  const source = event?.source;
  const text = strings([metadata.error, metadata.message, typeof source === 'string' ? source : [source?.message, source?.error, source?.stack, source?.exceptions]]).join('\n');
  const isError = metadata.level === 'error' || typeof metadata.error === 'string';
  if (!isError) return null;
  let category = 'unknown';
  if (/constraint failed|SQLITE_CONSTRAINT/i.test(text)) category = 'sqlite_constraint';
  else if (/no such (?:table|column)|has no column named/i.test(text)) category = 'sqlite_schema';
  else if (/SQLITE_BUSY|database is locked/i.test(text)) category = 'sqlite_busy';
  else if (/Network connection lost|D1 DB is unavailable|D1_ERROR.*(?:overloaded|reset|timeout)/i.test(text)) category = 'd1_unavailable';
  else if (/D1_ERROR|SQLITE_ERROR/.test(text)) category = 'database_error';
  else if (/TypeError/.test(text)) category = 'type_error';
  const diagnostic = { ...requestReference(event), category, sites: sites.filter(site => text.includes(site)) };
  // Only known repository table/property names survive, never arbitrary SQL,
  // query parameters, message text, URLs, stack traces or request identities.
  if (category === 'sqlite_schema') diagnostic.schema_objects = tables.filter(table => new RegExp(`no such table:\\s*${table}\\b`, 'i').test(text));
  if (category === 'type_error') diagnostic.properties = properties.filter(property => text.includes(`reading '${property}'`) || text.includes(`reading "${property}"`));
  if (Number.isSafeInteger(event?.timestamp)) diagnostic.timestamp = event.timestamp;
  return diagnostic;
}
export function sealException(event, publicKey) {
  const source = event?.source;
  // Deliberately exclude request, headers, bindings and the Workers envelope.
  const detail = { error: event?.$metadata?.error, message: event?.$metadata?.message,
    source: typeof source === 'string' ? source : { message: source?.message, error: source?.error, stack: source?.stack, exceptions: source?.exceptions },
    exceptions: event?.$workers?.exceptions, logs: event?.$workers?.logs,
    structure: { keys: Object.keys(event ?? {}), source_keys: source && typeof source === 'object' ? Object.keys(source) : [], worker_keys: Object.keys(event?.$workers ?? {}) } };
  const plaintext = Buffer.from(JSON.stringify(detail));
  if (plaintext.length > 65536) throw new Error('Exception exceeds sealed diagnostic limit');
  const key = randomBytes(32), iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ...requestReference(event), algorithm: 'RSA-OAEP-SHA256+AES-256-GCM',
    encrypted_key: publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key).toString('base64'),
    iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}
export function queryBody(from, to, worker) {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from || to - from > 300_000) throw new Error('Query must be a valid window of at most five minutes');
  if (!/^[a-zA-Z0-9_-]{1,63}$/.test(worker)) throw new Error('Configured Worker name is invalid');
  return { queryId: 'hands-reporter-incident', dry: true, view: 'events', limit: 500, timeframe: { from, to }, parameters: { filters: [{ key: '$metadata.service', operation: 'eq', type: 'string', value: worker }] } };
}
export async function main(env = process.env, fetcher = fetch) {
  const { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account, HANDS_WORKER_NAME: worker } = env;
  if (!token || !/^[a-f0-9]{32}$/.test(account ?? '')) throw new Error('Cloudflare query credentials are not configured');
  const body = queryBody(Number(env.QUERY_FROM_MS), Number(env.QUERY_TO_MS), worker ?? '');
  const response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/observability/telemetry/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Cloudflare historical query returned HTTP ${response.status}`);
  const data = await response.json();
  if (data.success !== true) throw new Error('Cloudflare historical query was unsuccessful');
  const events = data.result?.events?.events;
  if (!Array.isArray(events)) throw new Error('Cloudflare historical query returned an unsupported response shape');
  const diagnostics = events.map(summarizeEvent).filter(Boolean);
  const reference = env.QUERY_EXCEPTION_REQUEST_ID;
  if (reference && !/^[a-f0-9-]{16,64}$/i.test(reference)) throw new Error('Invalid exception request reference');
  const matchedErrors = reference ? events.filter(event => requestReference(event).request_id === reference) : [];
  if (matchedErrors.length > 10) throw new Error('Too many exceptions for sealed diagnostic');
  const publicKey = reference ? readFileSync(new URL('./reporter-query-public.pem', import.meta.url)) : null;
  const sealed_exceptions = matchedErrors.map(event => sealException(event, publicKey));
  console.log(JSON.stringify({ from: body.timeframe.from, to: body.timeframe.to, returned_events: events.length, possibly_truncated: events.length >= body.limit, error_events: diagnostics.length, diagnostics, sealed_exceptions, failed_requests: events.map(summarizeResponse).filter(Boolean) }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    const safe = error instanceof Error && /^Cloudflare historical query returned HTTP [0-9]{3}$/.test(error.message) ? error.message : 'Reporter log query failed; credentials and response content withheld.';
    console.error(safe); process.exitCode = 1;
  });
}
