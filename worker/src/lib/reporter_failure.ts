// Request-local diagnostics. These fixed labels deliberately exclude exception
// text, identifiers and request data; the map cannot outlive its Hono context.
export type ReporterFailureStage =
  | "authentication" | "token_lookup" | "session_verify" | "audit_hash"
  | "rate_limit" | "list_query" | "route_bind" | "route_readback";
const stages = new WeakMap<object, ReporterFailureStage>();
export function setReporterFailureStage(context: object, stage: ReporterFailureStage) {
  stages.set(context, stage);
}
export function reporterFailureDiagnostic(context: object, error: unknown) {
  let code = "unknown";
  // Inspect only to select a fixed label. Never emit any part of a message or
  // cause: database errors can contain SQL parameters and credential material.
  const messages: string[] = [];
  let current = error;
  for (let i = 0; i < 4 && current instanceof Error; i++) {
    messages.push(current.message);
    current = current.cause;
  }
  const message = messages.join("\n");
  if (/SQLITE_CONSTRAINT|constraint failed/i.test(message)) code = "sqlite_constraint";
  else if (/no such (?:table|column)|has no column named/i.test(message)) code = "sqlite_schema";
  else if (/SQLITE_BUSY|database is locked/i.test(message)) code = "sqlite_busy";
  else if (/Network connection lost|D1 DB is unavailable|D1_ERROR.*(?:overloaded|reset|timeout)/i.test(message)) code = "d1_unavailable";
  else if (/D1_ERROR|SQLITE_ERROR/.test(message)) code = "database_error";
  else if (error instanceof TypeError) code = "type_error";
  return { failure_stage: stages.get(context) ?? "unknown", failure_code: code };
}
