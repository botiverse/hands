/** App-level TestFlight Beta App Description, separate from build-level What to Test. */
import type { Context } from "hono";
import type { AdminEnv } from "../middleware/auth";
import { getAscCredentials } from "../lib/asc_credentials";
import {
  AscApiError,
  getBetaAppLocalizations,
  resolveAscAppId,
  upsertBetaAppLocalizations,
  type AscApiCredentials,
  type BetaAppLocalizationResource,
} from "../lib/asc_api";
import { insertAuditLog } from "../lib/permissions";

type AdminContext = Context<AdminEnv & { Bindings: Env }>;

const MAX_DESCRIPTION_LENGTH = 4_000;
const MAX_LOCALES_PER_REQUEST = 100;
const LOCALE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

class BetaAppDescriptionError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 500 | 502,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function parseBetaAppDescriptions(body: unknown): Record<string, string> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new BetaAppDescriptionError(400, "INVALID_BODY", "request body must be an object");
  }
  const bodyKeys = Object.keys(body);
  if (bodyKeys.length !== 1 || bodyKeys[0] !== "descriptions") {
    throw new BetaAppDescriptionError(
      400,
      "INVALID_BODY",
      "request body may contain only descriptions",
    );
  }
  const descriptions = (body as { descriptions?: unknown }).descriptions;
  if (!descriptions || typeof descriptions !== "object" || Array.isArray(descriptions)) {
    throw new BetaAppDescriptionError(
      400,
      "INVALID_DESCRIPTIONS",
      "descriptions must be a non-empty locale-to-text object",
    );
  }
  const entries = Object.entries(descriptions);
  if (entries.length === 0 || entries.length > MAX_LOCALES_PER_REQUEST) {
    throw new BetaAppDescriptionError(
      400,
      "INVALID_DESCRIPTIONS",
      `descriptions must contain between 1 and ${MAX_LOCALES_PER_REQUEST} locales`,
    );
  }
  const normalized: Record<string, string> = Object.create(null);
  for (const [rawLocale, rawDescription] of entries) {
    const locale = rawLocale.trim();
    if (
      !locale ||
      locale !== rawLocale ||
      locale.length > 64 ||
      !LOCALE_PATTERN.test(locale)
    ) {
      throw new BetaAppDescriptionError(400, "INVALID_LOCALE", `invalid locale: ${rawLocale}`);
    }
    if (typeof rawDescription !== "string") {
      throw new BetaAppDescriptionError(
        400,
        "INVALID_DESCRIPTION",
        `description for ${locale} must be a string`,
      );
    }
    if (!rawDescription.trim() || rawDescription.length > MAX_DESCRIPTION_LENGTH) {
      throw new BetaAppDescriptionError(
        400,
        "INVALID_DESCRIPTION",
        `description for ${locale} must contain 1-${MAX_DESCRIPTION_LENGTH} characters`,
      );
    }
    normalized[locale] = rawDescription;
  }
  return normalized;
}

function publicLocalizations(items: BetaAppLocalizationResource[]) {
  return items
    .map((item) => ({
      id: item.id,
      locale: item.attributes.locale,
      description: item.attributes.description,
    }))
    .sort((a, b) => (a.locale ?? "").localeCompare(b.locale ?? ""));
}

async function resolveAppContext(c: AdminContext): Promise<{
  bundleId: string;
  ascAppId: string;
  creds: AscApiCredentials;
}> {
  const appId = c.req.param("appId") ?? "";
  const app = await c.env.DB.prepare("SELECT platform FROM apps WHERE id = ?1")
    .bind(appId)
    .first<{ platform: string }>();
  if (!app) throw new BetaAppDescriptionError(404, "APP_NOT_FOUND", "app not found");
  if (app.platform !== "ios") {
    throw new BetaAppDescriptionError(
      400,
      "APP_NOT_IOS",
      "Beta App Description is available only for iOS apps",
    );
  }
  const bundleRow = await c.env.DB.prepare(
    "SELECT bundle_id FROM channels WHERE app_id = ?1 AND slug = 'main' LIMIT 1",
  )
    .bind(appId)
    .first<{ bundle_id: string | null }>();
  const bundleId = (bundleRow?.bundle_id ?? "").trim();
  if (!bundleId) {
    throw new BetaAppDescriptionError(
      400,
      "BUNDLE_ID_NOT_CONFIGURED",
      "the main channel has no App Store bundle id",
    );
  }
  const encKey = c.env.ASC_CRED_ENC_KEY;
  if (!encKey) {
    throw new BetaAppDescriptionError(
      500,
      "ASC_ENCRYPTION_NOT_CONFIGURED",
      "server is missing ASC_CRED_ENC_KEY",
    );
  }
  const creds = await getAscCredentials(c.env.DB, encKey, appId);
  if (!creds) {
    throw new BetaAppDescriptionError(
      400,
      "ASC_CREDENTIALS_NOT_CONFIGURED",
      "no ASC credentials configured for this app",
    );
  }
  const ascAppId = await resolveAscAppId(creds, bundleId);
  if (!ascAppId) {
    throw new BetaAppDescriptionError(
      404,
      "ASC_APP_NOT_FOUND",
      `no App Store Connect app record for bundle id ${bundleId}`,
    );
  }
  return { bundleId, ascAppId, creds };
}

