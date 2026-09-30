import { AwsClient } from "aws4fetch";

export interface R2PresignAsset {
  key: string;
  filetype: string;
  contentDisposition: string;
}

export function canPresignR2Download(env: Env): boolean {
  return Boolean(
    (env.R2_S3_ENDPOINT || env.R2_ACCOUNT_ID) &&
      env.R2_BUCKET_NAME &&
      env.R2_S3_ACCESS_KEY_ID &&
      env.R2_S3_SECRET_ACCESS_KEY,
  );
}

export async function presignR2DownloadUrl(
  env: Env,
  asset: R2PresignAsset,
  ttlSeconds: number,
  method: "GET" | "HEAD" = "GET",
): Promise<string | null> {
  if (!canPresignR2Download(env)) return null;

  const expires = String(Math.max(1, Math.min(Math.floor(ttlSeconds), 604800)));
  const url = new URL(`${r2Endpoint(env)}/${encodeURIComponent(env.R2_BUCKET_NAME!)}/${asset.key.split("/").map(encodeURIComponent).join("/")}`);
  url.searchParams.set("X-Amz-Expires", expires);
  url.searchParams.set("response-content-type", contentTypeForPresignedAsset(asset.filetype));
  url.searchParams.set("response-content-disposition", asset.contentDisposition);

  const aws = new AwsClient({
    accessKeyId: env.R2_S3_ACCESS_KEY_ID!,
    secretAccessKey: env.R2_S3_SECRET_ACCESS_KEY!,
    service: "s3",
    region: "auto",
    retries: 0,
  });
  const request = await aws.sign(url.toString(), {
    method,
    aws: {
      signQuery: true,
      service: "s3",
      region: "auto",
    },
  });
  return request.url;
}

/**
 * Presign a direct-to-R2 PUT so large attachments upload straight to the
 * bucket, bypassing the Worker's request-size limits. The client must PUT
 * with the same Content-Type it declared. Returns null if R2 S3 creds are
 * unconfigured.
 */
export async function presignR2UploadUrl(
  env: Env,
  key: string,
  contentType: string,
  ttlSeconds: number,
): Promise<string | null> {
  if (!canPresignR2Download(env)) return null;
  const expires = String(Math.max(1, Math.min(Math.floor(ttlSeconds), 3600)));
  const url = new URL(
    `${r2Endpoint(env)}/${encodeURIComponent(env.R2_BUCKET_NAME!)}/${key.split("/").map(encodeURIComponent).join("/")}`,
  );
  url.searchParams.set("X-Amz-Expires", expires);
  const aws = new AwsClient({
    accessKeyId: env.R2_S3_ACCESS_KEY_ID!,
    secretAccessKey: env.R2_S3_SECRET_ACCESS_KEY!,
    service: "s3",
    region: "auto",
    retries: 0,
  });
  const request = await aws.sign(url.toString(), {
    method: "PUT",
    headers: { "content-type": contentType || "application/octet-stream" },
    aws: { signQuery: true, service: "s3", region: "auto" },
  });
  return request.url;
}

function r2Endpoint(env: Env): string {
  const configured = env.R2_S3_ENDPOINT?.replace(/\/+$/, "");
  if (configured) return configured;
  return `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
}

function contentTypeForPresignedAsset(filetype: string): string {
  switch (filetype) {
    case "apk":
      return "application/vnd.android.package-archive";
    case "json":
      return "application/json";
    case "txt":
      return "text/plain; charset=utf-8";
    case "zip":
      return "application/zip";
    default:
      return "application/octet-stream";
  }
}
