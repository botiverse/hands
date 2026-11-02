/**
 * Route-level Range contract on the Electron download route.
 *
 * The parser tests cover syntax. This file covers the part that actually reaches
 * electron-updater: the status, the Content-Range/Content-Length pair, and — the
 * assertion a status-only test would miss — that the body is the requested SLICE
 * and not the whole object. A 206 whose body is the full file would corrupt the
 * client's block assembly while looking correct.
 */
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { handleElectronGenericAsset } from "../src/routes/electron";

const FILE_BYTES = Uint8Array.from({ length: 1000 }, (_, i) => i % 256);
const R2_KEY = "electron/build/installer.exe";

type RangeArg = { offset: number; length?: number } | undefined;

function makeApp(
  rangeSeen: { value: RangeArg } = { value: undefined },
  getImpl?: (key: string, opts?: { range?: RangeArg }) => Promise<any>,
) {
  const app = new Hono<{ Bindings: any }>();
  app.get("/electron/:slug/:channel/:file", handleElectronGenericAsset as any);
  const env = {
    DB: {
      prepare: (sql: string) => ({
        bind: (..._args: unknown[]) => ({
          first: async () => {
            if (sql.includes("FROM apps")) return { id: "app-1" };
            if (sql.includes("JOIN releases")) return { build_id: "build-1" };
            return null;
          },
          all: async () => ({
            results: [
              {
                id: "asset-1",
                artifact_kind: "installable",
                platform: "win32",
                arch: "x64",
                variant: null,
                filetype: "exe",
                r2_key: R2_KEY,
                size_bytes: FILE_BYTES.length,
                metadata_json: "{}",
              },
            ],
          }),
        }),
      }),
    },
    APK_BUCKET: {
      get: getImpl ?? (async (_key: string, opts?: { range?: RangeArg }) => {
        rangeSeen.value = opts?.range;
        const r = opts?.range;
        const slice = r ? FILE_BYTES.slice(r.offset, r.offset + (r.length ?? FILE_BYTES.length)) : FILE_BYTES;
        return {
          body: slice,
          httpEtag: '"etag-test"',
          writeHttpMetadata: (h: Headers) => h.set("content-type", "application/octet-stream"),
        };
      }),
    },
  };
  return { app, env };
}

describe("electron download route — Range", () => {
  it("answers a single range with 206, correct headers and the sliced body", async () => {
    const seen = { value: undefined as RangeArg };
    const { app, env } = makeApp(seen);
    const res = await app.request(
      "/electron/raft-desktop/main/installer.exe",
      { headers: { range: "bytes=100-199" } },
      env as any,
    );

    expect(res.status).toBe(206);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-range")).toBe(`bytes 100-199/${FILE_BYTES.length}`);
    expect(res.headers.get("content-length")).toBe("100");
    // The body must be the slice, not the whole object.
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.length).toBe(100);
    expect(body[0]).toBe(FILE_BYTES[100]);
    // And R2 must have been asked for exactly that slice.
    expect(seen.value).toEqual({ offset: 100, length: 100 });
  });

  it("serves 200 with the whole body when no Range is sent", async () => {
    const seen = { value: undefined as RangeArg };
    const { app, env } = makeApp(seen);
    const res = await app.request("/electron/raft-desktop/main/installer.exe", {}, env as any);

    expect(res.status).toBe(200);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(seen.value).toBeUndefined();
    expect(new Uint8Array(await res.arrayBuffer()).length).toBe(FILE_BYTES.length);
  });

  it("returns 416 when the range starts past the end", async () => {
    const { app, env } = makeApp();
    const res = await app.request(
      "/electron/raft-desktop/main/installer.exe",
      { headers: { range: "bytes=5000-5999" } },
      env as any,
    );
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe(`bytes */${FILE_BYTES.length}`);
  });

  it("416 carries no Content-Length, because it promises no body", async () => {
    // Reusing the representation headers here set Content-Length to the whole object size
    // while the body was empty. A client that trusts Content-Length then waits for bytes
    // that never arrive instead of handling the 416, so the response has to be built with
    // its own header set rather than the one prepared for the object.
    const { app, env } = makeApp();
    const res = await app.request(
      "/electron/raft-desktop/main/installer.exe",
      { headers: { range: "bytes=5000-5999" } },
      env as any,
    );
    expect(res.status).toBe(416);
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.length).toBe(0);
    const contentLength = res.headers.get("content-length");
    // Either absent, or honestly "0" -- never the object size.
    expect(contentLength === null || contentLength === "0").toBe(true);
    expect(contentLength).not.toBe(String(FILE_BYTES.length));
  });

  it("ignores Range when If-Range names a different representation", async () => {
    // A resumed download must not splice a new object onto bytes from an old one.
    const seen = { value: undefined as RangeArg };
    const { app, env } = makeApp(seen);
    const res = await app.request(
      "/electron/raft-desktop/main/installer.exe",
      { headers: { range: "bytes=100-199", "if-range": '"some-other-etag"' } },
      env as any,
    );
    expect(res.status).toBe(200);
    expect(seen.value).toBeUndefined();
    expect(new Uint8Array(await res.arrayBuffer()).length).toBe(FILE_BYTES.length);
  });

  it("honours Range when If-Range matches the current etag", async () => {
    const seen = { value: undefined as RangeArg };
    const { app, env } = makeApp(seen);
    const res = await app.request(
      "/electron/raft-desktop/main/installer.exe",
      { headers: { range: "bytes=100-199", "if-range": '"etag-test"' } },
      env as any,
    );
    expect(res.status).toBe(206);
    expect(seen.value).toEqual({ offset: 100, length: 100 });
  });

  it("serves the full body for a multi-interval request instead of a wrong slice", async () => {
    const seen = { value: undefined as RangeArg };
    const { app, env } = makeApp(seen);
    const res = await app.request(
      "/electron/raft-desktop/main/installer.exe",
      { headers: { range: "bytes=0-99,200-299" } },
      env as any,
    );
    // A correct multipart/byteranges body is not implemented; falling back to 200 is
    // the documented "no range support" answer that makes clients re-download in full.
    expect(res.status).toBe(200);
    expect(seen.value).toBeUndefined();
    expect(new Uint8Array(await res.arrayBuffer()).length).toBe(FILE_BYTES.length);
  });

  it("retries a transient R2 get failure on the real download route", async () => {
    let attempts = 0;
    const { app, env } = makeApp({ value: undefined }, async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("get: We encountered an internal error. Please try again. (10001)");
      return {
        body: FILE_BYTES,
        httpEtag: '"etag-test"',
        writeHttpMetadata: (h: Headers) => h.set("content-type", "application/octet-stream"),
      };
    });
    const res = await app.request("/electron/raft-desktop/main/installer.exe", {}, env as any);
    expect(res.status).toBe(200);
    expect(attempts).toBe(2);
    expect(new Uint8Array(await res.arrayBuffer()).length).toBe(FILE_BYTES.length);
  });
});
