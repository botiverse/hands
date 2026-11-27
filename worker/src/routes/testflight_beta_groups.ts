/**
 * App-level TestFlight beta groups: list, create external groups, and update
 * public-link / feedback settings, so a public external beta can be prepared
 * without the App Store Connect web UI. Every write is audited and verified by a
 * fresh read of the group from Apple.
 */
import {
  AscApiError,
  createExternalBetaGroup,
  getBetaGroup,
  listBetaGroups,
  updateBetaGroup,
  type BetaGroupResource,
  type BetaGroupWritableAttributes,
} from "../lib/asc_api";
import { insertAuditLog } from "../lib/permissions";
import {
  errorResponse,
  resolveAppContext,
  TestflightAppError,
  type AdminContext,
} from "./testflight_beta_app_description";

const FEATURE = "TestFlight beta groups";
const MAX_GROUP_NAME_LENGTH = 255;
export const PUBLIC_LINK_LIMIT_MIN = 1;
export const PUBLIC_LINK_LIMIT_MAX = 10_000;

/** Hands snake_case body field -> ASC betaGroups attribute. */
const FIELD_MAP = {
  name: "name",
  public_link_enabled: "publicLinkEnabled",
  public_link_limit: "publicLinkLimit",
  public_link_limit_enabled: "publicLinkLimitEnabled",
  feedback_enabled: "feedbackEnabled",
} as const;
type GroupField = keyof typeof FIELD_MAP;
const PUBLIC_LINK_FIELDS: GroupField[] = [
  "public_link_enabled",
  "public_link_limit",
  "public_link_limit_enabled",
];

export function publicBetaGroup(group: BetaGroupResource) {
  const a = group.attributes;
  return {
    id: group.id,
    name: a.name ?? null,
    is_internal: a.isInternalGroup ?? null,
    has_access_to_all_builds: a.hasAccessToAllBuilds ?? null,
    public_link_enabled: a.publicLinkEnabled ?? null,
    public_link: a.publicLink ?? null,
    public_link_limit: a.publicLinkLimit ?? null,
    public_link_limit_enabled: a.publicLinkLimitEnabled ?? null,
    feedback_enabled: a.feedbackEnabled ?? null,
    created_date: a.createdDate ?? null,
  };
}

const normalizeName = (name: string | null | undefined) => (name ?? "").trim().toLowerCase();

/**
 * Validate a create (`requireName`) or update body. Unknown keys are refused so a
 * typo never silently does nothing. A limit supplied without
 * public_link_limit_enabled turns the limit on, since a limit that is off has no effect.
 */
export function parseBetaGroupInput(
  body: unknown,
  mode: "create" | "update",
): { fields: GroupField[]; attributes: BetaGroupWritableAttributes } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new TestflightAppError(400, "INVALID_BODY", "request body must be an object");
  }
  const allowed: GroupField[] =
    mode === "create"
      ? ["name", "public_link_enabled", "public_link_limit", "public_link_limit_enabled", "feedback_enabled"]
      : (Object.keys(FIELD_MAP) as GroupField[]);
  const input = body as Record<string, unknown>;
  const keys = Object.keys(input);
  const unknown = keys.filter((key) => !(allowed as string[]).includes(key));
  if (unknown.length > 0) {
    throw new TestflightAppError(
      400,
      "INVALID_BODY",
      `unsupported field(s): ${unknown.join(", ")}; allowed: ${allowed.join(", ")}`,
    );
  }
  if (mode === "create" && !("name" in input)) {
    throw new TestflightAppError(400, "INVALID_NAME", "name is required");
  }
  if (keys.length === 0) {
    throw new TestflightAppError(400, "INVALID_BODY", "nothing to update");
  }
  const attributes: BetaGroupWritableAttributes = {};
  if ("name" in input) {
    const name = input.name;
    if (typeof name !== "string" || !name.trim() || name.length > MAX_GROUP_NAME_LENGTH || name !== name.trim()) {
      throw new TestflightAppError(
        400,
        "INVALID_NAME",
        `name must be a non-empty string of at most ${MAX_GROUP_NAME_LENGTH} characters without leading/trailing spaces`,
      );
    }
    attributes.name = name;
  }
  for (const key of ["public_link_enabled", "public_link_limit_enabled", "feedback_enabled"] as const) {
    if (key in input) {
      if (typeof input[key] !== "boolean") {
        throw new TestflightAppError(400, "INVALID_FIELD", `${key} must be a boolean`);
      }
      attributes[FIELD_MAP[key]] = input[key] as boolean;
    }
  }
  if ("public_link_limit" in input) {
    const limit = input.public_link_limit;
    if (
      typeof limit !== "number" ||
      !Number.isInteger(limit) ||
      limit < PUBLIC_LINK_LIMIT_MIN ||
      limit > PUBLIC_LINK_LIMIT_MAX
    ) {
      throw new TestflightAppError(
        400,
        "INVALID_PUBLIC_LINK_LIMIT",
        `public_link_limit must be an integer between ${PUBLIC_LINK_LIMIT_MIN} and ${PUBLIC_LINK_LIMIT_MAX}`,
      );
    }
    attributes.publicLinkLimit = limit;
    if (!("public_link_limit_enabled" in input)) attributes.publicLinkLimitEnabled = true;
  }
  const fields = (Object.keys(FIELD_MAP) as GroupField[]).filter(
    (key) => attributes[FIELD_MAP[key]] !== undefined,
  );
  return { fields, attributes };
}

