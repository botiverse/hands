/**
 * TestFlight tab — one place to see every Hands→Apple upload and distribution
 * request. Upload attempts are recorded as `testflight-upload` operations;
 * each successful one carries a
 * build_upload_id whose Apple state (PROCESSING → COMPLETE | FAILED) is
 * polled live, so the operation's "upload succeeded" is separated from
 * Apple's async accept/reject verdict. Group assignment/review attempts are
 * recorded as `testflight-publish` operations.
 */
import { useQuery } from "@tanstack/react-query";
import {
  listOperations,
  getTestflightPublishStatus,
  getTestflightUploadStatus,
  type Operation,
  type AscUploadState,
  type TestflightPublishState,
} from "../lib/api";

interface UploadInput {
  version_name?: string;
  version_code?: number;
  bundle_id?: string;
}
interface UploadOutput {
  build_upload_id?: string;
  asc_app_id?: string;
}
interface PublishInput {
  hands_build_id?: string;
  bundle_id?: string;
  distribution?: "internal" | "external";
  group_ids?: string[];
  notify_testers?: boolean;
}
type PublishOutput = Partial<TestflightPublishState>;

function ascTestflightUrl(ascAppId: string | undefined): string {
  return ascAppId
    ? `https://appstoreconnect.apple.com/apps/${ascAppId}/testflight/ios`
    : "https://appstoreconnect.apple.com/apps";
}

