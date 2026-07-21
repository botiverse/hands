import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AscApiCredentials } from "../src/lib/asc_api";
import {
  handleTestflightPublish,
  parsePublishInput,
  publishProcessedAscBuild,
  TestflightPublishError,
} from "../src/routes/testflight";

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

interface FakeAscOptions {
  processingState?: string;
  audience?: string;
  internalState?: string;
  externalState?: string;
  reviewState?: string | null;
}

function fakeAsc(options: FakeAscOptions = {}) {
  const assigned = new Set<string>();
  const localizations = new Map<string, { id: string; whatsNew: string }>();
  let autoNotify = false;
  let internalState = options.internalState ?? "IN_BETA_TESTING";
  let externalState = options.externalState ?? "READY_FOR_BETA_SUBMISSION";
  let reviewState = options.reviewState ?? null;
  let notificationCount = 0;

  const groups = [
    {
      id: "internal-1",
      attributes: {
        name: "Internal QA",
        isInternalGroup: true,
        hasAccessToAllBuilds: false,
      },
    },
    {
      id: "internal-2",
      attributes: {
        name: "Dogfood",
        isInternalGroup: true,
        hasAccessToAllBuilds: false,
      },
    },
    {
      id: "external-1",
      attributes: {
        name: "External Beta",
        isInternalGroup: false,
        hasAccessToAllBuilds: false,
      },
    },
  ];

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const json = () => JSON.parse(String(init?.body ?? "{}"));

    if (method === "GET" && url.pathname === "/v1/apps/app-1/betaGroups") {
      return Response.json({ data: groups });
    }
    if (method === "GET" && url.pathname === "/v1/builds/build-1") {
      return Response.json({
        data: {
          id: "build-1",
          attributes: {},
          relationships: {
            betaGroups: {
              data: [...assigned].map((id) => ({ type: "betaGroups", id })),
            },
          },
        },
      });
    }
    if (
      method === "GET" &&
      url.pathname === "/v1/builds/build-1/betaBuildLocalizations"
    ) {
      return Response.json({
        data: [...localizations.entries()].map(([locale, value]) => ({
          id: value.id,
          attributes: { locale, whatsNew: value.whatsNew },
        })),
      });
    }
    if (
      method === "GET" &&
      url.pathname === "/v1/builds/build-1/betaAppReviewSubmission"
    ) {
      return Response.json({
        data: reviewState
          ? {
              id: "review-1",
              attributes: {
                betaReviewState: reviewState,
                submittedDate: "2026-07-21T00:00:00Z",
              },
            }
          : null,
      });
    }
    if (
      method === "GET" &&
      url.pathname === "/v1/builds/build-1/buildBetaDetail"
    ) {
      return Response.json({
        data: {
          id: "detail-1",
          attributes: {
            autoNotifyEnabled: autoNotify,
            internalBuildState: internalState,
            externalBuildState: externalState,
          },
        },
      });
    }
    if (
      method === "POST" &&
      url.pathname === "/v1/builds/build-1/relationships/betaGroups"
    ) {
      for (const item of json().data) assigned.add(item.id);
      return new Response(null, { status: 204 });
    }
    if (method === "POST" && url.pathname === "/v1/betaBuildLocalizations") {
      const body = json().data;
      const id = `loc-${localizations.size + 1}`;
      localizations.set(body.attributes.locale, {
        id,
        whatsNew: body.attributes.whatsNew,
      });
      return Response.json(
        { data: { id, attributes: body.attributes } },
        { status: 201 },
      );
    }
    if (method === "PATCH" && url.pathname.startsWith("/v1/betaBuildLocalizations/")) {
      const body = json().data;
      const entry = [...localizations.entries()].find(
        ([, value]) => value.id === body.id,
      );
      if (entry) entry[1].whatsNew = body.attributes.whatsNew;
      return Response.json({
        data: {
          id: body.id,
          attributes: { locale: entry?.[0] ?? null, whatsNew: body.attributes.whatsNew },
        },
      });
    }
    if (method === "PATCH" && url.pathname === "/v1/buildBetaDetails/detail-1") {
      autoNotify = json().data.attributes.autoNotifyEnabled;
      return Response.json({
        data: {
          id: "detail-1",
          attributes: {
            autoNotifyEnabled: autoNotify,
            internalBuildState: internalState,
            externalBuildState: externalState,
          },
        },
      });
    }
    if (method === "POST" && url.pathname === "/v1/betaAppReviewSubmissions") {
      reviewState = "WAITING_FOR_REVIEW";
      externalState = "WAITING_FOR_BETA_REVIEW";
      return Response.json(
        {
          data: {
            id: "review-1",
            attributes: {
              betaReviewState: reviewState,
              submittedDate: "2026-07-21T00:00:00Z",
            },
          },
        },
        { status: 201 },
      );
    }
    if (method === "POST" && url.pathname === "/v1/buildBetaNotifications") {
      notificationCount += 1;
      externalState = "IN_BETA_TESTING";
      return Response.json({ data: { id: "notification-1" } }, { status: 201 });
    }

    return Response.json(
      { errors: [{ title: "UNEXPECTED_REQUEST", detail: `${method} ${url.pathname}` }] },
      { status: 500 },
    );
  });

  return {
    assigned,
    localizations,
    fetchMock,
    setReviewState(value: string, buildState = externalState) {
      reviewState = value;
      externalState = buildState;
    },
    notificationCount: () => notificationCount,
  };
}

