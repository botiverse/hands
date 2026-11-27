/** App-level TestFlight Beta App Description, separate from build-level What to Test. */
import type { Context } from "hono";
import type { AdminEnv } from "../middleware/auth";
import { getAscCredentials } from "../lib/asc_credentials";
import {
  AscApiError,
  BetaAppLocalizationNeedsDescriptionError,
  getBetaAppLocalizations,
  resolveAscAppId,
  upsertBetaAppLocalizations,
  type AscApiCredentials,
  type BetaAppLocalizationFields,
  type BetaAppLocalizationResource,
} from "../lib/asc_api";
import { insertAuditLog } from "../lib/permissions";
import { BUNDLE_ID_NOT_CONFIGURED_MESSAGE, bundleIdNotConfiguredNextAction } from "../lib/bundle_id_guidance";

export type AdminContext = Context<AdminEnv & { Bindings: Env }>;

const MAX_DESCRIPTION_LENGTH = 4_000;
const MAX_LOCALES_PER_REQUEST = 100;
const LOCALE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

/** Hands-side refusal for the app-level TestFlight routes (shared with beta groups / review detail). */
export class TestflightAppError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 500 | 502,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_URL_LENGTH = 2_048;

export function isPlausibleEmail(value: string): boolean {
  return value.length <= 254 && EMAIL_PATTERN.test(value);
}

export function isHttpsUrl(value: string): boolean {
  if (value.length > MAX_URL_LENGTH || value !== value.trim()) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname);
  } catch {
    return false;
  }
}

/** Hands snake_case per-locale field -> ASC betaAppLocalizations attribute. */
const LOCALIZATION_FIELD_MAP = {
  feedback_email: "feedbackEmail",
  marketing_url: "marketingUrl",
  privacy_policy_url: "privacyPolicyUrl",
} as const;
type LocalizationFieldName = keyof typeof LOCALIZATION_FIELD_MAP;

