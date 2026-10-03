const response = status => ({ timestamp: Date.now(), duration_ms: 2, status, method: 'POST', route: '/api/apps/:appId/server-grants' });
process.stdout.write(JSON.stringify({ private: 'private-body', logs: [...Array.from({ length: 100 }, () => 200), ...Array.from({ length: 7 }, () => 302), 400].map(status => ({ message: ['hands_http_response', JSON.stringify(response(status))] })) }));
setInterval(() => {}, 10000);
