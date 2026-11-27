/**
 * App-level TestFlight Beta App Review Detail (contact + demo account + notes for
 * Apple's beta reviewers). The demo account password is write-only through Hands:
 * it is never returned, logged, or written to the audit trail.
 */
import {
  AscApiError,
  getBetaAppReviewDetail,
  updateBetaAppReviewDetail,
  type BetaAppReviewDetailAttributes,
  type BetaAppReviewDetailResource,
} from "../lib/asc_api";
import { insertAuditLog } from "../lib/permissions";
import {
  errorResponse,
  isPlausibleEmail,
  resolveAppContext,
  TestflightAppError,
  type AdminContext,
} from "./testflight_beta_app_description";

const FEATURE = "TestFlight Beta App Review Detail";
const MAX_NOTES_LENGTH = 4_000;
const MAX_FIELD_LENGTH = 255;

/** Hands snake_case field -> ASC betaAppReviewDetails attribute. */
const FIELD_MAP = {
  contact_first_name: "contactFirstName",
  contact_last_name: "contactLastName",
  contact_phone: "contactPhone",
  contact_email: "contactEmail",
  demo_account_name: "demoAccountName",
  demo_account_password: "demoAccountPassword",
  demo_account_required: "demoAccountRequired",
  notes: "notes",
} as const satisfies Record<string, keyof BetaAppReviewDetailAttributes>;
type ReviewField = keyof typeof FIELD_MAP;
const PASSWORD_FIELD: ReviewField = "demo_account_password";

export function publicReviewDetail(detail: BetaAppReviewDetailResource) {
  const a = detail.attributes ?? {};
  return {
    id: detail.id,
    contact_first_name: a.contactFirstName ?? null,
    contact_last_name: a.contactLastName ?? null,
    contact_phone: a.contactPhone ?? null,
    contact_email: a.contactEmail ?? null,
    demo_account_name: a.demoAccountName ?? null,
    demo_account_password_set: typeof a.demoAccountPassword === "string" && a.demoAccountPassword.length > 0,
    demo_account_required: a.demoAccountRequired ?? null,
    notes: a.notes ?? null,
  };
}

/** Validate a PUT body. Error messages never echo a supplied value. */
export function parseReviewDetailInput(body: unknown): {
  fields: ReviewField[];
  attributes: Partial<BetaAppReviewDetailAttributes>;
} {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new TestflightAppError(400, "INVALID_BODY", "request body must be an object");
  }
  const input = body as Record<string, unknown>;
  const keys = Object.keys(input);
  const unknown = keys.filter((key) => !Object.hasOwn(FIELD_MAP, key));
  if (unknown.length > 0) {
    throw new TestflightAppError(
      400,
      "INVALID_BODY",
      `unsupported field(s): ${unknown.join(", ")}; allowed: ${Object.keys(FIELD_MAP).join(", ")}`,
    );
  }
  if (keys.length === 0) {
    throw new TestflightAppError(400, "INVALID_BODY", "nothing to update");
  }
  const attributes: Partial<BetaAppReviewDetailAttributes> = {};
  for (const key of keys as ReviewField[]) {
    const value = input[key];
    if (key === "demo_account_required") {
      if (typeof value !== "boolean") {
        throw new TestflightAppError(400, "INVALID_FIELD", `${key} must be a boolean`);
      }
      attributes.demoAccountRequired = value;
      continue;
    }
    const max = key === "notes" ? MAX_NOTES_LENGTH : MAX_FIELD_LENGTH;
    if (typeof value !== "string" || !value.trim() || value.length > max) {
      throw new TestflightAppError(
        400,
        "INVALID_FIELD",
        `${key} must be a non-empty string of at most ${max} characters`,
      );
    }
    if (key === "contact_email" && !isPlausibleEmail(value)) {
      throw new TestflightAppError(400, "INVALID_FIELD", "contact_email must be an email address");
    }
    attributes[FIELD_MAP[key]] = value as never;
  }
  const fields = (Object.keys(FIELD_MAP) as ReviewField[]).filter((key) => key in input);
  return { fields, attributes };
}

export async function handleGetBetaReviewDetail(c: AdminContext) {
  try {
    const { bundleId, ascAppId, creds } = await resolveAppContext(c, FEATURE);
    const detail = await getBetaAppReviewDetail(creds, ascAppId);
    return c.json({
      bundle_id: bundleId,
      asc_app_id: ascAppId,
      review_detail: publicReviewDetail(detail),
    });
  } catch (error) {
    return errorResponse(c, error);
  }
}

export async function handleUpdateBetaReviewDetail(c: AdminContext) {
  try {
    const { fields, attributes } = parseReviewDetailInput(await c.req.json().catch(() => null));
    const { bundleId, ascAppId, creds } = await resolveAppContext(c, FEATURE);
    const audit = (action: string, payload: Record<string, unknown>) =>
      insertAuditLog(c.env.DB, c, {
        app_id: c.req.param("appId") ?? "",
        action: `testflight.beta_review_detail.${action}`,
        payload,
      });
    const requestId = crypto.randomUUID();
    const base = { request_id: requestId, bundle_id: bundleId, asc_app_id: ascAppId };
    // Field names only: contact details are personal data and the password is a secret.
    await audit("update_requested", { ...base, fields });

    let readback: BetaAppReviewDetailResource;
    try {
      const current = await getBetaAppReviewDetail(creds, ascAppId);
      await updateBetaAppReviewDetail(creds, current.id, attributes);
      readback = await getBetaAppReviewDetail(creds, ascAppId);
    } catch (error) {
      await audit("update_failed", {
        ...base,
        error: error instanceof AscApiError ? error.message : "unexpected error",
        asc_status: error instanceof AscApiError ? error.status : null,
      });
      throw error;
    }
    const live = readback.attributes ?? {};
    const mismatched = fields.filter((field) => {
      if (field === PASSWORD_FIELD) {
        // Apple may not echo the password verbatim; require only that one is set.
        return !(typeof live.demoAccountPassword === "string" && live.demoAccountPassword.length > 0);
      }
      return live[FIELD_MAP[field]] !== attributes[FIELD_MAP[field]];
    });
    if (mismatched.length > 0) {
      await audit("update_mismatch", { ...base, mismatched_fields: mismatched });
      throw new TestflightAppError(
        409,
        "READBACK_MISMATCH",
        "App Store Connect readback did not match the requested Beta App Review Detail",
        { mismatched_fields: mismatched },
      );
    }
    await audit("update_verified", { ...base, fields, readback_exact: true });
    return c.json({
      ok: true,
      bundle_id: bundleId,
      asc_app_id: ascAppId,
      updated_fields: fields,
      readback_exact: true,
      review_detail: publicReviewDetail(readback),
    });
  } catch (error) {
    return errorResponse(c, error);
  }
}
