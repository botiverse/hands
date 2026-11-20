import { errorMessage } from "../lib/errorMessage";
/**
 * Releases — a page of a list: the releases of every channel and product
 * type, newest first, filtered by channel and state, with New release in the
 * toolbar. Releases waiting for a person's approval sit above the list.
 *
 * Opening a release shows it beside the list: Publish, Edit, Change rollout
 * and Restore, who receives it (scopes, rollout share, force update), how many
 * devices took it, its checks, release notes and assets, and Cancel release /
 * Delete draft at the end.
 */

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Ban, Plus, Rocket, ShieldCheck } from "lucide-react";
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
  Banner,
  BannerAction,
  BannerDescription,
  BannerTitle,
  Button,
  Checkbox,
  CopyableCode,
  CopyableCodeAction,
  CopyableCodeRoot,
  DescriptionDetails,
  DescriptionItem,
  DescriptionList,
  DescriptionTerm,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  EmptyStateContent,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  ListRow,
  ListRowBody,
  ListRowBottom,
  ListRowDescription,
  ListRowGroup,
  ListRowIcon,
  ListRowMeta,
  ListRowSubtitle,
  ListRowTitle,
  ListRowTop,
  Progress,
  ProgressHeader,
  ProgressIndicator,
  ProgressLabel,
  ProgressTrack,
  ProgressValue,
  ScrollArea,
  Select,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectList,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Step,
  Steps,
  Switch,
  Text,
  TextLink,
  TextLinkExternalIcon,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@botiverse/raft-ui";
import { ListRowSkeleton } from "@botiverse/raft-ui/wip";
import { useToast } from "../components/Toast";
import { useLocale, useText } from "../lib/locale";
import { ConfirmActionDialog } from "../components/ConfirmActionDialog";
import { ReleaseAssetsPanel } from "../components/ReleaseAssetsPanel";
import { ReleaseAssetUploader } from "../components/ReleaseAssetUploader";
import { ChangelogEditor, ChangelogViewer } from "../components/ChangelogMarkdown";
import { DetailColumn, DetailSection, ListHeading, ListPage } from "../components/ListPage";
import { ReleaseStatusBadge, releaseStatusLabel } from "../components/ReleaseBadges";
import { createBuildAsset, uploadApk } from "../lib/api";
import type { PendingFile } from "../lib/releaseFileDetect";
import { timeAgo } from "./Operations";

type T = ReturnType<typeof useText>;

const ROLLOUT_PRESETS = [5, 25, 50, 100];
const STATUSES = ["draft", "active", "superseded", "cancelled"] as const;

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

function scopeTypeLabels(tx: T): Record<EditableScopeType, string> {
  return {
    full: tx("Everyone", "全部用户"),
    platform: tx("Platform", "平台"),
    user_cohort: tx("User cohort", "用户分组"),
    ip_range: tx("IP range", "IP 范围"),
    device_group: tx("Device group", "设备组"),
  };
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
    return <Text.Sans size="small" variant="muted">{tx("No device groups available.", "暂无设备组。")}</Text.Sans>;
  }
  return (
    <ScrollArea className="max-h-40 rounded-container border border-line-hairline" contentClassName="flex flex-col divide-y divide-line-hairline">
      {groups.map((group) => {
        const checked = selectedIds.includes(group.id);
        return (
          <label key={group.id} className="flex items-center gap-2 px-3 py-2 text-footnote">
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
            <span className="font-mono text-foreground-hint">{group.member_count}</span>
          </label>
        );
      })}
    </ScrollArea>
  );
}

function RolloutPercentInput({
  id,
  value,
  onChange,
}: {
  id?: string;
  value: number;
  onChange: (next: number) => void;
}) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="flex items-center gap-1">
        <Input
          id={id}
          type="number"
          min={0}
          max={100}
          step={1}
          value={value}
          onChange={(e) => {
            const next = Number(e.target.value);
            if (Number.isFinite(next)) onChange(Math.min(100, Math.max(0, Math.trunc(next))));
          }}
          className="w-20 text-right font-mono"
        />
        <span className="text-foreground-muted">%</span>
      </span>
      <span className="flex gap-1">
        {ROLLOUT_PRESETS.map((preset) => (
          <Button
            key={preset}
            type="button"
            size="md"
            variant={value === preset ? "default" : "ghost"}
            aria-pressed={value === preset}
            className="font-mono"
            onClick={() => onChange(preset)}
          >
            {preset}
          </Button>
        ))}
      </span>
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

/** A scope as one mono chip: `type:value`. */
function ScopeChip({ children }: { children: ReactNode }) {
  return <Badge appearance="outline" className="font-mono">{children}</Badge>;
}

function parseApprovalScopes(a: ReleaseApproval): { scope_type: string; scope_value: string }[] {
  // Guard the parsed values are arrays with the expected item shape — a
  // malformed stored value must not break the row.
  try {
    const v = JSON.parse(a.expected_scopes);
    return Array.isArray(v)
      ? v.filter((s) => s && typeof s.scope_type === "string" && typeof s.scope_value === "string")
      : [];
  } catch {
    return [];
  }
}

