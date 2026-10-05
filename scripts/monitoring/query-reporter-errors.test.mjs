import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeEvent, summarizeResponse, queryBody, main } from './query-reporter-errors.mjs';
test('extracts actionable classes and fixed sites without raw error or user data', () => {
  const event = { timestamp: 123, $metadata: { level: 'error', error: "D1_ERROR: no such table: app_reporter_routes private-token", url: 'https://private-body' }, source: { stack: 'at handleBindReporterRouteSubject private-user' } };
  assert.deepEqual(summarizeEvent(event), { timestamp: 123, category: 'sqlite_schema', sites: ['handleBindReporterRouteSubject'], schema_objects: ['app_reporter_routes'] });
  assert.ok(!JSON.stringify(summarizeEvent(event)).includes('private'));
  assert.deepEqual(summarizeEvent({ $metadata: { level: 'error', error: "TypeError: Cannot read properties of undefined (reading 'results') private-token" }, source: 'loadDeployToken' }), { category: 'type_error', sites: ['loadDeployToken'], properties: ['results'] });
  assert.equal(summarizeEvent({ $metadata: { level: 'info', message: 'private-body' } }), null);
});
test('rejects unbounded windows and malicious configuration', () => {
  for (const args of [[0, 300001, 'hands-worker'], [5, 5, 'hands-worker'], [NaN, 5, 'hands-worker'], [0, 5, 'private/path']]) assert.throws(() => queryBody(...args));
  const body = queryBody(0, 5, 'hands-worker'); assert.equal(body.dry, true); assert.equal(body.view, 'events');
});
test('uses only the query API and never prints token, response bodies or provider errors', async () => {
  const env = { CLOUDFLARE_API_TOKEN: 'private-token', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), HANDS_WORKER_NAME: 'hands-worker', QUERY_FROM_MS: '0', QUERY_TO_MS: '5' };
  const original = console.log; const output = []; console.log = value => output.push(value);
  try {
    await main(env, async (url, options) => {
      assert.equal(url, `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/workers/observability/telemetry/query`);
      assert.equal(options.method, 'POST');
      return Response.json({ success: true, result: { events: { events: [{ $metadata: { level: 'error', error: 'private-token' }, source: { authorization: 'private-token' } }] } } });
    });
    assert.ok(!output.join('').includes('private'));
    await assert.rejects(main(env, async () => new Response('private-token', { status: 403 })), /HTTP 403/);
  } finally { console.log = original; }
});

test('correlates only target failures with fixed origin/route labels', () => {
  const row = summarizeResponse({ timestamp: 123, $metadata: { statusCode: 500, requestId: 'a'.repeat(32), url: 'https://hands.build/api/apps/private-identity/reporter-feedback?token=private-token' } });
  assert.deepEqual(row, { request_id: 'a'.repeat(32), timestamp: 123, status: 500, route: 'reporter_list', origin: 'production' });
  assert.ok(!JSON.stringify(row).includes('private'));
  assert.equal(summarizeResponse({ $metadata: { statusCode: 200, url: 'https://hands.build/api/apps/x/reporter-feedback' } }), null);
});
