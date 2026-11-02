import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from '../../worker/scripts/inspect-staged-asset.mjs';
const build = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const asset = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const app = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const env = { CLOUDFLARE_API_TOKEN: 'private-token', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), HANDS_D1_DATABASE_ID: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', HANDS_R2_BUCKET_NAME: 'hands-artifacts', R2_S3_ACCESS_KEY_ID: 'private-access', R2_S3_SECRET_ACCESS_KEY: 'private-secret', QUERY_BUILD_ID: build, QUERY_ASSET_ID: asset };
const row = { app_id: app, build_id: build, asset_id: asset, attempt: 1, state: 'pending', staging_key: `apps/${app}/build-ingest/pending/${build}/${asset}/1/private-filename`, declared_size: 12, upload_expires_at: 123456 };
const database = value => Response.json({ success: true, result: [{ success: true, results: value }] });
test('issues only the fixed database read and HEAD for the exact pending asset', async () => {
  const calls = [];
  const result = await inspect(env, async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) {
      const body = JSON.parse(options.body);
      assert.match(body.sql, /^SELECT\b/);
      assert.deepEqual(body.params, [build, asset]);
      return database([row]);
    }
    assert.equal(options.method, 'HEAD');
    assert.equal(options.redirect, 'error');
    assert.match(url, /^https:\/\/[a-f0-9]{32}\.r2\.cloudflarestorage\.com\//);
    return new Response(null, { status: 200, headers: { 'content-length': '12' } });
  });
  assert.deepEqual(result, { result: 'upload_found', state: 'pending', upload_expires_at: 123456, object: 'present', status: 200, size_matches: true });
  assert.ok(!JSON.stringify(result).includes('private'));
  assert.equal(calls.length, 2);
});
test('reports a size mismatch and absence or access failure without exposing object data', async () => {
  let count = 0;
  const mismatch = await inspect(env, async () => ++count === 1 ? database([row]) : new Response(null, { status: 200, headers: { 'content-length': '11' } }));
  assert.equal(mismatch.object, 'present'); assert.equal(mismatch.size_matches, false);
  for (const [status, object] of [[404, 'not_found'], [403, 'unavailable']]) {
    let n = 0;
    const result = await inspect(env, async () => ++n === 1 ? database([row]) : new Response(null, { status }));
    assert.equal(result.object, object); assert.equal(result.status, status); assert.equal('size_matches' in result, false);
  }
});
test('skips HEAD after upload leaves pending and rejects untrusted rows', async () => {
  let n = 0;
  const result = await inspect(env, async () => { n++; return database([{ ...row, state: 'ready' }]); });
  assert.equal(result.object, 'not_checked'); assert.equal(n, 1);
  for (const bad of [{ ...row, staging_key: 'other/object' }, { ...row, asset_id: build }, { ...row, declared_size: -1 }]) {
    await assert.rejects(inspect(env, async () => database([bad])));
  }
});
test('reports empty record and rejects malformed identifiers', async () => {
  assert.deepEqual(await inspect(env, async () => database([])), { result: 'upload_not_found' });
  await assert.rejects(inspect({ ...env, QUERY_BUILD_ID: 'bad' }, async () => { throw new Error('must not call'); }));
});
