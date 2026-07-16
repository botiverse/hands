/**
 * App-scoped macOS notarization proxy.
 *
 * The caller uploads a Developer-ID-signed .dmg/.pkg/.zip through the normal
 * Hands upload route. Hands owns the encrypted App Store Connect key, creates
 * the Apple submission, and streams the exact R2 bytes to Apple's temporary
 * S3 object. No Apple private key or temporary AWS credential crosses this API.
 */

import type { Context } from "hono";
import type { AdminEnv } from "../middleware/auth";
import { currentActor } from "../middleware/auth";
import { getAscCredentials } from "../lib/asc_credentials";
import {
  createNotarySubmission,
  getNotarySubmission,
  getNotarySubmissionLog,
  isTerminalNotaryStatus,
  NotaryApiError,
  uploadNotaryArtifact,
  verifyNotaryArtifactBinding,
  type NotaryLog,
} from "../lib/notary_api";
import { insertAuditLog } from "../lib/permissions";
import { createOperation, updateOperation } from "./operations";

type AdminContext = Context<AdminEnv & { Bindings: Env }>;

type NotarizationRow = {
  id: string;
  app_id: string;
  operation_id: string | null;
  idempotency_key: string;
  apple_submission_id: string | null;
  submission_name: string;
  source_r2_key: string;
  source_sha256: string;
  source_size_bytes: number;
  status: string;
  log_json: string | null;
  binding_verified: number;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
};

type CreateNotarizationInput = {
  r2Key: string;
  sha256: string;
  sizeBytes: number;
  submissionName: string;
  idempotencyKey: string;
};

function publicNotaryError(error: unknown) {
  if (error instanceof NotaryApiError) {
    return {
      code: "APPLE_NOTARY_REQUEST_FAILED",
      error: error.message,
      remote_status: error.status,
      retryable: error.status === 429 || error.status >= 500,
    };
  }
  return {
    code: "NOTARIZATION_PROXY_FAILED",
    error: "Hands could not complete the notarization request",
    retryable: true,
  };
}

export function parseCreateNotarizationInput(
  appId: string,
  body: Record<string, unknown>,
): { input: CreateNotarizationInput | null; error: string | null } {
  const r2Key = typeof body.r2_key === "string" ? body.r2_key.trim() : "";
  const sha256 =
    typeof body.sha256 === "string" ? body.sha256.trim().toLowerCase() : "";
  const sizeBytes =
    typeof body.size_bytes === "number" && Number.isSafeInteger(body.size_bytes)
      ? body.size_bytes
      : -1;
  const submissionName =
    typeof body.submission_name === "string"
      ? body.submission_name.trim()
      : "";
  const idempotencyKey =
    typeof body.idempotency_key === "string"
      ? body.idempotency_key.trim()
      : "";

  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    return { input: null, error: "sha256 must be 64 hexadecimal characters" };
  }
  if (sizeBytes <= 0) {
    return { input: null, error: "size_bytes must be a positive safe integer" };
  }
  if (
    !submissionName ||
    submissionName.length > 255 ||
    submissionName.includes("/") ||
    submissionName.includes("\\") ||
    !/\.(dmg|pkg|zip)$/i.test(submissionName)
  ) {
    return {
      input: null,
      error:
        "submission_name must be a .dmg, .pkg, or .zip basename of at most 255 characters",
    };
  }
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey)) {
    return {
      input: null,
      error:
        "idempotency_key must contain 1-128 letters, digits, dot, underscore, colon, or hyphen",
    };
  }
  const pendingPrefix = `apps/${appId}/pending/`;
  const pendingName = r2Key.slice(pendingPrefix.length);
  if (
    !r2Key.startsWith(pendingPrefix) ||
    !new RegExp(`^${sha256}\\.(dmg|pkg|zip)$`, "i").test(pendingName)
  ) {
    return {
      input: null,
      error:
        "r2_key must reference the sha256-addressed pending upload for this app",
    };
  }

  return {
    input: { r2Key, sha256, sizeBytes, submissionName, idempotencyKey },
    error: null,
  };
}

