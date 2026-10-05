import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { boundedLog } from './bounded-log.mjs';
test('rotation bounds bytes, preserves complete newest records and survives restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hands-log-'));
  try {
    const file = join(dir, 'responses.jsonl');
    for (let restart = 0; restart < 3; restart++) {
      const write = boundedLog(file, 256, 3);
      for (let i = 0; i < 100; i++) write({ kind: 'http_response', status: 400, sequence: restart * 100 + i });
    }
    const files = readdirSync(dir); assert.equal(files.length, 3);
    let total = 0;
    for (const f of files) {
      const size = statSync(join(dir, f)).size; assert.ok(size <= 256); total += size;
      assert.equal(statSync(join(dir, f)).mode & 0o777, 0o600);
      for (const line of readFileSync(join(dir, f), 'utf8').trim().split('\n')) assert.equal(JSON.parse(line).status, 400);
    }
    assert.ok(total <= 768);
    assert.equal(JSON.parse(readFileSync(file, 'utf8').trim().split('\n').at(-1)).sequence, 299);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('collector sums successful statuses, retains errors and never persists raw tail data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hands-collector-'));
  try {
    const file = join(dir, 'responses.jsonl');
    const result = spawnSync(process.execPath, ['scripts/monitoring/collect-http-responses.mjs', 'scripts/monitoring/tail-fixture.mjs', 'unused', file, '0.0002'], { timeout: 5000 });
    assert.equal(result.status, 0, result.stderr.toString());
    const raw = readFileSync(file, 'utf8'); assert.ok(!raw.includes('private-body')); assert.ok(!raw.includes('tail_event'));
    const rows = raw.trim().split('\n').map(JSON.parse);
    assert.equal(rows.filter(r => r.kind === 'http_response').length, 1);
    assert.equal(rows.find(r => r.kind === 'http_response').status, 400);
    assert.equal(rows.find(r => r.kind === 'http_response_count' && r.status === 200).count, 100);
    assert.equal(rows.find(r => r.kind === 'http_response_count' && r.status === 302).count, 7);
    assert.equal(rows.find(r => r.kind === 'tail_heartbeat').observed_events, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('silent live child is recycled and produces an explicit coverage gap', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hands-idle-'));
  try {
    const file = join(dir, 'responses.jsonl');
    const result = spawnSync(process.execPath, ['scripts/monitoring/collect-http-responses.mjs', 'scripts/monitoring/tail-fixture.mjs', 'unused', file, '0.0007'], { timeout: 5000, env: { ...process.env, HANDS_TAIL_IDLE_MS: '150' } });
    assert.equal(result.status, 0, result.stderr.toString());
    const rows = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(rows.some(r => r.kind === 'tail_idle_gap'));
    assert.ok(rows.filter(r => r.kind === 'tail_connecting').length >= 2);
    assert.ok(rows.filter(r => r.kind === 'http_response' && r.status === 400).length >= 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('collector retains only allowlisted 5xx diagnostics and discards exception payloads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hands-diagnostic-'));
  try {
    const file = join(dir, 'responses.jsonl');
    const result = spawnSync(process.execPath, ['scripts/monitoring/collect-http-responses.mjs', 'scripts/monitoring/tail-fixture.mjs', 'unused', file, '0.0002'], { timeout: 5000, env: { ...process.env, HANDS_DIAGNOSTIC_FIXTURE: '1' } });
    assert.equal(result.status, 0, result.stderr.toString());
    const raw = readFileSync(file, 'utf8');
    assert.ok(!raw.includes('private-body'));
    const rows = raw.trim().split('\n').map(JSON.parse).filter(r => r.kind === 'http_response');
    assert.equal(rows[0].failure_stage, 'token_lookup');
    assert.equal(rows[0].failure_code, 'd1_unavailable');
    for (const row of rows.slice(1)) { assert.ok(!('failure_stage' in row)); assert.ok(!('failure_code' in row)); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
