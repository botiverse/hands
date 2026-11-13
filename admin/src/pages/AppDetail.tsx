import { errorMessage } from "../lib/errorMessage";
import {
  Button,
  Checkbox,
  Input,
  Label,
  Switch,
  Textarea,
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
  EmptyState,
  EmptyStateTitle,
  EmptyStateDescription,
  Skeleton,
  Badge,
  type BadgeProps,
} from "raft-ui";
import { DeviceAnalytics } from "../components/DeviceAnalytics";
import { ReleaseHealth } from "../components/ReleaseHealth";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ConfirmActionDialog, TypedConfirmField } from "../components/ConfirmActionDialog";
import {
  archiveApp,
  getAuthMe,
  listApps,
  listChannels,
  listBuilds,
  createChannel,
  updateChannel,
  deleteChannel,
  updateApp,
  type App,
  type Channel,
  uploadAppIcon,
  publicAppIconUrl,
  updateAppPublicHistory,
  updateAppHistoryChannels,
  updateAppHistoryDownloads,
  updateAppDeltaUpdates,
  updateAppReleaseApproval,
  getAppClientKey,
  getFeedbackBuildFilter,
  setFeedbackBuildFilter,
  rotateAppClientKey,
  purgeApp,
  listOrgs,
  transferApp,
  getAppStoreReview,
  connectRaftBot,
  createRaftNotification,
  deleteRaftNotification,
  getRaftNotificationConfig,
  listRaftNotificationFailures,
  retryRaftNotificationFailure,
  testRaftNotification,
  updateRaftNotification,
  WEBHOOK_EVENT_TYPES,
  type WebhookEventType,
  type RaftNotificationSubscription,
  addDeviceGroupMember,
  createDeviceGroup,
  deleteDeviceGroup,
  listDeviceGroups,
  removeDeviceGroupMember,
  updateDeviceGroup,
  type DeviceGroup,
} from "../lib/api";
import { useToast } from "../components/Toast";
import { Operations } from "./Operations";
import { deviceGroupUpdatePayload } from "../lib/deviceGroupForm";
import { useLocale, useText } from "../lib/locale";

export function AppDetail({ appId }: { appId: string }) {
  const t = useText();
  const apps = useQuery({ queryKey: ["apps"], queryFn: listApps });
  const app = apps.data?.apps.find((a) => a.id === appId);
  const channels = useQuery({
    queryKey: ["channels", appId],
    queryFn: () => listChannels(appId),
  });
  const appMissing = !apps.isLoading && !apps.error && !app;

  return (
    <div>
      {apps.error && (
        <AppErrorBanner
          title={t("Cannot load apps", "无法加载应用列表")}
          error={apps.error}
        />
      )}
      {appMissing && (
        <AppErrorBanner
          title={t("App is not available", "应用不可用")}
          description={t("This app is not visible to the current account, or it no longer exists.", "当前账号无法查看此应用，或应用已不存在。")}
        />
      )}
      {channels.error && (
        <AppErrorBanner
          title={t("Cannot load app details", "无法加载应用详情")}
          error={channels.error}
        />
      )}

      <section>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-lg font-semibold">{t("App overview", "应用概览")}</h2>
            <p className="text-xs text-foreground-muted">
              {t("Releases are managed from the", "在")}{" "}
              <a href={`/apps/${appId}/releases`} className="underline">
                {t("Releases", "版本")}
              </a>{" "}
              {t("tab.", "页面管理发布。")}
            </p>
          </div>
          {channels.data?.channels.length ? (
            <Button
              variant="primary"
              className="text-sm"
              render={<a href={`/apps/${appId}/releases`} />}
            >
              {t("Publish release →", "发布版本 →")}
            </Button>
          ) : (
            <Button
              variant="primary"
              className="text-sm"
              render={<a href={`/apps/${appId}/channels`} />}
            >
              {t("Create channel first", "请先创建渠道")}
            </Button>
          )}
        </div>
      </section>

      <section className="mt-6">
        <ReleaseHealth appId={appId} />
        <DeviceAnalytics appId={appId} />
      </section>

      <section className="mt-8">
        <Operations appId={appId} />
      </section>
    </div>
  );
}

function AppErrorBanner({
  title,
  description,
  error,
}: {
  title: string;
  description?: string;
  error?: unknown;
}) {
  return (
    <div className="mb-4 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-strong">
      <div className="font-medium">{title}</div>
      <div className="text-xs mt-1">
        {description ?? errorMessage(error)}
      </div>
    </div>
  );
}

export function AppChannels({ appId }: { appId: string }) {
  const t = useText();
  const qc = useQueryClient();
  const apps = useQuery({ queryKey: ["apps"], queryFn: listApps });
  const app = apps.data?.apps.find((a) => a.id === appId);
  const channels = useQuery({
    queryKey: ["channels", appId],
    queryFn: () => listChannels(appId),
  });
  const [showCreateChannel, setShowCreateChannel] = useState(false);
  const [editingChannel, setEditingChannel] = useState<Channel | null>(null);

  return (
    <div>

      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">{t("Channels", "渠道")}</h2>
          <Button
            variant="outline"
            onClick={() => setShowCreateChannel(true)}
          >
            {t("+ New channel", "+ 新建渠道")}
          </Button>
        </div>
        {channels.isLoading && (
          <div className="space-y-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        )}
        <div className="space-y-4">
          {channels.data?.channels.length === 0 && (
            <EmptyState>
              <EmptyStateTitle>{t("No channels yet.", "暂无渠道。")}</EmptyStateTitle>
            </EmptyState>
          )}
          {channels.data?.channels.map((c) => (
            <ChannelRow
              key={c.id}
              channel={c}
              onEdit={() => setEditingChannel(c)}
              busy={false}
            />
          ))}
        </div>
        {showCreateChannel && (
          <CreateChannelDialog
            appId={appId}
            onClose={() => setShowCreateChannel(false)}
            onCreated={() => {
              setShowCreateChannel(false);
              qc.invalidateQueries({ queryKey: ["channels", appId] });
            }}
          />
        )}
        {editingChannel && (
          <EditChannelDialog
            appId={appId}
            app={app}
            channel={editingChannel}
            onClose={() => setEditingChannel(null)}
            onSaved={() => {
              setEditingChannel(null);
              qc.invalidateQueries({ queryKey: ["channels", appId] });
            }}
          />
        )}
      </section>
    </div>
  );
}

function AppNamePanel({ appId, app }: { appId: string; app: App }) {
  const t = useText();
  const toast = useToast();
  const qc = useQueryClient();
  const [name, setName] = useState(app.name);
  const rename = useMutation({
    mutationFn: () => updateApp(appId, { name: name.trim() }),
    onSuccess: () => {
      toast.show({ kind: "success", title: t("App renamed", "应用已重命名") });
      qc.invalidateQueries({ queryKey: ["apps"] });
    },
    onError: (e) =>
      toast.show({ kind: "error", title: t("Rename failed", "重命名失败"), description: errorMessage(e) }),
  });
  const dirty = name.trim().length > 0 && name.trim() !== app.name;
  return (
    <div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-3">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium">{t("App name", "应用名称")}</div>
        <div className="text-xs text-foreground-muted">
          {t("Display name shown in the console and on share pages. The slug (", "控制台和分享页面显示的名称。应用标识（")}
          <span className="font-mono">{app.slug}</span>{t(") is permanent — SDKs and CI reference it.", "）固定不变，SDK 和 CI 会使用它。")}
        </div>
      </div>
      <Input
        className="h-8! w-full md:w-56 text-sm!"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && dirty && !rename.isPending) rename.mutate();
        }}
      />
      <Button
        variant="primary"
        loading={rename.isPending}
        disabled={!dirty || rename.isPending}
        onClick={() => rename.mutate()}
      >
        {t("Save", "保存")}
      </Button>
    </div>
  );
}

function AppDescriptionPanel({ appId, app }: { appId: string; app: App }) {
  const t = useText();
  const toast = useToast();
  const qc = useQueryClient();
  const [description, setDescription] = useState(app.description ?? "");
  const save = useMutation({
    mutationFn: () => updateApp(appId, { description: description.trim() || null }),
    onSuccess: () => {
      toast.show({ kind: "success", title: t("Description saved", "描述已保存") });
      qc.invalidateQueries({ queryKey: ["apps"] });
    },
    onError: (e) =>
      toast.show({ kind: "error", title: t("Save failed", "保存失败"), description: errorMessage(e) }),
  });
  const dirty = description.trim() !== (app.description ?? "");
  return (
    <div className="flex flex-col gap-2 md:flex-row md:items-start md:gap-3">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium">{t("Description", "描述")}</div>
        <div className="text-xs text-foreground-muted">
          {t("Internal note about what this app is — shown in the console app list, not on public pages.", "关于此应用的内部备注，显示在控制台应用列表中，不显示在公开页面。")}
        </div>
      </div>
      <Textarea
        className="w-full resize-y md:w-72 h-16"
        value={description}
        placeholder={t("What is this app?", "这个应用有什么用途？")}
        onChange={(e) => setDescription(e.target.value)}
      />
      <Button
        variant="primary"
        loading={save.isPending}
        disabled={!dirty || save.isPending}
        onClick={() => save.mutate()}
      >
        {t("Save", "保存")}
      </Button>
    </div>
  );
}

