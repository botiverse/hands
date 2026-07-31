/**
 * Unit tests for the read-only AppGallery listing-review helper. The endpoint
 * must query the listing lane, surface provider values unmapped, and stay
 * strictly read-only: no request it issues may be anything but a GET.
 */

import { describe, it, expect, vi } from "vitest";
import { getAgcReviewStatus, AgcApiError } from "../src/lib/agc_api";
import { handleAppGalleryReview } from "../src/routes/agc_testing";

const auth = { clientId: "client-1", accessToken: "token-1" };

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

const rejectedBody = {
  ret: { code: 0, msg: "success" },
  appInfo: { releaseState: 3, defaultLang: "zh-CN" },
  auditInfo: {
    auditOpinion: "应用图标资源需分层，尺寸需满足规范要求",
    copyRightAuditResult: "1",
    copyRightAuditOpinion: null,
    copyRightCodeAuditResult: null,
    copyRightCodeAuditOpinion: "",
    recordAuditResult: "0",
    recordAuditOpinion: "备案通过",
  },
  languages: [],
};

describe("getAgcReviewStatus", () => {
  it("queries the listing lane and flattens the provider audit fields", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(rejectedBody));
    const status = await getAgcReviewStatus(auth, "app-42", 1, fetchMock as unknown as typeof fetch);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://connect-api.cloud.huawei.com/api/publish/v2/app-info?appId=app-42&releaseType=1",
    );
    // Read-only: no method override means GET, and no body is ever sent.
    expect(init.method ?? "GET").toBe("GET");
    expect(init.body).toBeUndefined();

    expect(status).toEqual({
      release_state: 3,
      audit_opinion: "应用图标资源需分层，尺寸需满足规范要求",
      copyright_audit_result: "1",
      copyright_audit_opinion: null,
      copyright_code_audit_result: null,
      copyright_code_audit_opinion: null,
      record_audit_result: "0",
      record_audit_opinion: "备案通过",
    });
  });

  it("defaults to the listing lane rather than the invitation-test lane", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(rejectedBody));
    await getAgcReviewStatus(auth, "app-42", undefined, fetchMock as unknown as typeof fetch);
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toContain("releaseType=1");
    expect(url).not.toContain("releaseType=6");
  });

  it("returns nulls instead of guesses when the provider omits audit data", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ ret: { code: 0 }, appInfo: { releaseState: "not-a-number" } }),
    );
    const status = await getAgcReviewStatus(auth, "app-42", 1, fetchMock as unknown as typeof fetch);
    expect(status.release_state).toBeNull();
    expect(status.release_state).not.toBe(0);
    expect(status.audit_opinion).toBeNull();
    expect(status.record_audit_result).toBeNull();
  });

  it("keeps an absent release state absent instead of reporting enum 0", async () => {
    // Number(null) and Number("") are both 0, so coercing before checking would
    // report a state the provider never sent — and 0 is a real enum value.
    for (const releaseState of [null, undefined, ""]) {
      const fetchMock = vi.fn(async () =>
        jsonResponse({ ret: { code: 0 }, appInfo: { releaseState } }),
      );
      const status = await getAgcReviewStatus(auth, "app-42", 1, fetchMock as unknown as typeof fetch);
      expect(status.release_state).toBeNull();
    }
    // A genuine 0 from the provider is still reported as 0.
    const zero = vi.fn(async () => jsonResponse({ ret: { code: 0 }, appInfo: { releaseState: 0 } }));
    expect(
      (await getAgcReviewStatus(auth, "app-42", 1, zero as unknown as typeof fetch)).release_state,
    ).toBe(0);
  });

  it("surfaces a provider-level error code even on HTTP 200", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ ret: { code: 204144647, msg: "app not exist" } }),
    );
    await expect(
      getAgcReviewStatus(auth, "missing-app", 1, fetchMock as unknown as typeof fetch),
    ).rejects.toBeInstanceOf(AgcApiError);
  });
});

describe("handleAppGalleryReview error disclosure", () => {
  /** Minimal context whose credential read throws the given error. */
  function contextThrowing(error: unknown) {
    return {
      env: {
        AGC_CRED_ENC_KEY: "test-key",
        DB: {
          prepare(sql: string) {
            return {
              bind() {
                return {
                  async first() {
                    if (sql.includes("FROM apps")) return { platform: "ohos" };
                    if (sql.includes("app_agc_credentials")) throw error;
                    if (sql.includes("FROM channels")) return { bundle_id: "com.example.app" };
                    return null;
                  },
                };
              },
            };
          },
        },
      },
      req: { param: (name: string) => (name === "appId" ? "app-1" : "") },
      json: (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status }),
    } as never;
  }

  it("never leaks a non-AgcApiError message to the caller", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await handleAppGalleryReview(
      contextThrowing(new Error("BEGIN PRIVATE KEY MIIEvQIBADANBg internal detail")),
    );
    const body = await response.json() as { review_error?: string };

    expect(body.review_error).toBe("AppGallery review status is unavailable");
    expect(JSON.stringify(body)).not.toContain("PRIVATE KEY");
    // The log sink is persistent storage too: it gets the error class, never
    // the message, because that message can embed the key material itself.
    expect(errorSpy).toHaveBeenCalledOnce();
    const logged = errorSpy.mock.calls.flat().join(" ");
    expect(logged).not.toContain("PRIVATE KEY");
    expect(logged).not.toContain("MIIEvQIBADANBg");
    expect(logged).toContain("unexpected Error");
    errorSpy.mockRestore();
  });

  it("applies to a real ohos app rather than a platform value that does not exist", async () => {
    // "ohos" is the only canonical HarmonyOS value (lib/app_platform.ts). The
    // previous guard compared against "harmony", so every real app fell through
    // to applicable:false and the feature could never run in production.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await handleAppGalleryReview(
      contextThrowing(new AgcApiError(404, "No AGC app found for package com.example.app")),
    );
    const body = await response.json() as { applicable?: boolean; platform?: string };

    expect(body.applicable).toBe(true);
    expect(body.platform).toBeUndefined();
    errorSpy.mockRestore();
  });

  it("reports a non-ohos app as inapplicable", async () => {
    const context = contextThrowing(new AgcApiError(404, "unused"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = context as any;
    const originalPrepare = ctx.env.DB.prepare;
    ctx.env.DB.prepare = (sql: string) =>
      sql.includes("FROM apps")
        ? { bind: () => ({ first: async () => ({ platform: "android" }) }) }
        : originalPrepare(sql);

    const body = await (await handleAppGalleryReview(context)).json() as {
      applicable?: boolean;
      platform?: string;
    };
    expect(body.applicable).toBe(false);
    expect(body.platform).toBe("android");
  });

  it("still surfaces provider-controlled AgcApiError text", async () => {
    const response = await handleAppGalleryReview(
      contextThrowing(new AgcApiError(404, "No AGC app found for package com.example.app")),
    );
    const body = await response.json() as { review_error?: string };
    expect(body.review_error).toBe("No AGC app found for package com.example.app");
  });
});
