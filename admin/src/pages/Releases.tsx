import { errorMessage } from "../lib/errorMessage";
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
  listDeviceGroups,
  listProductTypes,
  listReleases,
  listReleaseApprovals,
  approveReleaseApproval,
  rejectReleaseApproval,
  publishRelease,
  rollbackRelease,
  updateRelease,
  type Release,
  type ReleaseApproval,
  type ReleaseScope,
  type ProductType,
} from "../lib/api";
import {
  Badge,
  Button,
  Input,
  Label,
  Select,
  SelectTrigger,
  SelectValue,
  SelectIcon,
  SelectList,
  SelectContent,
  SelectItem,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  Checkbox,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
  DialogClose,
  EmptyState,
  EmptyStateTitle,
  EmptyStateDescription,
  Skeleton,
} from "raft-ui";
import type { BadgeProps } from "raft-ui";
import { useToast } from "../components/Toast";
import { useLocale, useText } from "../lib/locale";
import { ConfirmActionDialog } from "../components/ConfirmActionDialog";
import { ReleaseAssetsPanel } from "../components/ReleaseAssetsPanel";
import { ReleaseAssetUploader } from "../components/ReleaseAssetUploader";
import { ChangelogEditor, ChangelogViewer } from "../components/ChangelogMarkdown";
import { createBuildAsset, uploadApk } from "../lib/api";
import type { PendingFile } from "../lib/releaseFileDetect";


const ROLLOUT_PRESETS = [5, 25, 50, 100];

type EditableScopeType = "full" | "platform" | "user_cohort" | "ip_range" | "device_group";
type ScopeInput = { scope_type: string; scope_value: string };

function buildReleaseScopes(
  scopeType: EditableScopeType,
  scopeValue: string,
  alwaysIncludedGroupIds: string[],
): ScopeInput[] {
  if (scopeType !== "full") {
    return [{ scope_type: scopeType, scope_value: scopeValue.trim() }];
  }
  return [
    { scope_type: "full", scope_value: "all" },
    ...[...new Set(alwaysIncludedGroupIds)].sort().map((groupId) => ({
      scope_type: "device_group",
      scope_value: groupId,
    })),
  ];
}

function AlwaysIncludedDeviceGroups({
  groups,
  selectedIds,
  onChange,
}: {
  groups: { id: string; name: string; member_count: number }[];
  selectedIds: string[];
  onChange: (next: string[]) => void;
}) {
  const tx = useText();
  if (groups.length === 0) {
    return <p className="text-xs text-foreground-muted">{tx("No device groups available.", "暂无设备组。")}</p>;
  }
  return (
    <div className="max-h-36 overflow-y-auto rounded-sm border border-line-muted divide-y divide-line-hairline">
      {groups.map((group) => {
        const checked = selectedIds.includes(group.id);
        return (
          <label key={group.id} className="flex items-center gap-2 px-2 py-1.5 text-xs">
            <Checkbox
              checked={checked}
              onCheckedChange={(value) => {
                const next = Boolean(value)
                  ? [...selectedIds, group.id]
                  : selectedIds.filter((id) => id !== group.id);
                onChange([...new Set(next)].sort());
              }}
            />
            <span className="min-w-0 flex-1 truncate">{group.name}</span>
            <span className="font-mono text-foreground-muted">{group.member_count}</span>
          </label>
        );
      })}
    </div>
  );
}

function RolloutPercentInput({
  value,
  onChange,
}: {
  value: number;
  onChange: (next: number) => void;
}) {
  return (
    <span className="flex items-center gap-1">
      <Input
        type="number"
        min={0}
        max={100}
        step={1}
        value={value}
        onChange={(e) => {
          const next = Number(e.target.value);
          if (Number.isFinite(next)) onChange(Math.min(100, Math.max(0, Math.trunc(next))));
        }}
        className="w-16 text-right font-mono text-xs"
      />
      <span className="text-foreground-muted">%</span>
      {ROLLOUT_PRESETS.map((preset) => (
        <Button
          key={preset}
          type="button"
          size="xs"
          variant={value === preset ? "primary" : "outline"}
          aria-pressed={value === preset}
          onClick={() => onChange(preset)}
        >
          {preset}
        </Button>
      ))}
    </span>
  );
}

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
  if (platform === "node") {
    return productType.name === "cli-binary" || productType.parser_kind === "external";
  }
  return productType.name.includes(platform) || productType.parser_kind.includes(platform);
}