function mismatchedAttributes(
  group: BetaGroupResource,
  wanted: BetaGroupWritableAttributes,
): string[] {
  return (Object.keys(FIELD_MAP) as GroupField[])
    .filter((key) => {
      const value = wanted[FIELD_MAP[key]];
      return value !== undefined && group.attributes[FIELD_MAP[key]] !== value;
    });
}

function publicLinkNote(group: BetaGroupResource): string | undefined {
  return group.attributes.publicLinkEnabled && !group.attributes.publicLink
    ? "Public link is enabled but Apple has not returned a URL yet; list the groups again shortly."
    : undefined;
}

export async function handleListBetaGroups(c: AdminContext) {
  try {
    const { bundleId, ascAppId, creds } = await resolveAppContext(c, FEATURE);
    const groups = await listBetaGroups(creds, ascAppId);
    return c.json({
      bundle_id: bundleId,
      asc_app_id: ascAppId,
      groups: groups
        .map(publicBetaGroup)
        .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")),
    });
  } catch (error) {
    return errorResponse(c, error);
  }
}

async function auditGroup(
  c: AdminContext,
  action: string,
  payload: Record<string, unknown>,
) {
  await insertAuditLog(c.env.DB, c, {
    app_id: c.req.param("appId") ?? "",
    action: `testflight.beta_group.${action}`,
    payload,
  });
}

/** Re-read the group from Apple and fail (409) unless every requested attribute matches. */
async function verifyGroup(
  c: AdminContext,
  base: Record<string, unknown>,
  readback: BetaGroupResource,
  attributes: BetaGroupWritableAttributes,
  kind: "create" | "update",
) {
  const mismatched = mismatchedAttributes(readback, attributes);
  if (mismatched.length > 0) {
    await auditGroup(c, `${kind}_mismatch`, { ...base, mismatched_fields: mismatched });
    throw new TestflightAppError(
      409,
      "READBACK_MISMATCH",
      "App Store Connect readback did not match the requested beta group settings",
      { group_id: readback.id, mismatched_fields: mismatched, group: publicBetaGroup(readback) },
    );
  }
  await auditGroup(c, `${kind}_verified`, { ...base, readback_exact: true });
}