function ClientKeyPanel({ appId }: { appId: string }) {
  const t = useText();
  const toast = useToast();
  const qc = useQueryClient();
  const [revealed, setRevealed] = useState(false);
  const keyQuery = useQuery({
    queryKey: ["client-key", appId],
    queryFn: () => getAppClientKey(appId),
  });
  const rotate = useMutation({
    mutationFn: () => rotateAppClientKey(appId),
    onSuccess: () => {
      toast.show({ kind: "success", title: t("Client key rotated — update client configs", "客户端密钥已轮换，请更新客户端配置") });
      qc.invalidateQueries({ queryKey: ["client-key", appId] });
    },
    onError: (e) =>
      toast.show({ kind: "error", title: t("Rotate failed", "轮换失败"), description: errorMessage(e) }),
  });
  const key = keyQuery.data?.client_key ?? null;
  return (
    <div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-3">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium">{t("Client key", "客户端密钥")}</div>
        <div className="text-xs text-foreground-muted">
          {t("Required on feedback/crash submissions (X-Hands-Client-Key; legacy X-Quiver-Client-Key still accepted). Embedded in client builds; rotate if leaked.", "提交反馈和崩溃报告时需要此密钥（X-Hands-Client-Key；仍支持旧版 X-Quiver-Client-Key）。密钥嵌入客户端构建，泄露时请轮换。")}
        </div>
        {key && revealed && (
          <div className="mt-1 font-mono text-xs break-all">{key}</div>
        )}
        {!key && !keyQuery.isLoading && (
          <div className="mt-1 text-xs text-warning-strong">
            {t("No key set — submissions are currently unauthenticated. Rotate to generate one.", "尚未设置密钥，目前提交无需身份验证。请轮换以生成密钥。")}
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-2 md:contents">
        {key && (
          <>
            <Button
              variant="outline"
              onClick={() => setRevealed((v) => !v)}
            >
              {revealed ? t("Hide", "隐藏") : t("Reveal", "显示")}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                navigator.clipboard?.writeText(key);
                toast.show({ kind: "success", title: t("Client key copied", "客户端密钥已复制") });
              }}
            >
              {t("Copy", "复制")}
            </Button>
          </>
        )}
        <Button
          variant="outline"
          disabled={rotate.isPending}
          onClick={() => {
            if (window.confirm(t("Rotate the client key? Older client builds stop reporting until they carry the new key.", "轮换客户端密钥？旧客户端构建在更新到新密钥之前将无法上报。"))) {
              rotate.mutate();
            }
          }}
        >
          {rotate.isPending ? "…" : key ? t("Rotate", "轮换") : t("Generate", "生成")}
        </Button>
      </div>
    </div>
  );
}

function DeviceGroupsPanel({ appId }: { appId: string }) {
  const t = useText();
  const queryClient = useQueryClient();
  const toast = useToast();
  const groups = useQuery({
    queryKey: ["device-groups", appId],
    queryFn: () => listDeviceGroups(appId),
  });
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const create = useMutation({
    mutationFn: () => createDeviceGroup(appId, {
      name: name.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
    }),
    onSuccess: () => {
      setName("");
      setDescription("");
      void queryClient.invalidateQueries({ queryKey: ["device-groups", appId] });
      toast.show({ kind: "success", title: t("Device group created", "设备组已创建") });
    },
    onError: (error) => toast.show({ kind: "error", title: t("Create failed", "创建失败"), description: errorMessage(error) }),
  });

  return (
    <div className="border-t border-line-hairline pt-3 space-y-3">
      <div>
        <div className="text-sm font-medium">{t("Device groups", "设备组")}</div>
        <p className="text-xs text-foreground-muted">
          {t("Exact rollout groups use the stable installation device id sent by the Hands update SDK.", "精确发布组使用 Hands 更新 SDK 发送的稳定安装设备标识。")}
        </p>
      </div>
      <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
        <Input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("Test devices", "测试设备")} />
        <Input value={description} onChange={(event) => setDescription(event.target.value)} placeholder={t("Operator note (optional)", "操作备注（可选）")} />
        <Button variant="outline" disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>
          {t("Create group", "创建设备组")}
        </Button>
      </div>
      {groups.isLoading && <p className="text-xs text-foreground-muted">{t("Loading device groups…", "正在加载设备组…")}</p>}
      {groups.error && <p className="text-xs text-danger">{errorMessage(groups.error)}</p>}
      {(groups.data?.groups ?? []).map((group) => (
        <DeviceGroupCard key={group.id} appId={appId} group={group} />
      ))}
    </div>
  );
}