async function loadCredentials(c: AdminContext, appId: string) {
  const encKey = c.env.ASC_CRED_ENC_KEY;
  if (!encKey) {
    return {
      response: c.json({ error: "server is missing ASC_CRED_ENC_KEY" }, 500),
      credentials: null,
    };
  }
  const credentials = await getAscCredentials(c.env.DB, encKey, appId);
  if (!credentials) {
    return {
      response: c.json(
        {
          error:
            "no App Store Connect credentials configured for this app — add them in App Settings first",
        },
        400,
      ),
      credentials: null,
    };
  }
  return { response: null, credentials };
}

async function findByIdempotencyKey(
  db: D1Database,
  appId: string,
  idempotencyKey: string,
): Promise<NotarizationRow | null> {
  return (
    (await db
      .prepare(
        `SELECT id, app_id, operation_id, idempotency_key,
                apple_submission_id, submission_name, source_r2_key,
                source_sha256, source_size_bytes, status, log_json,
                binding_verified, created_at, updated_at, completed_at
         FROM app_notarizations
         WHERE app_id = ?1 AND idempotency_key = ?2
         LIMIT 1`,
      )
      .bind(appId, idempotencyKey)
      .first<NotarizationRow>()) ?? null
  );
}

function hasSameInput(row: NotarizationRow, input: CreateNotarizationInput) {
  return (
    row.submission_name === input.submissionName &&
    row.source_r2_key === input.r2Key &&
    row.source_sha256 === input.sha256 &&
    row.source_size_bytes === input.sizeBytes
  );
}

function submissionResponse(row: NotarizationRow, replayed: boolean) {
  return {
    notarization_id: row.id,
    operation_id: row.operation_id,
    submission_id: row.apple_submission_id,
    status: row.status,
    submission_name: row.submission_name,
    source_sha256: row.source_sha256,
    source_size_bytes: row.source_size_bytes,
    binding_verified: row.binding_verified === 1,
    replayed,
  };
}

