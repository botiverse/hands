import { AwsClient } from 'aws4fetch';
import { pathToFileURL } from 'node:url';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const sql = `SELECT b.app_id, b.id AS build_id, a.id AS asset_id,
                    i.attempt, i.state, i.staging_key, i.declared_size, i.upload_expires_at
             FROM builds b
             JOIN build_assets a ON a.build_id = b.id
             JOIN build_asset_ingest_attempt i ON i.asset_id = a.id
             WHERE b.id = ?1 AND a.id = ?2
             ORDER BY i.attempt DESC LIMIT 1`;

// Read one known upload, and issue HEAD only for its validated staging key.
// Never return the key, signed URL, credentials, or provider response bodies.
export async function inspect(env, fetcher = fetch) {
  const { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account,
    HANDS_D1_DATABASE_ID: database, HANDS_R2_BUCKET_NAME: bucket,
    R2_S3_ACCESS_KEY_ID: accessKeyId, R2_S3_SECRET_ACCESS_KEY: secretAccessKey,
    QUERY_BUILD_ID: build, QUERY_ASSET_ID: asset } = env;
  if (!token || !/^[a-f0-9]{32}$/.test(account ?? '') || !uuid.test(database ?? '') ||
      !/^[a-z0-9][a-z0-9.-]{0,62}$/.test(bucket ?? '') || !accessKeyId || !secretAccessKey ||
      !uuid.test(build ?? '') || !uuid.test(asset ?? '')) throw new Error('Invalid inspection configuration');
  const response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/query`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sql, params: [build, asset] }), redirect: 'error', signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) return { result: 'database_unavailable', status: response.status };
  const data = await response.json();
  const rows = data?.result?.[0]?.results;
  if (data?.success !== true || data?.result?.[0]?.success !== true || !Array.isArray(rows) || rows.length > 1) throw new Error('Unsupported database response');
  if (rows.length === 0) return { result: 'upload_not_found' };
  const row = rows[0];
  if (!uuid.test(row.app_id ?? '') || row.build_id !== build || row.asset_id !== asset ||
      !Number.isSafeInteger(row.attempt) || row.attempt < 1 || !Number.isSafeInteger(row.declared_size) || row.declared_size < 1 ||
      !Number.isSafeInteger(row.upload_expires_at) || !['pending', 'verifying', 'ready', 'failed', 'expired'].includes(row.state)) throw new Error('Invalid upload record');
  const prefix = `apps/${row.app_id}/build-ingest/pending/${build}/${asset}/${row.attempt}/`;
  if (typeof row.staging_key !== 'string' || !row.staging_key.startsWith(prefix) || !/^[A-Za-z0-9._-]{1,180}$/.test(row.staging_key.slice(prefix.length))) throw new Error('Invalid staging key');
  const summary = { result: 'upload_found', state: row.state, upload_expires_at: row.upload_expires_at };
  if (row.state !== 'pending') return { ...summary, object: 'not_checked' };
  const url = new URL(`https://${account}.r2.cloudflarestorage.com/${encodeURIComponent(bucket)}/${row.staging_key.split('/').map(encodeURIComponent).join('/')}`);
  url.searchParams.set('X-Amz-Expires', '60');
  const signer = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto', retries: 0 });
  const signed = await signer.sign(url.toString(), { method: 'HEAD', aws: { signQuery: true, service: 's3', region: 'auto' } });
  const head = await fetcher(signed.url, { method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (head.status === 404) return { ...summary, object: 'not_found', status: 404 };
  if (head.status !== 200) return { ...summary, object: 'unavailable', status: head.status };
  const length = head.headers.get('content-length');
  const size = length && /^\d+$/.test(length) ? Number(length) : NaN;
  return { ...summary, object: 'present', status: head.status,
    size_matches: Number.isSafeInteger(size) ? size === row.declared_size : null };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  inspect(process.env).then(result => console.log(JSON.stringify(result))).catch(() => {
    console.error('Staged-asset inspection failed; details and credentials withheld.'); process.exitCode = 1;
  });
}