function DeviceGroupCard({ appId, group }: { appId: string; group: DeviceGroup }) {
  const t = useText();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [deviceId, setDeviceId] = useState("");
  const [label, setLabel] = useState("");
  const [editing, setEditing] = useState(false);
  const [groupName, setGroupName] = useState(group.name);
  const [groupDescription, setGroupDescription] = useState(group.description ?? "");
  useEffect(() => {
    if (!editing) {
      setGroupName(group.name);
      setGroupDescription(group.description ?? "");
    }
  }, [editing, group.description, group.name]);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["device-groups", appId] });
  const update = useMutation({
    mutationFn: () => updateDeviceGroup(appId, group.id, deviceGroupUpdatePayload(groupName, groupDescription)),
    onSuccess: () => {
      setEditing(false);
      void refresh();
      toast.show({ kind: "success", title: t("Device group updated", "设备组已更新") });
    },
    onError: (error) => toast.show({ kind: "error", title: t("Update failed", "更新失败"), description: errorMessage(error) }),
  });
  const add = useMutation({
    mutationFn: () => addDeviceGroupMember(appId, group.id, {
      device_id: deviceId.trim(),
      ...(label.trim() ? { label: label.trim() } : {}),
    }),
    onSuccess: () => {
      setDeviceId("");
      setLabel("");
      void refresh();
      toast.show({ kind: "success", title: t("Device added", "设备已添加") });
    },
    onError: (error) => toast.show({ kind: "error", title: t("Add failed", "添加失败"), description: errorMessage(error) }),
  });
  const remove = useMutation({
    mutationFn: (memberDeviceId: string) => removeDeviceGroupMember(appId, group.id, memberDeviceId),
    onSuccess: () => void refresh(),
    onError: (error) => toast.show({ kind: "error", title: t("Remove failed", "移除失败"), description: errorMessage(error) }),
  });
  const destroy = useMutation({
    mutationFn: () => deleteDeviceGroup(appId, group.id),
    onSuccess: () => {
      void refresh();
      toast.show({ kind: "success", title: t("Device group deleted", "设备组已删除") });
    },
    onError: (error) => toast.show({ kind: "error", title: t("Delete failed", "删除失败"), description: errorMessage(error) }),
  });

  return (
    <div className="rounded-md bg-fill-muted p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div>
          {editing ? (
            <div className="space-y-2">
              <Input value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder={t("Group name", "组名称")} />
              <Input
                value={groupDescription}
                onChange={(event) => setGroupDescription(event.target.value)}
                placeholder={t("Operator note", "操作备注")}
              />
            </div>
          ) : (
            <>
              <div className="text-sm font-medium">{group.name}</div>
              {group.description && <div className="text-xs text-foreground-muted">{group.description}</div>}
            </>
          )}
          <div className="text-[11px] font-mono text-foreground-hint">{group.id}</div>
        </div>
        <div className="flex gap-2">
          {editing ? (
            <>
              <Button variant="outline" disabled={!groupName.trim() || update.isPending} onClick={() => update.mutate()}>
                {t("Save", "保存")}
              </Button>
              <Button variant="outline" disabled={update.isPending} onClick={() => setEditing(false)}>
                {t("Cancel", "取消")}
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={() => setEditing(true)}>{t("Edit", "编辑")}</Button>
          )}
          <Button
            variant="outline"
            disabled={destroy.isPending || editing}
            onClick={() => { if (window.confirm(t(`Delete device group '${group.name}'?`, `删除设备组“${group.name}”？`))) destroy.mutate(); }}
          >
            {t("Delete", "删除")}
          </Button>
        </div>
      </div>
      <div className="space-y-1">
        {group.members.length === 0 && <p className="text-xs text-foreground-muted">{t("No devices yet.", "暂无设备。")}</p>}
        {group.members.map((member) => (
          <div key={member.device_id} className="flex items-center justify-between gap-2 text-xs">
            <span className="min-w-0 truncate">
              <span className="font-medium">{member.label || t("Device", "设备")}</span>{" "}
              <span className="font-mono text-foreground-muted">{member.device_id}</span>
            </span>
            <Button variant="outline" onClick={() => remove.mutate(member.device_id)} disabled={remove.isPending}>
              {t("Remove", "移除")}
            </Button>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-[1fr_160px_auto] gap-2">
        <Input value={deviceId} onChange={(event) => setDeviceId(event.target.value)} placeholder={t("Installation device id", "安装设备 ID")} />
        <Input value={label} onChange={(event) => setLabel(event.target.value)} placeholder={t("Label", "标签")} />
        <Button variant="outline" disabled={!deviceId.trim() || add.isPending} onClick={() => add.mutate()}>
          {t("Add", "添加")}
        </Button>
      </div>
    </div>
  );
}

// --- App Store review status (read-only) ---------------------------------

type BadgeVariant = NonNullable<BadgeProps["variant"]>;

/** Map an appStoreState enum to a Badge variant + a human label. */
function appStoreStateBadge(state: string | null): {
  variant: BadgeVariant;
  label: string;
} {
  switch (state) {
    case "READY_FOR_SALE":
      return { variant: "success", label: "Ready for sale" };
    case "IN_REVIEW":
      return { variant: "information", label: "In review" };
    case "WAITING_FOR_REVIEW":
      return { variant: "warning", label: "Waiting for review" };
    case "PENDING_DEVELOPER_RELEASE":
      return { variant: "accent", label: "Pending developer release" };
    case "PENDING_APPLE_RELEASE":
      return { variant: "accent", label: "Pending Apple release" };
    case "PREPARE_FOR_SUBMISSION":
      return { variant: "muted", label: "Preparing" };
    case "REJECTED":
      return { variant: "danger", label: "Rejected" };
    case "METADATA_REJECTED":
      return { variant: "danger", label: "Metadata rejected" };
    case "DEVELOPER_REJECTED":
      return { variant: "danger", label: "Developer rejected" };
    default:
      // Unknown/other states (e.g. PROCESSING_FOR_APP_STORE): show verbatim.
      return {
        variant: "muted",
        label: state ? state.replace(/_/g, " ").toLowerCase() : "Unknown",
      };
  }
}

/** Map a TestFlight betaReviewState to a Badge variant + label. */
function betaReviewStateBadge(state: string | null): {
  variant: BadgeVariant;
  label: string;
} {
  switch (state) {
    case "APPROVED":
      return { variant: "success", label: "Approved" };
    case "IN_REVIEW":
      return { variant: "information", label: "In review" };
    case "WAITING_FOR_REVIEW":
      return { variant: "warning", label: "Waiting for review" };
    case "REJECTED":
      return { variant: "danger", label: "Rejected" };
    default:
      return { variant: "muted", label: "No beta review" };
  }
}

export function AppStoreReviewPanel({ appId }: { appId: string; app: App }) {
  const t = useText();
  const badgeZh: Record<string, string> = { "Ready for sale": "已上架", "In review": "审核中", "Waiting for review": "等待审核", "Pending developer release": "等待开发者发布", "Pending Apple release": "等待 Apple 发布", "Preparing": "准备中", "Rejected": "已拒绝", "Metadata rejected": "元数据被拒绝", "Developer rejected": "开发者已撤回", "Unknown": "未知", "Approved": "已批准", "No beta review": "暂无测试审核" };
  // Non-iOS apps never render this panel — the parent guards on
  // app.platform === "ios" (mirrors the worker's applicable:false response).
  const review = useQuery({
    queryKey: ["appstore-review", appId],
    queryFn: () => getAppStoreReview(appId),
  });

  const data = review.data;
  const versions = data?.app_store_versions ?? [];
  const builds = data?.testflight_builds ?? [];
  const current = versions[0];
  const currentBadge = current ? appStoreStateBadge(current.appStoreState) : null;

  return (
    <div className="border-t border-line-hairline pt-3">
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <div className="text-sm font-medium">{t("App Store review status", "App Store 审核状态")}</div>
            {currentBadge && (
              <Badge variant={currentBadge.variant}>{t(currentBadge.label, badgeZh[currentBadge.label] ?? current?.appStoreState ?? currentBadge.label)}</Badge>
            )}
          </div>
          <div className="text-xs text-foreground-muted">
            {t("Live review state of this app's recent App Store versions and TestFlight builds, from App Store Connect. Read-only.", "从 App Store Connect 查看此应用近期 App Store 版本和 TestFlight 构建的实时审核状态。仅供查看。")}
          </div>
        </div>
      </div>

      <div className="mt-3">
        {review.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : data?.configured === false ? (
          <EmptyState>
            <EmptyStateTitle>{t("App Store Connect not configured", "尚未配置 App Store Connect")}</EmptyStateTitle>
            <EmptyStateDescription>
              {t("Add App Store Connect credentials under Integrations → TestFlight to see review status.", "请在“集成 → TestFlight”中添加 App Store Connect 凭据，以查看审核状态。")}
            </EmptyStateDescription>
          </EmptyState>
        ) : data?.bundle_id === null ? (
          <EmptyState>
            <EmptyStateTitle>{t("No App Store bundle ID configured", "尚未配置 App Store Bundle ID")}</EmptyStateTitle>
            <EmptyStateDescription>
              {t("Set the production App Store bundle ID on the", "请在")}{" "}
              <a
                href={`/apps/${appId}/channels`}
                className="underline font-medium"
              >
                {t("main channel", "main 渠道")}
              </a>{" "}
              {t("(Channels tab). Only the main channel's bundle ID is used — preview/nightly channels are ignored, so their beta bundle IDs won't be picked up here.", "（渠道页面）设置正式版 App Store Bundle ID。这里只使用 main 渠道的 Bundle ID，不会使用 preview 或 nightly 的测试版 Bundle ID。")}
            </EmptyStateDescription>
          </EmptyState>
        ) : data?.error ? (
          <div className="rounded-md bg-warning-soft px-3 py-2 text-xs text-warning-strong">
            {t("Could not load review status from App Store Connect:", "无法从 App Store Connect 加载审核状态：")} {data.error}
            {data.bundle_id && (
              <div className="mt-1">
                {t("Bundle ID", "Bundle ID")} {" "}
                <span className="font-mono">{data.bundle_id}</span>{t(" is set on the main channel. If it doesn't match your App Store app, update it in", "设置在 main 渠道上。如果与 App Store 应用不一致，请在")}{" "}
                <a
                  href={`/apps/${appId}/channels`}
                  className="underline font-medium"
                >
                  {t("Channels", "渠道")}
                </a>
                {t(".", "中更新。")}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <div className="text-xs font-medium text-foreground-muted mb-1">
                {t("Recent App Store versions", "近期 App Store 版本")}
              </div>
              {versions.length === 0 ? (
                <div className="text-xs text-foreground-hint">
                  {t("No App Store versions yet.", "暂无 App Store 版本。")}
                </div>
              ) : (
                <ul className="space-y-1">
                  {versions.map((v, i) => {
                    const b = appStoreStateBadge(v.appStoreState);
                    return (
                      <li
                        key={`${v.versionString}-${i}`}
                        className="flex items-center gap-2 text-sm"
                      >
                        <span className="font-mono">
                          {v.versionString ?? "—"}
                        </span>
                        <Badge variant={b.variant}>{t(b.label, badgeZh[b.label] ?? v.appStoreState ?? b.label)}</Badge>
                        {(v.appStoreState === "REJECTED" ||
                          v.appStoreState === "METADATA_REJECTED" ||
                          v.appStoreState === "DEVELOPER_REJECTED") && (
                          <span className="text-xs text-foreground-hint">
                            {t("(see App Store Connect for the rejection details)", "（拒绝详情请查看 App Store Connect）")}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div>
              <div className="text-xs font-medium text-foreground-muted mb-1">
                {t("Recent TestFlight builds — beta review", "近期 TestFlight 构建 — 测试审核")}
              </div>
              {builds.length === 0 ? (
                <div className="text-xs text-foreground-hint">
                  {t("No builds on App Store Connect yet.", "App Store Connect 暂无构建。")}
                </div>
              ) : (
                <ul className="space-y-1">
                  {builds.map((bld, i) => {
                    const b = betaReviewStateBadge(bld.betaReviewState);
                    return (
                      <li
                        key={`${bld.version}-${i}`}
                        className="flex items-center gap-2 text-sm"
                      >
                        <span className="font-mono">{bld.version ?? "—"}</span>
                        <Badge variant={b.variant}>{t(b.label, badgeZh[b.label] ?? b.label)}</Badge>
                        {bld.processingState &&
                          bld.processingState !== "VALID" && (
                            <span className="text-xs text-foreground-hint">
                              {t(bld.processingState.toLowerCase(), ({ PROCESSING: "处理中", FAILED: "处理失败", INVALID: "无效" } as Record<string, string>)[bld.processingState] ?? bld.processingState)}
                            </span>
                          )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function PublicHistoryToggle({ appId, app }: { appId: string; app: App }) {
  const t = useText();
  const toast = useToast();
  const qc = useQueryClient();
  const enabled = Boolean(app.public_history);
  const channelsQuery = useQuery({
    queryKey: ["channels", appId],
    queryFn: () => listChannels(appId),
  });
  // history_channels is a JSON array of slugs; null/empty = all channels shown.
  const selectedChannels: string[] = (() => {
    try {
      const parsed = app.history_channels ? JSON.parse(app.history_channels) : null;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  })();
  const showDownloads = app.history_show_downloads !== 0;
  const channelsMutation = useMutation({
    mutationFn: (slugs: string[]) => updateAppHistoryChannels(appId, slugs.length ? slugs : null),
    onSuccess: () => {
      toast.show({ kind: "success", title: t("Visible channels updated", "可见渠道已更新") });
      qc.invalidateQueries({ queryKey: ["apps"] });
    },
    onError: (e) => toast.show({ kind: "error", title: t("Update failed", "更新失败"), description: errorMessage(e) }),
  });
  const downloadsToggle = useMutation({
    mutationFn: () => updateAppHistoryDownloads(appId, !showDownloads),
    onSuccess: () => {
      toast.show({
        kind: "success",
        title: !showDownloads ? t("Downloads shown on public pages", "公开页面已显示下载按钮") : t("Downloads hidden on public pages", "公开页面已隐藏下载按钮"),
      });
      qc.invalidateQueries({ queryKey: ["apps"] });
    },
    onError: (e) => toast.show({ kind: "error", title: t("Update failed", "更新失败"), description: errorMessage(e) }),
  });
  const toggleChannel = (slug: string) => {
    const next = selectedChannels.includes(slug)
      ? selectedChannels.filter((s) => s !== slug)
      : [...selectedChannels, slug];
    channelsMutation.mutate(next);
  };
  const toggle = useMutation({
    mutationFn: () => updateAppPublicHistory(appId, !enabled),
    onSuccess: () => {
      toast.show({
        kind: "success",
        title: !enabled ? t("Public version history enabled", "已开启公开版本历史") : t("Public version history disabled", "已关闭公开版本历史"),
      });
      qc.invalidateQueries({ queryKey: ["apps"] });
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: t("Update failed", "更新失败"),
        description: errorMessage(e),
      }),
  });
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <div className="text-sm font-medium">{t("Public version history", "公开版本历史")}</div>
          <div className="text-xs text-foreground-muted">
            {enabled ? (
              <>
                {t("Anyone can browse and download published versions at", "任何人都可以在此浏览和下载已发布版本：")}{" "}
                <a
                  className="underline"
                  href={`/apps/${app.slug}/history`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  /apps/{app.slug}/history
                </a>
                {t(" · latest landing: ", " · 最新版本页面：")}
                <a
                  className="underline"
                  href={`/apps/${app.slug}/latest`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  /apps/{app.slug}/latest
                </a>
                {t(".", "。")}
              </>
            ) : (
              t("Expose a public page listing published versions with changelogs and downloads.", "公开展示已发布版本、更新说明和下载链接的页面。")
            )}
          </div>
        </div>
        <Switch
          checked={enabled}
          disabled={toggle.isPending}
          onCheckedChange={() => toggle.mutate()}
        />
      </div>
      {enabled && (
        <div className="pl-1 space-y-2 text-sm">
          <div className="flex items-center gap-3">
            <div className="flex-1 text-xs text-foreground-muted">
              {t("Channels shown on the public history pages (none selected = all).", "公开历史页面显示的渠道（不选择则显示全部）。")}
            </div>
            <div className="flex flex-wrap gap-2">
              {(channelsQuery.data?.channels ?? []).map((ch) => (
                <label key={ch.id} className="flex items-center gap-1 text-xs">
                  <Checkbox
                    size="sm"
                    checked={selectedChannels.includes(ch.slug)}
                    disabled={channelsMutation.isPending}
                    onCheckedChange={() => toggleChannel(ch.slug)}
                  />
                  {ch.slug}
                </label>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex-1 text-xs text-foreground-muted">
              {t("Show per-version download buttons on the public history, notes and landing pages.", "在公开历史、更新说明和版本页面显示各版本的下载按钮。")}
            </div>
            <Switch
              checked={showDownloads}
              disabled={downloadsToggle.isPending}
              onCheckedChange={() => downloadsToggle.mutate()}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function DeltaUpdatesToggle({ appId, app }: { appId: string; app: App }) {
  const t = useText();
  const toast = useToast();
  const qc = useQueryClient();
  const enabled = Boolean(app.delta_updates_enabled);
  const toggle = useMutation({
    mutationFn: () => updateAppDeltaUpdates(appId, !enabled),
    onSuccess: () => {
      toast.show({
        kind: "success",
        title: !enabled ? t("Delta updates enabled", "已开启增量更新") : t("Delta updates disabled", "已关闭增量更新"),
      });
      qc.invalidateQueries({ queryKey: ["apps"] });
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: t("Update failed", "更新失败"),
        description: errorMessage(e),
      }),
  });
  return (
    <div className="flex items-center gap-3">
      <div className="flex-1">
        <div className="text-sm font-medium">{t("Delta updates", "增量更新")}</div>
        <div className="text-xs text-foreground-muted">
          {enabled
            ? t("On publish, small differential patches are generated from recent versions so users download less to update.", "发布时根据近期版本生成较小的差分补丁，减少用户更新时的下载量。")
            : t("Auto-generate differential update patches when a release is published, shrinking update downloads for users on recent versions.", "发布时自动生成差分更新补丁，减少使用近期版本的用户需要下载的数据。")}
        </div>
      </div>
      <Switch
        checked={enabled}
        disabled={toggle.isPending}
        onCheckedChange={() => toggle.mutate()}
      />
    </div>
  );
}

function ReleaseApprovalToggle({ appId, app }: { appId: string; app: App }) {
  const t = useText();
  const toast = useToast();
  const qc = useQueryClient();
  const enabled = Boolean(app.release_requires_human_approval);
  const toggle = useMutation({
    mutationFn: () => updateAppReleaseApproval(appId, !enabled),
    onSuccess: () => {
      toast.show({
        kind: "success",
        title: !enabled ? t("Human approval required", "需要人工审批") : t("Human approval not required", "不需要人工审批"),
      });
      qc.invalidateQueries({ queryKey: ["apps"] });
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: t("Update failed", "更新失败"),
        description: errorMessage(e),
      }),
  });
  return (
    <div className="flex items-center gap-3">
      <div className="flex-1">
        <div className="text-sm font-medium">{t("Require human approval for agent releases", "智能体发布需要人工审批")}</div>
        <div className="text-xs text-foreground-muted">
          {enabled
            ? t("On. Releases that an agent (deploy token) tries to publish are held for an app admin or org admin to approve or reject before they go live. Releases you publish from this console are unaffected.", "已开启。智能体通过部署令牌发起的发布须经应用管理员或组织管理员批准后才会生效，也可能被拒绝。您在此控制台发起的发布不受影响。")
            : t("When on, agent-initiated releases are held for a human (app admin / org admin) to approve before publishing. Your own console publishes are never gated.", "开启后，智能体发起的发布须由应用管理员或组织管理员批准。您在此控制台发起的发布不受此限制。")}
        </div>
      </div>
      <Switch
        checked={enabled}
        disabled={toggle.isPending}
        onCheckedChange={() => toggle.mutate()}
      />
    </div>
  );
}

function AppIconUploader({ appId, slug }: { appId: string; slug: string }) {
  const t = useText();
  const toast = useToast();
  const [bust, setBust] = useState(0);
  const upload = useMutation({
    mutationFn: (file: File) => uploadAppIcon(appId, file),
    onSuccess: () => {
      toast.show({ kind: "success", title: t("App icon updated", "应用图标已更新") });
      setBust(Date.now());
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: t("Icon upload failed", "图标上传失败"),
        description: errorMessage(e),
      }),
  });
  return (
    <div className="flex flex-wrap items-center gap-3">
      <img
        src={`${publicAppIconUrl(slug)}${bust ? `?v=${bust}` : ""}`}
        alt=""
        width={44}
        height={44}
        className="h-11 w-11 rounded-lg border border-line-muted bg-layer-inset object-cover"
        onError={(e) => {
          (e.target as HTMLImageElement).style.visibility = "hidden";
        }}
        onLoad={(e) => {
          (e.target as HTMLImageElement).style.visibility = "visible";
        }}
      />
      <div className="min-w-0">
        <div className="text-sm font-medium">{t("App icon", "应用图标")}</div>
        <div className="text-xs text-foreground-muted">
          {t("Shown on share/download pages. PNG/WebP/JPEG, max 1MB.", "显示在分享和下载页面。支持 PNG、WebP、JPEG，最大 1 MB。")}
        </div>
      </div>
      <Button variant="outline" size="xs" className="ml-auto" render={<label className="cursor-pointer" />}>
        {upload.isPending ? t("Uploading…", "上传中…") : t("Upload", "上传")}
        <input
          type="file"
          accept="image/png,image/webp,image/jpeg"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) upload.mutate(file);
            e.currentTarget.value = "";
          }}
        />
      </Button>
    </div>
  );
}

function FeedbackBuildFilterToggle({ appId }: { appId: string }) {
  const t = useText();
  const toast = useToast();
  const qc = useQueryClient();
  const setting = useQuery({ queryKey: ["feedback-build-filter", appId], queryFn: () => getFeedbackBuildFilter(appId) });
  const enabled = setting.data?.default_enabled === 1;
  const update = useMutation({
    mutationFn: (next: boolean) => setFeedbackBuildFilter(appId, next),
    onSuccess: (_, next) => {
      toast.show({ kind: "success", title: next ? t("External report separation enabled", "已开启外部报告分流") : t("External report separation disabled", "已关闭外部报告分流") });
      qc.invalidateQueries({ queryKey: ["feedback-build-filter", appId] });
      qc.invalidateQueries({ queryKey: ["feedback", appId] });
      qc.invalidateQueries({ queryKey: ["feedback-stats", appId] });
      qc.invalidateQueries({ queryKey: ["crash-groups", appId] });
      qc.invalidateQueries({ queryKey: ["error-groups", appId] });
    },
    onError: (e) => toast.show({ kind: "error", title: t("Update failed", "更新失败"), description: errorMessage(e) }),
  });
  return (
    <div className="flex items-center gap-3">
      <div className="flex-1">
        <div className="text-sm font-medium">{t("Separate external iOS reports", "分流外部 iOS 报告")}</div>
        <div className="text-xs text-foreground-muted">
          {t("Compare reported bundle IDs with this app's configured channels. Mismatches appear in the external view and do not create normal notification cards; unknown IDs stay in the main view. Bundle IDs are supplied by clients and do not verify identity.", "将报告的 Bundle ID 与此应用配置的渠道进行比较。不匹配的报告显示在外部视图中，不会创建普通通知卡片；未知 ID 仍保留在主视图。Bundle ID 由客户端提供，不能用于验证身份。")}
        </div>
        {setting.error && <div className="text-xs text-danger">{t("Could not load this setting.", "无法加载此设置。")}</div>}
      </div>
      <Switch aria-label={t("Separate external iOS reports", "分流外部 iOS 报告")} checked={enabled}
        disabled={!setting.data || update.isPending} onCheckedChange={(next) => update.mutate(next)} />
    </div>
  );
}

export function AppSettings({ appId }: { appId: string }) {
  const t = useText();
  const qc = useQueryClient();
  const toast = useToast();
  const apps = useQuery({ queryKey: ["apps"], queryFn: listApps });
  const app = apps.data?.apps.find((a) => a.id === appId);
  const me = useQuery({ queryKey: ["auth-me"], queryFn: () => getAuthMe() });
  const orgRole = me.data?.account.org_role ?? null;
  const isOrgAdmin = orgRole === "owner" || orgRole === "admin";
  const orgs = useQuery({ queryKey: ["orgs"], queryFn: listOrgs });

  const [confirmArchive, setConfirmArchive] = useState(false);

  // Owns the typed-confirmation state for the purge gate. ConfirmActionDialog renders the
  // field but deliberately does not hold state, so the caller supplies value/onChange and
  // enforces the match itself (see TypedConfirmField's doc comment).
  const [purgeTyped, setPurgeTyped] = useState("");
  const [confirmPurge, setConfirmPurge] = useState(false);
  const purge = useMutation({
    // Send what the operator actually typed. Passing `app.slug` made the gate decorative -
    // the caller never had to reproduce the slug, so it could not stop a misclick.
    mutationFn: () => purgeApp(appId, purgeTyped),
    onSuccess: (res) => {
      toast.show({
        kind: "success",
        title: t(`App purged (${res.r2_objects_deleted} stored files removed)`, `应用已永久删除（移除了 ${res.r2_objects_deleted} 个存储文件）`),
      });
      setConfirmPurge(false);
      qc.invalidateQueries({ queryKey: ["apps"] });
      window.location.assign("/apps");
    },
    onError: (e) =>
      toast.show({ kind: "error", title: t("Purge failed", "永久删除失败"), description: errorMessage(e) }),
  });

  const archive = useMutation({
    mutationFn: (archived: boolean) =>
      archiveApp(appId, { archived }),
    onSuccess: (_, archived) => {
      toast.show({
        kind: "success",
        title: archived ? t("App archived", "应用已归档") : t("App restored", "应用已恢复"),
      });
      qc.invalidateQueries({ queryKey: ["apps"] });
      qc.invalidateQueries({ queryKey: ["builds", appId] });
      qc.invalidateQueries({ queryKey: ["releases", appId] });
      setConfirmArchive(false);
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: t("Archive failed", "归档失败"),
        description: errorMessage(e),
      }),
  });

  if (!app) return null;

  return (
    <div>

    <div className="space-y-3 text-sm">
        <h2 className="text-sm font-medium text-foreground-strong">{t("Settings", "设置")}</h2>

        <AppTransferPanel appId={appId} app={app} orgs={orgs.data?.orgs ?? []} />

        {/* App name (slug is immutable) */}
        <AppNamePanel appId={appId} app={app} />

        {/* App description */}
        <AppDescriptionPanel appId={appId} app={app} />

        {/* App icon */}
        <AppIconUploader appId={appId} slug={app.slug} />

        {/* Public version history */}
        <PublicHistoryToggle appId={appId} app={app} />

        {/* Delta/differential updates — Android apps only */}
        {app.platform === "android" && <DeltaUpdatesToggle appId={appId} app={app} />}

        {/* Release human-approval gate (task #239) — mobile platforms */}
        {["ios", "android", "ohos"].includes(app.platform) && (
          <ReleaseApprovalToggle appId={appId} app={app} />
        )}

        {app.platform === "ios" && <FeedbackBuildFilterToggle appId={appId} />}

        {/* Client key (feedback/crash reporting auth) */}
        <ClientKeyPanel appId={appId} />

        {/* Exact per-installation rollout groups */}
        <DeviceGroupsPanel appId={appId} />

        {/* TestFlight upload credentials — iOS apps only */}

        {/* Hands-managed Raft App Bot notifications */}
        <RaftNotificationsPanel appId={appId} />

        {/* Default release channel picker */}
        <DefaultChannelPicker appId={appId} app={app} isOrgAdmin={isOrgAdmin} />

        {/* Danger zone: archive / restore */}
        <div className="border-t border-line-hairline pt-3">
          <h3 className="text-sm font-medium text-foreground-strong mb-2">
            {t("Danger zone", "危险操作")}
          </h3>
          {!isOrgAdmin && (
            <p className="text-xs text-warning-strong mb-2">
              {t("⚠ Org owner / admin required to archive apps.", "⚠ 归档应用需要组织所有者或管理员权限。")}
            </p>
          )}

          <div className="flex items-center justify-between gap-2 rounded-md bg-fill-muted p-3">
            <div>
              <div className="font-medium">
                {app.archived ? t("App is archived", "应用已归档") : t("App is active", "应用处于启用状态")}
              </div>
              <div className="text-xs text-foreground-muted">
                {app.archived
                  ? t("Archived apps reject new uploads but remain restorable. Restore the app to resume normal operation.", "归档的应用拒绝新上传，但仍可恢复。恢复应用后可继续正常使用。")
                  : t("Active apps accept uploads + releases normally.", "启用的应用可正常上传和发布。")}
              </div>
              {app.archived_at && (
                <div className="text-xs text-foreground-hint mt-1">
                  {t("Archived at:", "归档时间：")} {new Date(app.archived_at).toISOString()}
                </div>
              )}
            </div>
            {isOrgAdmin && (
              <div className="flex flex-col items-end gap-2">
                <Button
                  variant="outline"
                  onClick={() => setConfirmArchive(true)}
                  disabled={archive.isPending}
                >
                  {app.archived ? t("Restore app", "恢复应用") : t("Archive app", "归档应用")}
                </Button>
                {Boolean(app.archived) && (
                  <Button
                    variant="danger"
                    disabled={purge.isPending}
                    onClick={() => setConfirmPurge(true)}
                  >
                    {t("Purge permanently", "永久删除")}
                  </Button>
                )}
              </div>
            )}
          </div>

          <ConfirmActionDialog
            open={confirmPurge}
            title={t("Purge this app permanently?", "永久删除此应用？")}
            objectLabel={app.name ?? app.slug ?? app.id}
            objectHint={`slug: ${app.slug}`}
            body={
              <>
                {t("Deletes the app and", "将删除应用及其")} <strong>{t("everything it owns", "所有内容")}</strong>{t(" — builds, releases, share links, feedback tickets, and uploaded files.", "，包括构建、版本、分享链接、反馈工单和上传文件。")}{" "}
                <strong>{t("This cannot be undone.", "此操作无法撤销。")}</strong>
              </>
            }
            confirmLabel={t("Purge permanently", "永久删除")}
            confirmKind="danger"
            requiredText={app.slug}
            typedValue={purgeTyped}
            onTypedChange={setPurgeTyped}
            confirmDisabled={purgeTyped !== app.slug}
            pending={purge.isPending}
            onConfirm={() => purge.mutate()}
            onCancel={() => {
              setConfirmPurge(false);
              setPurgeTyped("");
            }}
          />

          <ConfirmActionDialog
            open={confirmArchive}
            title={app.archived ? t("Restore this app?", "恢复此应用？") : t("Archive this app?", "归档此应用？")}
            objectLabel={app.name ?? app.slug ?? app.id}
            objectHint={`slug: ${app.slug}`}
            objectSummary={
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 font-mono">
                <div className="text-foreground-muted">id</div>
                <div>{app.id.slice(0, 8)}…</div>
                <div className="text-foreground-muted">slug</div>
                <div>{app.slug}</div>
                <div className="text-foreground-muted">{t("status", "状态")}</div>
                <div>{app.archived ? t("archived", "已归档") : t("active", "启用")}</div>
              </div>
            }
            body={
              app.archived ? (
                <>
                  {t("Restoring returns the app to", "恢复后应用将回到")} <strong>{t("active", "启用")}</strong>{t(" status. New uploads and releases will be accepted again.", "状态，重新接受上传和发布。")}
                  <br />
                  <span className="text-xs text-foreground-muted">
                    {t("Existing builds, releases, and assets are kept as-is.", "现有构建、版本和文件保持不变。")}
                  </span>
                </>
              ) : (
                <>
                  {t("Archiving marks the app as", "归档会将应用标记为")} <strong>{t("archived", "已归档")}</strong>{t(". The app remains viewable in lists and admin pages, but", "。应用仍可在列表和管理页面查看，但")}{" "}
                  <strong>{t("new uploads are rejected", "新上传将被拒绝")}</strong>{t(".", "。")}
                  <br />
                  <span className="text-xs text-foreground-muted">
                    {t("This is reversible: existing builds, releases, and assets are kept as-is. Archiving does not free up storage.", "此操作可以撤销：现有构建、版本和文件保持不变。归档不会释放存储空间。")}
                  </span>
                </>
              )
            }
            confirmLabel={app.archived ? t("Restore app", "恢复应用") : t("Archive app", "归档应用")}
            cancelLabel={app.archived ? t("Keep archived", "保持归档") : t("Keep app", "保留应用")}
            confirmKind={app.archived ? "primary" : "danger"}
            pending={archive.isPending}
            onCancel={() => setConfirmArchive(false)}
            onConfirm={() => {
              archive.mutate(!app.archived);
              setConfirmArchive(false);
            }}
          />
          <p className="text-xs text-foreground-muted mt-2">
            {t("Future: signing credential binding, custom domains, app ownership transfer.", "后续计划：绑定签名凭据、自定义域名和转移应用所有权。")}
          </p>
        </div>
      </div>
    </div>
  );
}

function RaftNotificationsPanel({ appId }: { appId: string }) {
  const t = useText();
  const qc = useQueryClient();
  const toast = useToast();
  const config = useQuery({
    queryKey: ["raft-notifications", appId],
    queryFn: () => getRaftNotificationConfig(appId),
  });
  const [channelTarget, setChannelTarget] = useState("");
  const [events, setEvents] = useState<WebhookEventType[]>(WEBHOOK_EVENT_TYPES);

  useEffect(() => {
    if (config.data?.events?.length && events.length === 0) setEvents(config.data.events);
  }, [config.data?.events]);

  const refresh = () => qc.invalidateQueries({ queryKey: ["raft-notifications", appId] });
  const connect = useMutation({
    mutationFn: () => connectRaftBot(appId),
    onSuccess: () => { toast.show({ kind: "success", title: t("Hands App Bot connected", "Hands App Bot 已连接") }); refresh(); },
    onError: (error) => toast.show({ kind: "error", title: t("Could not connect App Bot", "无法连接 App Bot"), description: errorMessage(error) }),
  });
  const create = useMutation({
    mutationFn: () => createRaftNotification(appId, { channel_target: channelTarget.trim(), events }),
    onSuccess: () => { toast.show({ kind: "success", title: t("Raft notification destination added", "已添加 Raft 通知目标") }); setChannelTarget(""); refresh(); },
    onError: (error) => toast.show({ kind: "error", title: t("Could not add destination", "无法添加通知目标"), description: errorMessage(error) }),
  });
  const update = useMutation({
    mutationFn: (input: { id: string; enabled: boolean }) => updateRaftNotification(appId, input.id, { enabled: input.enabled }),
    onSuccess: refresh,
    onError: (error) => toast.show({ kind: "error", title: t("Could not update destination", "无法更新通知目标"), description: errorMessage(error) }),
  });
  const updateCards = useMutation({
    mutationFn: (input: { id: string; card_updates: boolean }) => updateRaftNotification(appId, input.id, { card_updates: input.card_updates }),
    onSuccess: (_result, input) => {
      if (!input.card_updates) toast.show({ kind: "success", title: t("Text selected", "已选择文字"), description: t("In-flight card requests may still finish; later notifications will use text.", "进行中的卡片请求仍可能完成；后续通知将使用文字。") });
      refresh();
    },
    onError: (error) => toast.show({ kind: "error", title: t("Could not update card settings", "无法更新卡片设置"), description: errorMessage(error) }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteRaftNotification(appId, id),
    onSuccess: () => { toast.show({ kind: "success", title: t("Raft notification destination removed", "已移除 Raft 通知目标") }); refresh(); },
    onError: (error) => toast.show({ kind: "error", title: t("Could not remove destination", "无法移除通知目标"), description: errorMessage(error) }),
  });
  const test = useMutation({
    mutationFn: (id: string) => testRaftNotification(appId, id),
    onSuccess: () => toast.show({ kind: "success", title: t("Test message sent", "测试消息已发送") }),
    onError: (error) => toast.show({ kind: "error", title: t("Test message failed", "测试消息发送失败"), description: errorMessage(error) }),
  });

  if (config.isLoading) return <div className="border-t border-line-hairline pt-3 text-xs text-foreground-muted">{t("Loading Raft notifications…", "正在加载 Raft 通知…")}</div>;
  if (config.error) return <div className="border-t border-line-hairline pt-3 text-xs text-danger-strong">{t("Could not load Raft notification settings:", "无法加载 Raft 通知设置：")} {errorMessage(config.error)}</div>;
  const bot = config.data?.bot;
  const subscriptions = config.data?.subscriptions ?? [];
  const toggleEvent = (event: WebhookEventType) => setEvents((current) => current.includes(event) ? current.filter((item) => item !== event) : [...current, event]);

  return (
    <div className="border-t border-line-hairline pt-3 space-y-3">
      <div>
        <h3 className="text-sm font-medium text-foreground-strong">{t("Raft notifications", "Raft 通知")}</h3>
        <p className="text-xs text-foreground-muted mt-1">
          {t("Choose the Raft channel and Hands events that this app should post. The bot key stays encrypted in Hands and is never shown here.", "选择此应用发送通知的 Raft 频道和 Hands 事件。Bot 密钥在 Hands 中加密保存，不会在此显示。")}
        </p>
        <p className="text-xs text-foreground-muted mt-1">
          {t("A Raft server owner/admin must grant the Hands App Bot. Connect it, add it to the target channel, choose events, and use Test to confirm delivery.", "Raft 服务器所有者或管理员必须授权 Hands App Bot。连接后将其加入目标频道，选择事件，再使用测试功能确认投递。")}{" "}
          <a className="underline" href={t("/docs/admin-user-guide/#raft-notifications", "/docs/zh/admin-user-guide/#raft-notifications")}>{t("Raft notification setup guide", "Raft 通知设置指南")}</a>
        </p>
        <p className="text-xs text-foreground-muted mt-1">
          {t("Feedback notifications can include an excerpt of user-submitted text. TestFlight notifications can include test group names and an excerpt of testing notes. Choose a channel whose members may see them.", "反馈通知可能包含用户提交文字的摘要。TestFlight 通知可能包含测试组名称和测试说明摘要。请选择成员可以查看这些内容的频道。")}
        </p>
        <p className="text-xs text-foreground-muted mt-1">
          {t("Release status cards update the same message when App Store, external TestFlight or Google Play status changes. Cards start with new objects; existing text threads stay as text. Updates do not send a new notification.", "App Store、外部 TestFlight 或 Google Play 状态变化时，版本状态卡片会更新同一条消息。卡片只用于新对象，现有文字线程继续使用文字；更新不会发送新通知。")}
        </p>
      </div>
      <div className="rounded-md bg-fill-muted p-3 flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs">
          <div className="font-medium">App Bot: {bot?.connected ? t("connected", "已连接") : t("not connected", "未连接")}</div>
          <div className="text-foreground-muted mt-1">
            {bot?.connected ? (bot.handle ? t(`Handle ${bot.handle}`, `账号 ${bot.handle}`) : t("The bot is ready to send.", "Bot 已准备好发送。")) : t("A Raft server owner/admin must grant the bot before connecting.", "连接前须由 Raft 服务器所有者或管理员授权 Bot。")}
          </div>
        </div>
        {!bot?.connected && <Button variant="outline" size="xs" onClick={() => connect.mutate()} disabled={connect.isPending}>{connect.isPending ? t("Connecting…", "连接中…") : t("Connect App Bot", "连接 App Bot")}</Button>}
      </div>
      {bot?.connected && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-64 flex-1">
              <Label htmlFor={`raft-channel-${appId}`}>{t("Target channel", "目标频道")}</Label>
              <Input id={`raft-channel-${appId}`} value={channelTarget} onChange={(event) => setChannelTarget(event.target.value)} placeholder="#proj-mobile-release" />
            </div>
            <Button variant="outline" size="xs" onClick={() => create.mutate()} disabled={!channelTarget.trim() || events.length === 0 || create.isPending}>{create.isPending ? t("Adding…", "添加中…") : t("Add destination", "添加目标")}</Button>
          </div>
          <div>
            <div className="text-xs font-medium mb-1">{t("Events", "事件")}</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-1">
              {WEBHOOK_EVENT_TYPES.map((event) => (
                <label key={event} className="flex items-center gap-2 text-xs text-foreground-muted">
                  <Checkbox checked={events.includes(event)} onCheckedChange={() => toggleEvent(event)} />
                  <span>{event}</span>
                </label>
              ))}
            </div>
          </div>
          {subscriptions.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-medium">{t("Configured destinations", "已配置的目标")}</div>
              {subscriptions.map((subscription) => (
                <RaftNotificationRow key={subscription.id} appId={appId} subscription={subscription} onToggle={(enabled) => update.mutate({ id: subscription.id, enabled })} onToggleCards={(card_updates) => updateCards.mutate({ id: subscription.id, card_updates })} onTest={() => test.mutate(subscription.id)} onDelete={() => { if (window.confirm(t(`Remove ${subscription.channel_target}?`, `移除 ${subscription.channel_target}？`))) remove.mutate(subscription.id); }} busy={update.isPending || updateCards.isPending || test.isPending || remove.isPending} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RaftNotificationRow({
  appId,
  subscription,
  onToggle,
  onToggleCards,
  onTest,
  onDelete,
  busy,
}: {
  appId: string;
  subscription: RaftNotificationSubscription;
  onToggle: (enabled: boolean) => void;
  onToggleCards: (enabled: boolean) => void;
  onTest: () => void;
  onDelete: () => void;
  busy: boolean;
}) {
  const t = useText();
  const { locale } = useLocale();
  const qc = useQueryClient();
  const toast = useToast();
  const failures = useQuery({
    queryKey: ["raft-notification-failures", appId, subscription.id],
    queryFn: () => listRaftNotificationFailures(appId, subscription.id),
  });
  const retry = useMutation({
    mutationFn: (id: string) => retryRaftNotificationFailure(appId, subscription.id, id),
    onSuccess: () => {
      toast.show({ kind: "success", title: t("Retry scheduled", "已安排重试"), description: t("Hands will retry when the delivery service next runs.", "投递服务下次运行时，Hands 将重试。") });
      void qc.invalidateQueries({ queryKey: ["raft-notification-failures", appId, subscription.id] });
    },
    onError: (error) => toast.show({ kind: "error", title: t("Could not retry notification", "无法重试通知"), description: errorMessage(error) }),
  });
  return (
    <div className="rounded-md border border-line-hairline p-2 flex flex-wrap items-center gap-2">
      <div className="min-w-48 flex-1">
        <div className="font-mono text-xs">{subscription.channel_target}</div>
        <div className="text-[11px] text-foreground-muted mt-1">{t(`${subscription.events.length} event${subscription.events.length === 1 ? "" : "s"}`, `${subscription.events.length} 个事件`)}</div>
      </div>
      <Badge variant={subscription.enabled ? "success" : "muted"}>{subscription.enabled ? t("enabled", "已启用") : t("disabled", "已停用")}</Badge>
      <Button variant="ghost" size="xs" onClick={() => onToggleCards(!subscription.card_updates)} disabled={busy}>{subscription.card_updates ? t("Use text", "使用文字") : t("Use status cards", "使用状态卡片")}</Button>
      <Button variant="ghost" size="xs" onClick={() => onToggle(!subscription.enabled)} disabled={busy}>{subscription.enabled ? t("Disable", "停用") : t("Enable", "启用")}</Button>
      <Button variant="ghost" size="xs" onClick={onTest} disabled={busy || !subscription.enabled}>{t("Test", "测试")}</Button>
      <Button variant="ghost" size="xs" onClick={onDelete} disabled={busy}>{t("Remove", "移除")}</Button>
      {failures.isError && <div className="w-full text-xs text-foreground-muted">{t("Could not load failed notifications.", "无法加载失败的通知。")}</div>}
      {failures.data?.failures.map((failure) => (
        <div key={failure.id} className="w-full flex flex-wrap items-center gap-2 text-xs text-foreground-muted">
          <span>{t("Failed:", "失败：")} {failure.event_type} · {new Date(failure.created_at).toLocaleString(locale)}</span>
          <Button variant="ghost" size="xs" onClick={() => retry.mutate(failure.id)} disabled={busy || retry.isPending || !subscription.enabled}>{t("Retry", "重试")}</Button>
        </div>
      ))}
    </div>
  );
}

function AppTransferPanel({ appId, app, orgs }: { appId: string; app: App; orgs: Array<{ id: string; name: string; slug: string; archived: number; org_role?: "owner" | "admin" | "member" | "viewer" }> }) {
  const t = useText();
  const toast = useToast(); const qc = useQueryClient();
  const [target, setTarget] = useState(""); const [confirm, setConfirm] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const transfer = useMutation({
    mutationFn: () => transferApp(appId, { target_org_id: target, expected_source_org_id: app.org_id ?? "", idempotency_key: idempotencyKey }),
    onSuccess: () => { toast.show({ kind: "success", title: t("App transferred", "应用已转移") }); setConfirm(""); setIdempotencyKey(crypto.randomUUID()); void qc.invalidateQueries({ queryKey: ["apps"] }); },
    onError: (e) => toast.show({ kind: "error", title: t("Transfer failed", "转移失败"), description: errorMessage(e) }),
  });
  const eligible = orgs.filter((o) => !o.archived && o.id !== app.org_id && o.org_role !== "viewer");
  return <div className="border-t border-line-hairline pt-3"><h3 className="text-sm font-medium text-foreground-strong mb-1">{t("Transfer app", "转移应用")}</h3><p className="text-xs text-foreground-muted mb-2">{t("Preserves this app ID and all releases, builds, channels, and history. You need to be an admin or owner of the organization that owns this app, and a member of the target organization; its admins can access the app after transfer.", "保留应用 ID 及所有版本、构建、渠道和历史记录。你需要是此应用所属组织的 admin 或 owner，并且是目标组织的成员；转移后目标组织的管理员可以访问此应用。")}</p><div className="flex flex-wrap items-center gap-2"><Select items={{ none: t("Select target organization…", "选择目标组织…"), ...Object.fromEntries(eligible.map((o) => [o.id, `${o.name} (${o.slug})`])) }} value={target || "none"} onValueChange={(value) => setTarget(value === "none" ? "" : String(value))}><SelectTrigger className="w-full sm:w-64" aria-label={t("Select target organization", "选择目标组织")} disabled={transfer.isPending}><SelectValue /><SelectIcon /></SelectTrigger><SelectContent>
    <SelectList><SelectItem value="none">{t("Select target organization…", "选择目标组织…")}</SelectItem>{eligible.map((o) => <SelectItem key={o.id} value={o.id}>{o.name} ({o.slug})</SelectItem>)}</SelectList>
  </SelectContent></Select><Input className="w-full sm:w-56" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={t(`Type ${app.slug} to confirm`, `输入 ${app.slug} 以确认`)} disabled={!target || transfer.isPending} /><Button variant="outline" size="xs" disabled={!target || confirm !== app.slug || !app.org_id || transfer.isPending} onClick={() => transfer.mutate()}>{transfer.isPending ? t("Transferring…", "转移中…") : t("Transfer", "转移")}</Button></div></div>;
}

function DefaultChannelPicker({
  appId,
  app,
  isOrgAdmin,
}: {
  appId: string;
  app:
    | (App & {
        default_channel_id?: string | null;
        default_channel_slug?: string | null;
        default_channel_name?: string | null;
      })
    | undefined;
  isOrgAdmin: boolean;
}) {
  const t = useText();
  const qc = useQueryClient();
  const toast = useToast();
  const channels = useQuery({
    queryKey: ["channels", appId],
    queryFn: () => listChannels(appId),
  });
  const [selected, setSelected] = useState<string | null>(
    app?.default_channel_id ?? null,
  );
  useEffect(() => {
    setSelected(app?.default_channel_id ?? null);
  }, [app?.default_channel_id]);

  const save = useMutation({
    mutationFn: () => updateApp(appId, { default_channel_id: selected }),
    onSuccess: () => {
      toast.show({
        kind: "success",
        title: selected
          ? t("Default release channel updated", "默认发布渠道已更新")
          : t("Default channel cleared (will fall back to first channel)", "已清除默认渠道（将回退到第一个渠道）"),
      });
      qc.invalidateQueries({ queryKey: ["apps"] });
      qc.invalidateQueries({ queryKey: ["app-detail", appId] });
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: t("Save failed", "保存失败"),
        description: errorMessage(e),
      }),
  });

  const dirty = selected !== (app?.default_channel_id ?? null);

  return (
    <div className="border-t border-line-hairline pt-3">
      <h3 className="text-sm font-medium text-foreground-strong mb-2">
        {t("Default release channel", "默认发布渠道")}
      </h3>
      <p className="text-xs text-foreground-muted mb-2">
        {t("Pre-fills the channel dropdown in the New Release dialog. Falls back to the first channel (by created_at) if unset.", "预填新建版本对话框中的渠道。未设置时使用按创建时间排列的第一个渠道。")}
      </p>
      <div className="flex flex-col gap-2 md:flex-row md:items-center">
        <Select
          items={{
            "": t("— none (use first channel) —", "— 未设置（使用第一个渠道）—"),
            ...Object.fromEntries(
              (channels.data?.channels ?? []).map((c: Channel) => [
                c.id,
                `${c.slug} (${c.name})`,
              ]),
            ),
          }}
          value={selected ?? ""}
          onValueChange={(v) => setSelected((v as string) || null)}
          disabled={!isOrgAdmin || save.isPending}
        >
          <SelectTrigger className="text-sm flex-1">
            <SelectValue />
            <SelectIcon />
          </SelectTrigger>
          <SelectContent>
            <SelectList>
            <SelectItem value="">{t("— none (use first channel) —", "— 未设置（使用第一个渠道）—")}</SelectItem>
            {channels.data?.channels.map((c: Channel) => (
              <SelectItem key={c.id} value={c.id}>
                {c.slug} ({c.name})
              </SelectItem>
            ))}
          </SelectList>
          </SelectContent>
        </Select>
        {isOrgAdmin && (
          <Button
            variant="primary"
            size="xs"
            onClick={() => save.mutate()}
            disabled={!dirty || save.isPending}
          >
            {save.isPending ? t("Saving…", "保存中…") : t("Save", "保存")}
          </Button>
        )}
      </div>
      {!isOrgAdmin && (
        <p className="text-xs text-warning-strong mt-2">
          {t("⚠ Org owner / admin required to change settings.", "⚠ 修改设置需要组织所有者或管理员权限。")}
        </p>
      )}
    </div>
  );
}

function CreateChannelDialog({
  appId,
  onClose,
  onCreated,
}: {
  appId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const t = useText();
  const [slug, setSlug] = useState("main");
  const [name, setName] = useState("Main");
  const [bundleId, setBundleId] = useState("");
  const toast = useToast();

  const create = useMutation({
    mutationFn: () =>
      createChannel(appId, {
        slug,
        name,
        bundle_id: bundleId.trim() || undefined,
      }),
    onSuccess: () => {
      toast.show({ kind: "success", title: t(`Channel '${slug}' created`, `渠道“${slug}”已创建`) });
      onCreated();
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: t("Failed to create channel", "创建渠道失败"),
        description: errorMessage(e),
      }),
  });

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("New channel", "新建渠道")}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <form
            id="create-channel-form"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
            className="space-y-3"
          >
            <div>
              <Label>{t("Slug", "标识")}</Label>
              <Input
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                required
              />
            </div>
            <div>
              <Label>{t("Name", "名称")}</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <div>
              <Label>{t("Bundle ID override (optional)", "覆盖 Bundle ID（可选）")}</Label>
              <Input
                className="font-mono text-xs"
                value={bundleId}
                onChange={(e) => setBundleId(e.target.value)}
                placeholder="com.example.myapp.beta"
              />
            </div>
          </form>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("Cancel", "取消")}
          </Button>
          <Button
            type="submit"
            form="create-channel-form"
            variant="primary"
            disabled={create.isPending}
          >
            {create.isPending ? t("Creating...", "创建中…") : t("Create", "创建")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ChannelRow({
  channel: c,
  onEdit,
  busy,
}: {
  channel: Channel;
  onEdit: () => void;
  busy: boolean;
}) {
  const t = useText();
  return (
    <section className="border-t border-line-hairline pt-3 flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium">{c.name}</span>
          <span className="text-xs font-mono text-foreground-muted">{c.slug}</span>
          {c.bundle_id && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Badge variant="information" className="font-mono">
                    {c.bundle_id}
                  </Badge>
                }
              />
              <TooltipContent>{t("Bundle ID override", "覆盖的 Bundle ID")}</TooltipContent>
            </Tooltip>
          )}
          {c.password && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Badge variant="warning">{t("🔒 gated", "🔒 受保护")}</Badge>
                }
              />
              <TooltipContent>{t("Downloads require password", "下载需要密码")}</TooltipContent>
            </Tooltip>
          )}
          {c.git_url && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <a
                    className="text-xs text-info-strong hover:underline font-mono truncate max-w-xs"
                    href={c.git_url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {c.git_url}
                  </a>
                }
              />
              <TooltipContent>{c.git_url}</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
      <Button
        variant="outline"
        onClick={onEdit}
        disabled={busy}
      >
        {t("Edit", "编辑")}
      </Button>
    </section>
  );
}

function EditChannelDialog({
  appId,
  app,
  channel,
  onClose,
  onSaved,
}: {
  appId: string;
  app:
    | (App & {
        default_channel_id?: string | null;
        default_channel_slug?: string | null;
        default_channel_name?: string | null;
      })
    | null
    | undefined;
  channel: Channel;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useText();
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(channel.name);
  const [bundleId, setBundleId] = useState(channel.bundle_id ?? "");
  const [password, setPassword] = useState(channel.password ?? "");
  const [gitUrl, setGitUrl] = useState(channel.git_url ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [typedConfirm, setTypedConfirm] = useState("");

  const save = useMutation({
    mutationFn: () =>
      updateChannel(appId, channel.id, {
        name,
        bundle_id: bundleId.trim() || null,
        password: password.trim() || null,
        git_url: gitUrl.trim() || null,
      }),
    onSuccess: () => {
      toast.show({ kind: "success", title: t(`Channel '${channel.slug}' saved`, `渠道“${channel.slug}”已保存`) });
      onSaved();
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: t("Save failed", "保存失败"),
        description: errorMessage(e),
      }),
  });

  const remove = useMutation({
    mutationFn: () => deleteChannel(appId, channel.id),
    onSuccess: () => {
      toast.show({ kind: "success", title: t(`Channel '${channel.slug}' deleted`, `渠道“${channel.slug}”已删除`) });
      onSaved();
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: t("Delete failed", "删除失败"),
        description: errorMessage(e),
      }),
  });

  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => { if (!open) onClose(); }}
      >
        {/* z-10 keeps this dialog below the nested delete-confirm (z-20),
            matching the original hand-rolled stacking. */}
        <DialogContent className="max-w-md z-10" overlay={{ className: "z-10" }}>
          <DialogHeader>
            <DialogTitle>{t(`Edit channel '${channel.slug}'`, `编辑渠道“${channel.slug}”`)}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <form
              id="edit-channel-form"
              onSubmit={(e) => {
                e.preventDefault();
                save.mutate();
              }}
              className="space-y-3"
            >
              <div>
                <Label>{t("Slug (immutable)", "标识（不可更改）")}</Label>
                <Input
                  className="font-mono text-xs bg-layer-inset"
                  value={channel.slug}
                  readOnly
                />
              </div>
              <div>
                <Label>{t("Name", "名称")}</Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>
              <div>
                <Label>{t("Bundle ID override", "覆盖 Bundle ID")}</Label>
                <Input
                  className="font-mono text-xs"
                  value={bundleId}
                  onChange={(e) => setBundleId(e.target.value)}
                  placeholder="com.example.myapp.beta"
                />
              </div>
              <div>
                <Label>{t("Download password", "下载密码")}</Label>
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={t("leave blank for no gate", "留空则无需密码")}
                />
              </div>
              <div>
                <Label>{t("Git URL", "Git 地址")}</Label>
                <Input
                  className="font-mono text-xs"
                  value={gitUrl}
                  onChange={(e) => setGitUrl(e.target.value)}
                  placeholder="https://github.com/foo/bar/tree/beta"
                />
              </div>
            </form>
          </DialogBody>
          <DialogFooter className="justify-between">
            <Button
              type="button"
              variant="danger-outline"
              onClick={() => setConfirmDelete(true)}
              disabled={save.isPending || remove.isPending}
            >
              {t("Delete channel", "删除渠道")}
            </Button>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={onClose}
              >
                {t("Cancel", "取消")}
              </Button>
              <Button
                type="submit"
                form="edit-channel-form"
                variant="primary"
                disabled={save.isPending}
              >
                {save.isPending ? t("Saving…", "保存中…") : t("Save", "保存")}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Channel delete confirmation (typed-confirm + default-channel warning) */}
      <ConfirmActionDialog
        open={confirmDelete}
        title={t("Delete channel?", "删除渠道？")}
        objectLabel={channel.slug}
        objectHint={`id: ${channel.id.slice(0, 8)}…`}
        objectSummary={
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 font-mono">
            <div className="text-foreground-muted">slug</div>
            <div>{channel.slug}</div>
            <div className="text-foreground-muted">{t("name", "名称")}</div>
            <div>{channel.name}</div>
            <div className="text-foreground-muted">bundle_id</div>
            <div>{channel.bundle_id ?? "—"}</div>
          </div>
        }
        body={
          <>
            {t("Deleting this channel removes it from this app.", "删除渠道会将其从此应用移除。")} {" "}
            <strong>
              {t("All releases pointing at this channel must be cancelled or moved first", "必须先取消或转移所有指向此渠道的版本")}
            </strong>{" "}
            {t("— otherwise the public API will start 404'ing your clients.", "，否则公开 API 将对客户端返回 404。")}
            {app?.default_channel_id === channel.id && (
              <div className="mt-2 p-2 bg-warning-soft border border-warning/30 rounded-sm text-xs text-warning-strong">
                {t("⚠ This is the app's", "⚠ 这是应用的")} <strong>{t("default release channel", "默认发布渠道")}</strong>{t(". After deletion, the New Release wizard will fall back to the first channel by created_at.", "。删除后，新建版本向导将使用按创建时间排列的第一个渠道。")}
              </div>
            )}
            <TypedConfirmField
              required={channel.slug}
              value={typedConfirm}
              onChange={setTypedConfirm}
            />
          </>
        }
        confirmLabel={t("Delete channel", "删除渠道")}
        cancelLabel={t("Keep channel", "保留渠道")}
        confirmKind="danger"
        confirmDisabled={typedConfirm !== channel.slug}
        pending={remove.isPending}
        onCancel={() => {
          setConfirmDelete(false);
          setTypedConfirm("");
        }}
        onConfirm={() => {
          remove.mutate();
          setConfirmDelete(false);
          setTypedConfirm("");
        }}
      />
    </>
  );
}
