import { expect, it, vi } from "vitest";
import { presignR2DownloadUrl } from "../src/lib/r2_presign";

it("binds a presigned download to GET or HEAD at the same signing time", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-30T10:00:00Z"));
  try {
    const env = {
      R2_S3_ENDPOINT: "https://r2.example.test",
      R2_BUCKET_NAME: "assets",
      R2_S3_ACCESS_KEY_ID: "test-access",
      R2_S3_SECRET_ACCESS_KEY: "test-secret",
    } as Env;
    const asset = { key: "verified/a file.gz", filetype: "gz", contentDisposition: "attachment" };
    const get = new URL((await presignR2DownloadUrl(env, asset, 120))!);
    const head = new URL((await presignR2DownloadUrl(env, asset, 120, "HEAD"))!);
    expect(get.pathname).toBe("/assets/verified/a%20file.gz");
    expect(head.pathname).toBe(get.pathname);
    expect(head.searchParams.get("X-Amz-Date")).toBe(get.searchParams.get("X-Amz-Date"));
    expect(head.searchParams.get("X-Amz-Expires")).toBe("120");
    expect(head.searchParams.get("X-Amz-Signature")).not.toBe(get.searchParams.get("X-Amz-Signature"));
  } finally {
    vi.useRealTimers();
  }
});
