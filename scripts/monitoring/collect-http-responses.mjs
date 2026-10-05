#!/usr/bin/env node
// Real request sampling, not synthetic availability probes. Raw tail envelopes
// (URLs/headers/provider errors) are parsed in memory and never persisted.
import { spawn } from 'node:child_process';
import { boundedLog } from './bounded-log.mjs';
const [wrangler, config, output, hours = '24'] = process.argv.slice(2);
if (!wrangler || !config || !output || !Number.isFinite(Number(hours)) || Number(hours) <= 0) {
  throw new Error('Usage: collect-http-responses.mjs <wrangler-cli.js> <config.json> <output.jsonl> [hours]');
}
const expires = Date.now() + Number(hours) * 3600000;
const idleMs = Number(process.env.HANDS_TAIL_IDLE_MS ?? 180000);
if (!Number.isFinite(idleMs) || idleMs < 100) throw new Error('Invalid tail idle limit');
const write = boundedLog(output);
let observedEvents = 0;
const counts = new Map();
function diagnosticFields(r) {
  if (r.status < 500
    || !['unknown', 'authentication', 'token_lookup', 'session_verify', 'audit_hash', 'rate_limit', 'list_query', 'route_bind', 'route_readback'].includes(r.failure_stage)
    || !['unknown', 'sqlite_constraint', 'sqlite_schema', 'sqlite_busy', 'd1_unavailable', 'database_error', 'type_error'].includes(r.failure_code)) return {};
  return { failure_stage: r.failure_stage, failure_code: r.failure_code };
}
function flushCounts() {
  const timestamp = Date.now();
  write({ kind: 'tail_heartbeat', timestamp, observed_events: observedEvents }); observedEvents = 0;
  for (const [status, count] of counts) write({ kind: 'http_response_count', timestamp, status, count });
  counts.clear();
}
const heartbeat = setInterval(flushCounts, 60000); heartbeat.unref();
let child, stopped = false, retry = 1000;
const end = () => { if (stopped) return; stopped = true; clearInterval(heartbeat); flushCounts(); child?.kill('SIGTERM'); write({ kind: 'collector_stopped', timestamp: Date.now() }); };
process.on('SIGTERM', end); process.on('SIGINT', end);
setTimeout(end, expires - Date.now()).unref();
function connect() {
  if (stopped || Date.now() >= expires) return;
  write({ kind: 'tail_connecting', timestamp: Date.now(), expires_at: expires });
  child = spawn(process.execPath, [wrangler, 'tail', 'hands-worker', '--config', config, '--format', 'json'], { stdio: ['ignore', 'pipe', 'ignore'] });
  let buffer = '', lastEventAt = Date.now();
  const idleWatch = setInterval(() => {
    if (stopped || Date.now() - lastEventAt < idleMs) return;
    write({ kind: 'tail_idle_gap', timestamp: Date.now(), last_event_at: lastEventAt });
    child.kill('SIGTERM');
  }, Math.min(idleMs, 1000)); idleWatch.unref();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    // Wrangler streams one pretty-printed JSON object per event. Find balanced
    // braces while ignoring braces inside strings; discard non-JSON banners.
    while (true) {
      const start = buffer.indexOf('{');
      if (start < 0) { buffer = ''; break; }
      let depth = 0, quoted = false, escaped = false, end = -1;
      for (let i = start; i < buffer.length; i++) {
        const char = buffer[i];
        if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; }
        else if (char === '"') quoted = true;
        else if (char === '{') depth++;
        else if (char === '}' && --depth === 0) { end = i + 1; break; }
      }
      if (end < 0) { if (buffer.length > 2000000) { buffer = ''; write({ kind: 'tail_parse_gap', timestamp: Date.now() }); } break; }
      const raw = buffer.slice(start, end); buffer = buffer.slice(end);
      let event; try { event = JSON.parse(raw); } catch { write({ kind: 'tail_parse_gap', timestamp: Date.now() }); continue; }
      lastEventAt = Date.now(); observedEvents++;
      for (const log of event.logs ?? []) {
        if (!Array.isArray(log.message) || log.message[0] !== 'hands_http_response') continue;
        let r; try { r = typeof log.message[1] === 'string' ? JSON.parse(log.message[1]) : log.message[1]; } catch { continue; }
        if (!r || !Number.isFinite(r.timestamp) || !Number.isFinite(r.duration_ms) || r.duration_ms < 0 || !Number.isInteger(r.status) || r.status < 100 || r.status > 599 || typeof r.route !== 'string' || !/^(unmatched|\/api\/[A-Za-z0-9_:/.-]+)$/.test(r.route)) continue;
        if (r.status < 400) { counts.set(r.status, (counts.get(r.status) ?? 0) + 1); continue; }
        write({ ...diagnosticFields(r), kind: 'http_response', timestamp: r.timestamp, method: /^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)$/.test(r.method) ? r.method : 'OTHER', route: r.route, status: r.status, duration_ms: r.duration_ms, request_id: /^[a-f0-9]{16}-[A-Z]{3}$/.test(r.request_id ?? '') ? r.request_id : null });
      }
    }
  });
  child.on('error', () => {});
  child.on('close', (code) => {
    clearInterval(idleWatch);
    write({ kind: 'tail_disconnected', timestamp: Date.now(), exit_code: code });
    if (!stopped && Date.now() < expires) { setTimeout(connect, retry); retry = Math.min(retry * 2, 60000); }
  });
}
connect();
