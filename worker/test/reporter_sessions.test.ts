import { describe, expect, it } from "vitest";
import {
  mintReporterSession,
  verifyReporterSession,
} from "../src/lib/reporter_sessions";

const APP_ID = "11111111-1111-4111-8111-111111111111";
const INTEGRATION_ID = "22222222-2222-4222-8222-222222222222";
const TOKEN_ID = "33333333-3333-4333-8333-333333333333";
const REPORTER_ID = "reporter_session_test_123456789";

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function encodedJson(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function env(active = "n", entries: Record<string, Uint8Array> = {
  n: new Uint8Array(32).fill(1),
}) {
  return {
    FEEDBACK_REPORTER_SESSION_ENABLED: "true",
    FEEDBACK_REPORTER_SESSION_ACTIVE_KEY_VERSION: active,
    FEEDBACK_REPORTER_SESSION_KEYS: JSON.stringify(Object.fromEntries(
      Object.entries(entries).map(([version, key]) => [version, base64Url(key)]),
    )),
  } as Env;
}

async function signMalformed(
  key: Uint8Array,
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
) {
  const encodedHeader = encodedJson(header);
  const encodedClaims = encodedJson(claims);
  const input = `${encodedHeader}.${encodedClaims}`;
  const cryptoKey = await crypto.subtle.importKey(
    "raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(input)),
  );
  return `hrps_v1_${input}.${base64Url(signature)}`;
}

describe("reporter sessions", () => {
  it("mints a fixed 30-second closed-claim token and verifies canonical scopes", async () => {
    const minted = await mintReporterSession(env(), {
      appId: APP_ID,
      integrationId: INTEGRATION_ID,
      reporterId: REPORTER_ID,
      tokenId: TOKEN_ID,
      scopes: ["feedback:read", "feedback:comment"],
      nowSeconds: 1_700_000_000,
    });
    expect(minted).not.toBeNull();
    expect(minted!.token).toMatch(/^hrps_v1_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(minted!.claims).toMatchObject({
      app_id: APP_ID,
      reporter_integration_id: INTEGRATION_ID,
      reporter_id: REPORTER_ID,
      token_id: TOKEN_ID,
      scopes: ["feedback:comment", "feedback:read"],
      iat: 1_700_000_000,
      nbf: 1_700_000_000,
      exp: 1_700_000_030,
      key_version: "n",
    });
    await expect(verifyReporterSession(env(), minted!.token, 1_700_000_010)).resolves.toEqual({
      ok: true,
      claims: minted!.claims,
    });
    await expect(verifyReporterSession(env(), minted!.token, 1_700_000_036)).resolves.toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("fails closed when disabled or key configuration is missing", async () => {
    const disabled = { ...env(), FEEDBACK_REPORTER_SESSION_ENABLED: "false" } as Env;
    await expect(mintReporterSession(disabled, {
      appId: APP_ID,
      integrationId: INTEGRATION_ID,
      reporterId: REPORTER_ID,
      tokenId: TOKEN_ID,
      scopes: ["feedback:read"],
    })).resolves.toBeNull();
    await expect(verifyReporterSession(disabled, "hrps_v1_bad", 1)).resolves.toEqual({
      ok: false,
      reason: "invalid",
    });
    await expect(verifyReporterSession({
      FEEDBACK_REPORTER_SESSION_ENABLED: "true",
    } as Env, "hrps_v1_bad", 1)).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  it("accepts N and N-1 during rotation, mints with N only, and rejects retired keys", async () => {
    const oldKey = new Uint8Array(32).fill(7);
    const newKey = new Uint8Array(32).fill(8);
    const oldEnv = env("n", { n: oldKey });
    const old = await mintReporterSession(oldEnv, {
      appId: APP_ID,
      integrationId: INTEGRATION_ID,
      reporterId: REPORTER_ID,
      tokenId: TOKEN_ID,
      scopes: ["feedback:read"],
      nowSeconds: 2_000,
    });
    const overlap = env("n1", { n1: newKey, n: oldKey });
    await expect(verifyReporterSession(overlap, old!.token, 2_010)).resolves.toMatchObject({ ok: true });
    const fresh = await mintReporterSession(overlap, {
      appId: APP_ID,
      integrationId: INTEGRATION_ID,
      reporterId: REPORTER_ID,
      tokenId: TOKEN_ID,
      scopes: ["feedback:read"],
      nowSeconds: 2_010,
    });
    expect(fresh!.claims.key_version).toBe("n1");
    await expect(verifyReporterSession(env("n1", { n1: newKey }), old!.token, 2_010))
      .resolves.toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects validly signed unknown claims, wrong algorithm, audience, and oversized lifetime", async () => {
    const key = new Uint8Array(32).fill(1);
    const header = { alg: "HS256", kid: "n", typ: "hands-reporter-session+jwt" };
    const claims = {
      v: 1,
      iss: "hands",
      aud: "hands-reporter-feedback",
      app_id: APP_ID,
      reporter_integration_id: INTEGRATION_ID,
      reporter_id: REPORTER_ID,
      token_id: TOKEN_ID,
      scopes: ["feedback:read"],
      iat: 1_000,
      nbf: 1_000,
      exp: 1_030,
      jti: "A".repeat(22),
      key_version: "n",
    };
    for (const [changedHeader, changedClaims] of [
      [{ ...header }, { ...claims, extra: "unknown" }],
      [{ ...header, alg: "HS512" }, { ...claims }],
      [{ ...header }, { ...claims, aud: "wrong" }],
      [{ ...header }, { ...claims, exp: 1_061 }],
    ] as Array<[Record<string, unknown>, Record<string, unknown>]>) {
      const token = await signMalformed(key, changedHeader, changedClaims);
      await expect(verifyReporterSession(env(), token, 1_010)).resolves.toEqual({
        ok: false,
        reason: "invalid",
      });
    }
  });

  it("rejects tampering, non-canonical claims, unknown key versions, and oversized tokens", async () => {
    const minted = await mintReporterSession(env(), {
      appId: APP_ID,
      integrationId: INTEGRATION_ID,
      reporterId: REPORTER_ID,
      tokenId: TOKEN_ID,
      scopes: ["feedback:read"],
      nowSeconds: 1_000,
    });
    const tampered = `${minted!.token.slice(0, -1)}${minted!.token.endsWith("A") ? "B" : "A"}`;
    await expect(verifyReporterSession(env(), tampered, 1_010)).resolves.toEqual({
      ok: false,
      reason: "invalid",
    });
    const wrongKey = { ...env(), FEEDBACK_REPORTER_SESSION_ACTIVE_KEY_VERSION: "missing" } as Env;
    await expect(verifyReporterSession(wrongKey, minted!.token, 1_010)).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    await expect(verifyReporterSession(env(), `hrps_v1_${"A".repeat(5_000)}`, 1_010)).resolves.toEqual({
      ok: false,
      reason: "invalid",
    });
  });
});
