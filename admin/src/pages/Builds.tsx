/**
 * Builds tab — list of build artifacts for an app.
 *
 * Wires the new /api/apps/:appId/builds + /builds/:id/assets endpoints.
 * Shows: status badge, product_type, version, changelog, asset matrix,
 * "Prepare release" button (becomes active when status=succeeded).
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  buildAssetDownloadUrl,
  getBuild,
  listBuildAssets,
  listBuilds,
  listChannels,
  listProductTypes,
  uploadBuildToTestflight,
  getTestflightUploadStatus,
  type Build,
  type BuildAsset,
} from "../lib/api";
import { useToast } from "../components/Toast";

export function Builds({ appId }: { appId: string }) {
  const qc = useQueryClient();
  const toast = useToast();

  const app = useQuery({ queryKey: ["apps"], queryFn: () => import("../lib/api").then((m) => m.listApps()) });
  const builds = useQuery({
    queryKey: ["builds", appId],
    queryFn: () => listBuilds(appId),
  });
  const channels = useQuery({
    queryKey: ["channels", appId],
    queryFn: () => listChannels(appId),
  });
  const productTypes = useQuery({
    queryKey: ["product-types", appId],
    queryFn: () => listProductTypes(appId),
  });

  const thisApp = app.data?.apps.find((a) => a.id === appId);
  const [expandedBuildId, setExpandedBuildId] = useState<string | null>(null);
  const [prepareBuild, setPrepareBuild] = useState<Build | null>(null);

  return (
    <div>
      <div className="mb-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Builds</h2>
          <a
            href={`/apps/${appId}/releases`}
            className="btn-primary text-sm no-underline"
            title={
              !channels.data?.channels.length
                ? "Create a channel first"
                : "Create a release + attach APK assets"
            }
          >
            + New release
          </a>
        </div>
      </div>

      {builds.isLoading && <p className="text-slate-500">Loading...</p>}
      {builds.error && (
        <p className="text-red-600">Failed: {(builds.error as Error).message}</p>
      )}

      {builds.data && builds.data.builds.length === 0 && !builds.isLoading && (
        <p className="text-slate-500 text-sm">
          No builds yet. Create a release from the Releases tab to upload assets.
        </p>
      )}

      <div className="space-y-2">
        {builds.data?.builds.map((b) => {
          const channel = channels.data?.channels.find((c) => c.id === b.channel_id);
          const pt = productTypes.data?.product_types.find((p) => p.name === b.product_type);
          const isExpanded = expandedBuildId === b.id;
          return (
            <div key={b.id} className="card p-3!">
              <div className="flex items-center gap-3 flex-wrap">
                <span className="font-mono font-medium">
                  v{b.version_name} ({b.version_code})
                </span>
                <span className="badge-gray">{b.product_type}</span>
                {channel && <span className="badge-blue">{channel.slug}</span>}
                <BuildStatusBadge status={b.status} />
                {b.should_force_update ? (
                  <span className="badge-orange text-xs">⚠ force</span>
                ) : null}
                {b.availability_at && b.availability_at > Date.now() ? (
                  <span className="badge-blue text-xs">
                    scheduled {new Date(b.availability_at).toISOString().slice(0, 16)}Z
                  </span>
                ) : null}
                <span className="text-xs text-slate-500 ml-auto">
                  {new Date(b.created_at).toISOString().slice(0, 16)}Z
                </span>
              </div>
              {b.changelog && (
                <details className="text-xs text-slate-600 mt-1">
                  <summary className="cursor-pointer hover:text-slate-800">
                    {(b.changelog.split("\n")[0] ?? "").slice(0, 80)}
                    {b.changelog.split("\n").length > 1 ? "…" : ""}
                  </summary>
                  <pre className="mt-1 pl-2 border-l-2 border-slate-100 font-mono whitespace-pre-wrap text-xs max-h-32 overflow-y-auto">
                    {b.changelog}
                  </pre>
                </details>
              )}
              <div className="flex gap-2 mt-2">
                <button
                  className="btn-secondary text-xs"
                  onClick={() => setExpandedBuildId(isExpanded ? null : b.id)}
                >
                  {isExpanded ? "Hide assets" : "Show assets"}
                </button>
                {b.status === "succeeded" && (
                  <button
                    className="btn-primary text-xs"
                    onClick={() => setPrepareBuild(b)}
                  >
                    Prepare release
                  </button>
                )}
              </div>
              {b.product_type === "ios-ipa" && (
                <TestflightUploadPanel appId={appId} build={b} />
              )}
              {isExpanded && <BuildAssetList appId={appId} buildId={b.id} />}
            </div>
          );
        })}
      </div>

      {prepareBuild && (
        <PrepareReleaseDialog
          build={prepareBuild}
          onClose={() => setPrepareBuild(null)}
          onCreated={() => {
            setPrepareBuild(null);
            qc.invalidateQueries({ queryKey: ["releases", appId] });
            qc.invalidateQueries({ queryKey: ["builds", appId] });
          }}
        />
      )}
    </div>
  );
}

function TestflightUploadPanel({ appId, build }: { appId: string; build: Build }) {
  const toast = useToast();
  const [buildUploadId, setBuildUploadId] = useState<string | null>(null);
  const [ascAppId, setAscAppId] = useState<string | null>(null);

  const upload = useMutation({
    mutationFn: () => uploadBuildToTestflight(appId, build.id),
    onSuccess: (res) => {
      if (res.ok && res.build_upload_id) {
        setBuildUploadId(res.build_upload_id);
        if (res.asc_app_id) setAscAppId(res.asc_app_id);
        toast.show({ kind: "success", title: "Uploaded to Apple — processing" });
      } else {
        toast.show({
          kind: "error",
          title: "Upload rejected",
          description: res.error ?? res.detail ?? "unknown error",
        });
      }
    },
    onError: (e) =>
      toast.show({ kind: "error", title: "Upload failed", description: (e as Error).message }),
  });

  const status = useQuery({
    queryKey: ["testflight-status", appId, buildUploadId],
    queryFn: () => getTestflightUploadStatus(appId, buildUploadId!),
    enabled: buildUploadId != null,
    refetchInterval: (q) => {
      const s = q.state.data?.state?.state;
      return s === "COMPLETE" || s === "FAILED" ? false : 5000;
    },
  });

  const state = status.data?.state;
  const stateName = state?.state;
  const stateColor =
    stateName === "COMPLETE"
      ? "text-green-700"
      : stateName === "FAILED"
        ? "text-red-700"
        : "text-blue-700";

  return (
    <div className="mt-2 pt-2 border-t border-slate-100">
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <span className="badge-gray"> TestFlight</span>
        <button
          className="btn-secondary py-1! px-2! text-xs!"
          disabled={upload.isPending || build.status !== "succeeded"}
          onClick={() => upload.mutate()}
          title={
            build.status !== "succeeded"
              ? "Build must be succeeded"
              : "Upload this IPA to App Store Connect / TestFlight"
          }
        >
          {upload.isPending ? "Uploading…" : "Upload to TestFlight"}
        </button>
        <a
          className="btn-secondary py-1! px-2! text-xs! no-underline"
          href={
            ascAppId
              ? `https://appstoreconnect.apple.com/apps/${ascAppId}/testflight/ios`
              : "https://appstoreconnect.apple.com/apps"
          }
          target="_blank"
          rel="noopener noreferrer"
        >
          Open in App Store Connect ↗
        </a>
        {stateName && (
          <span className={`font-medium ${stateColor}`}>
            {stateName === "PROCESSING" || stateName === "AWAITING_UPLOAD"
              ? "Apple processing…"
              : stateName}
          </span>
        )}
      </div>
      {state?.errors && state.errors.length > 0 && (
        <ul className="mt-1 text-xs text-red-700 list-disc pl-5">
          {state.errors.map((e, i) => (
            <li key={i}>
              {e.code ? `[${e.code}] ` : ""}
              {e.description}
            </li>
          ))}
        </ul>
      )}
      {stateName === "COMPLETE" && (
        <p className="mt-1 text-xs text-green-700">
          Processed — add it to a tester group in App Store Connect → TestFlight.
        </p>
      )}
    </div>
  );
}

function BuildStatusBadge({ status }: { status: string }) {
  const colorMap: Record<string, string> = {
    pending: "bg-gray-200 text-gray-700",
    building: "bg-blue-200 text-blue-700",
    succeeded: "bg-green-200 text-green-700",
    failed: "bg-red-200 text-red-700",
    smoke_testing: "bg-yellow-200 text-yellow-700",
    smoke_test_passed: "bg-green-200 text-green-700",
    smoke_test_failed: "bg-red-200 text-red-700",
  };
  return (
    <span
      className={`text-xs px-2 py-0.5 rounded-sm ${colorMap[status] ?? "bg-gray-200 text-gray-700"}`}
    >
      {status}
    </span>
  );
}

function BuildAssetList({ appId, buildId }: { appId: string; buildId: string }) {
  const assets = useQuery({
    queryKey: ["build-assets", appId, buildId],
    queryFn: () => listBuildAssets(appId, buildId),
    enabled: !!appId && !!buildId,
  });
  return (
    <div className="mt-2 pt-2 border-t border-slate-100 text-xs">
      {assets.isLoading && <p className="text-slate-500">Loading assets…</p>}
      {assets.data && assets.data.assets.length === 0 && (
        <p className="text-slate-500">No assets registered.</p>
      )}
      {assets.data && assets.data.assets.length > 0 && (
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="text-slate-500 text-left">
              <th className="font-normal pr-2">platform</th>
              <th className="font-normal pr-2">arch</th>
              <th className="font-normal pr-2">filetype</th>
              <th className="font-normal pr-2">kind</th>
              <th className="font-normal pr-2">size</th>
              <th className="font-normal pr-2">sha256</th>
              <th className="font-normal pr-2 text-right">download</th>
            </tr>
          </thead>
          <tbody>
            {assets.data.assets.map((a: BuildAsset) => (
              <tr key={a.id}>
                <td className="pr-2">{a.platform}</td>
                <td className="pr-2">{a.arch ?? "-"}</td>
                <td className="pr-2">{a.filetype}</td>
                <td className="pr-2">{a.artifact_kind}</td>
                <td className="pr-2">{(a.size_bytes / 1024 / 1024).toFixed(2)} MB</td>
                <td className="pr-2 truncate max-w-xs">
                  {a.file_hash.slice(0, 16)}…
                </td>
                <td className="pr-2 text-right">
                  <a
                    className="btn-secondary text-xs no-underline inline-flex"
                    href={buildAssetDownloadUrl(appId, buildId, a.id)}
                  >
                    Download
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function PrepareReleaseDialog({
  build,
  onClose,
  onCreated,
}: {
  build: Build;
  onClose: () => void;
  onCreated: () => void;
}) {
  const appId = build.app_id;
  const toast = useToast();
  const [scopeType, setScopeType] = useState<"full" | "platform" | "ip_range">("full");
  const [platforms, setPlatforms] = useState<string>("");
  const [ipRanges, setIpRanges] = useState<string>("");

  const create = useMutation({
    mutationFn: () =>
      import("../lib/api").then((m) =>
        m.createRelease(appId, {
          build_id: build.id,
          channel_id: build.channel_id ?? undefined,
          changelog: build.changelog ?? undefined,
          should_force_update: !!build.should_force_update,
          scopes:
            scopeType === "full"
              ? []
              : scopeType === "platform"
                ? [
                    {
                      scope_type: "platform",
                      scope_value: platforms
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean)
                        .join(","),
                    },
                  ]
                : [
                    {
                      scope_type: "ip_range",
                      scope_value: ipRanges
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean)
                        .join(","),
                    },
                  ],
        }),
      ),
    onSuccess: () => {
      toast.show({ kind: "success", title: "Release created" });
      onCreated();
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: "Failed to create release",
        description: (e as Error).message,
      }),
  });

  return (
    <div
      className="fixed inset-0 bg-black/30 flex items-center justify-center p-4 z-10"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="card max-w-lg w-full relative">
        <h2 className="text-lg font-bold mb-4 pr-8">Prepare release</h2>
        <p className="text-sm text-slate-500 mb-4">
          Release build <code className="text-xs">{build.id.slice(0, 8)}…</code> (v
          {build.version_name})
        </p>

        <div className="space-y-3">
          <div>
            <label className="label">Release scope</label>
            <div className="space-y-1">
              {(["full", "platform", "ip_range"] as const).map((t) => (
                <label key={t} className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    checked={scopeType === t}
                    onChange={() => setScopeType(t)}
                  />
                  {t === "full" && "Full release — all users"}
                  {t === "platform" && "Platform release — only specified platforms"}
                  {t === "ip_range" && "IP range — only specified CIDR list"}
                </label>
              ))}
            </div>
          </div>
          {scopeType === "platform" && (
            <div>
              <label className="label">Platforms (comma-separated)</label>
              <input
                className="input text-xs font-mono"
                value={platforms}
                onChange={(e) => setPlatforms(e.target.value)}
                placeholder="darwin-arm64,darwin-x64,linux-x64"
              />
            </div>
          )}
          {scopeType === "ip_range" && (
            <div>
              <label className="label">IP ranges (comma-separated CIDR)</label>
              <input
                className="input text-xs font-mono"
                value={ipRanges}
                onChange={(e) => setIpRanges(e.target.value)}
                placeholder="10.0.0.0/8,192.168.0.0/16"
              />
            </div>
          )}
        </div>

        <div className="flex gap-2 justify-end pt-4 mt-4 border-t border-slate-100">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() => create.mutate()}
            disabled={
              create.isPending ||
              (scopeType === "platform" && !platforms.trim()) ||
              (scopeType === "ip_range" && !ipRanges.trim())
            }
          >
            {create.isPending ? "Releasing…" : "Release"}
          </button>
        </div>
      </div>
    </div>
  );
}
