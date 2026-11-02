/** One provider subscription per request. Preview never issues provider writes. */
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { AscApiError, ascRequest, performUploadOperations, type UploadOperation } from "../lib/asc_api";
import { md5Hex } from "../lib/app_store_screenshots";
import { normalizeAppleProduct, ProductInputError, reconcileAppleProduct, type AppleExecution, type AscRequest } from "../lib/apple_subscription_products";
import { getGooglePlayBinding, hasGooglePlayConfiguration } from "../lib/google_play_bindings";
import { sniffImage } from "../lib/play_images";
import { insertAuditLog } from "../lib/permissions";
import { AppStoreReleaseError, ascAppIdFor, loadCredentials, type AdminContext } from "./app_store_release";

const MAX_REQUEST = 8 * 1024 * 1024;
const MAX_SCREENSHOT = 5 * 1024 * 1024;
const hash = (input: string | Uint8Array) => bytesToHex(sha256(typeof input === "string" ? new TextEncoder().encode(input) : input));
class RequestError extends Error { constructor(readonly status: 400 | 409 | 413, readonly code: string, message: string) { super(message); } }
type GoogleProductDiagnostic = { provider_http_status?: number; provider_body_empty?: boolean; provider_json_parsed?: boolean };
class GoogleProductError extends Error {
  constructor(readonly code: string, readonly diagnostic: GoogleProductDiagnostic = {}) { super("Store request failed; inspect provider state before retrying"); }
}
// Only adapter-defined categories cross the boundary; unknown codes and all
// provider messages, URLs, and metadata remain private.
const GOOGLE_PRODUCT_ERRORS = new Set([
  "play_credentials_invalid", "play_binding_invalid", "package_name_invalid",
  "play_token_unavailable", "play_token_rejected", "play_token_malformed",
  "play_api_unavailable", "play_api_rejected", "play_api_malformed",
  "play_subscription_malformed", "play_subscription_limit",
  "base_plan_immutable_mismatch", "base_plan_state_unknown",
]);

