const response = status => ({ timestamp: Date.now(), duration_ms: 2, status, method: 'POST', route: '/api/apps/:appId/server-grants' });
if (process.env.HANDS_DIAGNOSTIC_FIXTURE) process.stdout.write(JSON.stringify({ logs: [
  {...response(500), failure_stage: 'token_lookup', failure_code: 'd1_unavailable', detail: 'private-body'},
  {...response(500), failure_stage: 'private-body', failure_code: 'private-body'},
  {...response(400), failure_stage: 'token_lookup', failure_code: 'd1_unavailable'},
].map(r => ({ message: ['hands_http_response', JSON.stringify(r)] })) }));
process.stdout.write(JSON.stringify({ private: 'private-body', logs: [...Array.from({ length: 100 }, () => 200), ...Array.from({ length: 7 }, () => 302), 400].map(status => ({ message: ['hands_http_response', JSON.stringify(response(status))] })) }));
setInterval(() => {}, 10000);