function parseApprovalTargets(a: ReleaseApproval): string[] {
  try {
    const v = a.required_external_targets ? JSON.parse(a.required_external_targets) : [];
    return Array.isArray(v) ? v.filter((t) => typeof t === "string") : [];
  } catch {
    return [];
  }
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
    <section aria-labelledby="release-approvals" className="flex flex-col gap-2">
      <ListHeading
        id="release-approvals"
        icon={<ShieldCheck />}
        title={tx("Pending release approvals", "待审核的发布")}
        hint={items.length > 0 ? items.length : undefined}
      />
      <div className="px-(--column-margin)">
        {approvals.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : items.length === 0 ? (
          <Text.Sans size="small" variant="muted">{tx("No releases waiting for approval.", "没有等待审核的发布。")}</Text.Sans>
        ) : (
          <ListRowGroup>
            {items.map((a: ReleaseApproval) => {
              const scopes = parseApprovalScopes(a);
              const targets = parseApprovalTargets(a);
              return (
                <ListRow key={a.id} variant="plain" interactive={false}>
                  <ListRowBody className="flex flex-col gap-2">
                    <div>
                      <ListRowTop>
                        <ListRowTitle>{a.version_name ?? "?"}</ListRowTitle>
                        <ListRowMeta>{timeAgo(a.created_at, locale)}</ListRowMeta>
                      </ListRowTop>
                      <ListRowSubtitle>
                        {tx("code", "版本号")} <span className="font-mono">{a.version_code ?? "?"}</span>
                        {a.channel_slug ? <> · <span className="font-mono">{a.channel_slug}</span></> : null}
                        {" · "}{tx("Requested by", "申请人：")} {a.requested_by_actor}
                      </ListRowSubtitle>
                    </div>
                    {/* The conditions the approver is signing off on (task #239 review). */}
                    <div className="flex flex-wrap items-center gap-1 text-footnote">
                      <span className="text-foreground-muted">{tx("Publishes to", "发布范围")}</span>
                      {scopes.length === 0 ? (
                        <ScopeChip>full:all</ScopeChip>
                      ) : (
                        scopes.map((s, i) => <ScopeChip key={i}>{`${s.scope_type}:${s.scope_value}`}</ScopeChip>)
                      )}
                      {targets.length > 0 && (
                        <>
                          <span className="text-foreground-muted">{tx("· requires targets", "· 必需的目标")}</span>
                          {targets.map((t, i) => <ScopeChip key={i}>{t}</ScopeChip>)}
                        </>
                      )}
                    </div>
                    {a.assets.length > 0 && (
                      <ul className="flex flex-col gap-0.5 font-mono text-footnote text-foreground-muted">
                        {a.assets.map((asset, i) => (
                          <li key={i} className="[overflow-wrap:anywhere]">
                            {asset.artifact_kind} · {asset.platform}
                            {asset.arch ? `/${asset.arch}` : ""}
                            {asset.variant ? `/${asset.variant}` : ""} · {asset.filetype} ·{" "}
                            {asset.size_bytes} B · sha256 {asset.file_hash.slice(0, 16)}…
                          </li>
                        ))}
                      </ul>
                    )}
                    {a.changelog && (
                      <Text.Sans size="small" className="whitespace-pre-wrap">{a.changelog}</Text.Sans>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="default"
                        disabled={mutation.isPending}
                        onClick={() => mutation.mutate({ requestId: a.id, action: "approve" })}
                      >
                        {tx("Approve", "批准")}
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={mutation.isPending}
                        onClick={() => mutation.mutate({ requestId: a.id, action: "reject" })}
                      >
                        {tx("Reject", "拒绝")}
                      </Button>
                    </div>
                  </ListRowBody>
                </ListRow>
              );
            })}
          </ListRowGroup>
        )}
      </div>
    </section>
  );
}

/** The first line of the release notes, without Markdown markers. */
function notesPreview(changelog: string | null): string | null {
  if (!changelog) return null;
  for (const raw of changelog.split("\n")) {
    const line = raw.replace(/^\s*(#+|[-*+]|\d+\.)\s*/, "").replace(/[*_`]/g, "").trim();
    if (line && !/^\[?[a-z]{2}(-[A-Za-z]+)?\]?:?$/.test(line)) return line;
  }
  return null;
}

export function Releases({ appId }: { appId: string }) {
  const tx = useText();
  const qc = useQueryClient();
  const [searchParams] = useSearchParams();
  const [channelFilter, setChannelFilter] = useState<string>(searchParams.get("channel") ?? "all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [showNewRelease, setShowNewRelease] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

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
  const all = releases.data?.releases ?? [];
  const channelSlug = (r: Release) => channels.data?.channels.find((c) => c.id === r.channel_id)?.slug ?? r.channel ?? "?";
  const productTypeName = (r: Release) => productTypes.data?.product_types.find((p) => p.name === r.product_type)?.display_name ?? r.product_type;

  // Filter client-side (the list endpoint returns every release of the app).
  const byChannel = all.filter((r) => channelFilter === "all" || channelSlug(r) === channelFilter);
  const filtered = byChannel.filter((r) => statusFilter === "all" || r.status === statusFilter);
  const countOf = (status: string) => byChannel.filter((r) => r.status === status).length;
  const open = all.find((r) => r.id === openId) ?? null;
  const filtering = channelFilter !== "all" || statusFilter !== "all";
  const refresh = () => qc.invalidateQueries({ queryKey: ["releases", appId] });

  const statusItems: Record<string, string> = {
    all: tx("All states", "所有状态"),
    ...Object.fromEntries(STATUSES.map((s) => [s, releaseStatusLabel(s, tx)])),
  };

  return (
    <ListPage
      icon={<Rocket aria-hidden="true" />}
      title={tx("Releases", "版本")}
      count={releases.data ? all.length : undefined}
      busy={releases.isLoading}
      toolbar={
        <>
          <Select
            items={{
              all: tx("All channels", "所有渠道"),
              ...Object.fromEntries((channels.data?.channels ?? []).map((c) => [c.slug, c.slug])),
            }}
            value={channelFilter}
            onValueChange={(v) => setChannelFilter(v as string)}
          >
            <SelectTrigger aria-label={tx("Channel", "渠道")} className="min-w-0 flex-1 sm:w-auto sm:min-w-36 sm:flex-none">
              <SelectValue />
              <SelectIcon />
            </SelectTrigger>
            <SelectContent>
              <SelectList>
                <SelectItem value="all">{tx("All channels", "所有渠道")}</SelectItem>
                {channels.data?.channels.map((c) => (
                  <SelectItem key={c.id} value={c.slug}>{c.slug}</SelectItem>
                ))}
              </SelectList>
            </SelectContent>
          </Select>
          <Select items={statusItems} value={statusFilter} onValueChange={(v) => setStatusFilter(v as string)}>
            <SelectTrigger aria-label={tx("State", "状态")} className="min-w-0 flex-1 sm:w-auto sm:min-w-36 sm:flex-none">
              <SelectValue />
              <SelectIcon />
            </SelectTrigger>
            <SelectContent>
              <SelectList>
                <SelectItem value="all">{statusItems.all}</SelectItem>
                {STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    <span className="flex w-full items-center gap-3">
                      <span className="flex-1">{statusItems[s]}</span>
                      <span className="font-mono text-foreground-hint">{countOf(s)}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectList>
            </SelectContent>
          </Select>
          {filtering && (
            <TextLink onClick={() => { setChannelFilter("all"); setStatusFilter("all"); }}>
              {tx("Clear all", "清除筛选")}
            </TextLink>
          )}
          <Button variant="primary" className="ml-auto" onClick={() => setShowNewRelease(true)}>
            <Plus aria-hidden="true" />
            {/* On a phone the filters need the line; the button keeps its name for screen readers. */}
            <span className="max-sm:sr-only">{tx("New release", "新建版本")}</span>
          </Button>
        </>
      }
      detail={
        open && (
          <ReleaseDetail
            key={open.id}
            appId={appId}
            release={open}
            channelSlug={channelSlug(open)}
            productTypeName={productTypeName(open)}
            onClose={() => setOpenId(null)}
            onAction={() => void refresh()}
          />
        )
      }
    >
      {/* Release human-approval queue (task #239). Mounted regardless of the
          current toggle so already-pending requests stay reachable; the
          component hides itself only when the gate is off and nothing is pending. */}
      <PendingReleaseApprovals appId={appId} gateOn={Boolean(thisApp?.release_requires_human_approval)} />

      <div className="flex flex-col gap-0.5">
        {releases.isLoading && [0, 1, 2, 3].map((n) => <ListRowSkeleton key={n} cell />)}

        {releases.error && (
          <div className="px-(--column-margin)">
            <Banner status="warning">
              <AlertTriangle aria-hidden="true" />
              <BannerTitle>{tx("Could not load releases", "无法加载版本")}</BannerTitle>
              <BannerDescription>{errorMessage(releases.error)}</BannerDescription>
              <BannerAction>
                <Button variant="outline" onClick={() => void releases.refetch()}>{tx("Retry", "重试")}</Button>
              </BannerAction>
            </Banner>
          </div>
        )}

        {releases.data && filtered.length === 0 && (
          <EmptyState className="py-16">
            <EmptyStateContent>
              <EmptyStateIcon><Rocket aria-hidden="true" /></EmptyStateIcon>
              {all.length === 0 ? (
                <>
                  <EmptyStateTitle>{tx("No releases yet", "还没有版本")}</EmptyStateTitle>
                  <EmptyStateDescription>{tx("New release drafts one, with its files, and publishes it when you say.", "用“新建版本”创建草稿并附上文件，确认后再发布。")}</EmptyStateDescription>
                </>
              ) : (
                <>
                  <EmptyStateTitle>{tx("No releases match your filter.", "没有符合筛选条件的发布。")}</EmptyStateTitle>
                  <EmptyStateDescription>{tx("Choose another channel or state, or clear the filters.", "换一个渠道或状态，或清除筛选。")}</EmptyStateDescription>
                </>
              )}
            </EmptyStateContent>
          </EmptyState>
        )}

        {filtered.map((r) => (
          <ReleaseListRow
            key={r.id}
            release={r}
            channelSlug={channelSlug(r)}
            productTypeName={productTypeName(r)}
            selected={openId === r.id}
            onOpen={() => setOpenId(r.id)}
          />
        ))}
      </div>

      {showNewRelease && (
        <NewReleaseDialog
          appId={appId}
          onClose={() => setShowNewRelease(false)}
          onCreated={() => {
            setShowNewRelease(false);
            void refresh();
          }}
        />
      )}
    </ListPage>
  );
}

function ReleaseListRow({
  release: r,
  channelSlug,
  productTypeName,
  selected,
  onOpen,
}: {
  release: Release;
  channelSlug: string;
  productTypeName: string;
  selected: boolean;
  onOpen: () => void;
}) {
  const tx = useText();
  const { locale } = useLocale();
  const notes = notesPreview(r.changelog);
  const facts = [
    productTypeName,
    r.is_full ? null : tx("scoped", "限定范围"),
    r.should_force_update ? tx("force update", "强制更新") : null,
  ].filter(Boolean);
  return (
    <ListRow cell selected={selected} aria-current={selected || undefined} tone={r.status === "superseded" || r.status === "cancelled" ? "muted" : "default"} onClick={onOpen}>
      <ListRowBody>
        <ListRowTop>
          <span className="flex min-w-0 flex-1 items-baseline gap-2">
            <ListRowTitle className="flex-initial">{r.version_name ?? r.id.slice(0, 8)}</ListRowTitle>
            {r.version_code != null && <span className="shrink-0 font-mono text-footnote text-foreground-hint">{r.version_code}</span>}
          </span>
          <ListRowMeta>{timeAgo(r.activated_at ?? r.created_at, locale)}</ListRowMeta>
        </ListRowTop>
        <ListRowSubtitle>
          <span className="font-mono">{channelSlug}</span> · {facts.join(" · ")}
        </ListRowSubtitle>
        <ListRowBottom>
          <ListRowDescription>{notes ?? tx("No release notes", "没有发布说明")}</ListRowDescription>
          <ReleaseStatusBadge release={r} />
        </ListRowBottom>
      </ListRowBody>
    </ListRow>
  );
}

function ReleaseDetail({
  release: r,
  appId,
  channelSlug,
  productTypeName,
  onClose,
  onAction,
}: {
  release: Release;
  appId: string;
  channelSlug: string;
  productTypeName: string;
  onClose: () => void;
  onAction: () => void;
}) {
  const tx = useText();
  const { locale } = useLocale();
  const toast = useToast();
  const [showRollout, setShowRollout] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

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

  const live = r.status === "draft" || r.status === "active";
  const rollout = r.rollout_cohort_count ?? 100;
  const hasMetrics = Boolean(r.offered_count || r.current_count || r.offered_uv || r.current_uv);
  const scopes = detail.data?.scopes ?? [];
  const checks = detail.data?.checks ?? [];
  const title = r.version_name ?? r.id.slice(0, 8);
  const forceId = `force-update-${r.id}`;

  return (
    <DetailColumn label={`${title} · ${channelSlug}`} title={title} meta={<span className="font-mono">{channelSlug}</span>} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <ReleaseStatusBadge release={r} />
          <Text.Sans size="small" variant="muted">
            {productTypeName}
            {r.version_code != null && <> · {tx("code", "版本号")} <span className="font-mono">{r.version_code}</span></>}
            {" · "}{timeAgo(r.activated_at ?? r.created_at, locale)}
          </Text.Sans>
        </div>
        <div className="flex flex-wrap gap-2">
          {r.status === "draft" && (
            <Button
              variant="default"
              onClick={() => publish.mutate()}
              disabled={publish.isPending || !detail.data}
              loading={publish.isPending}
              loadingLabel={tx("Publishing", "发布中")}
            >
              <Rocket aria-hidden="true" />
              {!detail.data ? tx("Loading scope...", "加载范围中…") : tx("Publish", "发布")}
            </Button>
          )}
          {live && (
            <Button variant="default" onClick={() => setShowEdit(true)}>
              {tx("Edit", "编辑")}
            </Button>
          )}
          {r.status === "active" && Boolean(r.is_full) && (
            <Button variant="default" onClick={() => setShowRollout(true)}>
              {tx("Change rollout", "调整发布比例")}
            </Button>
          )}
          {(r.status === "superseded" || r.status === "cancelled") && (
            <Button variant="default" onClick={() => rollback.mutate()} disabled={rollback.isPending} loading={rollback.isPending}>
              {r.status === "cancelled" && r.activated_at == null
                ? tx("Restore draft", "恢复草稿")
                : tx("Restore as active", "恢复并生效")}
            </Button>
          )}
        </div>
      </div>

      <DetailSection title={tx("Who gets it", "发布范围")}>
        {r.is_full ? (
          <Progress value={rollout}>
            <ProgressHeader>
              <ProgressLabel>{tx("Share of devices", "设备比例")}</ProgressLabel>
              <ProgressValue />
            </ProgressHeader>
            <ProgressTrack>
              <ProgressIndicator />
            </ProgressTrack>
          </Progress>
        ) : null}
        {detail.isLoading ? (
          <Skeleton className="h-6 w-2/3" />
        ) : scopes.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1">
            <Text.Sans size="small" variant="muted" className="mr-1">{tx("Scopes", "范围")}</Text.Sans>
            {scopes.map((s: ReleaseScope) => <ScopeChip key={s.id}>{`${s.scope_type}:${s.scope_value}`}</ScopeChip>)}
          </div>
        ) : null}
        {r.status === "active" ? (
          <ListRowGroup>
            <ListRow variant="plain" interactive={false}>
              <ListRowBody>
                <ListRowTitle id={forceId}>{tx("Force update", "强制更新")}</ListRowTitle>
                <ListRowDescription wrap>{tx("Clients must install it before they can go on.", "客户端必须先安装这个版本才能继续使用。")}</ListRowDescription>
              </ListRowBody>
              <Switch
                checked={Boolean(r.should_force_update)}
                disabled={toggleForce.isPending}
                onCheckedChange={() => toggleForce.mutate()}
                aria-labelledby={forceId}
              />
            </ListRow>
          </ListRowGroup>
        ) : r.should_force_update ? (
          <Text.Sans size="small">{tx("Clients must install it (force update).", "客户端必须安装（强制更新）。")}</Text.Sans>
        ) : null}
      </DetailSection>

      {hasMetrics && (
        <DetailSection title={tx("Adoption", "采用情况")}>
          <DescriptionList direction="horizontal">
            <DescriptionItem>
              <DescriptionTerm>{tx("On this version", "使用此版本")}</DescriptionTerm>
              <DescriptionDetails>
                <Tooltip>
                  <TooltipTrigger render={<span className="font-mono">{r.current_uv ?? 0}</span>} />
                  <TooltipContent>{r.current_count ?? 0} {tx("update checks (PV)", "次更新检查（PV）")}</TooltipContent>
                </Tooltip>
              </DescriptionDetails>
            </DescriptionItem>
            <DescriptionItem>
              <DescriptionTerm>{tx("Offered", "已收到更新提示")}</DescriptionTerm>
              <DescriptionDetails>
                <Tooltip>
                  <TooltipTrigger render={<span className="font-mono">{r.offered_uv ?? 0}</span>} />
                  <TooltipContent>{r.offered_count ?? 0} {tx("update offers (PV)", "次更新提示（PV）")}</TooltipContent>
                </Tooltip>
              </DescriptionDetails>
            </DescriptionItem>
            {r.last_checked_at ? (
              <DescriptionItem>
                <DescriptionTerm>{tx("Last check", "最近检查")}</DescriptionTerm>
                <DescriptionDetails>{new Date(r.last_checked_at).toLocaleString(locale)}</DescriptionDetails>
              </DescriptionItem>
            ) : null}
          </DescriptionList>
        </DetailSection>
      )}

      {checks.length > 0 && (
        <DetailSection title={tx("Checks (advisory)", "检查（仅供参考）")}>
          <ListRowGroup>
            {checks.map((chk) => (
              <ListRow key={chk.id} variant="plain" interactive={false}>
                <ListRowBody>
                  <ListRowTitle className="font-mono">{chk.source}</ListRowTitle>
                  <ListRowSubtitle>
                    {chk.cases_total !== null ? tx(`${chk.cases_passed ?? 0}/${chk.cases_total} cases`, `${chk.cases_passed ?? 0}/${chk.cases_total} 个用例`) : null}
                    {chk.cases_total !== null && chk.summary ? " · " : null}
                    {chk.summary}
                  </ListRowSubtitle>
                  {chk.run_url && (
                    <TextLink className="mt-1 self-start text-footnote" render={<a href={chk.run_url} target="_blank" rel="noreferrer" />} nativeButton={false}>
                      {tx("run", "查看运行记录")}
                      <TextLinkExternalIcon label={tx("(opens in a new tab)", "（在新标签页打开）")} />
                    </TextLink>
                  )}
                </ListRowBody>
                <Badge
                  appearance="soft"
                  variant={chk.verdict === "passed" ? "success" : chk.verdict === "failed" || chk.verdict === "warning" ? "warning" : "muted"}
                >
                  {({ passed: tx("passed", "通过"), failed: tx("failed", "失败"), pending: tx("pending", "待处理") } as Record<string, string>)[chk.verdict] ?? chk.verdict}
                </Badge>
              </ListRow>
            ))}
          </ListRowGroup>
        </DetailSection>
      )}

      <DetailSection title={tx("Release notes", "发布说明")}>
        {r.changelog
          ? <ChangelogViewer value={r.changelog} />
          : <Text.Sans size="small" variant="muted">{tx("No release notes. Add them with Edit.", "没有发布说明，可以在“编辑”中添加。")}</Text.Sans>}
      </DetailSection>

      <DetailSection title={tx("Files", "文件")}>
        <ReleaseAssetsPanel
          appId={appId}
          releaseId={r.id}
          buildId={r.build_id}
          productTypeHint={r.product_type}
        />
      </DetailSection>

      <DetailSection title={tx("Details", "详情")}>
        <DescriptionList direction="horizontal">
          <DescriptionItem>
            <DescriptionTerm>{tx("Release", "版本 ID")}</DescriptionTerm>
            <DescriptionDetails>
              <CopyableCodeRoot size="sm">
                <CopyableCode className="[overflow-wrap:anywhere]">{r.id}</CopyableCode>
                <CopyableCodeAction aria-label={tx("Copy release ID", "复制版本 ID")} />
              </CopyableCodeRoot>
            </DescriptionDetails>
          </DescriptionItem>
          <DescriptionItem>
            <DescriptionTerm>{tx("Build", "构建")}</DescriptionTerm>
            <DescriptionDetails>
              {detail.data?.build
                ? <>{detail.data.build.version_name} ({detail.data.build.version_code}) · </>
                : null}
              <span className="font-mono">{r.build_id.slice(0, 8)}…</span>
            </DescriptionDetails>
          </DescriptionItem>
          <DescriptionItem>
            <DescriptionTerm>{tx("Revision", "修订")}</DescriptionTerm>
            <DescriptionDetails><span className="font-mono">{currentRevision}</span></DescriptionDetails>
          </DescriptionItem>
          <DescriptionItem>
            <DescriptionTerm>{tx("Created", "创建时间")}</DescriptionTerm>
            <DescriptionDetails>{new Date(r.created_at).toLocaleString(locale)}</DescriptionDetails>
          </DescriptionItem>
        </DescriptionList>
      </DetailSection>

      {live && (
        <DetailSection title={tx("Danger zone", "危险操作")}>
          <ListRowGroup>
            <ListRow variant="plain" onClick={() => setConfirmCancel(true)}>
              <ListRowIcon><Ban /></ListRowIcon>
              <ListRowBody>
                <ListRowTitle>{r.status === "draft" ? tx("Delete draft", "删除草稿") : tx("Cancel release", "取消发布")}</ListRowTitle>
                <ListRowDescription wrap>
                  {r.status === "draft"
                    ? tx("Its build and files stay; Restore draft brings it back.", "构建和文件会保留，可以用“恢复草稿”找回。")
                    : tx("Update checks stop offering it. Restore brings it back.", "更新检查将不再提供它，可以再恢复。")}
                </ListRowDescription>
              </ListRowBody>
            </ListRow>
          </ListRowGroup>
        </DetailSection>
      )}

      {showRollout && (
        <RolloutDialog
          appId={appId}
          release={r}
          revision={currentRevision}
          onClose={() => setShowRollout(false)}
          onDone={() => {
            setShowRollout(false);
            onAction();
          }}
        />
      )}

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
    </DetailColumn>
  );
}

function RolloutDialog({
  appId,
  release: r,
  revision,
  onClose,
  onDone,
}: {
  appId: string;
  release: Release;
  revision: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const tx = useText();
  const toast = useToast();
  const [percent, setPercent] = useState<number>(r.rollout_cohort_count ?? 100);
  const bump = useMutation({
    mutationFn: (target: number) => bumpRollout(appId, r.id, {
      to: target,
      expected_revision: revision,
    }),
    onSuccess: (data) => {
      toast.show({
        kind: "success",
        title: tx(`Rollout set to ${data.rollout_cohort_count ?? "?"}%`, `发布比例已设为 ${data.rollout_cohort_count ?? "?"}%`),
      });
      onDone();
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: tx("Bump rollout failed", "调整发布比例失败"),
        description: errorMessage(e),
      }),
  });
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{tx("Change rollout", "调整发布比例")}</DialogTitle>
          <DialogClose />
        </DialogHeader>
        <form className="contents" onSubmit={(e) => { e.preventDefault(); if (!bump.isPending) bump.mutate(percent); }}>
          <DialogBody className="grid gap-4">
            <Field>
              <FieldLabel htmlFor="rollout-percent">{tx("Share of devices", "设备比例")}</FieldLabel>
              <RolloutPercentInput id="rollout-percent" value={percent} onChange={setPercent} />
              <FieldDescription>{tx("Devices already on this release keep it.", "已经安装这个版本的设备不受影响。")}</FieldDescription>
            </Field>
          </DialogBody>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="ghost" size="lg" />}>{tx("Cancel", "取消")}</DialogClose>
            <Button type="submit" variant="primary" size="lg" loading={bump.isPending} loadingLabel={tx("Saving", "保存中")} disabled={bump.isPending}>
              {tx("Set", "设置")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Who receives a release: the scope, groups always included, force update and the rollout share. */
function TargetingFields({
  idPrefix,
  groups,
  scopeType,
  setScopeType,
  scopeValue,
  setScopeValue,
  alwaysIncludedGroupIds,
  setAlwaysIncludedGroupIds,
  shouldForceUpdate,
  setShouldForceUpdate,
  rolloutPercent,
  setRolloutPercent,
}: {
  idPrefix: string;
  groups: { id: string; name: string; member_count: number }[];
  scopeType: EditableScopeType;
  setScopeType: (v: EditableScopeType) => void;
  scopeValue: string;
  setScopeValue: (v: string) => void;
  alwaysIncludedGroupIds: string[];
  setAlwaysIncludedGroupIds: (v: string[]) => void;
  shouldForceUpdate: boolean;
  setShouldForceUpdate: (v: boolean) => void;
  rolloutPercent: number;
  setRolloutPercent: (v: number) => void;
}) {
  const tx = useText();
  const labels = scopeTypeLabels(tx);
  const forceId = `${idPrefix}-force`;
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel nativeLabel={false} render={<div />}>{tx("Scope", "范围")}</FieldLabel>
          <Select
            items={labels}
            value={scopeType}
            onValueChange={(v) => {
              const next = v as EditableScopeType;
              setScopeType(next);
              setScopeValue(next === "full" ? "all" : "");
            }}
          >
            <SelectTrigger aria-label={tx("Scope", "范围")}>
              <SelectValue />
              <SelectIcon />
            </SelectTrigger>
            <SelectContent>
              <SelectList>
                {(Object.keys(labels) as EditableScopeType[]).map((k) => (
                  <SelectItem key={k} value={k}>{labels[k]}</SelectItem>
                ))}
              </SelectList>
            </SelectContent>
          </Select>
        </Field>
        {scopeType !== "full" && (
          <Field>
            {scopeType === "device_group" ? (
              <>
                <FieldLabel nativeLabel={false} render={<div />}>{tx("Device group", "设备组")}</FieldLabel>
                <Select
                  items={Object.fromEntries(groups.map((group) => [group.id, group.name]))}
                  value={scopeValue}
                  onValueChange={(value) => setScopeValue(value as string)}
                >
                  <SelectTrigger aria-label={tx("Device group", "设备组")}><SelectValue placeholder={tx("Choose group", "选择设备组")} /><SelectIcon /></SelectTrigger>
                  <SelectContent>
                    <SelectList>
                      {groups.map((group) => (
                        <SelectItem key={group.id} value={group.id}>{group.name} ({group.member_count})</SelectItem>
                      ))}
                    </SelectList>
                  </SelectContent>
                </Select>
              </>
            ) : (
              <>
                <FieldLabel htmlFor={`${idPrefix}-scope-value`}>{labels[scopeType]}</FieldLabel>
                <Input
                  id={`${idPrefix}-scope-value`}
                  className="font-mono"
                  value={scopeValue}
                  onChange={(e) => setScopeValue(e.target.value)}
                  placeholder={scopeType === "ip_range" ? "10.0.0.0/8" : "android-arm64-v8a"}
                />
              </>
            )}
          </Field>
        )}
      </div>
      {scopeType === "full" && (
        <Field>
          <FieldLabel htmlFor={`${idPrefix}-rollout`}>{tx("Rollout cohort %", "发布比例")}</FieldLabel>
          <RolloutPercentInput id={`${idPrefix}-rollout`} value={rolloutPercent} onChange={setRolloutPercent} />
        </Field>
      )}
      {scopeType === "full" && (
        <Field>
          <FieldLabel nativeLabel={false} render={<div />}>{tx("Always included device groups", "始终包含的设备组")}</FieldLabel>
          <AlwaysIncludedDeviceGroups
            groups={groups}
            selectedIds={alwaysIncludedGroupIds}
            onChange={setAlwaysIncludedGroupIds}
          />
        </Field>
      )}
      <label htmlFor={forceId} className="flex items-start gap-2 text-footnote">
        <Checkbox
          id={forceId}
          checked={shouldForceUpdate}
          onCheckedChange={(v) => setShouldForceUpdate(Boolean(v))}
        />
        <span>{tx("Force update: clients must upgrade on next launch", "强制更新：客户端下次启动时必须升级")}</span>
      </label>
    </>
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
      <DialogContent size="lg">
        <DialogHeader>
          <div className="min-w-0">
            <DialogTitle>{tx("Edit release", "编辑发布")}</DialogTitle>
            <DialogDescription className="truncate font-mono">{release.id}</DialogDescription>
          </div>
          <DialogClose />
        </DialogHeader>
        <DialogBody className="grid gap-5" unstable_scrollArea>
          {loading && <Text.Sans size="small" variant="muted">{tx("Loading release details...", "正在加载发布详情…")}</Text.Sans>}
          <Field>
            <FieldLabel nativeLabel={false} render={<div />}>{tx("Release notes", "发布说明")}</FieldLabel>
            <ChangelogEditor value={changelog} onChange={setChangelog} />
          </Field>
          <TargetingFields
            idPrefix="edit-release"
            groups={deviceGroups.data?.groups ?? []}
            scopeType={scopeType}
            setScopeType={setScopeType}
            scopeValue={scopeValue}
            setScopeValue={setScopeValue}
            alwaysIncludedGroupIds={alwaysIncludedGroupIds}
            setAlwaysIncludedGroupIds={setAlwaysIncludedGroupIds}
            shouldForceUpdate={shouldForceUpdate}
            setShouldForceUpdate={setShouldForceUpdate}
            rolloutPercent={rolloutPercent}
            setRolloutPercent={setRolloutPercent}
          />
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" size="lg" onClick={onClose} disabled={save.isPending}>
            {tx("Cancel", "取消")}
          </Button>
          <Button
            variant="primary"
            size="lg"
            onClick={() => save.mutate()}
            disabled={save.isPending || loading || !scopeValid}
            loading={save.isPending}
            loadingLabel={tx("Saving", "保存中")}
          >
            {tx("Save changes", "保存更改")}
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
          description: tx(`${assetFailures[0]?.slice(0, 80)}… Add it again from the release's Files.`, `${assetFailures[0]?.slice(0, 80)}… 请在版本的“文件”中重新添加。`),
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

  const labels = scopeTypeLabels(tx);
  const scopeSummary =
    scopeType === "full"
      ? `${labels.full} (${rolloutPercent}%)${alwaysIncludedGroupIds.length > 0
        ? `; ${tx("always", "始终包含")} ${alwaysIncludedGroupIds.map((groupId) =>
          deviceGroups.data?.groups.find((group) => group.id === groupId)?.name ?? groupId
        ).join(", ")}`
        : ""}`
      : `${labels[scopeType]}: ${scopeValue || "?"}`;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent size="lg">
        <DialogHeader>
          <div className="min-w-0">
            <DialogTitle>{tx("Draft a new release", "创建发布草稿")}</DialogTitle>
            <DialogDescription>
              {tx("Draft the release, attach its files, then publish it or keep the draft.", "创建发布草稿、添加文件，然后发布或保留草稿。")}
            </DialogDescription>
          </div>
          <DialogClose />
        </DialogHeader>
        <DialogBody className="grid gap-5" unstable_scrollArea>
          <Steps current={step} aria-label={tx("Steps", "步骤")}>
            {STEP_LABELS.map((label) => <Step key={label} title={label} />)}
          </Steps>

          {/* ---------------- Step 1: Target ---------------- */}
          {step === 1 && (
            <div className="grid gap-5">
              <div className={showProductTypePicker ? "grid gap-4 sm:grid-cols-2" : "grid gap-4"}>
                <Field>
                  <FieldLabel nativeLabel={false} render={<div />}>{tx("Channel", "渠道")}</FieldLabel>
                  <Select
                    items={{
                      "": tx("Choose a channel", "选择渠道"),
                      ...Object.fromEntries((channels.data?.channels ?? []).map((c) => [c.slug, c.slug])),
                    }}
                    value={channelSlug}
                    onValueChange={(v) => setChannelSlug(v as string)}
                  >
                    <SelectTrigger aria-label={tx("Channel", "渠道")} autoFocus>
                      <SelectValue />
                      <SelectIcon />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectList>
                        <SelectItem value="">{tx("Choose a channel", "选择渠道")}</SelectItem>
                        {channels.data?.channels.map((c) => (
                          <SelectItem key={c.id} value={c.slug}>{c.slug}</SelectItem>
                        ))}
                      </SelectList>
                    </SelectContent>
                  </Select>
                </Field>
                {showProductTypePicker && (
                  <Field>
                    <FieldLabel nativeLabel={false} render={<div />}>{tx("Package type", "软件包类型")}</FieldLabel>
                    <Select
                      items={{
                        "": tx("Choose a type", "选择类型"),
                        ...Object.fromEntries(targetProductTypes.map((p) => [p.name, p.display_name])),
                      }}
                      value={productType}
                      onValueChange={(v) => setProductType(v as string)}
                    >
                      <SelectTrigger aria-label={tx("Package type", "软件包类型")}>
                        <SelectValue />
                        <SelectIcon />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectList>
                          <SelectItem value="">{tx("Choose a type", "选择类型")}</SelectItem>
                          {targetProductTypes.map((p) => (
                            <SelectItem key={p.name} value={p.name}>{p.display_name}</SelectItem>
                          ))}
                        </SelectList>
                      </SelectContent>
                    </Select>
                  </Field>
                )}
              </div>
              {!showProductTypePicker && selectedProductType && (
                <Text.Sans size="small" variant="muted">
                  {tx("Package type is set by this app:", "软件包类型由此应用设定：")}{" "}
                  <span className="font-medium text-foreground">{selectedProductType.display_name}</span>
                </Text.Sans>
              )}
              {channels.data && channels.data.channels.length === 0 && (
                <Banner status="warning" size="sm">
                  <BannerDescription>
                    {tx("This app has no channels yet. Create one on the Channels page first.", "此应用还没有渠道。请先在“渠道”页面创建。")}
                  </BannerDescription>
                </Banner>
              )}
            </div>
          )}

          {/* ---------------- Step 2: Version + notes ---------------- */}
          {step === 2 && (
            <div className="grid gap-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="new-release-version">{tx("Version name", "版本名称")}</FieldLabel>
                  <Input
                    id="new-release-version"
                    className="font-mono"
                    value={versionName}
                    onChange={(e) => setVersionName(e.target.value)}
                    placeholder="1.2.3"
                    autoFocus
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="new-release-code">{tx("Version code", "版本号")}</FieldLabel>
                  <Input
                    id="new-release-code"
                    className="font-mono"
                    type="number"
                    value={versionCode}
                    onChange={(e) => setVersionCode(e.target.value)}
                    placeholder="42"
                  />
                  <FieldDescription>{tx("A whole number, higher than the last release's.", "整数，需大于上一个版本。")}</FieldDescription>
                </Field>
              </div>
              <Field>
                <FieldLabel nativeLabel={false} render={<div />}>{tx("Release notes", "发布说明")}</FieldLabel>
                <ChangelogEditor value={changelog} onChange={setChangelog} minHeight={220} />
              </Field>
            </div>
          )}

          {/* ---------------- Step 3: Assets ---------------- */}
          {step === 3 && (
            <div className="grid gap-3">
              <Text.Sans size="small" variant="muted">
                {tx("Drop one or more binaries. We auto-detect platform / arch / filetype from the filename and keep optional fields blank when they are not needed.", "拖入一个或多个二进制文件。系统会根据文件名自动识别平台、架构和文件类型；不需要的可选字段留空。")}{" "}
                {tx("You can also publish without files and add them later from the release.", "也可以先发布，之后在版本详情中添加文件。")}
              </Text.Sans>
              <ReleaseAssetUploader
                variant="dialog"
                deferUpload
                appId={appId}
                buildId="__pending__"
                productTypeHint={productType || "android-apk"}
                onFilesChanged={setPendingFiles}
              />
              <Text.Sans size="caption" variant="muted">
                {tx("Files are uploaded after the draft is created and before it is published. The draft is preserved even if individual files fail.", "创建草稿后、发布前上传文件。即使个别文件上传失败，草稿仍会保留。")}
              </Text.Sans>
            </div>
          )}

          {/* ---------------- Step 4: Review ---------------- */}
          {step === 4 && (
            <div className="grid gap-5">
              <DescriptionList direction="horizontal">
                <DescriptionItem>
                  <DescriptionTerm>{tx("Channel", "渠道")}</DescriptionTerm>
                  <DescriptionDetails><span className="font-mono">{channelSlug || "—"}</span></DescriptionDetails>
                </DescriptionItem>
                <DescriptionItem>
                  <DescriptionTerm>{tx("Product type", "产品类型")}</DescriptionTerm>
                  <DescriptionDetails><span className="font-mono">{productType || "—"}</span></DescriptionDetails>
                </DescriptionItem>
                <DescriptionItem>
                  <DescriptionTerm>{tx("Version", "版本")}</DescriptionTerm>
                  <DescriptionDetails><span className="font-mono">{`${versionName || "—"} (${versionCode || "?"})`}</span></DescriptionDetails>
                </DescriptionItem>
                <DescriptionItem>
                  <DescriptionTerm>{tx("Scope", "范围")}</DescriptionTerm>
                  <DescriptionDetails>{scopeSummary}{shouldForceUpdate ? tx(" · force update", " · 强制更新") : ""}</DescriptionDetails>
                </DescriptionItem>
                <DescriptionItem>
                  <DescriptionTerm>{tx("Assets", "文件")}</DescriptionTerm>
                  <DescriptionDetails>{tx(`${pendingFiles.length} file(s) queued`, `已选择 ${pendingFiles.length} 个文件`)}</DescriptionDetails>
                </DescriptionItem>
              </DescriptionList>
              {changelog && (
                <div className="grid gap-2">
                  <Text.Sans render={<h3 />} size="group">{tx("Release notes", "发布说明")}</Text.Sans>
                  <div className="rounded-container border border-line-hairline p-3">
                    <ChangelogViewer value={changelog} />
                  </div>
                </div>
              )}
              <div className="grid gap-4">
                <TextLink
                  className="self-start"
                  aria-expanded={showAdvanced}
                  onClick={() => setShowAdvanced((v) => !v)}
                >
                  {showAdvanced
                    ? tx("Hide scope, force update and rollout", "收起范围、强制更新和发布比例")
                    : tx("Change scope, force update or rollout", "修改范围、强制更新或发布比例")}
                </TextLink>
                {showAdvanced && (
                  <TargetingFields
                    idPrefix="new-release"
                    groups={deviceGroups.data?.groups ?? []}
                    scopeType={scopeType}
                    setScopeType={setScopeType}
                    scopeValue={scopeValue}
                    setScopeValue={setScopeValue}
                    alwaysIncludedGroupIds={alwaysIncludedGroupIds}
                    setAlwaysIncludedGroupIds={setAlwaysIncludedGroupIds}
                    shouldForceUpdate={shouldForceUpdate}
                    setShouldForceUpdate={setShouldForceUpdate}
                    rolloutPercent={rolloutPercent}
                    setRolloutPercent={setRolloutPercent}
                  />
                )}
              </div>
              <Text.Sans size="small" variant="muted">
                {tx("Publishing creates the build and draft release, uploads queued assets, then publishes. Asset failures don't roll back the release.", "发布时会创建构建和发布草稿，上传已选择的文件，然后发布。文件上传失败不会撤销发布记录。")}
              </Text.Sans>
            </div>
          )}
        </DialogBody>
        {/* Wizard nav buttons */}
        <DialogFooter>
          {step > 1 ? (
            <Button
              type="button"
              variant="ghost"
              size="lg"
              className="mr-auto"
              onClick={() => setStep((step - 1) as Step)}
              disabled={submitRelease.isPending}
            >
              {tx("Back", "上一步")}
            </Button>
          ) : (
            <DialogClose render={<Button type="button" variant="ghost" size="lg" className="mr-auto" />}>{tx("Cancel", "取消")}</DialogClose>
          )}
          {step < 4 && (
            <Button
              type="button"
              variant="primary"
              size="lg"
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
                variant="default"
                size="lg"
                disabled={submitRelease.isPending || !step1Valid || !step2Valid}
                onClick={() => submitRelease.mutate("draft")}
              >
                {submitRelease.isPending && submitRelease.variables === "draft" ? tx("Saving...", "保存中…") : tx("Save draft", "保存草稿")}
              </Button>
              <Button
                type="button"
                variant="primary"
                size="lg"
                disabled={submitRelease.isPending || !step1Valid || !step2Valid}
                onClick={() => submitRelease.mutate("publish")}
              >
                {submitRelease.isPending && submitRelease.variables === "publish" ? tx("Publishing...", "发布中…") : tx("Publish now", "立即发布")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
