import { currentActor } from "../middleware/auth";
import type { AdminContext } from "../lib/permissions";
import {
  resolveActiveReleaseForClient,
  rolloutIncludes,
} from "./public_v2";

const EVENT = "app_update:cleanup_terminal";
const OPERATION_KIND = "app-update-cleanup-terminal";
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

interface CleanupTerminalInput {
  operation_id: string;
  run_case_id: string;
  attempt: number;
  artifact_bundle_digest: string;
  expected_release_revision: number;
  target_device_id: string;
}

interface ReleaseAuthority {
  release_id: string;
  release_revision: number;
  release_status: string;
  rollout_cohort_count: number | null;
  build_id: string;
  product_type: string;
  release_type: string;
  version_code: number;
  app_id: string;
  app_slug: string;
  app_platform: string;
  org_id: string;
  channel_id: string;
  channel_slug: string;
}

interface ReleaseScope {
  scope_type: string;
  scope_value: string;
}

interface TargetAsset {
  id: string;
  platform: string;
  file_hash: string;
}

interface ResolverWinnerAsset {
  id: string;
  file_hash: string;
}

interface CleanupTerminalReceiptRow {
  operation_id: string;
  receipt_digest: string;
  run_case_id: string;
  attempt: number;
  artifact_bundle_digest: string;
  app_id: string;
  release_id: string;
  release_revision: number;
  build_id: string;
  app_slug: string;
  channel_slug: string;
  target_artifact_sha256: string;
  target_version_code: number;
  target_installation_digest: string;
  cancel_readback: "inactive";
  scope_deactivated: number;
  scope_readback_json: string;
  delivery_bindings_json: string;
  canonical_request_json: string;
  event_payload_json: string;
  canonical_receipt_json: string;
  created_at: number;
}

function isExactInput(value: unknown): value is CleanupTerminalInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  const expected = [
    "artifact_bundle_digest",
    "attempt",
    "expected_release_revision",
    "operation_id",
    "run_case_id",
    "target_device_id",
  ];
  if (Object.keys(input).sort().join(",") !== expected.join(",")) return false;
  return typeof input.operation_id === "string" &&
    input.operation_id.length <= 128 && SAFE_REF.test(input.operation_id) &&
    typeof input.run_case_id === "string" && input.run_case_id.length <= 128 &&
    SAFE_REF.test(input.run_case_id) &&
    Number.isInteger(input.attempt) && Number(input.attempt) > 0 &&
    typeof input.artifact_bundle_digest === "string" &&
    SHA256_HEX.test(input.artifact_bundle_digest) &&
    Number.isInteger(input.expected_release_revision) &&
    Number(input.expected_release_revision) >= 0 &&
    typeof input.target_device_id === "string" &&
    input.target_device_id === input.target_device_id.trim() &&
    input.target_device_id.length >= 1 && input.target_device_id.length <= 200;
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function subscriptionPredicate(alias: string, orgParam: string, appParam: string): string {
  const safeEvents = `CASE WHEN json_valid(${alias}.events_json) THEN ${alias}.events_json ELSE 'null' END`;
  return `${alias}.org_id = ${orgParam}
    AND ${alias}.enabled = 1
    AND ${alias}.archived_at IS NULL
    AND (${alias}.app_id IS NULL OR ${alias}.app_id = ${appParam})
    AND (
      json_array_length(${safeEvents}) = 0
      OR EXISTS (
        SELECT 1 FROM json_each(${safeEvents}) event
        WHERE event.value IN ('*', '${EVENT}')
      )
    )`;
}

function receiptResponse(row: CleanupTerminalReceiptRow, replay: boolean) {
  return {
    replay,
    operation: {
      id: row.operation_id,
      kind: OPERATION_KIND,
      status: "success",
    },
    event: JSON.parse(row.event_payload_json) as Record<string, unknown>,
    readback: JSON.parse(row.scope_readback_json) as Record<string, unknown>,
    receipt: JSON.parse(row.canonical_receipt_json) as Record<string, unknown>,
    deliveries_frozen: true,
  };
}

async function findReceiptCollision(
  db: D1Database,
  operationId: string,
  runCaseId: string,
  releaseId: string,
): Promise<CleanupTerminalReceiptRow | null> {
  return await db.prepare(
    `SELECT * FROM app_update_cleanup_terminal_receipts
     WHERE operation_id = ?1 OR run_case_id = ?2 OR release_id = ?3
     ORDER BY CASE WHEN operation_id = ?1 THEN 0 WHEN run_case_id = ?2 THEN 1 ELSE 2 END
     LIMIT 1`,
  ).bind(operationId, runCaseId, releaseId).first<CleanupTerminalReceiptRow>();
}

function conflictResponse(c: AdminContext, code: string, error: string) {
  return c.json({ error, code }, 409);
}

/**
 * Persist the one immutable Hands terminal producer receipt for an Android App
 * Update cleanup.  This endpoint never cancels or otherwise mutates a release;
 * it only proves an already-cancelled current generation is unreachable to the
 * exact target installation and freezes the resulting webhook event.
 */
