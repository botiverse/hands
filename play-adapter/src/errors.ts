export class PlayAdapterError extends Error {
  constructor(
    public readonly status: 400 | 403 | 409 | 413 | 502 | 503,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function safeErrorResponse(error: unknown, operationId: string | null): Response {
  const known = error instanceof PlayAdapterError;
  const status = known ? error.status : 502;
  const code = known ? error.code : "play_adapter_error";
  const message = known ? error.message : "Google Play adapter request failed";
  console.error(JSON.stringify({
    event: "google_play_adapter_error",
    operation_id: operationId,
    code,
    status,
  }));
  return Response.json({ error: { code, message } }, { status });
}
