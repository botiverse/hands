/**
 * Releases tab — live releases per channel and product type.
 *
 * Wires the new /api/apps/:appId/releases + /releases/:id/{rollback,bump-rollout,force-update}
 * endpoints. Shows: status badge, scope visualization, action buttons.
 */

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  bumpRollout,
  createBuild,
  createRelease,
  deleteRelease,
  forceUpdate,
  getRelease,
  listApps,
  listChannels,
  listProductTypes,
  listReleases,
  publishRelease,
  rollbackRelease,
  updateRelease,
  type Release,
  type ReleaseScope,
  type ProductType,
} from "../lib/api";
import { useToast } from "../components/Toast";
import { ConfirmActionDialog } from "../components/ConfirmActionDialog";
import { ReleaseAssetsPanel } from "../components/ReleaseAssetsPanel";
import { ReleaseAssetUploader } from "../components/ReleaseAssetUploader";
import { createBuildAsset, uploadApk } from "../lib/api";
import type { PendingFile } from "../lib/releaseFileDetect";

function parseJsonStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function productTypeMatchesPlatform(productType: ProductType, appPlatform?: string | null): boolean {
  if (!appPlatform) return true;
  const platform = appPlatform.toLowerCase();
  const supported = parseJsonStringArray(productType.supported_platforms_json)
    .map((item) => item.toLowerCase());
  if (supported.some((item) => item === platform || item.startsWith(`${platform}-`))) {
    return true;
  }
  if (platform === "android") {
    return productType.name.startsWith("android-") || productType.parser_kind === "apk-aapt";
  }
  if (platform === "ios") {
    return productType.name.startsWith("ios-") || supported.some((item) => item.includes("iphone"));
  }
  if (platform === "electron") {
    return productType.name.includes("electron") || productType.parser_kind === "electron-asar";
  }
  if (platform === "rn" || platform === "react-native") {
    return productType.name.includes("rn") || productType.parser_kind === "rn-bundle";
  }
  return productType.name.includes(platform) || productType.parser_kind.includes(platform);
}

