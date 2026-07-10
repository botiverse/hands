/**
 * TestFlight tab — one place to see every Hands→Apple upload request and its
 * live App Store Connect processing state. Upload attempts are recorded as
 * `testflight-upload` operations; each successful one carries a
 * build_upload_id whose Apple state (PROCESSING → COMPLETE | FAILED) is
 * polled live, so the operation's "upload succeeded" is separated from
 * Apple's async accept/reject verdict.
 */
import { useQuery } from "@tanstack/react-query";
import {
  listOperations,
  getTestflightUploadStatus,
  type Operation,
  type AscUploadState,
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

  return (
    <div>
      <div className="mb-4">
        <h2 className="text-lg font-semibold">TestFlight</h2>
        <p className="text-xs text-slate-500 mt-1">
          Every Hands→Apple upload request and its live App Store Connect
          processing state. Configure the key in{" "}
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
      {!ops.isLoading && uploads.length === 0 && (
        <p className="text-slate-500 text-sm">
          No TestFlight uploads yet. Open the Builds tab, expand an iOS build,
          and click “Upload to TestFlight”.
        </p>
      )}

      <div className="space-y-2">
        {uploads.map((op) => (
          <UploadRow key={op.id} appId={appId} op={op} />
        ))}
      </div>
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
          Processed — add it to a tester group in{" "}
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

function friendlyError(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { error?: string; detail?: string | null };
    return [parsed.error, parsed.detail].filter(Boolean).join(" — ") || raw;
  } catch {
    return raw;
  }
}