function validLocale(rawLocale: string): string {
  const locale = rawLocale.trim();
  if (
    !locale ||
    locale !== rawLocale ||
    locale.length > 64 ||
    !LOCALE_PATTERN.test(locale)
  ) {
    throw new TestflightAppError(400, "INVALID_LOCALE", `invalid locale: ${rawLocale}`);
  }
  return locale;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Body: `{ descriptions?: {locale: text}, localizations?: {locale: {feedback_email?,
 * marketing_url?, privacy_policy_url?}} }`, at least one present. The original
 * descriptions-only body is unchanged. Returns ASC attribute names per locale.
 */
export function parseBetaAppDescriptions(body: unknown): Record<string, BetaAppLocalizationFields> {
  if (!plainObject(body)) {
    throw new TestflightAppError(400, "INVALID_BODY", "request body must be an object");
  }
  const bodyKeys = Object.keys(body);
  if (
    bodyKeys.length === 0 ||
    bodyKeys.some((key) => key !== "descriptions" && key !== "localizations")
  ) {
    throw new TestflightAppError(
      400,
      "INVALID_BODY",
      "request body may contain only descriptions and localizations",
    );
  }
  const normalized: Record<string, BetaAppLocalizationFields> = Object.create(null);
  if ("descriptions" in body) {
    const descriptions = body.descriptions;
    if (!plainObject(descriptions)) {
      throw new TestflightAppError(
        400,
        "INVALID_DESCRIPTIONS",
        "descriptions must be a non-empty locale-to-text object",
      );
    }
    const entries = Object.entries(descriptions);
    if (entries.length === 0 || entries.length > MAX_LOCALES_PER_REQUEST) {
      throw new TestflightAppError(
        400,
        "INVALID_DESCRIPTIONS",
        `descriptions must contain between 1 and ${MAX_LOCALES_PER_REQUEST} locales`,
      );
    }
    for (const [rawLocale, rawDescription] of entries) {
      const locale = validLocale(rawLocale);
      if (typeof rawDescription !== "string") {
        throw new TestflightAppError(
          400,
          "INVALID_DESCRIPTION",
          `description for ${locale} must be a string`,
        );
      }
      if (!rawDescription.trim() || rawDescription.length > MAX_DESCRIPTION_LENGTH) {
        throw new TestflightAppError(
          400,
          "INVALID_DESCRIPTION",
          `description for ${locale} must contain 1-${MAX_DESCRIPTION_LENGTH} characters`,
        );
      }
      normalized[locale] = { description: rawDescription };
    }
  }
  if ("localizations" in body) {
    const localizations = body.localizations;
    if (!plainObject(localizations)) {
      throw new TestflightAppError(
        400,
        "INVALID_LOCALIZATIONS",
        "localizations must be a non-empty locale-to-fields object",
      );
    }
    const entries = Object.entries(localizations);
    if (entries.length === 0 || entries.length > MAX_LOCALES_PER_REQUEST) {
      throw new TestflightAppError(
        400,
        "INVALID_LOCALIZATIONS",
        `localizations must contain between 1 and ${MAX_LOCALES_PER_REQUEST} locales`,
      );
    }
    for (const [rawLocale, rawFields] of entries) {
      const locale = validLocale(rawLocale);
      if (!plainObject(rawFields) || Object.keys(rawFields).length === 0) {
        throw new TestflightAppError(
          400,
          "INVALID_LOCALIZATION",
          `localizations.${locale} must be a non-empty object`,
        );
      }
      const fields: BetaAppLocalizationFields = { ...(normalized[locale] ?? {}) };
      for (const [name, value] of Object.entries(rawFields)) {
        if (!Object.hasOwn(LOCALIZATION_FIELD_MAP, name)) {
          throw new TestflightAppError(
            400,
            "INVALID_LOCALIZATION",
            `localizations.${locale} may contain only ${Object.keys(LOCALIZATION_FIELD_MAP).join(", ")} (put description in descriptions)`,
          );
        }
        const valid =
          typeof value === "string" &&
          (name === "feedback_email" ? isPlausibleEmail(value) : isHttpsUrl(value));
        if (!valid) {
          throw new TestflightAppError(
            400,
            "INVALID_LOCALIZATION",
            name === "feedback_email"
              ? `localizations.${locale}.feedback_email must be an email address`
              : `localizations.${locale}.${name} must be an https:// URL`,
          );
        }
        fields[LOCALIZATION_FIELD_MAP[name as LocalizationFieldName]] = value as string;
      }
      normalized[locale] = fields;
    }
  }
  if (Object.keys(normalized).length > MAX_LOCALES_PER_REQUEST) {
    throw new TestflightAppError(
      400,
      "INVALID_LOCALIZATIONS",
      `a request may touch at most ${MAX_LOCALES_PER_REQUEST} locales`,
    );
  }
  return normalized;
}

function publicLocalizations(items: BetaAppLocalizationResource[]) {
  return items
    .map((item) => ({
      id: item.id,
      locale: item.attributes.locale,
      description: item.attributes.description,
      feedback_email: item.attributes.feedbackEmail ?? null,
      marketing_url: item.attributes.marketingUrl ?? null,
      privacy_policy_url: item.attributes.privacyPolicyUrl ?? null,
    }))
    .sort((a, b) => (a.locale ?? "").localeCompare(b.locale ?? ""));
}

export async function resolveAppContext(c: AdminContext, feature = "Beta App Description"): Promise<{
  bundleId: string;
  ascAppId: string;
  creds: AscApiCredentials;
}> {
  const appId = c.req.param("appId") ?? "";
  const app = await c.env.DB.prepare("SELECT platform FROM apps WHERE id = ?1")
    .bind(appId)
    .first<{ platform: string }>();
  if (!app) throw new TestflightAppError(404, "APP_NOT_FOUND", "app not found");
  if (app.platform !== "ios") {
    throw new TestflightAppError(
      400,
      "APP_NOT_IOS",
      `${feature} is available only for iOS apps`,
    );
  }
  const bundleRow = await c.env.DB.prepare(
    "SELECT bundle_id FROM channels WHERE app_id = ?1 AND slug = 'main' LIMIT 1",
  )
    .bind(appId)
    .first<{ bundle_id: string | null }>();
  const bundleId = (bundleRow?.bundle_id ?? "").trim();
  if (!bundleId) {
    throw new TestflightAppError(
      400,
      "BUNDLE_ID_NOT_CONFIGURED",
      BUNDLE_ID_NOT_CONFIGURED_MESSAGE,
      { next_action: bundleIdNotConfiguredNextAction(appId) },
    );
  }
  const encKey = c.env.ASC_CRED_ENC_KEY;
  if (!encKey) {
    throw new TestflightAppError(
      500,
      "ASC_ENCRYPTION_NOT_CONFIGURED",
      "server is missing ASC_CRED_ENC_KEY",
    );
  }
  const creds = await getAscCredentials(c.env.DB, encKey, appId);
  if (!creds) {
    throw new TestflightAppError(
      400,
      "ASC_CREDENTIALS_NOT_CONFIGURED",
      "no ASC credentials configured for this app",
    );
  }
  const ascAppId = await resolveAscAppId(creds, bundleId);
  if (!ascAppId) {
    throw new TestflightAppError(
      404,
      "ASC_APP_NOT_FOUND",
      `no App Store Connect app record for bundle id ${bundleId}`,
    );
  }
  return { bundleId, ascAppId, creds };
}

export function errorResponse(c: AdminContext, error: unknown) {
  if (error instanceof TestflightAppError) {
    return c.json(
      { error: error.message, code: error.code, ...error.details },
      error.status,
    );
  }
  if (error instanceof BetaAppLocalizationNeedsDescriptionError) {
    return c.json(
      { error: error.message, code: "LOCALE_REQUIRES_DESCRIPTION", locales: error.locales },
      400,
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
    const requested = parseBetaAppDescriptions(await c.req.json().catch(() => null));
    const { bundleId, ascAppId, creds } = await resolveAppContext(c);
    const requestId = crypto.randomUUID();
    const digests: Record<string, string> = {};
    const fieldNames: Record<string, string[]> = {};
    for (const [locale, fields] of Object.entries(requested)) {
      fieldNames[locale] = Object.keys(fields).sort();
      const description = fields.description;
      if (description === undefined) continue;
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
        locales: Object.keys(requested).sort(),
        fields: fieldNames,
        description_sha256: digests,
      },
    });

    let readback: BetaAppLocalizationResource[];
    try {
      await upsertBetaAppLocalizations(creds, ascAppId, requested);
      readback = await getBetaAppLocalizations(creds, ascAppId);
    } catch (error) {
      await insertAuditLog(c.env.DB, c, {
        app_id: c.req.param("appId") ?? "",
        action: "testflight.beta_app_description.update_failed",
        payload: {
          request_id: requestId,
          bundle_id: bundleId,
          asc_app_id: ascAppId,
          error:
            error instanceof AscApiError || error instanceof BetaAppLocalizationNeedsDescriptionError
              ? error.message
              : "unexpected error",
          asc_status: error instanceof AscApiError ? error.status : null,
        },
      });
      throw error;
    }
    const byLocale = new Map(readback.map((item) => [item.attributes.locale, item.attributes]));
    const mismatched = Object.entries(requested)
      .filter(([locale, fields]) => {
        const live = byLocale.get(locale);
        return (
          !live ||
          (Object.keys(fields) as Array<keyof BetaAppLocalizationFields>).some(
            (key) => live[key] !== fields[key],
          )
        );
      })
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
      throw new TestflightAppError(
        409,
        "READBACK_MISMATCH",
        "App Store Connect readback did not match the requested localizations",
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
        locales: Object.keys(requested).sort(),
        fields: fieldNames,
        readback_exact: true,
      },
    });
    return c.json({
      ok: true,
      bundle_id: bundleId,
      asc_app_id: ascAppId,
      updated_locales: Object.keys(requested).sort(),
      readback_exact: true,
      localizations: publicLocalizations(readback),
    });
  } catch (error) {
    return errorResponse(c, error);
  }
}