export function Releases({ appId }: { appId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [channelFilter, setChannelFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [showNewRelease, setShowNewRelease] = useState(false);

  const app = useQuery({ queryKey: ["apps"], queryFn: () => listApps() });
  const releases = useQuery({
    queryKey: ["releases", appId],
    queryFn: () => listReleases(appId),
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

  // Filter client-side (expert's endpoint may or may not accept filter params;
  // we keep filtering here for v1 simplicity)
  const filtered = (releases.data?.releases ?? []).filter((r) => {
    if (channelFilter !== "all") {
      const ch = channels.data?.channels.find((c) => c.id === r.channel_id);
      if (ch?.slug !== channelFilter) return false;
    }
    if (statusFilter !== "all" && r.status !== statusFilter) return false;
    return true;
  });

  return (
    <div>
      <div className="mb-6 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="text-sm text-slate-500">Releases</div>
          <h1 className="text-2xl font-bold">
            {thisApp?.name ?? "..."}
            <span className="badge-blue align-middle ml-2">{thisApp?.platform}</span>
          </h1>
          <div className="text-sm text-slate-500 font-mono">{thisApp?.slug}</div>
        </div>
        <button
          className="btn-primary text-sm"
          onClick={() => setShowNewRelease(true)}
        >
          + New release
        </button>
      </div>

      {/* Stats summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <Stat label="Total" value={releases.data?.releases.length ?? 0} />
        <Stat
          label="Active"
          value={releases.data?.releases.filter((r) => r.status === "active").length ?? 0}
        />
        <Stat
          label="Draft"
          value={releases.data?.releases.filter((r) => r.status === "draft").length ?? 0}
        />
        <Stat
          label="Channels"
          value={channels.data?.channels.length ?? 0}
        />
      </div>

      {/* Filters */}
      <div className="card !p-3 mb-4 flex flex-wrap gap-3 items-center">
        <select
          className="input w-40"
          value={channelFilter}
          onChange={(e) => setChannelFilter(e.target.value)}
        >
          <option value="all">All channels</option>
          {channels.data?.channels.map((c) => (
            <option key={c.id} value={c.slug}>
              {c.slug}
            </option>
          ))}
        </select>
        <select
          className="input w-40"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          <option value="all">All statuses</option>
          <option value="draft">Draft</option>
          <option value="active">Active</option>
          <option value="superseded">Superseded</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </div>

      {releases.isLoading && <p className="text-slate-500">Loading…</p>}
      {releases.error && (
        <p className="text-red-600">Failed: {(releases.error as Error).message}</p>
      )}

      {filtered.length === 0 && !releases.isLoading && (
        <p className="text-slate-500 text-sm">
          No releases match your filter. Create a new release and upload the
          required assets from this tab.
        </p>
      )}

      <div className="space-y-2">
        {filtered.map((r) => {
          const channel = channels.data?.channels.find((c) => c.id === r.channel_id);
          const pt = productTypes.data?.product_types.find((p) => p.name === r.product_type);
          return (
            <ReleaseRow
              key={r.id}
              release={r}
              appId={appId}
              channelSlug={channel?.slug ?? "?"}
              productTypeName={pt?.display_name ?? r.product_type}
              onAction={() => {
                qc.invalidateQueries({ queryKey: ["releases", appId] });
              }}
            />
          );
        })}
      </div>

      {showNewRelease && (
        <NewReleaseDialog
          appId={appId}
          onClose={() => setShowNewRelease(false)}
          onCreated={() => {
            setShowNewRelease(false);
            qc.invalidateQueries({ queryKey: ["releases", appId] });
          }}
        />
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="card !p-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-2xl font-semibold mt-1">{value}</div>
    </div>
  );
}

function ReleaseRow({
  release: r,
  appId,
  channelSlug,
  productTypeName,
  onAction,
}: {
  release: Release;
  appId: string;
  channelSlug: string;
  productTypeName: string;
  onAction: () => void;
}) {
  const toast = useToast();
  const [showRollout, setShowRollout] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [newPercent, setNewPercent] = useState<number>(r.rollout_cohort_count ?? 100);

  const detail = useQuery({
    queryKey: ["release-detail", r.id],
    queryFn: () => getRelease(appId, r.id),
  });

  const publish = useMutation({
    mutationFn: () => publishRelease(appId, r.id),
    onSuccess: () => {
      toast.show({ kind: "success", title: `Published ${channelSlug}` });
      onAction();
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: "Publish failed",
        description: (e as Error).message,
      }),
  });

  const rollback = useMutation({
    mutationFn: () => rollbackRelease(appId, r.id, {}),
    onSuccess: () => {
      toast.show({ kind: "success", title: `Rolled back ${channelSlug}` });
      onAction();
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: "Rollback failed",
        description: (e as Error).message,
      }),
  });

  const bump = useMutation({
    mutationFn: (target: number) => bumpRollout(appId, r.id, { to: target }),
    onSuccess: (data) => {
      toast.show({
        kind: "success",
        title: `Rollout set to ${data.rollout_cohort_count ?? "?"}%`,
      });
      onAction();
      setShowRollout(false);
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: "Bump rollout failed",
        description: (e as Error).message,
      }),
  });

  const toggleForce = useMutation({
    mutationFn: () => forceUpdate(appId, r.id, { enabled: !r.should_force_update }),
    onSuccess: (data) => {
      toast.show({
        kind: "success",
        title: data.should_force_update
          ? "Now forcing update on clients"
          : "No longer forcing update",
      });
      onAction();
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: "Force-update toggle failed",
        description: (e as Error).message,
      }),
  });

  const cancel = useMutation({
    mutationFn: () => deleteRelease(appId, r.id),
    onSuccess: () => {
      toast.show({
        kind: "success",
        title: r.status === "draft" ? "Draft deleted" : "Release cancelled",
      });
      setConfirmCancel(false);
      onAction();
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: r.status === "draft" ? "Delete failed" : "Cancel failed",
        description: (e as Error).message,
      }),
  });

  return (
    <div className="card">
      <div className="flex items-center gap-3 flex-wrap">
        <ReleaseStatusBadge status={r.status} />
        <span className="font-medium">{channelSlug}</span>
        <span className="text-xs text-slate-500">{productTypeName}</span>
        {r.is_full ? (
          <span className="badge-green text-xs">full</span>
        ) : (
          <span className="badge-orange text-xs">scoped</span>
        )}
        {r.should_force_update ? (
          <span className="badge-orange text-xs">⚠ force</span>
        ) : null}
        {r.rollout_cohort_count != null && r.rollout_cohort_count < 100 && (
          <span className="badge-orange text-xs">
            {r.rollout_cohort_count}% rollout
          </span>
        )}
        <span className="text-xs text-slate-500 ml-auto">
          {new Date(r.created_at).toISOString().slice(0, 16)}Z
        </span>
      </div>
      <div className="text-xs text-slate-500 font-mono mt-1 truncate">
        {r.id} (build {r.build_id.slice(0, 8)}…)
      </div>
      {r.changelog && (
        <pre className="mt-2 pl-2 border-l-2 border-slate-100 font-mono whitespace-pre-wrap text-xs text-slate-600 max-h-32 overflow-y-auto">
          {r.changelog}
        </pre>
      )}
      <div className="flex flex-wrap gap-2 mt-2">
        {r.status === "draft" && (
          <button
            className="btn-primary text-xs"
            onClick={() => publish.mutate()}
            disabled={publish.isPending}
          >
            {publish.isPending ? "Publishing..." : "Publish"}
          </button>
        )}
        {(r.status === "draft" || r.status === "active") && (
          <button
            className="btn-secondary text-xs"
            onClick={() => setShowEdit(true)}
          >
            Edit
          </button>
        )}
        {r.status === "active" && (
          <>
            <button
              className="btn-secondary text-xs"
              onClick={() => setShowRollout(!showRollout)}
            >
              Bump rollout
            </button>
            <button
              className="btn-secondary text-xs"
              onClick={() => toggleForce.mutate()}
              disabled={toggleForce.isPending}
            >
              {r.should_force_update ? "Unforce" : "Force"}
            </button>
            <button
              className="btn-secondary text-xs"
              onClick={() => rollback.mutate()}
              disabled={rollback.isPending}
            >
              Roll back
            </button>
          </>
        )}
        {(r.status === "draft" || r.status === "active") && (
          <button
            className="btn-danger text-xs"
            onClick={() => setConfirmCancel(true)}
          >
            {r.status === "draft" ? "Delete draft" : "Cancel release"}
          </button>
        )}
      </div>
      {showRollout && (
        <div className="mt-2 pt-2 border-t border-slate-100 flex items-center gap-2 text-xs">
          <label>Rollout %:</label>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={newPercent}
            onChange={(e) => setNewPercent(Number(e.target.value))}
            className="flex-1"
          />
          <span className="font-mono w-10 text-right">{newPercent}%</span>
          <button
            className="btn-primary text-xs"
            onClick={() => bump.mutate(newPercent)}
            disabled={bump.isPending}
          >
            {bump.isPending ? "…" : "Set"}
          </button>
        </div>
      )}
      {detail.isLoading && (
        <div className="mt-2 pt-2 border-t border-slate-100 text-xs text-slate-500">
          Loading release details...
        </div>
      )}
      {detail.data && (
        <div className="mt-2 pt-2 border-t border-slate-100 text-xs">
          <div className="text-slate-500 mb-1">Build: {detail.data.build?.version_name} ({detail.data.build?.version_code})</div>
          <div className="text-slate-500 mb-1">
            Assets: {detail.data.assets.length} · Scopes: {detail.data.scopes.length}
          </div>
          {detail.data.scopes.length > 0 && (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-slate-500 text-left">
                  <th className="font-normal pr-2">type</th>
                  <th className="font-normal pr-2">value</th>
                </tr>
              </thead>
              <tbody>
                {detail.data.scopes.map((s: ReleaseScope) => (
                  <tr key={s.id}>
                    <td className="pr-2 font-mono">{s.scope_type}</td>
                    <td className="pr-2 font-mono">{s.scope_value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Asset upload zone — always visible (not gated by showDetail) so
          users can drop files onto a release row without expanding details. */}
      <ReleaseAssetsPanel
        appId={appId}
        releaseId={r.id}
        buildId={r.build_id}
        productTypeHint={r.product_type}
      />

      {showEdit && (
        <EditReleaseDialog
          appId={appId}
          release={r}
          detail={detail.data}
          loading={detail.isLoading}
          onClose={() => setShowEdit(false)}
          onSaved={() => {
            setShowEdit(false);
            onAction();
          }}
        />
      )}

      <ConfirmActionDialog
        open={confirmCancel}
        title={r.status === "draft" ? "Delete this draft?" : "Cancel this release?"}
        objectLabel={`${channelSlug} / ${r.product_type}`}
        objectHint={r.id.slice(0, 8)}
        body={
          r.status === "draft"
            ? "The draft will be marked cancelled. The build metadata and any uploaded assets stay available in storage; no live release is affected."
            : "This release will stop being served by update checks. The build metadata and uploaded assets stay available in storage."
        }
        confirmLabel={r.status === "draft" ? "Delete draft" : "Cancel release"}
        confirmKind="danger"
        pending={cancel.isPending}
        onCancel={() => setConfirmCancel(false)}
        onConfirm={() => cancel.mutate()}
      />
    </div>
  );
}

function ReleaseStatusBadge({ status }: { status: string }) {
  const colorMap: Record<string, string> = {
    draft: "bg-blue-100 text-blue-700",
    active: "bg-green-200 text-green-700",
    superseded: "bg-gray-200 text-gray-700",
    cancelled: "bg-red-200 text-red-700",
  };
  return (
    <span
      className={`text-xs px-2 py-0.5 rounded ${colorMap[status] ?? "bg-gray-200 text-gray-700"}`}
    >
      {status}
    </span>
  );
}

function EditReleaseDialog({
  appId,
  release,
  detail,
  loading,
  onClose,
  onSaved,
}: {
  appId: string;
  release: Release;
  detail?: { release: Release; scopes: ReleaseScope[] } | undefined;
  loading: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [changelog, setChangelog] = useState(release.changelog ?? "");
  const [scopeType, setScopeType] = useState<"full" | "platform" | "user_cohort" | "ip_range">("full");
  const [scopeValue, setScopeValue] = useState("all");
  const [shouldForceUpdate, setShouldForceUpdate] = useState(Boolean(release.should_force_update));
  const [rolloutPercent, setRolloutPercent] = useState<number>(release.rollout_cohort_count ?? 100);

  useEffect(() => {
    if (!detail) return;
    const firstScope = detail.scopes[0];
    setChangelog(detail.release.changelog ?? "");
    setShouldForceUpdate(Boolean(detail.release.should_force_update));
    setRolloutPercent(detail.release.rollout_cohort_count ?? 100);
    if (
      firstScope &&
      (firstScope.scope_type === "full" ||
        firstScope.scope_type === "platform" ||
        firstScope.scope_type === "user_cohort" ||
        firstScope.scope_type === "ip_range")
    ) {
      setScopeType(firstScope.scope_type);
      setScopeValue(firstScope.scope_value);
    }
  }, [detail]);

  const save = useMutation({
    mutationFn: () =>
      updateRelease(appId, release.id, {
        changelog: changelog.trim() || null,
        should_force_update: shouldForceUpdate,
        rollout_cohort_count: rolloutPercent < 100 ? rolloutPercent : null,
        scopes:
          scopeType === "full"
            ? [{ scope_type: "full", scope_value: "all" }]
            : [{ scope_type: scopeType, scope_value: scopeValue.trim() }],
      }),
    onSuccess: () => {
      toast.show({ kind: "success", title: "Release updated" });
      onSaved();
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: "Update failed",
        description: (e as Error).message,
      }),
  });

  const scopeValid = scopeType === "full" || scopeValue.trim().length > 0;

  return (
    <div
      className="fixed inset-0 bg-black/30 flex items-center justify-center p-4 z-10"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="card max-w-lg w-full relative">
        <h2 className="text-lg font-bold mb-1">Edit release</h2>
        <p className="text-xs text-slate-500 mb-3 font-mono">{release.id}</p>
        {loading && <p className="text-sm text-slate-500">Loading release details...</p>}
        <div className="space-y-3">
          <div>
            <label className="label">Release notes</label>
            <textarea
              className="input text-xs min-h-[120px]"
              value={changelog}
              onChange={(e) => setChangelog(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Scope type</label>
              <select
                className="input"
                value={scopeType}
                onChange={(e) => {
                  const next = e.target.value as typeof scopeType;
                  setScopeType(next);
                  setScopeValue(next === "full" ? "all" : "");
                }}
              >
                <option value="full">Full</option>
                <option value="platform">Platform</option>
                <option value="user_cohort">User cohort</option>
                <option value="ip_range">IP range</option>
              </select>
            </div>
            <div>
              <label className="label">Scope value</label>
              <input
                className="input"
                value={scopeValue}
                disabled={scopeType === "full"}
                onChange={(e) => setScopeValue(e.target.value)}
                placeholder={scopeType === "full" ? "all" : "android-arm64-v8a"}
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={shouldForceUpdate}
              onChange={(e) => setShouldForceUpdate(e.target.checked)}
            />
            Force update
          </label>
          <div className="flex items-center gap-2 text-xs">
            <label className="flex-1">Rollout cohort %</label>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={rolloutPercent}
              onChange={(e) => setRolloutPercent(Number(e.target.value))}
            />
            <span className="font-mono w-10 text-right">{rolloutPercent}%</span>
          </div>
        </div>
        <div className="flex gap-2 justify-end pt-4 mt-3 border-t border-slate-100">
          <button className="btn-secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={() => save.mutate()}
            disabled={save.isPending || loading || !scopeValid}
          >
            {save.isPending ? "Saving..." : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// NewReleaseDialog — release-first flow (P2.5 release v2)
// =============================================================================

function NewReleaseDialog({
  appId,
  onClose,
  onCreated,
}: {
  appId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const toast = useToast();
  const channels = useQuery({
    queryKey: ["channels", appId],
    queryFn: () => listChannels(appId),
  });
  const productTypes = useQuery({
    queryKey: ["product-types", appId],
    queryFn: () => listProductTypes(appId),
  });

  // Pre-fill the channel with the app's default release channel (set in
  // AppDetail Settings). Falls back to first channel if no default.
  const apps = useQuery({ queryKey: ["apps"], queryFn: () => listApps() });
  const thisApp = apps.data?.apps.find((a) => a.id === appId);
  const defaultChannelSlug =
    thisApp?.default_channel_slug ??
    channels.data?.channels
      .slice()
      .sort((a, b) => a.slug.localeCompare(b.slug))[0]?.slug ??
    "";

  // ---------------- 4-step wizard state ----------------
  type Step = 1 | 2 | 3 | 4;
  const STEP_LABELS = ["Target", "Version", "Assets", "Review"] as const;
  const [step, setStep] = useState<Step>(1);

  const [channelSlug, setChannelSlug] = useState<string>("");
  const [productType, setProductType] = useState<string>("");
  const [versionName, setVersionName] = useState<string>("");
  const [versionCode, setVersionCode] = useState<string>("");
  const [changelog, setChangelog] = useState<string>("");
  const [scopeType, setScopeType] = useState<"full" | "platform" | "user_cohort" | "ip_range">(
    "full",
  );
  const [scopeValue, setScopeValue] = useState<string>("all");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [shouldForceUpdate, setShouldForceUpdate] = useState(false);
  const [rolloutPercent, setRolloutPercent] = useState(100);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const createdReleaseIdRef = useRef<string | null>(null);

  // Compute the candidate product_types for this app's platform AFTER
  // `productType` state is declared (TDZ-safe — `productType` is read here).
  const matchingProductTypes =
    productTypes.data?.product_types.filter((p) =>
      productTypeMatchesPlatform(p, thisApp?.platform),
    ) ?? [];
  const targetProductTypes =
    matchingProductTypes.length > 0
      ? matchingProductTypes
      : productTypes.data?.product_types ?? [];
  const showProductTypePicker = targetProductTypes.length > 1;
  const selectedProductType = targetProductTypes.find((p) => p.name === productType);

  // Pre-fill channel + product_type from app defaults once data is loaded.
  const [channelInit, setChannelInit] = useState(false);
  useEffect(() => {
    if (channelInit) return;
    if (channels.data && defaultChannelSlug) {
      setChannelSlug(defaultChannelSlug);
      setChannelInit(true);
    }
  }, [channels.data, defaultChannelSlug, channelInit]);

  const [ptInit, setPtInit] = useState(false);
  useEffect(() => {
    if (ptInit) return;
    if (targetProductTypes.length > 0) {
      setProductType(targetProductTypes[0]!.name);
      setPtInit(true);
    }
  }, [targetProductTypes, ptInit]);

  // ---------------- validation ----------------
  const step1Valid =
    !!channelSlug && !!productType;
  const step2Valid =
    versionName.trim().length > 0 &&
    Number.isFinite(Number(versionCode)) &&
    Number(versionCode) > 0 &&
    (scopeType === "full" || scopeValue.trim().length > 0);

  // ---------------- submit (step 4 → draft / publish) ----------------
  const submitRelease = useMutation({
    mutationFn: async (mode: "draft" | "publish") => {
      if (!step1Valid) throw new Error("Target incomplete");
      if (!step2Valid) throw new Error("Version incomplete");
      const channel = channels.data?.channels.find(
        (c) => c.slug === channelSlug,
      );
      if (!channel) throw new Error(`channel '${channelSlug}' not found`);

      // 1. create build (status=pending)
      const build = await createBuild(appId, {
        channel_id: channel.id,
        product_type: productType,
        release_type: "stable",
        version_name: versionName.trim(),
        version_code: Number(versionCode),
        changelog: changelog.trim() || undefined,
        source: "web",
        status: "pending",
        should_force_update: shouldForceUpdate || undefined,
      });
      // 2. create draft release. Publishing is an explicit lifecycle step,
      //    which keeps the release editable while assets are queued.
      const scopes =
        scopeType === "full"
          ? [{ scope_type: "full", scope_value: "all" }]
          : [{ scope_type: scopeType, scope_value: scopeValue.trim() }];
      const release = await createRelease(appId, {
        build_id: build.id,
        status: "draft",
        scopes,
        should_force_update: shouldForceUpdate || undefined,
        rollout_cohort_count: rolloutPercent < 100 ? rolloutPercent : undefined,
      });
      createdReleaseIdRef.current = release.id;
      // 3. upload + register each pending file. Failures do NOT abort — the
      //    release is already live and the user can retry from the row.
      const assetFailures: string[] = [];
      for (const slot of pendingFiles) {
        try {
          const uploaded = await uploadApk(appId, slot.file);
          await createBuildAsset(appId, build.id, {
            platform: slot.platform,
            arch: slot.arch,
            variant: slot.variant,
            filetype: slot.filetype,
            r2_key: uploaded.r2_key,
            file_hash: uploaded.file_hash,
            size_bytes: uploaded.size_bytes,
          });
        } catch (e) {
          assetFailures.push(`${slot.file.name}: ${(e as Error).message}`);
        }
      }
      if (mode === "publish") {
        const published = await publishRelease(appId, release.id);
        return { release: published, assetFailures, mode };
      }
      return { release, assetFailures, mode };
    },
    onSuccess: ({ release, assetFailures, mode }) => {
      const action = mode === "publish" ? "published" : "saved as draft";
      if (assetFailures.length === 0) {
        toast.show({
          kind: "success",
          title: `Release ${release.id.slice(0, 8)}… ${action}`,
          description: `${pendingFiles.length} asset${pendingFiles.length === 1 ? "" : "s"} attached.`,
        });
      } else {
        toast.show({
          kind: "error",
          title: `Release ${release.id.slice(0, 8)}… ${action} but ${assetFailures.length} asset(s) failed`,
          description: `${assetFailures[0]?.slice(0, 80)}… — fix from the release row.`,
        });
      }
      onCreated();
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: "Release save failed",
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
      <div className="card max-w-xl w-full relative max-h-[90vh] overflow-y-auto">
        <h2 className="text-lg font-bold mb-1">Draft a new release</h2>
        <p className="text-xs text-slate-500 mb-3">
          Draft the release, attach binaries, then publish — all in one flow.
        </p>

        {/* Stepper header */}
        <div className="flex items-center gap-1 mb-4 text-xs">
          {STEP_LABELS.map((label, i) => {
            const idx = (i + 1) as Step;
            const active = step === idx;
            const done = step > idx;
            return (
              <div key={label} className="flex items-center gap-1">
                <div
                  className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-semibold ${
                    active
                      ? "bg-blue-600 text-white"
                      : done
                        ? "bg-green-200 text-green-800"
                        : "bg-slate-200 text-slate-500"
                  }`}
                >
                  {done ? "✓" : idx}
                </div>
                <span
                  className={
                    active
                      ? "font-medium text-slate-900"
                      : done
                        ? "text-green-700"
                        : "text-slate-500"
                  }
                >
                  {label}
                </span>
                {i < STEP_LABELS.length - 1 && (
                  <span className="text-slate-300 mx-1">›</span>
                )}
              </div>
            );
          })}
        </div>

        <div className="space-y-3 min-h-[260px]">
          {/* ---------------- Step 1: Target ---------------- */}
          {step === 1 && (
            <div className="space-y-3">
              <div className={showProductTypePicker ? "grid grid-cols-2 gap-3" : "grid grid-cols-1 gap-3"}>
                <div>
                  <label className="label">Channel</label>
                  <select
                    className="input"
                    value={channelSlug}
                    onChange={(e) => setChannelSlug(e.target.value)}
                    autoFocus
                  >
                    <option value="">— pick —</option>
                    {channels.data?.channels.map((c) => (
                      <option key={c.id} value={c.slug}>
                        {c.slug}
                      </option>
                    ))}
                  </select>
                </div>
                {showProductTypePicker && (
                  <div>
                    <label className="label">Package type</label>
                    <select
                      className="input"
                      value={productType}
                      onChange={(e) => setProductType(e.target.value)}
                    >
                      <option value="">— pick —</option>
                      {targetProductTypes.map((p) => (
                        <option key={p.name} value={p.name}>
                          {p.display_name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
              {!showProductTypePicker && selectedProductType && (
                <p className="text-xs text-slate-500">
                  Package type is set by this app:{" "}
                  <span className="font-medium">{selectedProductType.display_name}</span>.
                </p>
              )}
              {(!channels.data || channels.data.channels.length === 0) && (
                <p className="text-xs text-yellow-700">
                  ⚠ This app has no channels yet. Create one in AppDetail → Channels first.
                </p>
              )}
            </div>
          )}

          {/* ---------------- Step 2: Version + notes ---------------- */}
          {step === 2 && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Version name (e.g. 1.2.3)</label>
                  <input
                    className="input"
                    value={versionName}
                    onChange={(e) => setVersionName(e.target.value)}
                    placeholder="1.2.3"
                    autoFocus
                  />
                </div>
                <div>
                  <label className="label">Version code (integer)</label>
                  <input
                    className="input"
                    type="number"
                    value={versionCode}
                    onChange={(e) => setVersionCode(e.target.value)}
                    placeholder="42"
                  />
                </div>
              </div>
              <div>
                <label className="label">Release notes</label>
                <textarea
                  className="input text-xs min-h-[120px]"
                  value={changelog}
                  onChange={(e) => setChangelog(e.target.value)}
                  placeholder={"## What's new\n- Fix X\n- Add Y"}
                />
              </div>
            </div>
          )}

          {/* ---------------- Step 3: Assets ---------------- */}
          {step === 3 && (
            <div className="space-y-2">
              <p className="text-xs text-slate-500">
                Drop one or more binaries. We auto-detect platform / arch /
                filetype from the filename and keep optional fields blank when
                they are not needed.
                <br />
                <em>Optional</em>: you can publish without binaries and attach
                them later from the release row.
              </p>
              <ReleaseAssetUploader
                variant="dialog"
                deferUpload
                appId={appId}
                buildId="__pending__"
                productTypeHint={productType || "android-apk"}
                onFilesChanged={setPendingFiles}
              />
              <p className="text-[10px] text-slate-400">
                Asset upload happens after the release is published. The release
                is preserved even if individual assets fail.
              </p>
            </div>
          )}

          {/* ---------------- Step 4: Review ---------------- */}
          {step === 4 && (
            <div className="space-y-3 text-sm">
              <div className="border border-slate-200 rounded p-3 space-y-1">
                <Row k="Channel" v={channelSlug || "—"} />
                <Row k="Product type" v={productType || "—"} />
                <Row k="Version" v={`${versionName || "—"} (${versionCode || "?"})`} />
                <Row
                  k="Scope"
                  v={
                    scopeType === "full"
                      ? "full (all users)"
                      : `${scopeType}: ${scopeValue || "?"}`
                  }
                />
                <Row k="Assets" v={`${pendingFiles.length} file(s) queued`} />
                {changelog && (
                  <details className="pt-2 border-t border-slate-100">
                    <summary className="cursor-pointer text-xs text-slate-500">
                      Release notes
                    </summary>
                    <pre className="mt-1 p-2 bg-slate-50 rounded text-xs whitespace-pre-wrap">
                      {changelog}
                    </pre>
                  </details>
                )}
              </div>

              <details>
                <summary
                  className="cursor-pointer text-xs text-slate-600"
                  onClick={(e) => {
                    e.preventDefault();
                    setShowAdvanced((v) => !v);
                  }}
                >
                  {showAdvanced ? "▾" : "▸"} Advanced options (force update, rollout %)
                </summary>
                {showAdvanced && (
                  <div className="mt-2 p-3 border border-slate-200 rounded space-y-2">
                    <label className="flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={shouldForceUpdate}
                        onChange={(e) => setShouldForceUpdate(e.target.checked)}
                      />
                      Force update — clients must upgrade on next launch
                    </label>
                    <div className="flex items-center gap-2 text-xs">
                      <label className="flex-1">
                        Rollout cohort % (default 100)
                      </label>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        step={5}
                        value={rolloutPercent}
                        onChange={(e) => setRolloutPercent(Number(e.target.value))}
                      />
                      <span className="font-mono w-10 text-right">
                        {rolloutPercent}%
                      </span>
                    </div>
                  </div>
                )}
              </details>

              <p className="text-xs text-slate-500 pt-2 border-t border-slate-100">
                Publishing creates the build, the release row, and uploads all
                queued assets in order. Asset failures don't roll back the release.
              </p>
            </div>
          )}
        </div>

        {/* Wizard nav buttons */}
        <div className="flex gap-2 justify-between items-center pt-4 mt-3 border-t border-slate-100">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <div className="flex gap-2">
            {step > 1 && (
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setStep((step - 1) as Step)}
                disabled={submitRelease.isPending}
              >
                Back
              </button>
            )}
            {step < 4 && (
              <button
                type="button"
                className="btn-primary"
                disabled={
                  (step === 1 && !step1Valid) ||
                  (step === 2 && !step2Valid)
                }
                onClick={() => setStep((step + 1) as Step)}
              >
                Next
              </button>
            )}
            {step === 4 && (
              <>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={submitRelease.isPending || !step1Valid || !step2Valid}
                  onClick={() => submitRelease.mutate("draft")}
                >
                  {submitRelease.isPending ? "Saving..." : "Save draft"}
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  disabled={submitRelease.isPending || !step1Valid || !step2Valid}
                  onClick={() => submitRelease.mutate("publish")}
                >
                  {submitRelease.isPending ? "Publishing..." : "Publish now"}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <div className="w-32 text-xs text-slate-500">{k}</div>
      <div className="font-mono text-xs">{v}</div>
    </div>
  );
}