export async function handleCreateNotarization(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const rawBody = (await c.req.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  const parsed = parseCreateNotarizationInput(appId, rawBody);
  if (!parsed.input) return c.json({ error: parsed.error }, 400);
  const input = parsed.input;

  // A retry after a lost HTTP response must succeed even though the successful
  // first request has already deleted its pending R2 object.
  const prior = await findByIdempotencyKey(
    c.env.DB,
    appId,
    input.idempotencyKey,
  );
  if (prior) {
    if (!hasSameInput(prior, input)) {
      return c.json(
        {
          code: "IDEMPOTENCY_KEY_REUSED",
          error: "idempotency_key is already bound to different artifact bytes",
        },
        409,
      );
    }
    return c.json(submissionResponse(prior, true));
  }

  const object = await c.env.APK_BUCKET.get(input.r2Key);
  if (!object) {
    return c.json({ error: "pending notarization artifact not found" }, 404);
  }
  if (object.size !== input.sizeBytes) {
    return c.json(
      {
        code: "ARTIFACT_SIZE_MISMATCH",
        error: "size_bytes does not match the pending R2 object",
      },
      409,
    );
  }

  const auth = await loadCredentials(c, appId);
  if (!auth.credentials) return auth.response!;

  const notarizationId = crypto.randomUUID();
  const now = Date.now();
  const insert = await c.env.DB.prepare(
    `INSERT OR IGNORE INTO app_notarizations
       (id, app_id, idempotency_key, submission_name, source_r2_key,
        source_sha256, source_size_bytes, status, created_by_actor,
        created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'Creating', ?8, ?9, ?9)`,
  )
    .bind(
      notarizationId,
      appId,
      input.idempotencyKey,
      input.submissionName,
      input.r2Key,
      input.sha256,
      input.sizeBytes,
      currentActor(c),
      now,
    )
    .run();

  // A concurrent request may have won the unique(app,idempotency_key) race.
  if ((insert.meta.changes ?? 0) === 0) {
    const winner = await findByIdempotencyKey(
      c.env.DB,
      appId,
      input.idempotencyKey,
    );
    if (!winner || !hasSameInput(winner, input)) {
      return c.json(
        {
          code: "IDEMPOTENCY_KEY_REUSED",
          error: "idempotency_key is already bound to different artifact bytes",
        },
        409,
      );
    }
    return c.json(submissionResponse(winner, true));
  }

  const operation = await createOperation(c.env.DB, {
    app_id: appId,
    kind: "notarization-submit",
    actor: currentActor(c),
    input: JSON.stringify({
      notarization_id: notarizationId,
      submission_name: input.submissionName,
      source_sha256: input.sha256,
      source_size_bytes: input.sizeBytes,
    }),
  });
  await c.env.DB.prepare(
    `UPDATE app_notarizations SET operation_id = ?1, updated_at = ?2
     WHERE id = ?3 AND app_id = ?4`,
  )
    .bind(operation.id, Date.now(), notarizationId, appId)
    .run();
  await updateOperation(c.env.DB, operation.id, {
    status: "in_progress",
    progress: 0.1,
  });

  let appleSubmissionId: string | null = null;
  try {
    const submission = await createNotarySubmission(auth.credentials, {
      submissionName: input.submissionName,
      sha256: input.sha256,
    });
    appleSubmissionId = submission.id;
    await c.env.DB.prepare(
      `UPDATE app_notarizations
       SET apple_submission_id = ?1, status = 'Uploading', updated_at = ?2
       WHERE id = ?3 AND app_id = ?4`,
    )
      .bind(submission.id, Date.now(), notarizationId, appId)
      .run();
    await updateOperation(c.env.DB, operation.id, {
      progress: 0.25,
      output: JSON.stringify({
        notarization_id: notarizationId,
        submission_id: submission.id,
      }),
    });

    await uploadNotaryArtifact(submission, {
      body: object.body,
      size: object.size,
    });

    const uploadedAt = Date.now();
    await c.env.DB.prepare(
      `UPDATE app_notarizations
       SET status = 'In Progress', updated_at = ?1
       WHERE id = ?2 AND app_id = ?3`,
    )
      .bind(uploadedAt, notarizationId, appId)
      .run();
    await updateOperation(c.env.DB, operation.id, {
      status: "success",
      progress: 1,
      output: JSON.stringify({
        notarization_id: notarizationId,
        submission_id: submission.id,
        status: "In Progress",
      }),
      completed_at: uploadedAt,
    });
    await insertAuditLog(c.env.DB, c, {
      app_id: appId,
      action: "notarization.submit",
      payload: {
        notarization_id: notarizationId,
        submission_id: submission.id,
        submission_name: input.submissionName,
        source_sha256: input.sha256,
        source_size_bytes: input.sizeBytes,
      },
      created_at: uploadedAt,
    });

    // Apple now owns the exact pre-staple bytes. The caller publishes only
    // after local stapling and validation, so this pending object is not a
    // distributable asset and can be removed.
    try {
      await c.env.APK_BUCKET.delete(input.r2Key);
    } catch {
      // The immutable submission row still prevents this object being treated
      // as a different notarization request; R2 cleanup can be retried later.
    }

    const row = await findByIdempotencyKey(
      c.env.DB,
      appId,
      input.idempotencyKey,
    );
    return c.json(submissionResponse(row!, false), 202);
  } catch (error) {
    const detail = publicNotaryError(error);
    const failedAt = Date.now();
    const status = appleSubmissionId
      ? "Upload Failed"
      : error instanceof NotaryApiError
        ? "Create Failed"
        : "Create Outcome Unknown";
    await c.env.DB.prepare(
      `UPDATE app_notarizations
       SET status = ?1, updated_at = ?2, completed_at = ?2
       WHERE id = ?3 AND app_id = ?4`,
    )
      .bind(status, failedAt, notarizationId, appId)
      .run();
    await updateOperation(c.env.DB, operation.id, {
      status: "failed",
      error: JSON.stringify(detail),
      completed_at: failedAt,
    });
    return c.json(
      {
        notarization_id: notarizationId,
        operation_id: operation.id,
        submission_id: appleSubmissionId,
        status,
        ok: false,
        ...detail,
      },
      502,
    );
  }
}

export async function handleGetNotarization(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const notarizationId = c.req.param("notarizationId") ?? "";
  const row = await c.env.DB.prepare(
    `SELECT id, app_id, operation_id, idempotency_key,
            apple_submission_id, submission_name, source_r2_key,
            source_sha256, source_size_bytes, status, log_json,
            binding_verified, created_at, updated_at, completed_at
     FROM app_notarizations
     WHERE id = ?1 AND app_id = ?2
     LIMIT 1`,
  )
    .bind(notarizationId, appId)
    .first<NotarizationRow>();
  if (!row) return c.json({ error: "notarization submission not found" }, 404);

  // A concurrent idempotent caller can observe the pre-Apple row. Returning
  // the local state is safer than creating another Apple submission.
  if (!row.apple_submission_id) {
    return c.json({
      ...submissionResponse(row, false),
      ready_for_staple: false,
      apple_sha256: null,
      binding_error:
        row.status === "Creating"
          ? "submission creation is still in progress"
          : "submission creation did not produce an Apple submission id",
      log: null,
      log_error: null,
    });
  }

  const auth = await loadCredentials(c, appId);
  if (!auth.credentials) return auth.response!;

  try {
    const submission = await getNotarySubmission(
      auth.credentials,
      row.apple_submission_id,
    );
    const terminal = isTerminalNotaryStatus(submission.attributes.status);
    let log: NotaryLog | null = row.log_json
      ? (JSON.parse(row.log_json) as NotaryLog)
      : null;
    let logError: string | null = null;
    if (terminal && !log) {
      try {
        log = await getNotarySubmissionLog(
          auth.credentials,
          row.apple_submission_id,
        );
      } catch (error) {
        logError = publicNotaryError(error).error;
      }
    }

    const binding =
      submission.attributes.status === "Accepted"
        ? verifyNotaryArtifactBinding(log, row.source_sha256)
        : { verified: false, appleSha256: null, error: null };
    const readyForStaple =
      submission.attributes.status === "Accepted" && binding.verified;
    const now = Date.now();
    await c.env.DB.prepare(
      `UPDATE app_notarizations
       SET status = ?1, log_json = ?2, binding_verified = ?3,
           updated_at = ?4,
           completed_at = CASE WHEN ?5 = 1
             THEN COALESCE(completed_at, ?4) ELSE completed_at END
       WHERE id = ?6 AND app_id = ?7`,
    )
      .bind(
        submission.attributes.status,
        log ? JSON.stringify(log) : row.log_json,
        binding.verified ? 1 : 0,
        now,
        terminal ? 1 : 0,
        notarizationId,
        appId,
      )
      .run();

    return c.json({
      notarization_id: row.id,
      operation_id: row.operation_id,
      submission_id: submission.id,
      submission_name: submission.attributes.name,
      status: submission.attributes.status,
      created_date: submission.attributes.createdDate,
      source_sha256: row.source_sha256,
      source_size_bytes: row.source_size_bytes,
      ready_for_staple: readyForStaple,
      binding_verified: binding.verified,
      apple_sha256: binding.appleSha256,
      binding_error: binding.error,
      log,
      log_error: logError,
    });
  } catch (error) {
    return c.json(
      {
        notarization_id: row.id,
        operation_id: row.operation_id,
        submission_id: row.apple_submission_id,
        status: row.status,
        ok: false,
        ...publicNotaryError(error),
      },
      502,
    );
  }
}