export function PendingReleaseApprovals({ appId, gateOn }: { appId: string; gateOn: boolean }) {
  const tx = useText();
  const { locale } = useLocale();
  const qc = useQueryClient();
  const toast = useToast();
  const approvals = useQuery({
    queryKey: ["release-approvals", appId],
    queryFn: () => listReleaseApprovals(appId, "pending"),
  });
  const mutation = useMutation({
    mutationFn: ({ requestId, action }: { requestId: string; action: "approve" | "reject" }) =>
      action === "approve" ? approveReleaseApproval(appId, requestId) : rejectReleaseApproval(appId, requestId),
    onSuccess: (_data, vars) => {
      toast.show({
        kind: "success",
        title: vars.action === "approve" ? tx("Release approved and published", "发布已批准并发布") : tx("Release request rejected", "发布请求已拒绝"),
      });
      qc.invalidateQueries({ queryKey: ["release-approvals", appId] });
      qc.invalidateQueries({ queryKey: ["releases", appId] });
    },
    onError: (e) =>
      toast.show({ kind: "error", title: tx("Action failed", "操作失败"), description: errorMessage(e) }),
  });
  const items = approvals.data?.approvals ?? [];
  // The queue stays reachable even if the gate was switched off after requests
  // were created — pending approvals hang until decided, so they must not vanish
  // from the official entry point (task #239 review item 5).
  if (!gateOn && !approvals.isLoading && items.length === 0) return null;
  return (
    <section className="border-t border-line-hairline pt-5 mb-4">
      <h3 className="text-sm font-medium text-foreground-strong mb-2">{tx("Pending release approvals", "待审核的发布")}</h3>
      {approvals.isLoading ? (
        <Skeleton className="h-10" />
      ) : items.length === 0 ? (
        <div className="text-xs text-foreground-muted">{tx("No releases waiting for approval.", "没有等待审核的发布。")}</div>
      ) : (
        <ul className="space-y-2">
          {items.map((a: ReleaseApproval) => (
            <li
              key={a.id}
              className="rounded-md bg-fill-muted p-2.5 flex items-start justify-between gap-3"
            >
              <div className="text-sm min-w-0">
                <div className="font-medium">
                  {a.version_name ?? "?"}{" "}
                  <span className="text-xs text-foreground-muted">
                    ({tx("code", "版本号")} {a.version_code ?? "?"}) · {a.channel_slug ?? ""}
                  </span>
                </div>
                {a.changelog && (
                  <div className="text-xs text-foreground whitespace-pre-wrap">{a.changelog}</div>
                )}
                {a.assets.length > 0 && (
                  <ul className="text-xs text-foreground mt-1 space-y-0.5">
                    {a.assets.map((asset, i) => (
                      <li key={i} className="font-mono break-all">
                        {asset.artifact_kind} · {asset.platform}
                        {asset.arch ? `/${asset.arch}` : ""}
                        {asset.variant ? `/${asset.variant}` : ""} · {asset.filetype} ·{" "}
                        {asset.size_bytes} B · sha256 {asset.file_hash.slice(0, 16)}…
                      </li>
                    ))}
                  </ul>
                )}
                {(() => {
                  // The conditions the approver is signing off on (task #239 review).
                  // Guard the parsed values are arrays with the expected item
                  // shape — a malformed stored value must not break the card.
                  const parseScopes = (): { scope_type: string; scope_value: string }[] => {
                    try {
                      const v = JSON.parse(a.expected_scopes);
                      return Array.isArray(v)
                        ? v.filter(
                            (s) => s && typeof s.scope_type === "string" && typeof s.scope_value === "string",
                          )
                        : [];
                    } catch {
                      return [];
                    }
                  };
                  const parseTargets = (): string[] => {
                    try {
                      const v = a.required_external_targets ? JSON.parse(a.required_external_targets) : [];
                      return Array.isArray(v) ? v.filter((t) => typeof t === "string") : [];
                    } catch {
                      return [];
                    }
                  };
                  const scopes = parseScopes();
                  const targets = parseTargets();
                  return (
                    <div className="text-xs text-foreground mt-1 flex flex-wrap items-center gap-1">
                      <span className="text-foreground-muted">{tx("Publishes to", "发布范围")}</span>
                      {scopes.length === 0 ? (
                        <span className="font-mono">full:all</span>
                      ) : (
                        scopes.map((s, i) => (
                          <span key={i} className="font-mono rounded-sm bg-layer-inset px-1">
                            {s.scope_type}:{s.scope_value}
                          </span>
                        ))
                      )}
                      {targets.length > 0 && (
                        <>
                          <span className="text-foreground-muted">{tx("· requires targets", "· 必需的目标")}</span>
                          {targets.map((t, i) => (
                            <span key={i} className="font-mono rounded-sm bg-layer-inset px-1">
                              {t}
                            </span>
                          ))}
                        </>
                      )}
                    </div>
                  );
                })()}
                <div className="text-xs text-foreground-muted mt-1">
                  {tx("Requested by", "申请人：")} {a.requested_by_actor} · {new Date(a.created_at).toLocaleString(locale)}
                </div>
              </div>
              <div className="flex gap-2 shrink-0">
                <Button
                  variant="primary"
                  className="text-sm"
                  disabled={mutation.isPending}
                  onClick={() => mutation.mutate({ requestId: a.id, action: "approve" })}
                >
                  {tx("Approve", "批准")}
                </Button>
                <Button
                  className="text-sm"
                  disabled={mutation.isPending}
                  onClick={() => mutation.mutate({ requestId: a.id, action: "reject" })}
                >
                  {tx("Reject", "拒绝")}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function Releases({ appId }: { appId: string }) {
  const tx = useText();
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
      <div className="mb-4 flex items-center justify-between gap-4 flex-wrap">
        <h2 className="text-lg font-semibold">{tx("Releases", "发布")}</h2>
        <Button
          variant="primary"
          className="text-sm"
          onClick={() => setShowNewRelease(true)}
        >
          {tx("+ New release", "+ 新建发布")}
        </Button>
      </div>

      {/* Stats summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <Stat label={tx("Total", "总数")} value={releases.data?.releases.length ?? 0} />
        <Stat
          label={tx("Active", "生效中")}
          value={releases.data?.releases.filter((r) => r.status === "active").length ?? 0}
        />
        <Stat
          label={tx("Draft", "草稿")}
          value={releases.data?.releases.filter((r) => r.status === "draft").length ?? 0}
        />
        <Stat
          label={tx("Channels", "渠道")}
          value={channels.data?.channels.length ?? 0}
        />
      </div>

      {/* Release human-approval queue (task #239). Mounted regardless of the
          current toggle so already-pending requests stay reachable; the
          component hides itself only when the gate is off and nothing is pending. */}
      <PendingReleaseApprovals appId={appId} gateOn={Boolean(thisApp?.release_requires_human_approval)} />

      {/* Filters */}
      <div className="mb-4 flex flex-row flex-wrap gap-3 items-center">
        <Select
          items={{
            all: tx("All channels", "所有渠道"),
            ...Object.fromEntries(
              (channels.data?.channels ?? []).map((c) => [c.slug, c.slug]),
            ),
          }}
          value={channelFilter}
          onValueChange={(v) => setChannelFilter(v as string)}
        >
          <SelectTrigger className="w-40">
            <SelectValue />
            <SelectIcon />
          </SelectTrigger>
          <SelectContent>
            <SelectList>
            <SelectItem value="all">{tx("All channels", "所有渠道")}</SelectItem>
            {channels.data?.channels.map((c) => (
              <SelectItem key={c.id} value={c.slug}>
                {c.slug}
              </SelectItem>
            ))}
          </SelectList>
          </SelectContent>
        </Select>
        <Select
          items={{
            all: tx("All statuses", "所有状态"),
            draft: tx("Draft", "草稿"),
            active: tx("Active", "生效中"),
            superseded: tx("Superseded", "已替代"),
            cancelled: tx("Cancelled", "已取消"),
          }}
          value={statusFilter}
          onValueChange={(v) => setStatusFilter(v as string)}
        >
          <SelectTrigger className="w-40">
            <SelectValue />
            <SelectIcon />
          </SelectTrigger>
          <SelectContent>
            <SelectList>
            <SelectItem value="all">{tx("All statuses", "所有状态")}</SelectItem>
            <SelectItem value="draft">{tx("Draft", "草稿")}</SelectItem>
            <SelectItem value="active">{tx("Active", "生效中")}</SelectItem>
            <SelectItem value="superseded">{tx("Superseded", "已替代")}</SelectItem>
            <SelectItem value="cancelled">{tx("Cancelled", "已取消")}</SelectItem>
          </SelectList>
          </SelectContent>
        </Select>
      </div>

      {releases.isLoading && (
        <div className="space-y-2">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      )}
      {releases.error && (
        <p className="text-danger">{tx("Failed:", "加载失败：")} {errorMessage(releases.error)}</p>
      )}

      {filtered.length === 0 && !releases.isLoading && (
        <EmptyState>
          <EmptyStateTitle>{tx("No releases match your filter.", "没有符合筛选条件的发布。")}</EmptyStateTitle>
          <EmptyStateDescription>
            {tx("Create a new release and upload the required assets from this tab.", "在此页面新建发布并上传所需文件。")}
          </EmptyStateDescription>
        </EmptyState>
      )}

      <div className="space-y-6">
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
    <div>
      <div className="text-xs text-foreground-muted">{label}</div>
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
  const tx = useText();
  const { locale } = useLocale();
  const toast = useToast();
  const [showRollout, setShowRollout] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [newPercent, setNewPercent] = useState<number>(r.rollout_cohort_count ?? 100);

  const detail = useQuery({
    queryKey: ["release-detail", r.id],
    queryFn: () => getRelease(appId, r.id),
  });
  const currentRevision = detail.data?.release.revision ?? r.revision;

  const publish = useMutation({
    mutationFn: () => {
      const scopes = detail.data?.scopes ?? [];
      if (scopes.length === 0) throw new Error(tx("Release has no scope to publish", "发布没有可发布的范围"));
      return publishRelease(
        appId,
        r.id,
        scopes.map((scope) => ({
          scope_type: scope.scope_type,
          scope_value: scope.scope_value,
        })),
        currentRevision,
      );
    },
    onSuccess: () => {
      toast.show({ kind: "success", title: tx(`Published ${channelSlug}`, `已发布到 ${channelSlug}`) });
      onAction();
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: tx("Publish failed", "发布失败"),
        description: errorMessage(e),
      }),
  });

  const rollback = useMutation({
    mutationFn: () => rollbackRelease(appId, r.id, {
      expected_revision: currentRevision,
    }),
    onSuccess: (data) => {
      toast.show({
        kind: "success",
        title: data.restored_to_draft
          ? tx(`Restored ${channelSlug} draft`, `已恢复 ${channelSlug} 的草稿`)
          : tx(`Restored ${channelSlug} as active`, `已恢复 ${channelSlug} 并使其生效`),
      });
      onAction();
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: tx("Rollback failed", "恢复失败"),
        description: errorMessage(e),
      }),
  });

  const bump = useMutation({
    mutationFn: (target: number) => bumpRollout(appId, r.id, {
      to: target,
      expected_revision: currentRevision,
    }),
    onSuccess: (data) => {
      toast.show({
        kind: "success",
        title: tx(`Rollout set to ${data.rollout_cohort_count ?? "?"}%`, `发布比例已设为 ${data.rollout_cohort_count ?? "?"}%`),
      });
      onAction();
      setShowRollout(false);
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: tx("Bump rollout failed", "调整发布比例失败"),
        description: errorMessage(e),
      }),
  });

  const toggleForce = useMutation({
    mutationFn: () => forceUpdate(appId, r.id, {
      enabled: !r.should_force_update,
      expected_revision: currentRevision,
    }),
    onSuccess: (data) => {
      toast.show({
        kind: "success",
        title: data.should_force_update
          ? tx("Now forcing update on clients", "已要求客户端强制更新")
          : tx("No longer forcing update", "已取消强制更新"),
      });
      onAction();
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: tx("Force-update toggle failed", "切换强制更新失败"),
        description: errorMessage(e),
      }),
  });

  const cancel = useMutation({
    mutationFn: () => deleteRelease(appId, r.id, currentRevision),
    onSuccess: () => {
      toast.show({
        kind: "success",
        title: r.status === "draft" ? tx("Draft deleted", "草稿已删除") : tx("Release cancelled", "发布已取消"),
      });
      setConfirmCancel(false);
      onAction();
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: r.status === "draft" ? tx("Delete failed", "删除失败") : tx("Cancel failed", "取消失败"),
        description: errorMessage(e),
      }),
  });

  return (
    <section className="border-t border-line-hairline pt-5">
      <div className="flex items-center gap-3 flex-wrap">
        <ReleaseStatusBadge status={r.status} />
        <span className="font-medium">{channelSlug}</span>
        <span className="text-xs text-foreground-muted">{productTypeName}</span>
        {r.is_full ? (
          <Badge variant="success">{tx("full", "全量")}</Badge>
        ) : (
          <Badge variant="warning">{tx("scoped", "限定范围")}</Badge>
        )}
        {r.should_force_update ? (
          <Badge variant="warning">{tx("⚠ force", "⚠ 强制更新")}</Badge>
        ) : null}
        {r.rollout_cohort_count != null && r.rollout_cohort_count < 100 && (
          <Badge variant="warning">
            {r.rollout_cohort_count}% {tx("rollout", "发布比例")}
          </Badge>
        )}
        <span className="text-xs text-foreground-muted ml-auto">
          {new Date(r.created_at).toISOString().slice(0, 16)}Z
        </span>
      </div>
      <div className="text-xs text-foreground-muted font-mono mt-1 truncate">
        {r.id} ({tx("build", "构建")} {r.build_id.slice(0, 8)}…)
      </div>
      {(r.offered_count || r.current_count || r.offered_uv || r.current_uv) ? (
        <div className="mt-1 flex items-center gap-3 text-xs text-foreground-muted">
          <Tooltip>
            <TooltipTrigger
              render={
                <span>
                  <strong className="text-foreground-strong">{r.current_uv ?? 0}</strong> {tx("on this version", "使用此版本")}
                </span>
              }
            />
            <TooltipContent>
              {r.current_count ?? 0} {tx("update checks (PV)", "次更新检查（PV）")}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <span>
                  <strong className="text-foreground-strong">{r.offered_uv ?? 0}</strong> {tx("offered", "已收到更新提示")}
                </span>
              }
            />
            <TooltipContent>
              {r.offered_count ?? 0} {tx("update offers (PV)", "次更新提示（PV）")}
            </TooltipContent>
          </Tooltip>
          {r.last_checked_at ? (
            <span className="text-foreground-hint">
              {tx("last check", "最近检查")} {new Date(r.last_checked_at).toLocaleString(locale)}
            </span>
          ) : null}
        </div>
      ) : null}
      {r.changelog && (
        <div className="mt-3 border-l-2 border-line-hairline pl-3">
          <ChangelogViewer value={r.changelog} compact />
        </div>
      )}
      <div className="flex flex-wrap gap-2 mt-2">
        {r.status === "draft" && (
          <Button
            variant="primary"
            className="text-xs"
            onClick={() => publish.mutate()}
            disabled={publish.isPending || !detail.data}
          >
            {publish.isPending ? tx("Publishing...", "发布中…") : !detail.data ? tx("Loading scope...", "加载范围中…") : tx("Publish", "发布")}
          </Button>
        )}
        {(r.status === "draft" || r.status === "active") && (
          <Button
            variant="outline"
            className="text-xs"
            onClick={() => setShowEdit(true)}
          >
            {tx("Edit", "编辑")}
          </Button>
        )}
        {r.status === "active" && (
          <>
            {Boolean(r.is_full) && (
              <Button
                variant="outline"
                className="text-xs"
                onClick={() => setShowRollout(!showRollout)}
              >
                {tx("Bump rollout", "调整发布比例")}
              </Button>
            )}
            <Button
              variant="outline"
              className="text-xs"
              onClick={() => toggleForce.mutate()}
              disabled={toggleForce.isPending}
            >
              {r.should_force_update ? tx("Unforce", "取消强制") : tx("Force", "强制更新")}
            </Button>
          </>
        )}
        {(r.status === "superseded" || r.status === "cancelled") && (
          <Button
            variant="outline"
            className="text-xs"
            onClick={() => rollback.mutate()}
            disabled={rollback.isPending}
          >
            {r.status === "cancelled" && r.activated_at == null
              ? tx("Restore draft", "恢复草稿")
              : tx("Restore as active", "恢复并生效")}
          </Button>
        )}
        {(r.status === "draft" || r.status === "active") && (
          <Button
            variant="danger"
            className="text-xs"
            onClick={() => setConfirmCancel(true)}
          >
            {r.status === "draft" ? tx("Delete draft", "删除草稿") : tx("Cancel release", "取消发布")}
          </Button>
        )}
      </div>
      {showRollout && (
        <div className="mt-2 pt-2 border-t border-line-hairline flex items-center gap-2 text-xs">
          <label>{tx("Rollout %:", "发布比例：")}</label>
          <RolloutPercentInput value={newPercent} onChange={setNewPercent} />
          <Button
            variant="primary"
            className="text-xs"
            onClick={() => bump.mutate(newPercent)}
            disabled={bump.isPending}
          >
            {bump.isPending ? "…" : tx("Set", "设置")}
          </Button>
        </div>
      )}
      {detail.isLoading && (
        <div className="mt-2 pt-2 border-t border-line-hairline text-xs text-foreground-muted">
          {tx("Loading release details...", "正在加载发布详情…")}
        </div>
      )}
      {detail.data && (
        <div className="mt-2 pt-2 border-t border-line-hairline text-xs">
          <div className="text-foreground-muted mb-1">{tx("Build:", "构建：")} {detail.data.build?.version_name} ({detail.data.build?.version_code})</div>
          <div className="text-foreground-muted mb-1">
            {tx("Assets:", "文件：")} {detail.data.assets.length} · {tx("Scopes:", "范围：")} {detail.data.scopes.length}
          </div>
          {detail.data.scopes.length > 0 && (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-foreground-muted text-left">
                  <th className="font-normal pr-2">{tx("type", "类型")}</th>
                  <th className="font-normal pr-2">{tx("value", "值")}</th>
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
          {(detail.data.checks ?? []).length > 0 && (
            <div className="mt-2">
              <div className="text-foreground-muted mb-1">{tx("Checks (advisory)", "检查（仅供参考）")}</div>
              {detail.data.checks.map((chk) => (
                <div key={chk.id} className="flex items-center gap-2 mb-0.5">
                  <span
                    className={
                      chk.verdict === "passed"
                        ? "text-success-strong font-medium"
                        : chk.verdict === "failed"
                          ? "text-danger font-medium"
                          : "text-warning font-medium"
                    }
                  >
                    {({ passed: tx("passed", "通过"), failed: tx("failed", "失败"), pending: tx("pending", "待处理") } as Record<string, string>)[chk.verdict] ?? chk.verdict}
                  </span>
                  <span className="font-mono">{chk.source}</span>
                  {chk.cases_total !== null && (
                    <span className="text-foreground-muted">
                      {chk.cases_passed ?? 0}/{chk.cases_total} {tx("cases", "个用例")}
                    </span>
                  )}
                  {chk.run_url && (
                    <a
                      href={chk.run_url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-info-strong hover:underline"
                    >
                      {tx("run", "查看运行记录")}
                    </a>
                  )}
                  {chk.summary && (
                    <span className="text-foreground-muted truncate" title={chk.summary}>
                      {chk.summary}
                    </span>
                  )}
                </div>
              ))}
            </div>
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
        title={r.status === "draft" ? tx("Delete this draft?", "删除此草稿？") : tx("Cancel this release?", "取消此发布？")}
        objectLabel={`${channelSlug} / ${r.product_type}`}
        objectHint={r.id.slice(0, 8)}
        body={
          r.status === "draft"
            ? tx("The draft will be disabled. Its build, assets, and audit history stay available, while this version becomes available for a corrected upload. No live release is affected.", "草稿将停用。其构建、文件和审计记录仍可查看；此版本可用于重新上传修正后的文件。线上发布不会受影响。")
            : tx("This release will stop being served by update checks. Its build, assets, and audit history stay available. Although the version becomes available for historical correction, devices that already received this release will not update to different bits with the same version code; publish any client update with a higher version code.", "更新检查将不再返回此发布。其构建、文件和审计记录仍可查看。虽然此版本可用于修正历史记录，但已经收到该发布的设备不会更新到相同版本号下的不同文件；请使用更高的版本号发布客户端更新。")
        }
        confirmLabel={r.status === "draft" ? tx("Delete draft", "删除草稿") : tx("Cancel release", "取消发布")}
        confirmKind="danger"
        pending={cancel.isPending}
        onCancel={() => setConfirmCancel(false)}
        onConfirm={() => cancel.mutate()}
      />
    </section>
  );
}

type BadgeVariant = NonNullable<BadgeProps["variant"]>;

function ReleaseStatusBadge({ status }: { status: string }) {
  const tx = useText();
  const labels: Record<string, string> = { draft: tx("draft", "草稿"), active: tx("active", "生效中"), superseded: tx("superseded", "已替代"), cancelled: tx("cancelled", "已取消") };
  const variantMap: Record<string, BadgeVariant> = {
    draft: "information",
    active: "success",
    superseded: "muted",
    cancelled: "danger",
  };
  return <Badge variant={variantMap[status] ?? "muted"}>{labels[status] ?? status}</Badge>;
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
  const tx = useText();
  const toast = useToast();
  const [changelog, setChangelog] = useState(release.changelog ?? "");
  const deviceGroups = useQuery({
    queryKey: ["device-groups", appId],
    queryFn: () => listDeviceGroups(appId),
  });
  const [scopeType, setScopeType] = useState<EditableScopeType>("full");
  const [scopeValue, setScopeValue] = useState("all");
  const [alwaysIncludedGroupIds, setAlwaysIncludedGroupIds] = useState<string[]>([]);
  const [shouldForceUpdate, setShouldForceUpdate] = useState(Boolean(release.should_force_update));
  const [rolloutPercent, setRolloutPercent] = useState<number>(release.rollout_cohort_count ?? 100);

  useEffect(() => {
    if (!detail) return;
    const fullScope = detail.scopes.find((scope) => scope.scope_type === "full" && scope.scope_value === "all");
    const firstScope = detail.scopes[0];
    setChangelog(detail.release.changelog ?? "");
    setShouldForceUpdate(Boolean(detail.release.should_force_update));
    setRolloutPercent(detail.release.rollout_cohort_count ?? 100);
    if (fullScope) {
      setScopeType("full");
      setScopeValue("all");
      setAlwaysIncludedGroupIds(
        detail.scopes
          .filter((scope) => scope.scope_type === "device_group")
          .map((scope) => scope.scope_value)
          .sort(),
      );
    } else if (
      firstScope &&
      (firstScope.scope_type === "full" ||
        firstScope.scope_type === "platform" ||
        firstScope.scope_type === "user_cohort" ||
        firstScope.scope_type === "ip_range" ||
        firstScope.scope_type === "device_group")
    ) {
      setScopeType(firstScope.scope_type);
      setScopeValue(firstScope.scope_value);
      setAlwaysIncludedGroupIds([]);
    }
  }, [detail]);

  const save = useMutation({
    mutationFn: () =>
      updateRelease(appId, release.id, {
        expected_revision: detail?.release.revision ?? release.revision,
        changelog: changelog.trim() || null,
        should_force_update: shouldForceUpdate,
        rollout_cohort_count:
          scopeType === "full" && rolloutPercent < 100 ? rolloutPercent : null,
        scopes: buildReleaseScopes(scopeType, scopeValue, alwaysIncludedGroupIds),
      }),
    onSuccess: () => {
      toast.show({ kind: "success", title: tx("Release updated", "发布已更新") });
      onSaved();
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: tx("Update failed", "更新失败"),
        description: errorMessage(e),
      }),
  });

  const scopeValid = scopeType === "full" || scopeValue.trim().length > 0;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-3xl">
        <DialogHeader>
          <div>
            <DialogTitle>{tx("Edit release", "编辑发布")}</DialogTitle>
            <DialogDescription className="font-mono">{release.id}</DialogDescription>
          </div>
          <DialogClose />
        </DialogHeader>
        <DialogBody>
          {loading && <p className="text-sm text-foreground-muted">{tx("Loading release details...", "正在加载发布详情…")}</p>}
          <div className="space-y-3">
          <div>
            <Label>{tx("Release notes", "发布说明")}</Label>
            <ChangelogEditor value={changelog} onChange={setChangelog} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>{tx("Scope type", "范围类型")}</Label>
              <Select
                items={{
                  full: tx("Full", "全量"),
                  platform: tx("Platform", "平台"),
                  user_cohort: tx("User cohort", "用户分组"),
                  ip_range: tx("IP range", "IP 范围"),
                  device_group: tx("Device group", "设备组"),
                }}
                value={scopeType}
                onValueChange={(v) => {
                  const next = v as typeof scopeType;
                  setScopeType(next);
                  setScopeValue(next === "full" ? "all" : "");
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                  <SelectIcon />
                </SelectTrigger>
                <SelectContent>
                  <SelectList>
                  <SelectItem value="full">{tx("Full", "全量")}</SelectItem>
                  <SelectItem value="platform">{tx("Platform", "平台")}</SelectItem>
                  <SelectItem value="user_cohort">{tx("User cohort", "用户分组")}</SelectItem>
                  <SelectItem value="ip_range">{tx("IP range", "IP 范围")}</SelectItem>
                  <SelectItem value="device_group">{tx("Device group", "设备组")}</SelectItem>
                </SelectList>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>{tx("Scope value", "范围值")}</Label>
              {scopeType === "device_group" ? (
                <Select
                  items={Object.fromEntries((deviceGroups.data?.groups ?? []).map((group) => [group.id, group.name]))}
                  value={scopeValue}
                  onValueChange={(value) => setScopeValue(value as string)}
                >
                  <SelectTrigger><SelectValue placeholder={tx("Choose group", "选择设备组")} /><SelectIcon /></SelectTrigger>
                  <SelectContent>
                    <SelectList>
                    {(deviceGroups.data?.groups ?? []).map((group) => (
                      <SelectItem key={group.id} value={group.id}>{group.name} ({group.member_count})</SelectItem>
                    ))}
                  </SelectList>
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  value={scopeValue}
                  disabled={scopeType === "full"}
                  onChange={(e) => setScopeValue(e.target.value)}
                  placeholder={scopeType === "full" ? "all" : "android-arm64-v8a"}
                />
              )}
            </div>
          </div>
          {scopeType === "full" && (
            <div>
              <Label>{tx("Always included device groups", "始终包含的设备组")}</Label>
              <AlwaysIncludedDeviceGroups
                groups={deviceGroups.data?.groups ?? []}
                selectedIds={alwaysIncludedGroupIds}
                onChange={setAlwaysIncludedGroupIds}
              />
            </div>
          )}
          <label className="flex items-center gap-2 text-xs">
            <Checkbox
              checked={shouldForceUpdate}
              onCheckedChange={(v) => setShouldForceUpdate(Boolean(v))}
            />
            {tx("Force update", "强制更新")}
          </label>
          {scopeType === "full" && (
            <div className="flex items-center gap-2 text-xs">
              <label className="flex-1">{tx("Rollout cohort %", "发布比例")}</label>
              <RolloutPercentInput value={rolloutPercent} onChange={setRolloutPercent} />
            </div>
          )}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>
            {tx("Cancel", "取消")}
          </Button>
          <Button
            variant="primary"
            onClick={() => save.mutate()}
            disabled={save.isPending || loading || !scopeValid}
          >
            {save.isPending ? tx("Saving...", "保存中…") : tx("Save changes", "保存更改")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  const tx = useText();
  const toast = useToast();
  const channels = useQuery({
    queryKey: ["channels", appId],
    queryFn: () => listChannels(appId),
  });
  const productTypes = useQuery({
    queryKey: ["product-types", appId],
    queryFn: () => listProductTypes(appId),
  });
  const deviceGroups = useQuery({
    queryKey: ["device-groups", appId],
    queryFn: () => listDeviceGroups(appId),
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
  const STEP_LABELS = [tx("Target", "目标"), tx("Version", "版本"), tx("Assets", "文件"), tx("Review", "确认")] as const;
  const [step, setStep] = useState<Step>(1);

  const [channelSlug, setChannelSlug] = useState<string>("");
  const [productType, setProductType] = useState<string>("");
  const [versionName, setVersionName] = useState<string>("");
  const [versionCode, setVersionCode] = useState<string>("");
  const [changelog, setChangelog] = useState<string>("");
  const [scopeType, setScopeType] = useState<EditableScopeType>("full");
  const [scopeValue, setScopeValue] = useState<string>("all");
  const [alwaysIncludedGroupIds, setAlwaysIncludedGroupIds] = useState<string[]>([]);
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
      if (!step1Valid) throw new Error(tx("Target incomplete", "发布目标信息不完整"));
      if (!step2Valid) throw new Error(tx("Version incomplete", "版本信息不完整"));
      const channel = channels.data?.channels.find(
        (c) => c.slug === channelSlug,
      );
      if (!channel) throw new Error(tx(`channel '${channelSlug}' not found`, `找不到渠道“${channelSlug}”`));

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
      const scopes = buildReleaseScopes(scopeType, scopeValue, alwaysIncludedGroupIds);
      const release = await createRelease(appId, {
        build_id: build.id,
        status: "draft",
        scopes,
        should_force_update: shouldForceUpdate || undefined,
        rollout_cohort_count:
          scopeType === "full" && rolloutPercent < 100 ? rolloutPercent : undefined,
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
          assetFailures.push(`${slot.file.name}: ${errorMessage(e)}`);
        }
      }
      if (mode === "publish") {
        const published = await publishRelease(
          appId,
          release.id,
          scopes,
          release.revision,
        );
        return { release: published, assetFailures, mode };
      }
      return { release, assetFailures, mode };
    },
    onSuccess: ({ release, assetFailures, mode }) => {
      const action = mode === "publish" ? tx("published", "已发布") : tx("saved as draft", "已保存为草稿");
      if (assetFailures.length === 0) {
        toast.show({
          kind: "success",
          title: tx(`Release ${release.id.slice(0, 8)}… ${action}`, `发布 ${release.id.slice(0, 8)}… ${action}`),
          description: tx(`${pendingFiles.length} asset${pendingFiles.length === 1 ? "" : "s"} attached.`, `已添加 ${pendingFiles.length} 个文件。`),
        });
      } else {
        toast.show({
          kind: "error",
          title: tx(`Release ${release.id.slice(0, 8)}… ${action} but ${assetFailures.length} asset(s) failed`, `发布 ${release.id.slice(0, 8)}… ${action}，但 ${assetFailures.length} 个文件上传失败`),
          description: tx(`${assetFailures[0]?.slice(0, 80)}… — fix from the release row.`, `${assetFailures[0]?.slice(0, 80)}… — 请在发布列表中修复。`),
        });
      }
      onCreated();
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: tx("Release save failed", "保存发布失败"),
        description: errorMessage(e),
      }),
  });

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <div>
            <DialogTitle>{tx("Draft a new release", "创建发布草稿")}</DialogTitle>
            <DialogDescription>
              {tx("Draft the release, attach binaries, then publish — all in one flow.", "创建发布草稿、添加二进制文件并发布，所有步骤在此完成。")}
            </DialogDescription>
          </div>
          <DialogClose />
        </DialogHeader>
        <DialogBody>
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
                      ? "bg-info text-foreground-inverse"
                      : done
                        ? "bg-success text-success-foreground"
                        : "bg-layer-inset text-foreground-muted"
                  }`}
                >
                  {done ? "✓" : idx}
                </div>
                <span
                  className={
                    active
                      ? "font-medium text-foreground-strong"
                      : done
                        ? "text-success-strong"
                        : "text-foreground-muted"
                  }
                >
                  {label}
                </span>
                {i < STEP_LABELS.length - 1 && (
                  <span className="text-foreground-hint mx-1">›</span>
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
                  <Label>{tx("Channel", "渠道")}</Label>
                  <Select
                    items={{
                      "": tx("— pick —", "— 请选择 —"),
                      ...Object.fromEntries(
                        (channels.data?.channels ?? []).map((c) => [
                          c.slug,
                          c.slug,
                        ]),
                      ),
                    }}
                    value={channelSlug}
                    onValueChange={(v) => setChannelSlug(v as string)}
                  >
                    <SelectTrigger autoFocus>
                      <SelectValue />
                      <SelectIcon />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectList>
                      <SelectItem value="">{tx("— pick —", "— 请选择 —")}</SelectItem>
                      {channels.data?.channels.map((c) => (
                        <SelectItem key={c.id} value={c.slug}>
                          {c.slug}
                        </SelectItem>
                      ))}
                    </SelectList>
                    </SelectContent>
                  </Select>
                </div>
                {showProductTypePicker && (
                  <div>
                    <Label>{tx("Package type", "软件包类型")}</Label>
                    <Select
                      items={{
                        "": tx("— pick —", "— 请选择 —"),
                        ...Object.fromEntries(
                          targetProductTypes.map((p) => [
                            p.name,
                            p.display_name,
                          ]),
                        ),
                      }}
                      value={productType}
                      onValueChange={(v) => setProductType(v as string)}
                    >
                      <SelectTrigger>
                        <SelectValue />
                        <SelectIcon />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectList>
                        <SelectItem value="">{tx("— pick —", "— 请选择 —")}</SelectItem>
                        {targetProductTypes.map((p) => (
                          <SelectItem key={p.name} value={p.name}>
                            {p.display_name}
                          </SelectItem>
                        ))}
                      </SelectList>
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>
              {!showProductTypePicker && selectedProductType && (
                <p className="text-xs text-foreground-muted">
                  {tx("Package type is set by this app:", "软件包类型由此应用设定：")}{" "}
                  <span className="font-medium">{selectedProductType.display_name}</span>.
                </p>
              )}
              {(!channels.data || channels.data.channels.length === 0) && (
                <p className="text-xs text-warning-strong">
                  {tx("⚠ This app has no channels yet. Create one in AppDetail → Channels first.", "⚠ 此应用尚无渠道。请先在应用详情 → 渠道中创建。")}
                </p>
              )}
            </div>
          )}

          {/* ---------------- Step 2: Version + notes ---------------- */}
          {step === 2 && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>{tx("Version name (e.g. 1.2.3)", "版本名称（例如 1.2.3）")}</Label>
                  <Input
                    value={versionName}
                    onChange={(e) => setVersionName(e.target.value)}
                    placeholder="1.2.3"
                    autoFocus
                  />
                </div>
                <div>
                  <Label>{tx("Version code (integer)", "版本号（整数）")}</Label>
                  <Input
                    type="number"
                    value={versionCode}
                    onChange={(e) => setVersionCode(e.target.value)}
                    placeholder="42"
                  />
                </div>
              </div>
              <div>
                <Label>{tx("Release notes", "发布说明")}</Label>
                <ChangelogEditor
                  value={changelog}
                  onChange={setChangelog}
                  minHeight={220}
                />
              </div>
            </div>
          )}

          {/* ---------------- Step 3: Assets ---------------- */}
          {step === 3 && (
            <div className="space-y-2">
              <p className="text-xs text-foreground-muted">
                {tx("Drop one or more binaries. We auto-detect platform / arch / filetype from the filename and keep optional fields blank when they are not needed.", "拖入一个或多个二进制文件。系统会根据文件名自动识别平台、架构和文件类型；不需要的可选字段留空。")}
                <br />
                {tx("Optional: you can publish without binaries and attach them later from the release row.", "可选：也可以先发布，之后在发布列表中添加二进制文件。")}
              </p>
              <ReleaseAssetUploader
                variant="dialog"
                deferUpload
                appId={appId}
                buildId="__pending__"
                productTypeHint={productType || "android-apk"}
                onFilesChanged={setPendingFiles}
              />
              <p className="text-[10px] text-foreground-hint">
                {tx("Files are uploaded after the draft is created and before it is published. The draft is preserved even if individual files fail.", "创建草稿后、发布前上传文件。即使个别文件上传失败，草稿仍会保留。")}
              </p>
            </div>
          )}

          {/* ---------------- Step 4: Review ---------------- */}
          {step === 4 && (
            <div className="space-y-3 text-sm">
              <div className="border border-line-muted rounded-sm p-3 space-y-1">
                <Row k={tx("Channel", "渠道")} v={channelSlug || "—"} />
                <Row k={tx("Product type", "产品类型")} v={productType || "—"} />
                <Row k={tx("Version", "版本")} v={`${versionName || "—"} (${versionCode || "?"})`} />
                <Row
                  k={tx("Scope", "范围")}
                  v={
                    scopeType === "full"
                      ? `${tx("full", "全量")} (${rolloutPercent}%)${alwaysIncludedGroupIds.length > 0
                        ? `; ${tx("always", "始终包含")} ${alwaysIncludedGroupIds.map((groupId) =>
                          deviceGroups.data?.groups.find((group) => group.id === groupId)?.name ?? groupId
                        ).join(", ")}`
                        : ""}`
                      : `${({ platform: tx("Platform", "平台"), user_cohort: tx("User cohort", "用户分组"), ip_range: tx("IP range", "IP 范围"), device_group: tx("Device group", "设备组"), full: tx("Full", "全量") })[scopeType]}: ${scopeValue || "?"}`
                  }
                />
                <Row k={tx("Assets", "文件")} v={tx(`${pendingFiles.length} file(s) queued`, `已选择 ${pendingFiles.length} 个文件`)} />
                {changelog && (
                  <details className="pt-2 border-t border-line-hairline">
                    <summary className="cursor-pointer text-xs text-foreground-muted">
                      {tx("Release notes", "发布说明")}
                    </summary>
                    <div className="mt-2 rounded-md bg-layer-canvas-muted p-3">
                      <ChangelogViewer value={changelog} />
                    </div>
                  </details>
                )}
              </div>

              <details>
                <summary
                  className="cursor-pointer text-xs text-foreground"
                  onClick={(e) => {
                    e.preventDefault();
                    setShowAdvanced((v) => !v);
                  }}
                >
                  {showAdvanced ? "▾" : "▸"} {tx("Advanced options (scope, force update, rollout %)", "高级选项（范围、强制更新、发布比例）")}
                </summary>
                {showAdvanced && (
                  <div className="mt-2 p-3 border border-line-muted rounded-sm space-y-2">
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <Label>{tx("Release scope", "发布范围")}</Label>
                        <Select
                          items={{ full: tx("Full", "全量"), platform: tx("Platform", "平台"), user_cohort: tx("User cohort", "用户分组"), ip_range: tx("IP range", "IP 范围"), device_group: tx("Device group", "设备组") }}
                          value={scopeType}
                          onValueChange={(value) => {
                            const next = value as typeof scopeType;
                            setScopeType(next);
                            setScopeValue(next === "full" ? "all" : "");
                          }}
                        >
                          <SelectTrigger><SelectValue /><SelectIcon /></SelectTrigger>
                          <SelectContent>
                            <SelectList>
                            <SelectItem value="full">{tx("Full", "全量")}</SelectItem>
                            <SelectItem value="platform">{tx("Platform", "平台")}</SelectItem>
                            <SelectItem value="user_cohort">{tx("User cohort", "用户分组")}</SelectItem>
                            <SelectItem value="ip_range">{tx("IP range", "IP 范围")}</SelectItem>
                            <SelectItem value="device_group">{tx("Device group", "设备组")}</SelectItem>
                          </SelectList>
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <Label>{tx("Scope value", "范围值")}</Label>
                        {scopeType === "device_group" ? (
                          <Select
                            items={Object.fromEntries((deviceGroups.data?.groups ?? []).map((group) => [group.id, group.name]))}
                            value={scopeValue}
                            onValueChange={(value) => setScopeValue(value as string)}
                          >
                            <SelectTrigger><SelectValue placeholder={tx("Choose group", "选择设备组")} /><SelectIcon /></SelectTrigger>
                            <SelectContent>
                              <SelectList>
                              {(deviceGroups.data?.groups ?? []).map((group) => (
                                <SelectItem key={group.id} value={group.id}>{group.name} ({group.member_count})</SelectItem>
                              ))}
                            </SelectList>
                            </SelectContent>
                          </Select>
                        ) : (
                          <Input
                            value={scopeValue}
                            disabled={scopeType === "full"}
                            onChange={(event) => setScopeValue(event.target.value)}
                            placeholder={scopeType === "full" ? "all" : "android-arm64-v8a"}
                          />
                        )}
                      </div>
                    </div>
                    {scopeType === "full" && (
                      <div>
                        <Label>{tx("Always included device groups", "始终包含的设备组")}</Label>
                        <AlwaysIncludedDeviceGroups
                          groups={deviceGroups.data?.groups ?? []}
                          selectedIds={alwaysIncludedGroupIds}
                          onChange={setAlwaysIncludedGroupIds}
                        />
                      </div>
                    )}
                    <label className="flex items-center gap-2 text-xs">
                      <Checkbox
                        checked={shouldForceUpdate}
                        onCheckedChange={(v) => setShouldForceUpdate(Boolean(v))}
                      />
                      {tx("Force update — clients must upgrade on next launch", "强制更新：客户端下次启动时必须升级")}
                    </label>
                    {scopeType === "full" && (
                      <div className="flex items-center gap-2 text-xs">
                        <label className="flex-1">{tx("Rollout cohort %", "发布比例")}</label>
                        <RolloutPercentInput
                          value={rolloutPercent}
                          onChange={setRolloutPercent}
                        />
                      </div>
                    )}
                  </div>
                )}
              </details>

              <p className="text-xs text-foreground-muted pt-2 border-t border-line-hairline">
                {tx("Publishing creates the build and draft release, uploads queued assets, then publishes. Asset failures don't roll back the release.", "发布时会创建构建和发布草稿，上传已选择的文件，然后发布。文件上传失败不会撤销发布记录。")}
              </p>
            </div>
          )}
        </div>

        </DialogBody>
        {/* Wizard nav buttons */}
        <DialogFooter className="justify-between">
          <Button type="button" variant="outline" onClick={onClose}>
            {tx("Cancel", "取消")}
          </Button>
          <div className="flex gap-2">
            {step > 1 && (
              <Button
                type="button"
                variant="outline"
                onClick={() => setStep((step - 1) as Step)}
                disabled={submitRelease.isPending}
              >
                {tx("Back", "上一步")}
              </Button>
            )}
            {step < 4 && (
              <Button
                type="button"
                variant="primary"
                disabled={
                  (step === 1 && !step1Valid) ||
                  (step === 2 && !step2Valid)
                }
                onClick={() => setStep((step + 1) as Step)}
              >
                {tx("Next", "下一步")}
              </Button>
            )}
            {step === 4 && (
              <>
                <Button
                  type="button"
                  variant="outline"
                  disabled={submitRelease.isPending || !step1Valid || !step2Valid}
                  onClick={() => submitRelease.mutate("draft")}
                >
                  {submitRelease.isPending ? tx("Saving...", "保存中…") : tx("Save draft", "保存草稿")}
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  disabled={submitRelease.isPending || !step1Valid || !step2Valid}
                  onClick={() => submitRelease.mutate("publish")}
                >
                  {submitRelease.isPending ? tx("Publishing...", "发布中…") : tx("Publish now", "立即发布")}
                </Button>
              </>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <div className="w-32 text-xs text-foreground-muted">{k}</div>
      <div className="font-mono text-xs">{v}</div>
    </div>
  );
}