export async function handleCreateBetaGroup(c: AdminContext) {
  try {
    const { fields, attributes } = parseBetaGroupInput(
      await c.req.json().catch(() => null),
      "create",
    );
    const name = attributes.name!;
    const { bundleId, ascAppId, creds } = await resolveAppContext(c, FEATURE);
    const existing = await listBetaGroups(creds, ascAppId);
    const duplicate = existing.find((group) => normalizeName(group.attributes.name) === normalizeName(name));
    if (duplicate) {
      throw new TestflightAppError(
        409,
        "DUPLICATE_GROUP_NAME",
        `a beta group named "${duplicate.attributes.name}" already exists for this app`,
        { group: publicBetaGroup(duplicate) },
      );
    }
    const requestId = crypto.randomUUID();
    const base = { request_id: requestId, bundle_id: bundleId, asc_app_id: ascAppId };
    await auditGroup(c, "create_requested", { ...base, fields, attributes });

    let readback: BetaGroupResource;
    try {
      const created = await createExternalBetaGroup(creds, ascAppId, { ...attributes, name });
      // Apple may fill publicLink only after the link is enabled: always re-read.
      readback = await getBetaGroup(creds, created.id);
    } catch (error) {
      await auditGroup(c, "create_failed", {
        ...base,
        error: error instanceof AscApiError ? error.message : "unexpected error",
        asc_status: error instanceof AscApiError ? error.status : null,
      });
      throw error;
    }
    if (readback.attributes.isInternalGroup !== false) {
      await auditGroup(c, "create_mismatch", { ...base, group_id: readback.id, mismatched_fields: ["is_internal"] });
      throw new TestflightAppError(
        409,
        "READBACK_MISMATCH",
        "App Store Connect did not report the new group as external",
        { group_id: readback.id, mismatched_fields: ["is_internal"], group: publicBetaGroup(readback) },
      );
    }
    await verifyGroup(c, { ...base, group_id: readback.id }, readback, attributes, "create");
    const note = publicLinkNote(readback);
    return c.json(
      {
        ok: true,
        bundle_id: bundleId,
        asc_app_id: ascAppId,
        readback_exact: true,
        group: publicBetaGroup(readback),
        ...(note ? { note } : {}),
      },
      201,
    );
  } catch (error) {
    return errorResponse(c, error);
  }
}

export async function handleUpdateBetaGroup(c: AdminContext) {
  try {
    const groupId = c.req.param("groupId") ?? "";
    const { fields, attributes } = parseBetaGroupInput(
      await c.req.json().catch(() => null),
      "update",
    );
    const { bundleId, ascAppId, creds } = await resolveAppContext(c, FEATURE);
    // Ownership: the group must be one of this ASC app's groups, never another app's.
    const groups = await listBetaGroups(creds, ascAppId);
    const current = groups.find((group) => group.id === groupId);
    if (!current) {
      throw new TestflightAppError(
        404,
        "GROUP_NOT_FOUND",
        "beta group not found for this app's App Store Connect record",
      );
    }
    if (current.attributes.isInternalGroup !== false) {
      const refused = fields.filter((field) => PUBLIC_LINK_FIELDS.includes(field));
      if (refused.length > 0) {
        throw new TestflightAppError(
          400,
          "INTERNAL_GROUP_PUBLIC_LINK",
          "internal beta groups cannot have a public link; App Store Connect allows public links only on external groups",
          { fields: refused },
        );
      }
    }
    if (attributes.name !== undefined) {
      const clash = groups.find(
        (group) => group.id !== groupId && normalizeName(group.attributes.name) === normalizeName(attributes.name),
      );
      if (clash) {
        throw new TestflightAppError(
          409,
          "DUPLICATE_GROUP_NAME",
          `a beta group named "${clash.attributes.name}" already exists for this app`,
          { group: publicBetaGroup(clash) },
        );
      }
    }
    const requestId = crypto.randomUUID();
    const base = { request_id: requestId, bundle_id: bundleId, asc_app_id: ascAppId, group_id: groupId };
    await auditGroup(c, "update_requested", {
      ...base,
      fields,
      attributes,
      previous: publicBetaGroup(current),
    });
    let readback: BetaGroupResource;
    try {
      await updateBetaGroup(creds, groupId, attributes);
      readback = await getBetaGroup(creds, groupId);
    } catch (error) {
      await auditGroup(c, "update_failed", {
        ...base,
        error: error instanceof AscApiError ? error.message : "unexpected error",
        asc_status: error instanceof AscApiError ? error.status : null,
      });
      throw error;
    }
    await verifyGroup(c, base, readback, attributes, "update");
    const note = publicLinkNote(readback);
    return c.json({
      ok: true,
      bundle_id: bundleId,
      asc_app_id: ascAppId,
      updated_fields: fields,
      readback_exact: true,
      group: publicBetaGroup(readback),
      ...(note ? { note } : {}),
    });
  } catch (error) {
    return errorResponse(c, error);
  }
}
