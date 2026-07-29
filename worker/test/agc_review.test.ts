/**
 * Unit tests for the read-only AppGallery listing-review helper. The endpoint
 * must query the listing lane, surface provider values unmapped, and stay
 * strictly read-only: no request it issues may be anything but a GET.
 */

import { describe, it, expect, vi } from "vitest";
import { getAgcReviewStatus, AgcApiError } from "../src/lib/agc_api";

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
    expect(status.audit_opinion).toBeNull();
    expect(status.record_audit_result).toBeNull();
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
