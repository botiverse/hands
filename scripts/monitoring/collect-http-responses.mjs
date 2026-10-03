#!/usr/bin/env node
// Real request sampling, not synthetic availability probes. Raw tail envelopes
// (URLs/headers/provider errors) are parsed in memory and never persisted.
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
const [wrangler, config, output, hours = '24'] = process.argv.slice(2);
if (!wrangler || !config || !output || !Number.isFinite(Number(hours)) || Number(hours) <= 0) {
  throw new Error('Usage: collect-http-responses.mjs <wrangler-cli.js> <config.json> <output.jsonl> [hours]');
}
mkdirSync(dirname(resolve(output)), { recursive: true, mode: 0o700 });
const expires = Date.now() + Number(hours) * 3600000;
const write = (row) => appendFileSync(output, JSON.stringify(row) + '\n', { mode: 0o600 });
let child, stopped = false, retry = 1000;
const end = () => { stopped = true; child?.kill('SIGTERM'); write({ kind: 'collector_stopped', timestamp: Date.now() }); };
process.on('SIGTERM', end); process.on('SIGINT', end);
setTimeout(end, expires - Date.now()).unref();
function connect() {
  if (stopped || Date.now() >= expires) return;
  write({ kind: 'tail_connecting', timestamp: Date.now(), expires_at: expires });
  child = spawn(process.execPath, [wrangler, 'tail', 'hands-worker', '--config', config, '--format', 'json'], { stdio: ['ignore', 'pipe', 'ignore'] });
  let buffer = '';
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
      write({ kind: 'tail_event', timestamp: Date.now() });
      for (const log of event.logs ?? []) {
        if (!Array.isArray(log.message) || log.message[0] !== 'hands_http_response') continue;
        let r; try { r = typeof log.message[1] === 'string' ? JSON.parse(log.message[1]) : log.message[1]; } catch { continue; }
        if (!r || !Number.isFinite(r.timestamp) || !Number.isFinite(r.duration_ms) || r.duration_ms < 0 || !Number.isInteger(r.status) || r.status < 100 || r.status > 599 || typeof r.route !== 'string' || !/^(unmatched|\/api\/[A-Za-z0-9_:/.-]+)$/.test(r.route)) continue;
        write({ kind: 'http_response', timestamp: r.timestamp, method: /^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)$/.test(r.method) ? r.method : 'OTHER', route: r.route, status: r.status, duration_ms: r.duration_ms, request_id: /^[a-f0-9]{16}-[A-Z]{3}$/.test(r.request_id ?? '') ? r.request_id : null });
      }
    }
  });
  child.on('error', () => {});
  child.on('close', (code) => {
    write({ kind: 'tail_disconnected', timestamp: Date.now(), exit_code: code });
    if (!stopped && Date.now() < expires) { setTimeout(connect, retry); retry = Math.min(retry * 2, 60000); }
  });
}
connect();
