// Exception details are sealed for the incident owner. No request/environment
// fields are collected, and a diagnostic failure never changes the response.
const publicKeyPem = `-----BEGIN PUBLIC KEY-----
MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEAhNo8YC17GxaKS/EH8S5m
aCHjgPm52Ik1/JFdFBURjYfS/E0jIkPilLNsG0hEUYSGS/plSEdae236vCfftRqe
r0ZY6GsOyr1PL5en/Zpeiu5IBI3MOenu1AAymc0elT5W7eq+1K9k5TQnfczIcBxD
qGUAdezQmJ78PZ+Ud9kkbXHr+LmaJg10XXGXJXuNFr/emxlXxJKKuBgG1uXMqyAW
GsYPTmdbRrUOwVGF9DZa70duDGoWFx7F6C1+DZpLWgePkrHZ8Fe5PgqhnYz9+CBj
PwIaejjIr6AEeqFXNlVzfk5rA/UuDS3ACrkgeubo9pzNomZ4d3XyxJXrpf7zBBOE
uUpyQPoXFW5HByakrLkXFMUFWBt8vQJJJb6yRtpSuYX45qMS8YyOzbIX+J9zMhGo
6gSxSP2+K3o9E8FJOMd4RWw3KPhFdgtQx8jMFLfJCt88Eo3fV5qyDhkxg7vcaqr8
pOtLoO8LxIuOzDSFuDWLCFN2UMHN1HxObtMbRKVvBNnHAgMBAAE=
-----END PUBLIC KEY-----
`;
let keyPromise: Promise<CryptoKey> | undefined;
function publicKey() {
  if (!keyPromise) {
    const body = publicKeyPem.replace(/-----[^-]+-----|\s/g, "");
    const der = Uint8Array.from(atob(body), char => char.charCodeAt(0));
    keyPromise = crypto.subtle.importKey("spki", der, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
  }
  return keyPromise;
}
function base64(bytes: Uint8Array) {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}
export async function sealedReporterFailure(error: unknown) {
  if (!(error instanceof Error)) return null;
  try {
    const exceptions: { name: string; message: string }[] = [];
    let current: unknown = error;
    for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
      exceptions.push({ name: current.name.slice(0, 128), message: current.message.slice(0, 4096) });
      current = current.cause;
    }
    const keyBytes = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
    const plaintext = new TextEncoder().encode(JSON.stringify({ exceptions }));
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
    const wrapped = new Uint8Array(await crypto.subtle.encrypt("RSA-OAEP", await publicKey(), keyBytes));
    return { algorithm: "RSA-OAEP-SHA256+AES-256-GCM", encrypted_key: base64(wrapped), iv: base64(iv),
      ciphertext: base64(encrypted.slice(0, -16)), tag: base64(encrypted.slice(-16)) };
  } catch {
    return null;
  }
}