function errorResponse(c: AdminContext, error: unknown) {
  if (error instanceof BetaAppDescriptionError) {
    return c.json(
      { error: error.message, code: error.code, ...error.details },
      error.status,
    );
  }
  if (error instanceof AscApiError) {
    return c.json(
      { error: error.message, code: "ASC_API_ERROR", status: error.status, detail: error.detail },
      502,
    );
  }
  throw error;
}

export async function handleGetBetaAppDescription(c: AdminContext) {
  try {
    const { bundleId, ascAppId, creds } = await resolveAppContext(c);
    const localizations = await getBetaAppLocalizations(creds, ascAppId);
    return c.json({
      bundle_id: bundleId,
      asc_app_id: ascAppId,
      localizations: publicLocalizations(localizations),
    });
  } catch (error) {
    return errorResponse(c, error);
  }
}

export async function handleUpdateBetaAppDescription(c: AdminContext) {
  try {
    const descriptions = parseBetaAppDescriptions(await c.req.json().catch(() => null));
    const { bundleId, ascAppId, creds } = await resolveAppContext(c);
    const requestId = crypto.randomUUID();
    const digests: Record<string, string> = {};
    for (const [locale, description] of Object.entries(descriptions)) {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(description),
      );
      digests[locale] = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
    }
    await insertAuditLog(c.env.DB, c, {
      app_id: c.req.param("appId") ?? "",
      action: "testflight.beta_app_description.update_requested",
      payload: {
        request_id: requestId,
        bundle_id: bundleId,
        asc_app_id: ascAppId,
        locales: Object.keys(descriptions).sort(),
        description_sha256: digests,
      },
    });

    let readback: BetaAppLocalizationResource[];
    try {
      await upsertBetaAppLocalizations(creds, ascAppId, descriptions);
      readback = await getBetaAppLocalizations(creds, ascAppId);
    } catch (error) {
      await insertAuditLog(c.env.DB, c, {
        app_id: c.req.param("appId") ?? "",
        action: "testflight.beta_app_description.update_failed",
        payload: {
          request_id: requestId,
          bundle_id: bundleId,
          asc_app_id: ascAppId,
          error: error instanceof AscApiError ? error.message : "unexpected error",
          asc_status: error instanceof AscApiError ? error.status : null,
        },
      });
      throw error;
    }
    const byLocale = new Map(
      readback.map((item) => [item.attributes.locale, item.attributes.description]),
    );
    const mismatched = Object.entries(descriptions)
      .filter(([locale, description]) => byLocale.get(locale) !== description)
      .map(([locale]) => locale);
    if (mismatched.length > 0) {
      await insertAuditLog(c.env.DB, c, {
        app_id: c.req.param("appId") ?? "",
        action: "testflight.beta_app_description.update_mismatch",
        payload: {
          request_id: requestId,
          bundle_id: bundleId,
          asc_app_id: ascAppId,
          mismatched_locales: mismatched,
        },
      });
      throw new BetaAppDescriptionError(
        409,
        "READBACK_MISMATCH",
        "App Store Connect readback did not match the requested descriptions",
        { mismatched_locales: mismatched },
      );
    }

    await insertAuditLog(c.env.DB, c, {
      app_id: c.req.param("appId") ?? "",
      action: "testflight.beta_app_description.update_verified",
      payload: {
        request_id: requestId,
        bundle_id: bundleId,
        asc_app_id: ascAppId,
        locales: Object.keys(descriptions).sort(),
        readback_exact: true,
      },
    });
    return c.json({
      ok: true,
      bundle_id: bundleId,
      asc_app_id: ascAppId,
      updated_locales: Object.keys(descriptions).sort(),
      readback_exact: true,
      localizations: publicLocalizations(readback),
    });
  } catch (error) {
    return errorResponse(c, error);
  }
}
