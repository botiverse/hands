import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { redirectToR2 } from "../src/lib/r2_presign";
import { generateInternalR2Url, handleInternalR2Download } from "../src/routes/public_v2";

const R2 = { R2_ACCOUNT_ID: "acct", R2_BUCKET_NAME: "hands-artifacts", R2_S3_ACCESS_KEY_ID: "AKIDEXAMPLE", R2_S3_SECRET_ACCESS_KEY: "secret-example" };

describe("redirectToR2", () => {
  it("redirects to a signed URL carrying the headers Hands would have sent, never cacheable", async () => {
    const res = await redirectToR2(R2 as unknown as Env, { key: "apps/a/feedback/shot.png", filetype: "bin", contentType: "image/png",
      contentDisposition: "inline; filename*=UTF-8''shot.png" }, "GET", 600);
    expect(res?.status).toBe(302);
    expect(res?.headers.get("cache-control")).toBe("no-store");
    const url = new URL(res!.headers.get("location")!);
    expect(url.origin).toBe("https://acct.r2.cloudflarestorage.com");
    expect(url.pathname).toBe("/hands-artifacts/apps/a/feedback/shot.png");
    expect(url.searchParams.get("response-content-type")).toBe("image/png");
    expect(url.searchParams.get("response-content-disposition")).toBe("inline; filename*=UTF-8''shot.png");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("600");
  });

  it("returns null when R2 signing is not configured, so the caller can stream", async () => {
    expect(await redirectToR2({} as Env, { key: "k", filetype: "bin", contentDisposition: "attachment" })).toBeNull();
  });
});

describe("internal signed download", () => {
  it("redirects a valid signature to R2 instead of streaming the object", async () => {
    const env = { ...R2, SIGNED_URL_SECRET: "test-secret", APK_BUCKET: { get: async () => { throw new Error("must not stream"); } } } as any;
    const app = new Hono<{ Bindings: any }>();
    app.get("/internal/r2/:key", handleInternalR2Download as any);
    const path = await generateInternalR2Url(env, "apps/a/builds/b/base.apk", 300);
    const res = await app.request(path, {}, env);
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/hands-artifacts/apps/a/builds/b/base.apk");
  });
});
