import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
  getBetaAppLocalizations,
  upsertBetaAppLocalizations,
  type AscApiCredentials,
} from "../src/lib/asc_api";
import {
  handleGetBetaAppDescription,
  handleUpdateBetaAppDescription,
  parseBetaAppDescriptions,
} from "../src/routes/testflight_beta_app_description";
import { encryptP8 } from "../src/lib/asc_credentials";

async function generateTestCreds(): Promise<AscApiCredentials> {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(
    (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
  );
  let binary = "";
  for (const byte of pkcs8) binary += String.fromCharCode(byte);
  return {
    key_id: "TESTKEY123",
    issuer_id: "issuer-uuid-1234",
    p8: `-----BEGIN PRIVATE KEY-----\n${btoa(binary)}\n-----END PRIVATE KEY-----`,
  };
}

function fakeAsc(initial: Record<string, string> = {}) {
  const localizations = new Map(
    Object.entries(initial).map(([locale, description], index) => [
      locale,
      { id: `loc-${index + 1}`, description },
    ]),
  );
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)).data : null;
    if (method === "GET" && url.pathname === "/v1/apps/asc-app-1/betaAppLocalizations") {
      return Response.json({
        data: [...localizations.entries()].map(([locale, value]) => ({
          type: "betaAppLocalizations",
          id: value.id,
          attributes: { locale, description: value.description },
        })),
      });
    }
    if (method === "POST" && url.pathname === "/v1/betaAppLocalizations") {
      const id = `loc-${localizations.size + 1}`;
      localizations.set(body.attributes.locale, {
        id,
        description: body.attributes.description,
      });
      return Response.json({ data: { id, attributes: body.attributes } }, { status: 201 });
    }
    if (method === "PATCH" && url.pathname.startsWith("/v1/betaAppLocalizations/")) {
      const entry = [...localizations.entries()].find(([, value]) => value.id === body.id);
      if (entry) entry[1].description = body.attributes.description;
      return Response.json({
        data: {
          id: body.id,
          attributes: {
            locale: entry?.[0] ?? null,
            description: body.attributes.description,
          },
        },
      });
    }
    return Response.json(
      { errors: [{ title: "UNEXPECTED_REQUEST", detail: `${method} ${url.pathname}` }] },
      { status: 500 },
    );
  });
  return { localizations, fetchMock };
}

afterEach(() => vi.unstubAllGlobals());

describe("betaAppLocalizations ASC client", () => {
  it("uses app-level resources and preserves untouched locales", async () => {
    const creds = await generateTestCreds();
    const fake = fakeAsc({ "en-US": "Old", "fr-FR": "Conserver" });
    vi.stubGlobal("fetch", fake.fetchMock);

    await upsertBetaAppLocalizations(creds, "asc-app-1", {
      "en-US": "New",
      "zh-Hans": "新描述",
    });
    const readback = await getBetaAppLocalizations(creds, "asc-app-1");

    expect(fake.localizations.get("en-US")?.description).toBe("New");
    expect(fake.localizations.get("zh-Hans")?.description).toBe("新描述");
    expect(fake.localizations.get("fr-FR")?.description).toBe("Conserver");
    expect(readback).toHaveLength(3);
    const calls = fake.fetchMock.mock.calls.map(([url, init]) => [
      init?.method ?? "GET",
      new URL(String(url)).pathname,
    ]);
    expect(calls).toContainEqual(["PATCH", "/v1/betaAppLocalizations/loc-1"]);
    expect(calls).toContainEqual(["POST", "/v1/betaAppLocalizations"]);
    expect(calls.some(([, path]) => String(path).includes("betaBuildLocalizations"))).toBe(false);
  });

  it("recovers a create race through a fresh app-level read", async () => {
    const creds = await generateTestCreds();
    const fake = fakeAsc();
    let createCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if ((init?.method ?? "GET") === "POST" && url.pathname === "/v1/betaAppLocalizations") {
        createCalls += 1;
        fake.localizations.set("ja", { id: "raced", description: "古い" });
        return Response.json(
          { errors: [{ title: "ENTITY_ERROR", detail: "locale exists" }] },
          { status: 409 },
        );
      }
      return fake.fetchMock(input, init);
    });
    vi.stubGlobal("fetch", fetchMock);

    await upsertBetaAppLocalizations(creds, "asc-app-1", { ja: "新しい" });
    expect(createCalls).toBe(1);
    expect(fake.localizations.get("ja")?.description).toBe("新しい");
  });
});