export function Testflight({ appId }: { appId: string }) {
  const ops = useQuery({
    queryKey: ["operations", appId],
    queryFn: () => listOperations(appId, 100),
    refetchInterval: 10000,
  });

  const uploads = (ops.data?.operations ?? []).filter(
    (o) => o.kind === "testflight-upload",
  );
  const publishes = (ops.data?.operations ?? []).filter(
    (o) => o.kind === "testflight-publish",
  );

  return (
    <div>
      <div className="mb-4">
        <h2 className="text-lg font-semibold">TestFlight</h2>
        <p className="text-xs text-slate-500 mt-1">
          Hands→Apple uploads, processing, beta-group distribution, and review
          state. Configure the key in{" "}
          <a className="underline" href={`/apps/${appId}/settings`}>
            Settings → TestFlight
          </a>
          ; upload a build from the{" "}
          <a className="underline" href={`/apps/${appId}/builds`}>
            Builds
          </a>{" "}
          tab.
        </p>
      </div>

      {ops.isLoading && <p className="text-slate-500 text-sm">Loading…</p>}
      {!ops.isLoading && uploads.length === 0 && publishes.length === 0 && (
        <p className="text-slate-500 text-sm">
          No TestFlight activity yet.
        </p>
      )}

      {uploads.length > 0 && (
        <section className="mb-6">
          <h3 className="text-sm font-semibold mb-2">Uploads</h3>
          <div className="space-y-2">
            {uploads.map((op) => (
              <UploadRow key={op.id} appId={appId} op={op} />
            ))}
          </div>
        </section>
      )}

      {publishes.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold mb-2">Distributions</h3>
          <div className="space-y-2">
            {publishes.map((op) => (
              <PublishRow key={op.id} appId={appId} op={op} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function UploadRow({ appId, op }: { appId: string; op: Operation }) {
  let input: UploadInput = {};
  let output: UploadOutput = {};
  try {
    input = JSON.parse(op.input || "{}");
  } catch {
    /* ignore */
  }
  try {
    output = JSON.parse(op.output || "{}");
  } catch {
    /* ignore */
  }
  const buildUploadId = output.build_upload_id;

  const status = useQuery({
    queryKey: ["testflight-status", appId, buildUploadId],
    queryFn: () => getTestflightUploadStatus(appId, buildUploadId!),
    enabled: Boolean(buildUploadId) && op.status === "success",
    refetchInterval: (q) => {
      const s = q.state.data?.state?.state;
      return s === "COMPLETE" || s === "FAILED" ? false : 8000;
    },
  });

  const appleState: AscUploadState | null | undefined = status.data?.state;
  const uploadFailed = op.status === "failed";

  return (
    <div className="card p-3!">
      <div className="flex items-center gap-3 flex-wrap text-sm">
        <span className="font-mono font-medium">
          {input.version_name ? `v${input.version_name}` : "—"}
          {input.version_code ? ` (${input.version_code})` : ""}
        </span>
        {input.bundle_id && <span className="badge-gray">{input.bundle_id}</span>}
        <StateBadge uploadFailed={uploadFailed} appleState={appleState} />
        {!uploadFailed && (
          <a
            className="text-xs underline text-blue-700"
            href={ascTestflightUrl(output.asc_app_id)}
            target="_blank"
            rel="noopener noreferrer"
          >
            View in App Store Connect ↗
          </a>
        )}
        <span className="text-xs text-slate-500 ml-auto">
          {new Date(op.created_at).toISOString().slice(0, 16)}Z
        </span>
      </div>

      {uploadFailed && op.error && (
        <p className="mt-1 text-xs text-red-700 font-mono break-all">
          {friendlyError(op.error)}
        </p>
      )}
      {appleState?.errors && appleState.errors.length > 0 && (
        <ul className="mt-1 text-xs text-red-700 list-disc pl-5">
          {appleState.errors.map((e, i) => (
            <li key={i}>
              {e.code ? `[${e.code}] ` : ""}
              {e.description}
            </li>
          ))}
        </ul>
      )}
      {appleState?.state === "COMPLETE" && (
        <p className="mt-1 text-xs text-green-700">
          Upload processed. Ready for group distribution. Inspect the build in{" "}
          <a
            className="underline"
            href={ascTestflightUrl(output.asc_app_id)}
            target="_blank"
            rel="noopener noreferrer"
          >
            App Store Connect → TestFlight
          </a>
          .
        </p>
      )}
    </div>
  );
}

function isTerminalPublishState(
  state: string | undefined,
  input: PublishInput,
): boolean {
  if (!state) return false;
  if (
    state === "rejected" ||
    state === "expired" ||
    state === "processing_failed" ||
    state === "blocked_export_compliance" ||
    state === "not_applicable"
  ) {
    return true;
  }
  if (state === "testing") return true;
  return (
    input.distribution === "external" &&
    !input.notify_testers &&
    (state === "approved" || state === "approved_not_notified")
  );
}

function PublishRow({ appId, op }: { appId: string; op: Operation }) {
  let input: PublishInput = {};
  let output: PublishOutput = {};
  try {
    input = JSON.parse(op.input || "{}");
  } catch {
    /* ignore */
  }
  try {
    output = JSON.parse(op.output || "{}");
  } catch {
    /* ignore */
  }
  const buildId = input.hands_build_id;
  const liveStatus = useQuery({
    queryKey: [
      "testflight-publish-status",
      appId,
      buildId,
      input.distribution,
      input.bundle_id,
    ],
    queryFn: () =>
      getTestflightPublishStatus(appId, buildId!, {
        ...(input.distribution ? { distribution: input.distribution } : {}),
        ...(input.bundle_id ? { bundleId: input.bundle_id } : {}),
      }),
    enabled: Boolean(buildId) && op.status === "success",
    staleTime: 5000,
    refetchInterval: (query) =>
      isTerminalPublishState(query.state.data?.state, input) ? 300000 : 12000,
  });
  const current: PublishOutput = { ...output, ...(liveStatus.data ?? {}) };
  const failed = op.status === "failed";
  const state = failed ? "failed" : current.state ?? op.status;
  const blocked =
    state === "rejected" ||
    state === "expired" ||
    state === "processing_failed" ||
    state === "blocked_export_compliance" ||
    state === "not_applicable";
  const badge =
    failed || blocked
      ? "badge-red"
      : state === "testing"
        ? "badge-green"
        : "badge-blue";
  const localizationLocales = (current.localizations ?? [])
    .map((item) => item.locale)
    .filter((locale): locale is string => Boolean(locale));

  return (
    <div className="card p-3!">
      <div className="flex items-center gap-3 flex-wrap text-sm">
        <span className="font-mono font-medium">
          {current.version
            ? `v${current.version}`
            : input.hands_build_id?.slice(0, 8) ?? "—"}
          {current.build_number ? ` (${current.build_number})` : ""}
        </span>
        {input.distribution && (
          <span className="badge-gray text-xs">{input.distribution}</span>
        )}
        <span className={`${badge} text-xs`}>{state}</span>
        {current.beta_review?.state && (
          <span className="badge-gray text-xs">
            review: {current.beta_review.state}
          </span>
        )}
        {current.beta_detail?.auto_notify_enabled && (
          <span className="badge-gray text-xs">auto notify on</span>
        )}
        <span className="text-xs text-slate-500 ml-auto">
          {new Date(op.created_at).toISOString().slice(0, 16)}Z
        </span>
      </div>
      {current.assigned_groups && current.assigned_groups.length > 0 && (
        <p className="mt-1 text-xs text-slate-600">
          Groups: {current.assigned_groups.map((group) => group.name ?? group.id).join(", ")}
        </p>
      )}
      {localizationLocales.length > 0 && (
        <p className="mt-1 text-xs text-slate-600">
          What to Test: {localizationLocales.join(", ")}
        </p>
      )}
      {current.expiration_date && (
        <p className="mt-1 text-xs text-slate-500">
          Expires: {new Date(current.expiration_date).toISOString().slice(0, 10)}
        </p>
      )}
      {output.notification && (
        <p className="mt-1 text-xs text-slate-600">
          Notification action: {output.notification}
        </p>
      )}
      {failed && op.error && (
        <p className="mt-1 text-xs text-red-700 font-mono break-all">
          {friendlyError(op.error)}
        </p>
      )}
      {liveStatus.isError && !failed && (
        <p className="mt-1 text-xs text-red-700">
          Live state refresh failed: {friendlyError(liveStatus.error)}
        </p>
      )}
    </div>
  );
}

function StateBadge({
  uploadFailed,
  appleState,
}: {
  uploadFailed: boolean;
  appleState: AscUploadState | null | undefined;
}) {
  if (uploadFailed) {
    return <span className="badge-red text-xs">upload failed</span>;
  }
  const s = appleState?.state;
  if (!s) return <span className="badge-gray text-xs">uploaded</span>;
  if (s === "COMPLETE")
    return <span className="badge-green text-xs">complete</span>;
  if (s === "FAILED")
    return <span className="badge-red text-xs">Apple rejected</span>;
  return <span className="badge-blue text-xs">Apple processing…</span>;
}

function friendlyError(raw: unknown): string {
  const text = raw instanceof Error ? raw.message : String(raw);
  try {
    const parsed = JSON.parse(text) as { error?: string; detail?: string | null };
    return [parsed.error, parsed.detail].filter(Boolean).join(" — ") || text;
  } catch {
    return text;
  }
}
