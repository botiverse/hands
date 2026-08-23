const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function tokenKey(secret: string) {
  const material = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`hands-admin-raft-token-v1:${secret}`),
  );
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export async function encryptAdminRaftToken(secret: string, token: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await tokenKey(secret),
    encoder.encode(token),
  );
  return `${base64Url(iv)}.${base64Url(new Uint8Array(ciphertext))}`;
}

export async function decryptAdminRaftToken(secret: string, value: string) {
  const [iv, ciphertext, extra] = value.split(".");
  if (!iv || !ciphertext || extra) throw new Error("invalid encrypted Raft token");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64Url(iv) },
    await tokenKey(secret),
    fromBase64Url(ciphertext),
  );
  return decoder.decode(plaintext);
}