function baseArgs() {
  return {
    handsBuild: {
      id: "hands-build-1",
      product_type: "ios-ipa",
      version_name: "1.0.0",
      version_code: 1000005,
      build_metadata_json: "{}",
    },
    bundleId: "build.raft.app",
    ascAppId: "app-1",
    ascBuild: {
      id: "build-1",
      attributes: {
        version: "1000005",
        uploadedDate: "2026-07-21T00:00:00Z",
        expirationDate: "2026-10-19T00:00:00Z",
        expired: false,
        processingState: "VALID",
        buildAudienceType: "APP_STORE_ELIGIBLE",
      },
    },
  } as const;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("publishProcessedAscBuild", () => {
  it("rejects a bundle assertion mismatch before operation or Apple access", async () => {
    let operationWrites = 0;
    const db = {
      prepare(sql: string) {
        if (sql.includes("INSERT INTO operation_logs")) operationWrites += 1;
        return {
          bind() {
            return this;
          },
          async all() {
            if (sql.includes("FROM builds b")) {
              return {
                results: [
                  {
                    id: "build-1",
                    product_type: "ios-ipa",
                    version_name: "1.0.0",
                    version_code: 1000005,
                    build_metadata_json: JSON.stringify({
                      bundle_id: "build.raft.app",
                    }),
                  },
                ],
              };
            }
            return { results: [] };
          },
          async first() {
            return null;
          },
          async run() {
            return { success: true };
          },
        };
      },
    };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const app = new Hono();
    app.post(
      "/api/apps/:appId/builds/:buildId/testflight-publish",
      handleTestflightPublish as any,
    );

    const response = await app.request(
      "/api/apps/app-1/builds/build-1/testflight-publish",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          distribution: "internal",
          group_ids: ["internal-1"],
          bundle_id: "other.example.app",
        }),
      },
      { DB: db, APK_BUCKET: { get: vi.fn() } } as any,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "BUNDLE_ID_MISMATCH",
      metadata_bundle_id: "build.raft.app",
    });
    expect(operationWrites).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("validates boolean notification and bundle assertions", () => {
    expect(() =>
      parsePublishInput({
        distribution: "external",
        group_ids: ["external-1"],
        notify_testers: "true",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "INVALID_NOTIFY_TESTERS" }),
    );
    expect(() =>
      parsePublishInput({
        distribution: "internal",
        group_ids: ["internal-1"],
        bundle_id: "   ",
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_BUNDLE_ID" }));
  });

  it("assigns multiple internal groups and is idempotent on retry", async () => {
    const creds = await generateTestCreds();
    const fake = fakeAsc();
    vi.stubGlobal("fetch", fake.fetchMock);

    const input = {
      distribution: "internal" as const,
      group_ids: ["internal-1", "internal-2"],
      what_to_test: { "en-US": "Verify login and Activity." },
      notify_testers: false,
    };
    const first = await publishProcessedAscBuild(creds, {
      ...baseArgs(),
      input,
    });
    const second = await publishProcessedAscBuild(creds, {
      ...baseArgs(),
      input,
    });

    expect(first.state).toBe("testing");
    expect(second.state).toBe("testing");
    expect([...fake.assigned].sort()).toEqual(["internal-1", "internal-2"]);
    expect(fake.localizations.get("en-US")?.whatsNew).toBe(
      "Verify login and Activity.",
    );
    const relationshipPosts = fake.fetchMock.mock.calls.filter(
      ([url, init]) =>
        String(url).includes("/relationships/betaGroups") &&
        init?.method === "POST",
    );
    expect(relationshipPosts).toHaveLength(1);
    const localizationPosts = fake.fetchMock.mock.calls.filter(
      ([url, init]) =>
        String(url).endsWith("/v1/betaBuildLocalizations") &&
        init?.method === "POST",
    );
    expect(localizationPosts).toHaveLength(1);
  });

  it("lets scheduled auto-notify complete without a duplicate manual notification", async () => {
    const creds = await generateTestCreds();
    const fake = fakeAsc();
    vi.stubGlobal("fetch", fake.fetchMock);
    const input = {
      distribution: "external" as const,
      group_ids: ["external-1"],
      what_to_test: {
        "en-US": "Verify the release candidate.",
        "zh-Hans": "验证发布候选版本。",
      },
      notify_testers: true,
    };

    const submitted = await publishProcessedAscBuild(creds, {
      ...baseArgs(),
      input,
    });
    expect(submitted.state).toBe("waiting_for_review");
    expect(submitted.notification).toBe("scheduled");
    expect(fake.notificationCount()).toBe(0);

    fake.setReviewState("APPROVED", "IN_BETA_TESTING");
    const approved = await publishProcessedAscBuild(creds, {
      ...baseArgs(),
      input,
    });
    expect(approved.notification).toBe("already_sent");
    expect(approved.state).toBe("testing");
    expect(fake.notificationCount()).toBe(0);

    const notificationPosts = fake.fetchMock.mock.calls.filter(
      ([url, init]) =>
        String(url).endsWith("/v1/buildBetaNotifications") &&
        init?.method === "POST",
    );
    expect(notificationPosts).toHaveLength(0);
    const autoNotifyPatches = fake.fetchMock.mock.calls.filter(
      ([url, init]) =>
        String(url).endsWith("/v1/buildBetaDetails/detail-1") &&
        init?.method === "PATCH",
    );
    expect(autoNotifyPatches).toHaveLength(1);
  });

  it("sends one manual notification when review was approved without auto-notify", async () => {
    const creds = await generateTestCreds();
    const fake = fakeAsc();
    vi.stubGlobal("fetch", fake.fetchMock);
    const initialInput = {
      distribution: "external" as const,
      group_ids: ["external-1"],
      what_to_test: { "en-US": "Verify the release candidate." },
      notify_testers: false,
    };
    await publishProcessedAscBuild(creds, {
      ...baseArgs(),
      input: initialInput,
    });
    fake.setReviewState("APPROVED", "BETA_APPROVED");

    const notifyInput = { ...initialInput, notify_testers: true };
    const approved = await publishProcessedAscBuild(creds, {
      ...baseArgs(),
      input: notifyInput,
    });
    expect(approved.notification).toBe("sent");
    expect(approved.state).toBe("testing");
    expect(fake.notificationCount()).toBe(1);

    const retried = await publishProcessedAscBuild(creds, {
      ...baseArgs(),
      input: notifyInput,
    });
    expect(retried.notification).toBe("already_sent");
    expect(fake.notificationCount()).toBe(1);
    const autoNotifyPatches = fake.fetchMock.mock.calls.filter(
      ([url, init]) =>
        String(url).endsWith("/v1/buildBetaDetails/detail-1") &&
        init?.method === "PATCH",
    );
    expect(autoNotifyPatches).toHaveLength(0);
  });

  it("fails closed while the ASC build is still processing", async () => {
    const creds = await generateTestCreds();
    const fake = fakeAsc();
    vi.stubGlobal("fetch", fake.fetchMock);
    const args = baseArgs();

    await expect(
      publishProcessedAscBuild(creds, {
        ...args,
        ascBuild: {
          ...args.ascBuild,
          attributes: { ...args.ascBuild.attributes, processingState: "PROCESSING" },
        },
        input: {
          distribution: "internal",
          group_ids: ["internal-1"],
          what_to_test: {},
          notify_testers: false,
        },
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "ASC_BUILD_NOT_READY",
    } satisfies Partial<TestflightPublishError>);
    expect(fake.assigned.size).toBe(0);
    expect(fake.localizations.size).toBe(0);
  });

  it("rejects missing or wrong-kind beta groups before mutation", async () => {
    const creds = await generateTestCreds();
    const fake = fakeAsc();
    vi.stubGlobal("fetch", fake.fetchMock);

    await expect(
      publishProcessedAscBuild(creds, {
        ...baseArgs(),
        input: {
          distribution: "internal",
          group_ids: ["missing-group"],
          what_to_test: {},
          notify_testers: false,
        },
      }),
    ).rejects.toMatchObject({ code: "ASC_BETA_GROUP_NOT_FOUND" });

    await expect(
      publishProcessedAscBuild(creds, {
        ...baseArgs(),
        input: {
          distribution: "external",
          group_ids: ["internal-1"],
          what_to_test: { "en-US": "Verify release." },
          notify_testers: false,
        },
      }),
    ).rejects.toMatchObject({ code: "ASC_BETA_GROUP_TYPE_MISMATCH" });
    expect(fake.assigned.size).toBe(0);
  });

  it("requires external What to Test metadata and rejects internal-only builds", async () => {
    const creds = await generateTestCreds();
    const fake = fakeAsc();
    vi.stubGlobal("fetch", fake.fetchMock);

    await expect(
      publishProcessedAscBuild(creds, {
        ...baseArgs(),
        input: {
          distribution: "external",
          group_ids: ["external-1"],
          what_to_test: {},
          notify_testers: false,
        },
      }),
    ).rejects.toMatchObject({ code: "WHAT_TO_TEST_REQUIRED" });

    const args = baseArgs();
    await expect(
      publishProcessedAscBuild(creds, {
        ...args,
        ascBuild: {
          ...args.ascBuild,
          attributes: {
            ...args.ascBuild.attributes,
            buildAudienceType: "INTERNAL_ONLY",
          },
        },
        input: {
          distribution: "external",
          group_ids: ["external-1"],
          what_to_test: { "en-US": "Verify release." },
          notify_testers: false,
        },
      }),
    ).rejects.toMatchObject({
      code: "ASC_BUILD_INTERNAL_ONLY",
      details: { build_audience_type: "INTERNAL_ONLY" },
    });
  });

  it.each([
    ["null", null],
    ["missing", undefined],
    ["unknown", "FUTURE_AUDIENCE"],
  ])(
    "rejects an external %s build audience before any Apple access",
    async (_label, audience) => {
      const creds = await generateTestCreds();
      const fake = fakeAsc();
      vi.stubGlobal("fetch", fake.fetchMock);
      const args = baseArgs();
      const {
        buildAudienceType: baseAudience,
        ...attributesWithoutAudience
      } = args.ascBuild.attributes;
      void baseAudience;
      const attributes = {
        ...attributesWithoutAudience,
        ...(audience === undefined ? {} : { buildAudienceType: audience }),
      };

      expect(Object.hasOwn(attributes, "buildAudienceType")).toBe(
        audience !== undefined,
      );
      expect(attributes.buildAudienceType).toBe(audience);

      await expect(
        publishProcessedAscBuild(creds, {
          ...args,
          ascBuild: {
            ...args.ascBuild,
            attributes,
          },
          input: {
            distribution: "external",
            group_ids: ["external-1"],
            what_to_test: { "en-US": "Verify release." },
            notify_testers: true,
          },
        }),
      ).rejects.toMatchObject({
        status: 409,
        code: "ASC_BUILD_AUDIENCE_NOT_ELIGIBLE",
        details: { build_audience_type: audience ?? null },
      } satisfies Partial<TestflightPublishError>);

      expect(fake.fetchMock).not.toHaveBeenCalled();
      expect(fake.assigned.size).toBe(0);
      expect(fake.localizations.size).toBe(0);
      expect(fake.notificationCount()).toBe(0);
    },
  );

  it("treats rejected and export-compliance beta states as terminal blockers", async () => {
    const creds = await generateTestCreds();
    const rejected = fakeAsc({ externalState: "BETA_REJECTED" });
    vi.stubGlobal("fetch", rejected.fetchMock);

    await expect(
      publishProcessedAscBuild(creds, {
        ...baseArgs(),
        input: {
          distribution: "external",
          group_ids: ["external-1"],
          what_to_test: { "en-US": "Verify release." },
          notify_testers: false,
        },
      }),
    ).rejects.toMatchObject({ code: "BETA_REVIEW_REJECTED" });
    expect(rejected.assigned.size).toBe(0);

    const compliance = fakeAsc({
      internalState: "MISSING_EXPORT_COMPLIANCE",
    });
    vi.stubGlobal("fetch", compliance.fetchMock);
    await expect(
      publishProcessedAscBuild(creds, {
        ...baseArgs(),
        input: {
          distribution: "internal",
          group_ids: ["internal-1"],
          what_to_test: {},
          notify_testers: false,
        },
      }),
    ).rejects.toMatchObject({
      code: "ASC_BETA_STATE_NOT_READY",
      details: { beta_state: "MISSING_EXPORT_COMPLIANCE" },
    });
    expect(compliance.assigned.size).toBe(0);
  });
});
