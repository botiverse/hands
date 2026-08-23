export const MIN_REPORTER_AUDIT_KEY_BYTES = 32;

export async function computeReporterAuditHash(input: {
  key: string;
  appId: string;
  integrationId: string;
  reporterId: string;
}): Promise<string | null> {
  const keyBytes = new TextEncoder().encode(input.key);
  if (keyBytes.byteLength < MIN_REPORTER_AUDIT_KEY_BYTES) return null;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const message = [
    "feedback-audit-v1",
    input.appId,
    input.integrationId,
    input.reporterId,
  ].join("\0");
  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(message),
  );
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
