import { describe, expect, it } from "vitest";
import {
  handleAbortFeedbackMultipart,
  handleCompleteFeedbackMultipart,
  handleFeedbackMultipartPart,
  handlePresignFeedbackAttachments,
} from "../src/routes/feedback";

const APP_ID = "app-ohos";
const CLIENT_KEY = "qk_ohos";
const R2_KEY = `feedback/${APP_ID}/presigned/attachment-log.zip`;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeContext(
  bucket: Record<string, unknown>,
  options: {
    query?: Record<string, string>;
    headers?: Record<string, string>;
    json?: unknown;
    body?: ReadableStream<Uint8Array> | null;
  } = {},
) {
  const headers = options.headers ?? {};
  return {
    env: {
      DB: {
        prepare: () => ({
          bind() { return this; },
          first: async () => ({ id: APP_ID, client_key: CLIENT_KEY }),
        }),
      },
      APK_BUCKET: bucket,
    },
    req: {
      param: (name: string) => name === "slug" ? "raft-ohos" : "",
      query: (name: string) => options.query?.[name],
      header: (name: string) => headers[name],
      json: async () => options.json,
      raw: { body: options.body ?? null },
    },
    json: jsonResponse,
  } as any;
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

function byteStream(bytes: number[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
}

describe("pure-ArkTS feedback R2 multipart proxy", () => {
  it("starts an R2 multipart session instead of returning a raw presigned PUT", async () => {
    let startedKey = "";
    let startedContentType = "";
    const bucket = {
      createMultipartUpload: async (key: string, options: { httpMetadata?: { contentType?: string } }) => {
        startedKey = key;
        startedContentType = options.httpMetadata?.contentType ?? "";
        return { key, uploadId: "upload-1" };
      },
    };
    const response = await handlePresignFeedbackAttachments(makeContext(bucket, {
      headers: { "X-Hands-Client-Key": CLIENT_KEY },
      json: {
        upload_mode: "r2_multipart_proxy",
        files: [{ filename: "log.zip", content_type: "application/zip", size: 50 * 1024 * 1024 + 1 }],
      },
    }));
    expect(response.status).toBe(200);
    const body = await responseJson(response);
    const uploads = body.uploads as Array<Record<string, unknown>>;
    expect(uploads[0]).toMatchObject({ upload_id: "upload-1", part_size: 5 * 1024 * 1024 });
    expect(uploads[0]?.upload_url).toBeUndefined();
    expect(startedKey).toMatch(/^feedback\/app-ohos\/presigned\//);
    expect(startedContentType).toBe("application/zip");
  });

  it("streams one exact bounded part and returns the R2 receipt", async () => {
    let received = new Uint8Array();
    const bucket = {
      resumeMultipartUpload: () => ({
        uploadPart: async (partNumber: number, stream: ReadableStream<Uint8Array>) => {
          const chunks: Uint8Array[] = [];
          const reader = stream.getReader();
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            chunks.push(next.value);
          }
          received = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
          let offset = 0;
          for (const chunk of chunks) {
            received.set(chunk, offset);
            offset += chunk.byteLength;
          }
          return { partNumber, etag: "etag-1" };
        },
        abort: async () => {},
      }),
    };
    const response = await handleFeedbackMultipartPart(makeContext(bucket, {
      query: { r2_key: R2_KEY, upload_id: "upload-1", part_number: "1" },
      headers: { "X-Hands-Client-Key": CLIENT_KEY, "X-Hands-Part-Bytes": "4" },
      body: byteStream([1, 2, 3, 4]),
    }));
    expect(response.status).toBe(200);
    expect(await responseJson(response)).toEqual({ part_number: 1, etag: "etag-1", size: 4 });
    expect([...received]).toEqual([1, 2, 3, 4]);
  });

  it("aborts a part whose actual bytes differ from the declared bound", async () => {
    let aborted = false;
    const upload = {
      uploadPart: async (partNumber: number, stream: ReadableStream<Uint8Array>) => {
        const reader = stream.getReader();
        while (!(await reader.read()).done) { /* consume */ }
        return { partNumber, etag: "etag-short" };
      },
      abort: async () => { aborted = true; },
    };
    const response = await handleFeedbackMultipartPart(makeContext({
      resumeMultipartUpload: () => upload,
    }, {
      query: { r2_key: R2_KEY, upload_id: "upload-1", part_number: "1" },
      headers: { "X-Hands-Client-Key": CLIENT_KEY, "X-Hands-Part-Bytes": "4" },
      body: byteStream([1, 2, 3]),
    }));
    expect(response.status).toBe(400);
    expect(aborted).toBe(true);
  });

  it("completes only a sequential exact-size part list", async () => {
    let completedParts: unknown[] = [];
    const bucket = {
      resumeMultipartUpload: () => ({
        complete: async (parts: unknown[]) => {
          completedParts = parts;
          return { size: 5 * 1024 * 1024 + 1 };
        },
      }),
      delete: async () => {},
    };
    const response = await handleCompleteFeedbackMultipart(makeContext(bucket, {
      headers: { "X-Hands-Client-Key": CLIENT_KEY },
      json: {
        r2_key: R2_KEY,
        upload_id: "upload-1",
        size: 5 * 1024 * 1024 + 1,
        parts: [
          { part_number: 1, etag: "etag-1" },
          { part_number: 2, etag: "etag-2" },
        ],
      },
    }));
    expect(response.status).toBe(200);
    expect(completedParts).toEqual([
      { partNumber: 1, etag: "etag-1" },
      { partNumber: 2, etag: "etag-2" },
    ]);

    const invalid = await handleCompleteFeedbackMultipart(makeContext(bucket, {
      headers: { "X-Hands-Client-Key": CLIENT_KEY },
      json: {
        r2_key: R2_KEY,
        upload_id: "upload-1",
        size: 5 * 1024 * 1024 + 1,
        parts: [
          { part_number: 2, etag: "etag-2" },
          { part_number: 1, etag: "etag-1" },
        ],
      },
    }));
    expect(invalid.status).toBe(400);
  });

  it("treats abort as idempotent cleanup", async () => {
    let abortCalls = 0;
    const response = await handleAbortFeedbackMultipart(makeContext({
      resumeMultipartUpload: () => ({
        abort: async () => { abortCalls += 1; },
      }),
    }, {
      headers: { "X-Hands-Client-Key": CLIENT_KEY },
      json: { r2_key: R2_KEY, upload_id: "upload-1" },
    }));
    expect(response.status).toBe(200);
    expect(abortCalls).toBe(1);
  });
});
