import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";

/**
 * The largest JSON request body Hands reads. Every JSON body is parsed whole
 * in memory (c.req.json()), so without a cap one huge body could exhaust the
 * isolate before any schema runs. The largest legitimate JSON bodies are
 * signing uploads (base64 certificates and provisioning profiles, tens of
 * KiB) and Play API proxy payloads; 8 MiB leaves ample room. Binary uploads
 * (APK, IPA, minidumps, attachments) are not JSON and keep their own limits.
 */
export const MAX_JSON_BODY_BYTES = 8 * 1024 * 1024;

const jsonLimit = bodyLimit({
  maxSize: MAX_JSON_BODY_BYTES,
  onError: (c) =>
    c.json({ error: "request body is larger than 8 MiB", code: "PAYLOAD_TOO_LARGE" }, 413),
});

/** Refuses a JSON request body over MAX_JSON_BODY_BYTES with 413 before it is read. */
export const jsonBodyLimit: MiddlewareHandler = async (c, next) => {
  const type = (c.req.header("content-type") ?? "").toLowerCase();
  if (!type.includes("json")) return next();
  return jsonLimit(c, next);
};
