import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeEvent, summarizeResponse, summarizeAssetResponse, queryBody, main, sealException } from './query-reporter-errors.mjs';
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

test('reports only fixed upload routes for one exact build without exposing paths or query data', () => {
  const app = 'a'.repeat(8)+'-'+('a'.repeat(4)+'-').repeat(3)+'a'.repeat(12);
  const build = 'b'.repeat(8)+'-'+('b'.repeat(4)+'-').repeat(3)+'b'.repeat(12);
  const asset = 'c'.repeat(8)+'-'+('c'.repeat(4)+'-').repeat(3)+'c'.repeat(12);
  const event = (path, status=500) => ({ timestamp: 123, $metadata: { statusCode: status, requestId: 'd'.repeat(32), url: `https://hands.build/api/apps/${app}/builds/${build}/assets/${path}?token=private` } });
  const expected = { request_id: 'd'.repeat(32), timestamp: 123, status: 500 };
  assert.deepEqual(summarizeAssetResponse(event('uploads'),build), { ...expected, route: 'asset_declare' });
  assert.deepEqual(summarizeAssetResponse(event(`${asset}/upload/complete`,200),build), { ...expected, status: 200, route: 'asset_complete' });
  assert.equal(summarizeAssetResponse(event('uploads'),asset), null);
  assert.equal(summarizeAssetResponse(event(`${asset}/upload`),build), null);
  assert.equal(summarizeAssetResponse(event('uploads'), 'bad-build'), null);
  assert.equal(summarizeAssetResponse(event('uploads', 700),build), null);
  assert.equal(summarizeAssetResponse(event('uploads', '500'),build), null);
  assert.equal(summarizeAssetResponse({ $metadata: { statusCode: 500, url: `https://other.example/api/apps/${app}/builds/${build}/assets/uploads` } },build), null);
  assert.ok(!JSON.stringify(summarizeAssetResponse(event('uploads'),build)).includes('private'));
});

test('the query returns upload outcomes only when a valid build UUID is supplied', async () => {
  const build = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const env = { CLOUDFLARE_API_TOKEN: 'private-token', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), HANDS_WORKER_NAME: 'hands-worker', QUERY_FROM_MS: '0', QUERY_TO_MS: '5', QUERY_ASSET_BUILD_ID: build };
  const event = { timestamp: 123, $metadata: { requestId: 'a'.repeat(32), statusCode: 500, url: `https://hands.build/api/apps/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/builds/${build}/assets/uploads?token=private` } };
  const original = console.log; const output = []; console.log = value => output.push(JSON.parse(value));
  try {
    const fetcher = async () => Response.json({ success: true, result: { events: { events: [event] } } });
    await main(env, fetcher);
    assert.deepEqual(output[0].asset_requests, [{ request_id: 'a'.repeat(32), timestamp: 123, status: 500, route: 'asset_declare' }]);
    assert.ok(!JSON.stringify(output).includes('private'));
    await assert.rejects(main({ ...env, QUERY_ASSET_BUILD_ID: 'bad' }, fetcher), /Invalid build UUID/);
  } finally { console.log = original; }
});

test('request headers and payload cannot impersonate an exception cause', () => {
  const row = summarizeEvent({ $metadata: { level: 'error', error: "TypeError: Cannot read properties of undefined (reading 'results')" }, source: { request: { body: 'SQLITE_CONSTRAINT loadDeployToken', authorization: 'Network connection lost' } }, $workers: { request: { body: 'no such table: app_reporter_routes' } } });
  assert.deepEqual(row, { category: 'type_error', sites: [], properties: ['results'] });
});


test('seals only exception fields, with authenticated encryption for the fixed recipient', async () => {
  const { generateKeyPairSync, privateDecrypt, createDecipheriv, constants } = await import('node:crypto');
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const event = { $metadata: { error: 'private-error', requestId: 'a'.repeat(32) }, source: { stack: 'private-stack', request: { authorization: 'excluded-secret' } }, $workers: { env: 'excluded-binding' } };
  const sealed = sealException(event, publicKey);
  assert.ok(!JSON.stringify(sealed).includes('private-'));
  const key = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(sealed.encrypted_key, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, 'base64')), decipher.final()]).toString();
  assert.deepEqual(JSON.parse(plaintext), { error: 'private-error', source: { stack: 'private-stack' }, structure: { keys: ['$metadata', 'source', '$workers'], source_keys: ['stack', 'request'], worker_keys: ['env'] } });
  assert.ok(!plaintext.includes('excluded'));
  const wrongKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  assert.throws(() => privateDecrypt({ key: wrongKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(sealed.encrypted_key, 'base64')));
  assert.throws(() => sealException({ $metadata: { error: 'x'.repeat(65537) } }, publicKey));
});

test('opt-in seals all log levels only for the exact request and caps matched records', async () => {
  const env = { CLOUDFLARE_API_TOKEN: 'private-token', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), HANDS_WORKER_NAME: 'hands-worker', QUERY_FROM_MS: '0', QUERY_TO_MS: '5', QUERY_EXCEPTION_REQUEST_ID: 'a'.repeat(32) };
  const error = { $metadata: { level: 'error', requestId: 'a'.repeat(32), error: 'private-error' } };
  const other = { $metadata: { level: 'error', requestId: 'b'.repeat(32), error: 'other-private-error' } };
  const original = console.log; const output = []; console.log = value => output.push(JSON.parse(value));
  try {
    await main(env, async () => Response.json({ success: true, result: { events: { events: [error, other, { $metadata: { level: 'info', requestId: 'a'.repeat(32), message: 'private-info' } }] } } }));
    assert.equal(output[0].sealed_exceptions.length, 2);
    assert.equal(output[0].sealed_exceptions[0].request_id, 'a'.repeat(32));
    assert.ok(!JSON.stringify(output).includes('private-'));
    await assert.rejects(main(env, async () => Response.json({ success: true, result: { events: { events: Array(11).fill(error) } } })), /Too many exceptions/);
  } finally { console.log = original; }
});
