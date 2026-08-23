type CursorPayload = {
  v: 1;
  kind: "catalog" | "subscriptions";
  account: string;
  after: string;
};

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function key(env: Env): Promise<CryptoKey> {
  const secret = env.SIGNED_URL_SECRET || env.RAFT_CLIENT_SECRET;
  if (!secret) throw new Error("installer cursor signing secret is not configured");
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`hands-installer-cursor-v1:${secret}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function encodeInstallerCursor(env: Env, payload: CursorPayload): Promise<string> {
  const encoded = base64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = new Uint8Array(await crypto.subtle.sign(
    "HMAC", await key(env), new TextEncoder().encode(encoded),
  ));
  return `${encoded}.${base64Url(signature)}`;
}

export async function decodeInstallerCursor(
  env: Env,
  cursor: string | undefined,
  expected: Pick<CursorPayload, "kind" | "account">,
): Promise<string | null | undefined> {
  if (!cursor) return null;
  if (cursor.length > 512) return undefined;
  const [encoded, signature, extra] = cursor.split(".");
  if (!encoded || !signature || extra) return undefined;
  const signatureBytes = decodeBase64Url(signature);
  const payloadBytes = decodeBase64Url(encoded);
  if (!signatureBytes || !payloadBytes) return undefined;
  const valid = await crypto.subtle.verify(
    "HMAC", await key(env), signatureBytes, new TextEncoder().encode(encoded),
  );
  if (!valid) return undefined;
  try {
    const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as Partial<CursorPayload>;
    if (payload.v !== 1 || payload.kind !== expected.kind || payload.account !== expected.account ||
        typeof payload.after !== "string" || payload.after.length > 256) return undefined;
    return payload.after;
  } catch {
    return undefined;
  }
}
