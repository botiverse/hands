/**
 * App-scoped credential export for local Apple notarization.
 *
 * Hands remains the encrypted source of truth for the ASC team key, but the
 * protected macOS release runner owns the artifact and invokes Apple's
 * supported `notarytool` directly. This endpoint never receives artifact
 * bytes. It deliberately requires publisher access, emits an audit receipt
 * before releasing the secret, and marks the response non-cacheable.
 */

import type { Context } from "hono";
import type { AdminEnv } from "../middleware/auth";
import { currentActor } from "../middleware/auth";
import { getAscCredentials } from "../lib/asc_credentials";
import { insertAuditLog } from "../lib/permissions";

type AdminContext = Context<AdminEnv & { Bindings: Env }>;

export type NotarizationCredentialExportInput = {
  submissionName: string;
  sha256: string;
  sizeBytes: number;
};

export function parseNotarizationCredentialExportInput(
  body: Record<string, unknown>,
): { input: NotarizationCredentialExportInput | null; error: string | null } {
  const submissionName =
    typeof body.submission_name === "string"
      ? body.submission_name.trim()
      : "";
  const sha256 =
    typeof body.sha256 === "string" ? body.sha256.trim().toLowerCase() : "";
  const sizeBytes =
    typeof body.size_bytes === "number" && Number.isSafeInteger(body.size_bytes)
      ? body.size_bytes
      : -1;

  if (
    !submissionName ||
    submissionName.length > 255 ||
    submissionName.includes("/") ||
    submissionName.includes("\\") ||
    !/\.(dmg|pkg)$/i.test(submissionName)
  ) {
    return {
      input: null,
      error:
        "submission_name must be a .dmg or .pkg basename of at most 255 characters",
    };
  }
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    return { input: null, error: "sha256 must be 64 hexadecimal characters" };
  }
  if (sizeBytes <= 0) {
    return { input: null, error: "size_bytes must be a positive safe integer" };
  }

  return {
    input: { submissionName, sha256, sizeBytes },
    error: null,
  };
}

export async function handleExportNotarizationCredentials(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const body = (await c.req.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  const parsed = parseNotarizationCredentialExportInput(body);
  if (!parsed.input) return c.json({ error: parsed.error }, 400);

  const encKey = c.env.ASC_CRED_ENC_KEY;
  if (!encKey) {
    return c.json({ error: "server is missing ASC_CRED_ENC_KEY" }, 500);
  }
  const credentials = await getAscCredentials(c.env.DB, encKey, appId);
  if (!credentials) {
    return c.json(
      {
        error:
          "no App Store Connect credentials configured for this app — add them in App Settings first",
      },
      404,
    );
  }

  const exportId = crypto.randomUUID();
  const issuedAt = Date.now();

  // Audit must commit before secret material can cross the response boundary.
  // The private key and its ciphertext are never included in the audit row.
  await insertAuditLog(c.env.DB, c, {
    app_id: appId,
    action: "notarization.credentials_export",
    payload: {
      export_id: exportId,
      credential_id: credentials.id,
      credential_updated_at: credentials.updated_at,
      submission_name: parsed.input.submissionName,
      source_sha256: parsed.input.sha256,
      source_size_bytes: parsed.input.sizeBytes,
      actor: currentActor(c),
    },
    created_at: issuedAt,
  });

  return c.json(
    {
      export_id: exportId,
      app_id: appId,
      issued_at: issuedAt,
      credential_updated_at: credentials.updated_at,
      submission_name: parsed.input.submissionName,
      source_sha256: parsed.input.sha256,
      source_size_bytes: parsed.input.sizeBytes,
      credentials: {
        kind: "app_store_connect_api_key",
        key_id: credentials.key_id,
        issuer_id: credentials.issuer_id,
        p8: credentials.p8,
      },
    },
    200,
    {
      "cache-control": "no-store, max-age=0",
      pragma: "no-cache",
      "x-content-type-options": "nosniff",
    },
  );
}