describe("Beta App Description route", () => {
  it("validates a non-empty locale map without accepting blank descriptions", () => {
    expect({ ...parseBetaAppDescriptions({ descriptions: { "en-US": "  Hello  " } }) })
      .toEqual({ "en-US": "  Hello  " });
    expect(() => parseBetaAppDescriptions({ descriptions: {} })).toThrow(/between 1 and 100/);
    expect(() => parseBetaAppDescriptions({ descriptions: { "en-US": "   " } })).toThrow(
      /must contain/,
    );
    expect(() => parseBetaAppDescriptions({
      descriptions: { "en-US": "Hello" },
      what_to_test: { "en-US": "Wrong field" },
    })).toThrow(/only descriptions/);
    expect(() => parseBetaAppDescriptions({ descriptions: { __proto__: "unsafe" } }))
      .toThrow(/between 1 and 100/);
  });

  it("updates app descriptions, performs exact readback, and writes a redacted audit", async () => {
    const creds = await generateTestCreds();
    const encrypted = await encryptP8(creds.p8, "test-key");
    const fake = fakeAsc({ "en-US": "Old" });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/apps" && url.searchParams.get("filter[bundleId]") === "build.raft.app") {
        return Response.json({ data: [{ id: "asc-app-1" }] });
      }
      return fake.fetchMock(input, init);
    }));

    const audits: Array<{ action: string; payload: string }> = [];
    const db = {
      prepare(sql: string) {
        const values: unknown[] = [];
        return {
          bind(...args: unknown[]) {
            values.push(...args);
            return this;
          },
          async first() {
            if (sql.includes("SELECT platform FROM apps")) return { platform: "ios" };
            if (sql.includes("SELECT bundle_id FROM channels")) return { bundle_id: "build.raft.app" };
            if (sql.includes("FROM app_asc_credentials")) {
              return {
                id: "cred-1",
                app_id: "app-1",
                key_id: creds.key_id,
                issuer_id: creds.issuer_id,
                created_by_actor: "tester",
                created_at: 1,
                updated_at: 1,
                p8_ciphertext_b64: encrypted.ciphertext_b64,
                p8_iv_b64: encrypted.iv_b64,
              };
            }
            return null;
          },
          async run() {
            if (sql.includes("INSERT INTO audit_logs")) {
              audits.push({ action: String(values[2]), payload: String(values.at(-2)) });
            }
            return { success: true };
          },
        };
      },
    };

    const app = new Hono();
    app.get("/api/apps/:appId/testflight-beta-app-description", handleGetBetaAppDescription as any);
    app.put("/api/apps/:appId/testflight-beta-app-description", handleUpdateBetaAppDescription as any);
    const env = { DB: db, ASC_CRED_ENC_KEY: "test-key" } as any;

    const response = await app.request(
      "/api/apps/app-1/testflight-beta-app-description",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ descriptions: { "en-US": "New", ja: "新しい" } }),
      },
      env,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      bundle_id: "build.raft.app",
      asc_app_id: "asc-app-1",
      updated_locales: ["en-US", "ja"],
      readback_exact: true,
    });
    expect(audits).toHaveLength(2);
    expect(audits.map((audit) => audit.action)).toEqual([
      "testflight.beta_app_description.update_requested",
      "testflight.beta_app_description.update_verified",
    ]);
    for (const audit of audits) {
      expect(audit.payload).not.toContain("New");
      expect(audit.payload).not.toContain("新しい");
    }

    const getResponse = await app.request(
      "/api/apps/app-1/testflight-beta-app-description",
      undefined,
      env,
    );
    expect(getResponse.status).toBe(200);
    await expect(getResponse.json()).resolves.toMatchObject({
      localizations: [
        { locale: "en-US", description: "New" },
        { locale: "ja", description: "新しい" },
      ],
    });
  });
});