async function boundedJson(req: Request): Promise<Record<string, unknown>> {
  const length = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_REQUEST) throw new RequestError(413, "request_too_large", "request exceeds the size limit");
  if (!req.body) throw new RequestError(400, "request_invalid", "JSON body required");
  const reader = req.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const part = await reader.read(); if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_REQUEST) { await reader.cancel(); throw new RequestError(413, "request_too_large", "request exceeds the size limit"); }
    chunks.push(part.value);
  }
  const data = new Uint8Array(size); let offset = 0;
  for (const part of chunks) { data.set(part, offset); offset += part.length; }
  let body: unknown;
  try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(data)); }
  catch { throw new RequestError(400, "request_invalid", "body must be valid JSON"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new RequestError(400, "request_invalid", "body must be a JSON object");
  return body as Record<string, unknown>;
}

function screenshot(raw: unknown) {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new RequestError(400, "screenshot_invalid", "screenshot must be an object");
  const s = raw as Record<string, unknown>;
  if (Object.keys(s).some(k => !["fileName", "base64"].includes(k)) || typeof s.fileName !== "string" || !/^[A-Za-z0-9._-]{1,120}\.(?:png|jpg|jpeg)$/i.test(s.fileName)
    || typeof s.base64 !== "string" || s.base64.length > Math.ceil(MAX_SCREENSHOT / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s.base64)) {
    throw new RequestError(400, "screenshot_invalid", "screenshot needs a safe PNG/JPEG filename and base64 image");
  }
  let binary: string; try { binary = atob(s.base64); } catch { throw new RequestError(400, "screenshot_invalid", "screenshot encoding is invalid"); }
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  const image = sniffImage(bytes);
  if (!bytes.length || bytes.length > MAX_SCREENSHOT || !image || (image.format === "png" && !/\.png$/i.test(s.fileName)) || (image.format === "jpeg" && !/\.jpe?g$/i.test(s.fileName))) throw new RequestError(400, "screenshot_invalid", "screenshot must be a PNG or JPEG with a matching filename, at most 5 MiB");
  return { fileName: s.fileName, md5: md5Hex(bytes), sha256: hash(bytes), bytes };
}

/** Verify all ranges before the first upload, so overlap cannot masquerade as coverage. */
export async function performSubscriptionScreenshotUpload(ops: UploadOperation[], bytes: Uint8Array) {
  if (ops.length > 100) throw new AscApiError(502, "screenshot_reservation_malformed");
  let end = 0;
  for (const op of [...ops].sort((a,b) => a.offset - b.offset)) {
    let url: URL; try { url = new URL(op.url); } catch { throw new AscApiError(502, "screenshot_reservation_malformed"); }
    if (url.protocol !== "https:" || url.username || url.password || url.hash || /^(?:localhost|\d+\.\d+\.\d+\.\d+|\[)/i.test(url.hostname)
      || op.method !== "PUT" || !Number.isSafeInteger(op.offset) || !Number.isSafeInteger(op.length) || op.offset !== end || op.length <= 0 || op.offset + op.length > bytes.length) {
      throw new AscApiError(502, "screenshot_reservation_malformed");
    }
    end += op.length;
  }
  if (end !== bytes.length) throw new AscApiError(502, "screenshot_reservation_malformed");
  await performUploadOperations(ops, bytes);
}

export async function handleApplyStoreProduct(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  let locked = false, releaseLock = true, mutationStarted = false, targetHash = "", provider = "", operationId = crypto.randomUUID();
  try {
    const body = await boundedJson(c.req.raw);
    if (Object.keys(body).some(k => !["store", "mode", "product", "regionsVersion", "screenshot"].includes(k))
      || (body.store !== "apple" && body.store !== "google") || (body.mode !== "dry_run" && body.mode !== "commit")) {
      throw new RequestError(400, "request_invalid", "store and mode must be specified and fields must be supported");
    }
    provider = body.store; const mode = body.mode;
    const app = await c.env.DB.prepare("SELECT platform FROM apps WHERE id = ?1 AND archived = 0").bind(appId).first<{ platform: string }>();
    if (!app) return c.json({ code: "APP_NOT_FOUND", message: "app not found" }, 404);
    if ((provider === "apple" && app.platform !== "ios") || (provider === "google" && app.platform !== "android")) {
      return c.json({ code: "STORE_PLATFORM_MISMATCH", message: "store does not match this app's platform" }, 400);
    }
    let run: () => Promise<any>; let productId: string;
    if (provider === "apple") {
      if (body.regionsVersion !== undefined) throw new RequestError(400, "request_invalid", "regionsVersion is only for Google Play");
      const product = normalizeAppleProduct(body.product, screenshot(body.screenshot)); productId = product.productId;
      const creds = await loadCredentials(c, appId); const ascId = await ascAppIdFor(c, appId);
      targetHash = hash(`apple:${ascId}`); const groupHash = hash(product.group.referenceName);
      const req: AscRequest = (method, path, data) => { if (method !== "GET") mutationStarted = true; return ascRequest(creds, method, path, data); };
      const exec: AppleExecution = {
        claimGroupCreation: async () => {
          const r = await c.env.DB.prepare("INSERT OR IGNORE INTO store_apple_group_intents (target_hash, group_hash, operation_id, created_at) VALUES (?1, ?2, ?3, ?4)")
            .bind(targetHash, groupHash, operationId, Date.now()).run();
          return r.meta.changes === 1;
        },
        confirmGroupVisible: async () => { await c.env.DB.prepare("DELETE FROM store_apple_group_intents WHERE target_hash = ?1 AND group_hash = ?2").bind(targetHash, groupHash).run(); },
        releaseRejectedGroup: async () => { await c.env.DB.prepare("DELETE FROM store_apple_group_intents WHERE target_hash = ?1 AND group_hash = ?2 AND operation_id = ?3").bind(targetHash, groupHash, operationId).run(); },
        upload: performSubscriptionScreenshotUpload,
      };
      run = () => reconcileAppleProduct(req, ascId, product, mode, exec);
    } else {
      if (body.screenshot !== undefined || (body.regionsVersion !== undefined && (typeof body.regionsVersion !== "string" || !/^\d{4}\/\d{2}$/.test(body.regionsVersion)))) throw new RequestError(400, "request_invalid", "Google request has invalid fields or regionsVersion");
      if (!body.product || typeof body.product !== "object" || Array.isArray(body.product) || typeof (body.product as Record<string,unknown>).productId !== "string" || !/^[a-z0-9][a-z0-9._]{0,39}$/.test((body.product as Record<string,string>).productId!)) throw new RequestError(400, "request_invalid", "invalid productId");
      productId = (body.product as Record<string,string>).productId!;
      const service = c.env.PLAY_RELEASE_SERVICE;
      if (!service?.applySubscriptionProduct) return c.json({ code: "PLAY_SERVICE_UNAVAILABLE", message: "Google Play subscription service is unavailable" }, 503);
      let binding; try { binding = await getGooglePlayBinding(c.env.DB, appId, c.env.PLAY_CRED_ENC_KEYS); }
      catch { return c.json({ code: "PLAY_CREDENTIALS_UNAVAILABLE", message: "Google Play credentials are unavailable" }, 502); }
      if (!binding || !hasGooglePlayConfiguration(binding) || binding.enabled !== 1 || binding.verification_state !== "verified") return c.json({ code: "PLAY_BINDING_NOT_READY", message: "Google Play binding must be verified and enabled" }, 403);
      targetHash = hash(`google:${binding.package_name}`);
      run = async () => {
        const reply = await service.applySubscriptionProduct!({ credential: binding!.credential, packageName: binding!.package_name!, product: body.product, mode, regionsVersion: (body.regionsVersion as string | undefined) ?? "2022/02" });
        if (!reply.ok) {
          if (reply.error.code === "subscription_request_invalid" && reply.error.status === 400) {
            releaseLock = true; // adapter validates this before making any provider call
            throw new RequestError(400, "subscription_request_invalid", reply.error.message);
          }
          if (reply.error.code === "play_catalog_unverified" && reply.error.status === 409) {
            // The adapter emits this rejection only from its initial list,
            // before any provider write. Post-write failures use outcome=failed.
            releaseLock = true;
            throw new RequestError(409, "play_catalog_unverified", "Google Play returned no catalogue; confirm its state before writing");
          }
          const code = GOOGLE_PRODUCT_ERRORS.has(reply.error.code) ? reply.error.code : "google_subscription_failed";
          // This is a provider-reported field, not the transport status. Bound its
          // type and range and never copy the rest of the provider response.
          const http = reply.error.cause?.provider_identifiers?.http_code;
          const diagnostic: GoogleProductDiagnostic = {};
          if (code === "play_api_rejected" && typeof http === "number" && Number.isInteger(http) && http >= 400 && http <= 599) diagnostic.provider_http_status = http;
          const shape = reply.error.cause?.response_shape;
          if (code === "play_api_malformed" && shape && Number.isInteger(shape.status) && shape.status >= 200 && shape.status <= 299
            && typeof shape.body_empty === "boolean" && typeof shape.json_parsed === "boolean") {
            diagnostic.provider_http_status = shape.status;
            diagnostic.provider_body_empty = shape.body_empty;
            diagnostic.provider_json_parsed = shape.json_parsed;
          }
          throw new GoogleProductError(code, diagnostic);
        }
        if (reply.value.product_id !== productId || reply.value.mode !== mode || !["planned", "committed", "no_changes", "failed", "pending"].includes(reply.value.outcome)) throw new AscApiError(502, "google_response_malformed");
        return reply.value;
      };
    }
    if (mode === "commit") {
      const result = await c.env.DB.prepare("INSERT OR IGNORE INTO store_product_locks (provider, target_hash, operation_id, acquired_at) VALUES (?1, ?2, ?3, ?4)")
        .bind(provider, targetHash, operationId, Date.now()).run();
      if (result.meta.changes !== 1) return c.json({ code: "STORE_PRODUCT_LOCKED", message: "another operation is active or requires recovery" }, 409);
      locked = true;
      await insertAuditLog(c.env.DB, c, { app_id: appId, action: "store_product.attempt", payload: { provider, product_id: productId, operation_id: operationId } });
    }
    if (mode === "commit") releaseLock = false; // provider may have accepted a write even if its reply is lost
    const result = await run();
    if (mode === "commit" && (result.outcome !== "failed" || (provider === "apple" && !mutationStarted))) releaseLock = true;
    if (mode === "commit") await insertAuditLog(c.env.DB, c, { app_id: appId, action: "store_product.result", payload: { provider, product_id: productId, operation_id: operationId, outcome: result.outcome, completed: result.completed } });
    return c.json({ ...result, operation_id: mode === "commit" ? operationId : null, recovery_required: locked && !releaseLock }, result.outcome === "failed" ? 502 : 200);
  } catch (error) {
    if (provider === "apple" && !mutationStarted) releaseLock = true;
    if (locked && !releaseLock) return c.json({ code: "STORE_PRODUCT_RECOVERY_REQUIRED", operation_id: operationId, recovery_required: true, message: "A store write may have completed; inspect provider state and recover the lock before retrying" }, 502);
    if (error instanceof GoogleProductError) return c.json({ code: error.code, message: error.message, ...error.diagnostic }, 502);
    if (error instanceof RequestError) return c.json({ code: error.code, message: error.message }, error.status);
    if (error instanceof ProductInputError) return c.json({ code: "subscription_request_invalid", message: error.message }, 400);
    if (error instanceof AppStoreReleaseError) return c.json({ code: error.code, message: error.message }, error.status as 400);
    if (error instanceof AscApiError) return c.json({ code: /^[a-z0-9_]{1,80}$/.test(error.message) ? error.message : "provider_request_failed", message: "Store request failed; inspect provider state before retrying" }, error.status === 409 ? 409 : 502);
    return c.json({ code: "store_product_failed", message: "Store request failed; inspect provider state before retrying" }, 502);
  } finally {
    if (locked && releaseLock) await c.env.DB.prepare("DELETE FROM store_product_locks WHERE provider = ?1 AND target_hash = ?2 AND operation_id = ?3").bind(provider, targetHash, operationId).run();
  }
}