export async function handleEmitAppUpdateCleanupTerminal(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const releaseId = c.req.param("releaseId") ?? "";
  const raw = await c.req.json().catch(() => null);
  if (!isExactInput(raw)) {
    return c.json({
      error: "exact operation/run/attempt/bundle/revision/target-device input required",
      code: "INVALID_APP_UPDATE_CLEANUP_TERMINAL_INPUT",
    }, 400);
  }
  const input = raw;
  const targetInstallationDigest = `sha256:${await sha256(input.target_device_id)}`;
  const canonicalRequest = JSON.stringify({
    operation_id: input.operation_id,
    run_case_id: input.run_case_id,
    attempt: input.attempt,
    artifact_bundle_digest: input.artifact_bundle_digest,
    app_id: appId,
    release_id: releaseId,
    expected_release_revision: input.expected_release_revision,
    target_installation_digest: targetInstallationDigest,
  });
  // Response-loss replay is resolved before any mutable release/subscriber
  // read. A later key rotation, archive, or release transition must not make
  // the caller regenerate or silently rebind the frozen receipt.
  const earlyExisting = await findReceiptCollision(
    c.env.DB,
    input.operation_id,
    input.run_case_id,
    releaseId,
  );
  if (earlyExisting) {
    if (earlyExisting.operation_id === input.operation_id &&
        earlyExisting.canonical_request_json === canonicalRequest) {
      return c.json(receiptResponse(earlyExisting, true));
    }
    return conflictResponse(
      c,
      "APP_UPDATE_TERMINAL_BINDING_CONFLICT",
      "operation, run case, or release is already bound to another terminal receipt",
    );
  }

  const authority = await c.env.DB.prepare(
    `SELECT r.id AS release_id, r.revision AS release_revision,
            r.status AS release_status, r.rollout_cohort_count,
            r.build_id, r.product_type, r.release_type,
            b.version_code, a.id AS app_id, a.slug AS app_slug,
            a.platform AS app_platform, a.org_id,
            ch.id AS channel_id, ch.slug AS channel_slug
     FROM releases r
     JOIN builds b ON b.id = r.build_id
     JOIN apps a ON a.id = r.app_id
     JOIN channels ch ON ch.id = r.channel_id AND ch.app_id = r.app_id
     WHERE r.app_id = ?1 AND r.id = ?2`,
  ).bind(appId, releaseId).first<ReleaseAuthority>();
  if (!authority) return c.json({ error: "release not found" }, 404);
  if (authority.release_revision !== input.expected_release_revision) {
    return c.json({
      error: "release changed before cleanup terminal readback",
      code: "RELEASE_REVISION_CONFLICT",
      expected_revision: input.expected_release_revision,
      current_revision: authority.release_revision,
    }, 409);
  }
  if (authority.release_status !== "cancelled") {
    return conflictResponse(
      c,
      "APP_UPDATE_RELEASE_NOT_INACTIVE",
      "cleanup terminal requires a currently cancelled release",
    );
  }
  if (authority.app_platform !== "android" || authority.product_type !== "android-apk") {
    return conflictResponse(
      c,
      "APP_UPDATE_TARGET_NOT_ANDROID",
      "cleanup terminal requires an Android APK release",
    );
  }
  if (authority.app_slug.length > 64 || !SAFE_REF.test(authority.app_slug) ||
      authority.channel_slug.length > 64 || !SAFE_REF.test(authority.channel_slug)) {
    return conflictResponse(
      c,
      "APP_UPDATE_TARGET_REFERENCE_INVALID",
      "app or channel slug cannot be represented in the exact terminal contract",
    );
  }
  const orgId = c.get("org_id");
  if (!orgId || authority.org_id !== orgId) {
    return c.json({ error: "release organization mismatch" }, 403);
  }

  const { results: scopes } = await c.env.DB.prepare(
    `SELECT scope_type, scope_value FROM release_scopes
     WHERE release_id = ?1 ORDER BY scope_type, scope_value`,
  ).bind(releaseId).all<ReleaseScope>();
  if (scopes.length === 0) {
    return conflictResponse(
      c,
      "APP_UPDATE_RELEASE_SCOPE_MISSING",
      "release has no frozen scope identity",
    );
  }

  const { results: assets } = await c.env.DB.prepare(
    `SELECT id, platform, file_hash FROM build_assets
     WHERE build_id = ?1 AND artifact_kind = 'installable' AND filetype = 'apk'
     ORDER BY id`,
  ).bind(authority.build_id).all<TargetAsset>();
  if (assets.length !== 1) {
    return conflictResponse(
      c,
      assets.length === 0 ? "APP_UPDATE_TARGET_ARTIFACT_MISSING" : "APP_UPDATE_TARGET_ARTIFACT_AMBIGUOUS",
      "cleanup terminal requires exactly one installable APK target",
    );
  }
  const asset = assets[0]!;
  if (!SHA256_HEX.test(asset.file_hash) || authority.version_code < 1) {
    return conflictResponse(
      c,
      "APP_UPDATE_TARGET_IDENTITY_INVALID",
      "target APK digest or version code is invalid",
    );
  }

  const { results: memberships } = await c.env.DB.prepare(
    `SELECT m.group_id FROM device_group_members m
     JOIN device_groups g ON g.id = m.group_id
     WHERE g.app_id = ?1 AND m.device_id = ?2
     ORDER BY m.group_id`,
  ).bind(appId, input.target_device_id).all<{ group_id: string }>();
  const targetGroups = new Set(memberships.map((membership) => membership.group_id));
  const scopeMatchedBeforeCancellation = scopes.some((scope) => {
    if (scope.scope_type === "device_group") return targetGroups.has(scope.scope_value);
    if (scope.scope_type === "full" && scope.scope_value === "all") {
      return rolloutIncludes(releaseId, authority.rollout_cohort_count, input.target_device_id);
    }
    if (scope.scope_type === "platform") {
      return scope.scope_value.split(",").map((value) => value.trim()).includes(asset.platform);
    }
    return false;
  });
  if (!scopeMatchedBeforeCancellation) {
    return conflictResponse(
      c,
      "APP_UPDATE_TARGET_OUTSIDE_RELEASE_SCOPE",
      "target installation is not bound to the preserved release scope",
    );
  }

  // Run the exact same candidate/scope/rollout/winner resolver as the public
  // update-check path.  A cancelled row by itself proves nothing: historical
  // duplicate releases may still resolve the same B version/artifact.
  const activeResolution = await resolveActiveReleaseForClient(c.env.DB, {
    appId,
    channelId: authority.channel_id,
    productType: authority.product_type,
    deviceId: input.target_device_id,
    cohort: null,
    clientPlatform: asset.platform,
    clientIp: null,
  });
  const resolverWinnerCandidate = activeResolution.winner
    ? activeResolution.candidates.find(
      (candidate) => candidate.id === activeResolution.winner?.release_id,
    ) ?? null
    : null;
  let resolverWinnerVersionCode: number | null = null;
  let resolverWinnerAssets: ResolverWinnerAsset[] = [];
  if (resolverWinnerCandidate) {
    const winnerBuild = await c.env.DB.prepare(
      "SELECT version_code FROM builds WHERE id = ?1",
    ).bind(resolverWinnerCandidate.build_id).first<{ version_code: number }>();
    resolverWinnerVersionCode = winnerBuild?.version_code ?? null;
    const { results: winnerAssets } = await c.env.DB.prepare(
      `SELECT id, file_hash FROM build_assets
       WHERE build_id = ?1 AND artifact_kind = 'installable' AND filetype = 'apk'
       ORDER BY id`,
    ).bind(resolverWinnerCandidate.build_id).all<ResolverWinnerAsset>();
    resolverWinnerAssets = winnerAssets;
  }
  const targetBStillReachable = resolverWinnerVersionCode === authority.version_code &&
    resolverWinnerAssets.some((winnerAsset) => winnerAsset.file_hash === asset.file_hash);
  if (targetBStillReachable) {
    return conflictResponse(
      c,
      "APP_UPDATE_TARGET_STILL_REACHABLE",
      "canonical resolver still reaches the target release",
    );
  }

  const { results: subscribers } = await c.env.DB.prepare(
    `SELECT id, secret, signature_key_version FROM webhooks w
     WHERE ${subscriptionPredicate("w", "?1", "?2")}
     ORDER BY id`,
  ).bind(orgId, appId).all<{
    id: string;
    secret: string;
    signature_key_version: string;
  }>();
  if (subscribers.length === 0) {
    return conflictResponse(
      c,
      "APP_UPDATE_TERMINAL_SUBSCRIBER_MISSING",
      "no active webhook subscribes to the cleanup terminal event",
    );
  }

  const scopeIdentityJson = JSON.stringify(scopes);
  const scopeIdentityDigest = `sha256:${await sha256(scopeIdentityJson)}`;
  const deliveryBindings = subscribers.map((subscriber) => ({
    subscriber_id: subscriber.id,
    signature_key_version: subscriber.signature_key_version,
  }));
  const deliveryBindingsJson = JSON.stringify(deliveryBindings);
  const deliveryBindingsDigest = `sha256:${await sha256(deliveryBindingsJson)}`;
  const resolverSnapshotJson = JSON.stringify({
    candidates: [...activeResolution.candidates].sort((left, right) =>
      left.id.localeCompare(right.id)),
    scopes: [...activeResolution.scopes].sort((left, right) =>
      left.release_id.localeCompare(right.release_id) ||
      left.scope_type.localeCompare(right.scope_type) ||
      left.scope_value.localeCompare(right.scope_value)),
    device_group_ids: activeResolution.deviceGroupIds,
    matched: activeResolution.matched,
    winner: activeResolution.winner,
    winner_version_code: resolverWinnerVersionCode,
    winner_assets: resolverWinnerAssets,
  });
  const resolverSnapshotDigest = `sha256:${await sha256(resolverSnapshotJson)}`;
  const operationCollision = await c.env.DB.prepare(
    "SELECT id FROM operation_logs WHERE id = ?1",
  ).bind(input.operation_id).first<{ id: string }>();
  if (operationCollision) {
    return conflictResponse(
      c,
      "APP_UPDATE_TERMINAL_OPERATION_CONFLICT",
      "operation id is already used by another operation",
    );
  }

  const readback = {
    source: "hands_current_release_resolver",
    release_id: releaseId,
    release_revision: authority.release_revision,
    release_status: "cancelled",
    target_installation_digest: targetInstallationDigest,
    target_artifact_sha256: asset.file_hash,
    target_version_code: authority.version_code,
    preserved_scope_identity_digest: scopeIdentityDigest,
    preserved_scope_count: scopes.length,
    target_matched_preserved_scope: true,
    resolver_snapshot_digest: resolverSnapshotDigest,
    resolver_candidate_count: activeResolution.candidates.length,
    resolver_winner_release_id: activeResolution.winner?.release_id ?? null,
    resolver_winner_version_code: resolverWinnerVersionCode,
    target_release_reachable: false,
    scope_inactive: true,
  };
  const scopeReadbackJson = JSON.stringify(readback);
  const receiptMaterial = {
    operation_id: input.operation_id,
    run_case_id: input.run_case_id,
    attempt: input.attempt,
    artifact_bundle_digest: input.artifact_bundle_digest,
    app_id: appId,
    release_id: releaseId,
    release_revision: authority.release_revision,
    build_id: authority.build_id,
    app_slug: authority.app_slug,
    channel: authority.channel_slug,
    target_artifact_sha256: asset.file_hash,
    target_version_code: authority.version_code,
    target_installation_digest: targetInstallationDigest,
    scope_readback_digest: `sha256:${await sha256(scopeReadbackJson)}`,
    delivery_bindings_digest: deliveryBindingsDigest,
    delivery_count: deliveryBindings.length,
    cancel_readback: "inactive",
    scope_deactivated: true,
  };
  const receiptDigest = `sha256:${await sha256(JSON.stringify(receiptMaterial))}`;
  const eventPayload = {
    operation_id: input.operation_id,
    receipt_digest: receiptDigest,
    run_case_id: input.run_case_id,
    attempt: input.attempt,
    artifact_bundle_digest: input.artifact_bundle_digest,
    app_slug: authority.app_slug,
    channel: authority.channel_slug,
    target_artifact_sha256: asset.file_hash,
    target_version_code: authority.version_code,
    cancel_readback: "inactive",
    scope_deactivated: true,
  };
  const eventPayloadJson = JSON.stringify(eventPayload);
  const canonicalReceiptJson = JSON.stringify({ ...receiptMaterial, receipt_digest: receiptDigest });
  const now = Date.now();
  const envelopeJson = JSON.stringify({
    event: EVENT,
    delivered_at: now,
    org_id: orgId,
    app_id: appId,
    payload: eventPayload,
  });
  const operationInput = JSON.stringify({
    run_case_id: input.run_case_id,
    attempt: input.attempt,
    artifact_bundle_digest: input.artifact_bundle_digest,
    release_id: releaseId,
    expected_release_revision: input.expected_release_revision,
    target_installation_digest: targetInstallationDigest,
  });
  const operationOutput = JSON.stringify({
    receipt_digest: receiptDigest,
    event: EVENT,
    release_id: releaseId,
    release_revision: authority.release_revision,
    scope_readback_digest: receiptMaterial.scope_readback_digest,
  });
  const actor = currentActor(c);

  // Build one shared current-generation predicate.  Every statement in the D1
  // transaction is gated on the immutable release/build/asset coordinate,
  // preserved exact scope set, target membership, and current subscriber.
  const binds: Array<string | number | null> = [];
  const bind = (value: string | number | null) => {
    binds.push(value);
    return `?${binds.length}`;
  };
  const releaseIdParam = bind(releaseId);
  const appIdParam = bind(appId);
  const revisionParam = bind(authority.release_revision);
  const buildIdParam = bind(authority.build_id);
  const channelIdParam = bind(authority.channel_id);
  const channelSlugParam = bind(authority.channel_slug);
  const appSlugParam = bind(authority.app_slug);
  const authorityOrgParam = bind(authority.org_id);
  const productTypeParam = bind(authority.product_type);
  const releaseTypeParam = bind(authority.release_type);
  const versionCodeParam = bind(authority.version_code);
  const rolloutPredicate = authority.rollout_cohort_count === null
    ? "r.rollout_cohort_count IS NULL"
    : `r.rollout_cohort_count = ${bind(authority.rollout_cohort_count)}`;
  const assetIdParam = bind(asset.id);
  const assetHashParam = bind(asset.file_hash);
  const assetPlatformParam = bind(asset.platform);
  const scopeCountParam = bind(scopes.length);
  const scopePredicates = scopes.map((scope) => {
    const typeParam = bind(scope.scope_type);
    const valueParam = bind(scope.scope_value);
    return `EXISTS (
      SELECT 1 FROM release_scopes exact_scope
      WHERE exact_scope.release_id = r.id
        AND exact_scope.scope_type = ${typeParam}
        AND exact_scope.scope_value = ${valueParam}
    )`;
  });
  const orgParam = bind(orgId);
  const subscriberAppParam = bind(appId);
  const subscriberCountParam = bind(subscribers.length);
  const subscriberPredicates = subscribers.map((subscriber) => {
    const idParam = bind(subscriber.id);
    const secretParam = bind(subscriber.secret);
    const keyVersionParam = bind(subscriber.signature_key_version);
    return `EXISTS (
      SELECT 1 FROM webhooks exact_subscriber
      WHERE exact_subscriber.id = ${idParam}
        AND exact_subscriber.secret = ${secretParam}
        AND exact_subscriber.signature_key_version = ${keyVersionParam}
        AND ${subscriptionPredicate("exact_subscriber", orgParam, subscriberAppParam)}
    )`;
  });
  const targetScopePredicates: string[] = [];
  for (const scope of scopes) {
    if (scope.scope_type === "device_group" && targetGroups.has(scope.scope_value)) {
      const groupParam = bind(scope.scope_value);
      const deviceParam = bind(input.target_device_id);
      targetScopePredicates.push(`EXISTS (
        SELECT 1 FROM release_scopes target_scope
        JOIN device_group_members target_member ON target_member.group_id = target_scope.scope_value
        WHERE target_scope.release_id = r.id
          AND target_scope.scope_type = 'device_group'
          AND target_scope.scope_value = ${groupParam}
          AND target_member.device_id = ${deviceParam}
      )`);
    } else if (scope.scope_type === "full" && scope.scope_value === "all" &&
               rolloutIncludes(releaseId, authority.rollout_cohort_count, input.target_device_id)) {
      targetScopePredicates.push(`EXISTS (
        SELECT 1 FROM release_scopes target_scope
        WHERE target_scope.release_id = r.id
          AND target_scope.scope_type = 'full' AND target_scope.scope_value = 'all'
      )`);
    } else if (scope.scope_type === "platform" &&
               scope.scope_value.split(",").map((value) => value.trim()).includes(asset.platform)) {
      const platformScopeParam = bind(scope.scope_value);
      targetScopePredicates.push(`EXISTS (
        SELECT 1 FROM release_scopes target_scope
        WHERE target_scope.release_id = r.id
          AND target_scope.scope_type = 'platform'
          AND target_scope.scope_value = ${platformScopeParam}
      )`);
    }
  }

  // Freeze every mutable input to the shared resolver, then repeat its
  // priority/activation/id winner ordering inside the commit transaction.
  // rollout eligibility is precomputed by the shared JS resolver; exact
  // candidate rollout values are CAS-checked below, so that set cannot drift.
  const resolverCandidatePredicates = activeResolution.candidates.map((candidate) => {
    const candidateIdParam = bind(candidate.id);
    const candidateBuildParam = bind(candidate.build_id);
    const candidateActivatedParam = bind(candidate.activated_at);
    const candidateProductParam = bind(candidate.product_type);
    const candidateRolloutPredicate = candidate.rollout_cohort_count === null
      ? "resolver_candidate.rollout_cohort_count IS NULL"
      : `resolver_candidate.rollout_cohort_count = ${bind(candidate.rollout_cohort_count)}`;
    return `EXISTS (
      SELECT 1 FROM releases resolver_candidate
      JOIN builds resolver_build ON resolver_build.id = resolver_candidate.build_id
      WHERE resolver_candidate.id = ${candidateIdParam}
        AND resolver_candidate.app_id = ${appIdParam}
        AND resolver_candidate.channel_id = ${channelIdParam}
        AND resolver_candidate.product_type = ${candidateProductParam}
        AND resolver_candidate.status = 'active'
        AND resolver_candidate.build_id = ${candidateBuildParam}
        AND COALESCE(resolver_candidate.activated_at, resolver_candidate.created_at) = ${candidateActivatedParam}
        AND ${candidateRolloutPredicate}
        AND resolver_build.product_type != 'ios-simulator-qa'
        AND resolver_build.release_type != 'qa'
    )`;
  });
  const resolverCandidateCountParam = bind(activeResolution.candidates.length);
  const resolverCandidateCountPredicate = `(SELECT COUNT(*)
    FROM releases resolver_counted
    JOIN builds resolver_counted_build ON resolver_counted_build.id = resolver_counted.build_id
    WHERE resolver_counted.app_id = ${appIdParam}
      AND resolver_counted.channel_id = ${channelIdParam}
      AND resolver_counted.product_type = ${productTypeParam}
      AND resolver_counted.status = 'active'
      AND resolver_counted_build.product_type != 'ios-simulator-qa'
      AND resolver_counted_build.release_type != 'qa') = ${resolverCandidateCountParam}`;

  const resolverScopePredicates = activeResolution.scopes.map((scope) => {
    const releaseParam = bind(scope.release_id);
    const typeParam = bind(scope.scope_type);
    const valueParam = bind(scope.scope_value);
    return `EXISTS (
      SELECT 1 FROM release_scopes resolver_scope
      WHERE resolver_scope.release_id = ${releaseParam}
        AND resolver_scope.scope_type = ${typeParam}
        AND resolver_scope.scope_value = ${valueParam}
    )`;
  });
  const resolverScopeCountParam = bind(activeResolution.scopes.length);
  const resolverCandidateIds = activeResolution.candidates.map((candidate) => bind(candidate.id));
  const resolverScopeCountPredicate = resolverCandidateIds.length > 0
    ? `(SELECT COUNT(*) FROM release_scopes resolver_scope_counted
        WHERE resolver_scope_counted.release_id IN (${resolverCandidateIds.join(",")})) = ${resolverScopeCountParam}`
    : `${resolverScopeCountParam} = 0`;

  const resolverGroupPredicates = activeResolution.deviceGroupIds.map((groupId) => {
    const groupParam = bind(groupId);
    const deviceParam = bind(input.target_device_id);
    return `EXISTS (
      SELECT 1 FROM device_group_members resolver_member
      JOIN device_groups resolver_group ON resolver_group.id = resolver_member.group_id
      WHERE resolver_group.app_id = ${appIdParam}
        AND resolver_member.group_id = ${groupParam}
        AND resolver_member.device_id = ${deviceParam}
    )`;
  });
  const resolverGroupCountParam = bind(activeResolution.deviceGroupIds.length);
  const resolverGroupDeviceParam = bind(input.target_device_id);
  const resolverGroupCountPredicate = `(SELECT COUNT(*)
    FROM device_group_members resolver_member_counted
    JOIN device_groups resolver_group_counted
      ON resolver_group_counted.id = resolver_member_counted.group_id
    WHERE resolver_group_counted.app_id = ${appIdParam}
      AND resolver_member_counted.device_id = ${resolverGroupDeviceParam}) = ${resolverGroupCountParam}`;

  const resolverMatchSelects = activeResolution.matched.map((match) => {
    const releaseParam = bind(match.release_id);
    const typeParam = bind(match.scope_type);
    const valueParam = bind(match.scope_value);
    const priorityParam = bind(match.priority);
    const activatedParam = bind(match.release_activated_at);
    return `SELECT ${releaseParam} AS release_id,
                   ${priorityParam} AS priority,
                   ${activatedParam} AS activated_at
            WHERE EXISTS (
              SELECT 1 FROM releases resolver_match_release
              JOIN release_scopes resolver_match_scope
                ON resolver_match_scope.release_id = resolver_match_release.id
              WHERE resolver_match_release.id = ${releaseParam}
                AND resolver_match_release.status = 'active'
                AND resolver_match_scope.scope_type = ${typeParam}
                AND resolver_match_scope.scope_value = ${valueParam}
            )`;
  });
  const resolverWinnerSql = resolverMatchSelects.length > 0
    ? `(SELECT resolver_match.release_id
        FROM (${resolverMatchSelects.join(" UNION ALL ")}) resolver_match
        ORDER BY resolver_match.priority DESC,
                 resolver_match.activated_at DESC,
                 resolver_match.release_id ASC
        LIMIT 1)`
    : "NULL";
  const resolverWinnerPredicate = activeResolution.winner
    ? `${resolverWinnerSql} = ${bind(activeResolution.winner.release_id)}`
    : `${resolverWinnerSql} IS NULL`;
  const resolverWinnerBuildPredicate = resolverWinnerCandidate &&
      resolverWinnerVersionCode !== null
    ? `EXISTS (
        SELECT 1 FROM builds resolver_winner_exact_build
        WHERE resolver_winner_exact_build.id = ${bind(resolverWinnerCandidate.build_id)}
          AND resolver_winner_exact_build.version_code = ${bind(resolverWinnerVersionCode)}
      )`
    : activeResolution.winner ? "0" : "1";
  const resolverWinnerAssetPredicates = resolverWinnerCandidate
    ? resolverWinnerAssets.map((winnerAsset) => {
      const idParam = bind(winnerAsset.id);
      const hashParam = bind(winnerAsset.file_hash);
      const buildParam = bind(resolverWinnerCandidate.build_id);
      return `EXISTS (
        SELECT 1 FROM build_assets resolver_winner_exact_asset
        WHERE resolver_winner_exact_asset.id = ${idParam}
          AND resolver_winner_exact_asset.build_id = ${buildParam}
          AND resolver_winner_exact_asset.artifact_kind = 'installable'
          AND resolver_winner_exact_asset.filetype = 'apk'
          AND resolver_winner_exact_asset.file_hash = ${hashParam}
      )`;
    })
    : [];
  const resolverWinnerAssetCountPredicate = resolverWinnerCandidate
    ? `(SELECT COUNT(*) FROM build_assets resolver_winner_counted_asset
        WHERE resolver_winner_counted_asset.build_id = ${bind(resolverWinnerCandidate.build_id)}
          AND resolver_winner_counted_asset.artifact_kind = 'installable'
          AND resolver_winner_counted_asset.filetype = 'apk') = ${bind(resolverWinnerAssets.length)}`
    : "1";
  const resolverTargetVersionParam = bind(authority.version_code);
  const resolverTargetHashParam = bind(asset.file_hash);
  const resolverTargetBUnreachablePredicate = `NOT EXISTS (
    SELECT 1 FROM releases resolver_winner_release
    JOIN builds resolver_winner_build
      ON resolver_winner_build.id = resolver_winner_release.build_id
    JOIN build_assets resolver_winner_asset
      ON resolver_winner_asset.build_id = resolver_winner_build.id
    WHERE resolver_winner_release.id = ${resolverWinnerSql}
      AND resolver_winner_build.version_code = ${resolverTargetVersionParam}
      AND resolver_winner_asset.artifact_kind = 'installable'
      AND resolver_winner_asset.filetype = 'apk'
      AND resolver_winner_asset.file_hash = ${resolverTargetHashParam}
  )`;
  const resolverCasPredicate = [
    resolverCandidateCountPredicate,
    ...resolverCandidatePredicates,
    resolverScopeCountPredicate,
    ...resolverScopePredicates,
    resolverGroupCountPredicate,
    ...resolverGroupPredicates,
    resolverWinnerPredicate,
    resolverWinnerBuildPredicate,
    resolverWinnerAssetCountPredicate,
    ...resolverWinnerAssetPredicates,
    resolverTargetBUnreachablePredicate,
  ].join(" AND ");
  const operationIdParam = bind(input.operation_id);
  const eligibility = `r.id = ${releaseIdParam}
    AND r.app_id = ${appIdParam}
    AND r.revision = ${revisionParam}
    AND r.status = 'cancelled'
    AND r.build_id = ${buildIdParam}
    AND r.channel_id = ${channelIdParam}
    AND r.product_type = ${productTypeParam}
    AND r.release_type = ${releaseTypeParam}
    AND ${rolloutPredicate}
    AND b.id = r.build_id
    AND b.product_type = ${productTypeParam}
    AND b.release_type = ${releaseTypeParam}
    AND b.version_code = ${versionCodeParam}
    AND a.id = r.app_id AND a.platform = 'android'
    AND a.slug = ${appSlugParam} AND a.org_id = ${authorityOrgParam}
    AND ch.id = r.channel_id AND ch.app_id = r.app_id AND ch.slug = ${channelSlugParam}
    AND ba.id = ${assetIdParam} AND ba.build_id = b.id
    AND ba.file_hash = ${assetHashParam}
    AND ba.platform = ${assetPlatformParam}
    AND ba.artifact_kind = 'installable' AND ba.filetype = 'apk'
    AND (SELECT COUNT(*) FROM build_assets exact_asset
         WHERE exact_asset.build_id = b.id
           AND exact_asset.artifact_kind = 'installable'
           AND exact_asset.filetype = 'apk') = 1
    AND (SELECT COUNT(*) FROM release_scopes counted WHERE counted.release_id = r.id) = ${scopeCountParam}
    AND ${scopePredicates.join(" AND ")}
    AND (${targetScopePredicates.join(" OR ")})
    AND ${resolverCasPredicate}
    AND EXISTS (
      SELECT 1 FROM webhooks w
      WHERE ${subscriptionPredicate("w", orgParam, subscriberAppParam)}
    )
    AND (SELECT COUNT(*) FROM webhooks counted_subscriber
         WHERE ${subscriptionPredicate("counted_subscriber", orgParam, subscriberAppParam)}) = ${subscriberCountParam}
    AND ${subscriberPredicates.join(" AND ")}
    AND NOT EXISTS (
      SELECT 1 FROM app_update_cleanup_terminal_receipts receipt
      WHERE receipt.operation_id = ${operationIdParam}
         OR receipt.run_case_id = ${bind(input.run_case_id)}
         OR receipt.release_id = r.id
    )
    AND NOT EXISTS (SELECT 1 FROM operation_logs existing_op WHERE existing_op.id = ${operationIdParam})`;

  const operationStatement = c.env.DB.prepare(
    `INSERT INTO operation_logs
      (id, app_id, kind, status, parent_op_id, step_number, actor,
       input, output, error, progress, retry_count, created_at, updated_at, completed_at)
     SELECT ?${binds.length + 1}, ?${binds.length + 2}, '${OPERATION_KIND}', 'success',
            NULL, NULL, ?${binds.length + 3}, ?${binds.length + 4}, ?${binds.length + 5},
            NULL, 1, 0, ?${binds.length + 6}, ?${binds.length + 6}, ?${binds.length + 6}
     FROM releases r
     JOIN builds b ON b.id = r.build_id
     JOIN apps a ON a.id = r.app_id
     JOIN channels ch ON ch.id = r.channel_id
     JOIN build_assets ba ON ba.build_id = b.id
     WHERE ${eligibility}`,
  ).bind(
    ...binds,
    input.operation_id,
    appId,
    actor,
    operationInput,
    operationOutput,
    now,
  );

  const receiptStatement = c.env.DB.prepare(
    `INSERT INTO app_update_cleanup_terminal_receipts
      (operation_id, receipt_digest, run_case_id, attempt, artifact_bundle_digest,
       app_id, release_id, release_revision, build_id, app_slug, channel_slug,
       target_artifact_sha256, target_version_code, target_installation_digest,
       cancel_readback, scope_deactivated, scope_readback_json, delivery_bindings_json,
       canonical_request_json, event_payload_json, canonical_receipt_json, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
            ?12, ?13, ?14, 'inactive', 1, ?15, ?16, ?17, ?18, ?19, ?20
     WHERE EXISTS (
       SELECT 1 FROM operation_logs
       WHERE id = ?1 AND kind = '${OPERATION_KIND}' AND status = 'success'
     )`,
  ).bind(
    input.operation_id,
    receiptDigest,
    input.run_case_id,
    input.attempt,
    input.artifact_bundle_digest,
    appId,
    releaseId,
    authority.release_revision,
    authority.build_id,
    authority.app_slug,
    authority.channel_slug,
    asset.file_hash,
    authority.version_code,
    targetInstallationDigest,
    scopeReadbackJson,
    deliveryBindingsJson,
    canonicalRequest,
    eventPayloadJson,
    canonicalReceiptJson,
    now,
  );

  const deliveryStatement = c.env.DB.prepare(
    `INSERT INTO webhook_deliveries
      (id, webhook_id, event_type, payload_json, signing_secret,
       signature_key_version, reporter_delivery, app_update_terminal_receipt_id,
       status, attempts, max_attempts, last_attempt_at, next_attempt_at,
       created_at, updated_at)
     SELECT 'app-update:' || ?1 || ':' || w.id, w.id, '${EVENT}', ?2, w.secret,
            w.signature_key_version, 0, ?1,
            'pending', 0, 3, NULL, ?3, ?3, ?3
     FROM webhooks w
     JOIN app_update_cleanup_terminal_receipts receipt ON receipt.operation_id = ?1
     WHERE ${subscriptionPredicate("w", "?4", "?5")}`,
  ).bind(input.operation_id, envelopeJson, now, orgId, appId);

  const auditStatement = c.env.DB.prepare(
    `INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at)
     SELECT ?1, ?2, 'release.app_update_cleanup_terminal', ?3, ?4, ?5
     WHERE EXISTS (
       SELECT 1 FROM app_update_cleanup_terminal_receipts WHERE operation_id = ?6
     )`,
  ).bind(
    crypto.randomUUID(),
    appId,
    actor,
    JSON.stringify({
      operation_id: input.operation_id,
      receipt_digest: receiptDigest,
      release_id: releaseId,
      release_revision: authority.release_revision,
      run_case_id: input.run_case_id,
      attempt: input.attempt,
      artifact_bundle_digest: input.artifact_bundle_digest,
      target_installation_digest: targetInstallationDigest,
    }),
    now,
    input.operation_id,
  );

  try {
    const results = await c.env.DB.batch([
      operationStatement,
      receiptStatement,
      deliveryStatement,
      auditStatement,
    ]);
    const operationChanges = Number(results[0]?.meta?.changes ?? 0);
    const receiptChanges = Number(results[1]?.meta?.changes ?? 0);
    const deliveryChanges = Number(results[2]?.meta?.changes ?? 0);
    const auditChanges = Number(results[3]?.meta?.changes ?? 0);
    if (operationChanges !== 1 || receiptChanges !== 1 || deliveryChanges < 1 || auditChanges !== 1) {
      const collision = await findReceiptCollision(
        c.env.DB,
        input.operation_id,
        input.run_case_id,
        releaseId,
      );
      if (collision?.operation_id === input.operation_id &&
          collision.canonical_request_json === canonicalRequest) {
        return c.json(receiptResponse(collision, true));
      }
      return conflictResponse(
        c,
        "APP_UPDATE_TERMINAL_PRECONDITION_CHANGED",
        "release, target scope, subscriber, or operation binding changed before commit",
      );
    }
  } catch {
    const collision = await findReceiptCollision(
      c.env.DB,
      input.operation_id,
      input.run_case_id,
      releaseId,
    );
    if (collision?.operation_id === input.operation_id &&
        collision.canonical_request_json === canonicalRequest) {
      return c.json(receiptResponse(collision, true));
    }
    return conflictResponse(
      c,
      "APP_UPDATE_TERMINAL_COMMIT_CONFLICT",
      "cleanup terminal receipt could not be committed atomically",
    );
  }

  const created = await findReceiptCollision(
    c.env.DB,
    input.operation_id,
    input.run_case_id,
    releaseId,
  );
  if (!created || created.operation_id !== input.operation_id) {
    return c.json({ error: "terminal receipt readback missing" }, 500);
  }
  return c.json(receiptResponse(created, false), 201);
}
