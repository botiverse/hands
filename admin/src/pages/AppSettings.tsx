/**
 * App › Settings — one setting per row, grouped in sections (design:
 * patterns/forms). Switches and selects apply at once and say nothing on
 * success; a failed change puts the control back and shows its line under
 * the row. Text waits for Save. Device groups and Raft destinations are
 * rows that open beside the page. Access follows, then the danger zone at
 * the end.
 */
import { errorMessage } from "../lib/errorMessage";
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  ListRow,
  ListRowBody,
  ListRowChevron,
  ListRowDescription,
  ListRowGroup,
  ListRowIcon,
  ListRowMeta,
  ListRowSubtitle,
  ListRowTitle,
  Select,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectList,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Switch,
  Text,
  TextLink,
  TextLinkExternalIcon,
  Textarea,
} from "@botiverse/raft-ui";
import { SaveStatus, SaveStatusError } from "@botiverse/raft-ui/wip";
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  ArrowRightLeft,
  Bell,
  Globe,
  MessageSquare,
  Plus,
  Rocket,
  Settings as SettingsIcon,
  SlidersHorizontal,
  Smartphone,
  Trash2,
} from "lucide-react";
import type { ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { ConfirmActionDialog } from "../components/ConfirmActionDialog";
import { DetailColumn, DetailSection } from "../components/ListPage";
import { SectionNote, SettingsPage, SettingsSection } from "../components/SettingsPage";
import {
  archiveApp,
  getAuthMe,
  listApps,
  listChannels,
  updateApp,
  type App,
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
import { deviceGroupUpdatePayload } from "../lib/deviceGroupForm";
import { useLocale, useText } from "../lib/locale";
import { AppAccess } from "./AppAccess";

type Opened = { kind: "group" | "destination"; id: string } | null;

export function AppSettings({ appId }: { appId: string }) {
  const t = useText();
  const apps = useQuery({ queryKey: ["apps"], queryFn: listApps });
  const app = apps.data?.apps.find((a) => a.id === appId);
  const me = useQuery({ queryKey: ["auth-me"], queryFn: () => getAuthMe() });
  const orgRole = me.data?.account.org_role ?? null;
  const isOrgAdmin = orgRole === "owner" || orgRole === "admin";
  const [opened, setOpened] = useState<Opened>(null);
  const close = () => setOpened(null);

  const aside = opened?.kind === "group"
    ? <DeviceGroupColumn key={opened.id} appId={appId} groupId={opened.id} onClose={close} />
    : opened?.kind === "destination"
      ? <DestinationColumn key={opened.id} appId={appId} subscriptionId={opened.id} onClose={close} />
      : null;

  return (
    <SettingsPage
      icon={<SettingsIcon aria-hidden="true" />}
      title={t("Settings", "设置")}
      meta={app?.name}
      busy={apps.isLoading}
      aside={aside}
    >
      {apps.isLoading && <Skeleton className="h-40 w-full" />}
      {app && (
        <>
          <GeneralSection appId={appId} app={app} />
          <ReleasesSection appId={appId} app={app} isOrgAdmin={isOrgAdmin} />
          <PublicPagesSection appId={appId} app={app} />
          <ReportsSection appId={appId} app={app} />
          <DeviceGroupsSection
            appId={appId}
            openId={opened?.kind === "group" ? opened.id : null}
            onOpen={(id) => setOpened({ kind: "group", id })}
          />
          <RaftNotificationsSection
            appId={appId}
            openId={opened?.kind === "destination" ? opened.id : null}
            onOpen={(id) => setOpened({ kind: "destination", id })}
          />
          <AppAccess appId={appId} />
          <DangerZone appId={appId} app={app} isOrgAdmin={isOrgAdmin} />
        </>
      )}
    </SettingsPage>
  );
}

// --- Rows -------------------------------------------------------------------

/** A setting that applies at once: its title, what it does, the line that
 *  shows when the change failed, and the switch at the row's end. */
function SwitchRow({
  title,
  description,
  checked,
  disabled,
  error,
  onCheckedChange,
}: {
  title: string;
  description: ReactNode;
  checked: boolean;
  disabled?: boolean;
  error?: string | null;
  onCheckedChange: (next: boolean) => void;
}) {
  const id = useId();
  return (
    <ListRow variant="plain" interactive={false}>
      <ListRowBody>
        <ListRowTitle id={`${id}-title`}>{title}</ListRowTitle>
        <ListRowDescription id={`${id}-description`} wrap>{description}</ListRowDescription>
        <SaveStatus id={`${id}-status`}>{error && <SaveStatusError>{error}</SaveStatusError>}</SaveStatus>
      </ListRowBody>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description ${id}-status`}
      />
    </ListRow>
  );
}

const failed = (error: unknown, t: ReturnType<typeof useText>) =>
  error ? t(`Not saved: ${errorMessage(error)}`, `未保存：${errorMessage(error)}`) : null;

// --- General ----------------------------------------------------------------

function GeneralSection({ appId, app }: { appId: string; app: App }) {
  const t = useText();
  return (
    <SettingsSection id="settings-general" icon={<SlidersHorizontal />} title={t("General", "常规")}>
      <ListRowGroup className="@container">
        <AppIconRow appId={appId} slug={app.slug} />
        <AppNameRow appId={appId} app={app} />
        <AppDescriptionRow appId={appId} app={app} />
      </ListRowGroup>
    </SettingsSection>
  );
}

function AppIconRow({ appId, slug }: { appId: string; slug: string }) {
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
      toast.show({ kind: "error", title: t("Icon upload failed", "图标上传失败"), description: errorMessage(e) }),
  });
  return (
    <ListRow variant="plain" interactive={false}>
      <span className="size-11 shrink-0 overflow-hidden rounded-lg border border-line-hairline bg-layer-inset">
        <img
          src={`${publicAppIconUrl(slug)}${bust ? `?v=${bust}` : ""}`}
          alt=""
          width={44}
          height={44}
          className="size-full object-cover"
          onError={(e) => {
            (e.target as HTMLImageElement).style.visibility = "hidden";
          }}
          onLoad={(e) => {
            (e.target as HTMLImageElement).style.visibility = "visible";
          }}
        />
      </span>
      <ListRowBody>
        <ListRowTitle>{t("App icon", "应用图标")}</ListRowTitle>
        <ListRowDescription wrap>
          {t("Shown on share and download pages. PNG, WebP or JPEG, up to 1 MB.", "显示在分享和下载页面。支持 PNG、WebP、JPEG，最大 1 MB。")}
        </ListRowDescription>
      </ListRowBody>
      <Button variant="outline" loading={upload.isPending} render={<label className="cursor-pointer" />} nativeButton={false}>
        {t("Upload", "上传")}
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
    </ListRow>
  );
}

function AppNameRow({ appId, app }: { appId: string; app: App }) {
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
    <ListRow variant="plain" interactive={false} className="flex-wrap">
      <ListRowBody>
        <ListRowTitle id="app-name-title">{t("Name", "名称")}</ListRowTitle>
        <ListRowDescription wrap>
          {t("Shown in the console and on share pages. The slug ", "显示在控制台和分享页面。应用标识 ")}
          <span className="font-mono">{app.slug}</span>
          {t(" never changes: SDKs and CI use it.", " 不会改变，SDK 和 CI 会使用它。")}
        </ListRowDescription>
      </ListRowBody>
      <div className="flex w-full basis-full items-center gap-2 @lg:w-auto @lg:basis-auto">
        <Input
          aria-labelledby="app-name-title"
          className="min-w-0 flex-1 @lg:w-56 @lg:flex-none"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && dirty && !rename.isPending) rename.mutate();
          }}
        />
        <Button variant="outline" loading={rename.isPending} disabled={!dirty || rename.isPending} onClick={() => rename.mutate()}>
          {t("Save", "保存")}
        </Button>
      </div>
    </ListRow>
  );
}

function AppDescriptionRow({ appId, app }: { appId: string; app: App }) {
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
    <ListRow variant="plain" interactive={false} className="flex-col items-stretch">
      <ListRowBody>
        <ListRowTitle id="app-description-title">{t("Description", "描述")}</ListRowTitle>
        <ListRowDescription wrap>
          {t("A note for your team about what this app is. Shown in the app list, not on public pages.", "给团队看的应用说明。显示在应用列表中，不显示在公开页面。")}
        </ListRowDescription>
      </ListRowBody>
      <Textarea
        aria-labelledby="app-description-title"
        className="min-h-16 w-full resize-y"
        value={description}
        placeholder={t("What is this app?", "这个应用有什么用途？")}
        onChange={(e) => setDescription(e.target.value)}
      />
      <div>
        <Button variant="outline" loading={save.isPending} disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
          {t("Save", "保存")}
        </Button>
      </div>
    </ListRow>
  );
}

// --- Releases ---------------------------------------------------------------

function ReleasesSection({ appId, app, isOrgAdmin }: { appId: string; app: App; isOrgAdmin: boolean }) {
  const t = useText();
  return (
    <SettingsSection id="settings-releases" icon={<Rocket />} title={t("Releases", "版本发布")}>
      <ListRowGroup className="@container">
        <DefaultChannelRow appId={appId} app={app} isOrgAdmin={isOrgAdmin} />
        {/* Release human-approval gate (task #239): mobile platforms */}
        {["ios", "android", "ohos"].includes(app.platform) && <ReleaseApprovalRow appId={appId} app={app} />}
        {/* Delta/differential updates: Android apps only */}
        {app.platform === "android" && <DeltaUpdatesRow appId={appId} app={app} />}
      </ListRowGroup>
    </SettingsSection>
  );
}

const NO_DEFAULT = "__first__";

function DefaultChannelRow({ appId, app, isOrgAdmin }: { appId: string; app: App; isOrgAdmin: boolean }) {
  const t = useText();
  const qc = useQueryClient();
  const channels = useQuery({ queryKey: ["channels", appId], queryFn: () => listChannels(appId) });
  const current = app.default_channel_id ?? null;
  const [selected, setSelected] = useState<string | null>(current);
  useEffect(() => setSelected(current), [current]);
  const save = useMutation({
    mutationFn: (next: string | null) => updateApp(appId, { default_channel_id: next }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["apps"] });
      qc.invalidateQueries({ queryKey: ["app-detail", appId] });
    },
    // Put the select back to the stored value: it never shows one that isn't true.
    onError: () => setSelected(current),
  });
  const list = channels.data?.channels ?? [];
  const items = {
    [NO_DEFAULT]: t("First channel", "第一个渠道"),
    ...Object.fromEntries(list.map((c) => [c.id, c.name])),
  };
  return (
    <ListRow variant="plain" interactive={false} className="@max-lg:flex-wrap">
      <ListRowBody>
        <ListRowTitle id="default-channel-title">{t("Default channel", "默认渠道")}</ListRowTitle>
        <ListRowDescription id="default-channel-description" wrap>
          {isOrgAdmin
            ? t("New release starts on this channel. With none set, the oldest channel.", "新建版本时默认选择此渠道。未设置时使用最早创建的渠道。")
            : t("New release starts on this channel. Only an organization owner or admin can change it.", "新建版本时默认选择此渠道。只有组织所有者或管理员可以修改。")}
        </ListRowDescription>
        <SaveStatus id="default-channel-status">
          {save.error && <SaveStatusError>{failed(save.error, t)}</SaveStatusError>}
        </SaveStatus>
      </ListRowBody>
      <div className="shrink-0 @max-lg:basis-full">
        <Select
          items={items}
          value={selected ?? NO_DEFAULT}
          onValueChange={(v) => {
            const next = !v || v === NO_DEFAULT ? null : String(v);
            setSelected(next);
            save.mutate(next);
          }}
          disabled={!isOrgAdmin || save.isPending}
        >
          <SelectTrigger
            className="w-44 max-w-sm @max-lg:w-full"
            aria-labelledby="default-channel-title"
            aria-describedby="default-channel-description default-channel-status"
          >
            <SelectValue />
            <SelectIcon />
          </SelectTrigger>
          <SelectContent>
            <SelectList>
              <SelectItem value={NO_DEFAULT}>{t("First channel", "第一个渠道")}</SelectItem>
              {list.map((c) => (
                <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
              ))}
            </SelectList>
          </SelectContent>
        </Select>
      </div>
    </ListRow>
  );
}

function DeltaUpdatesRow({ appId, app }: { appId: string; app: App }) {
  const t = useText();
  const qc = useQueryClient();
  const enabled = Boolean(app.delta_updates_enabled);
  const toggle = useMutation({
    mutationFn: (next: boolean) => updateAppDeltaUpdates(appId, next),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["apps"] }),
  });
  return (
    <SwitchRow
      title={t("Delta updates", "增量更新")}
      description={t("On publish, Hands makes small patches from recent versions, so people on them download less to update.", "发布时根据近期版本生成差分补丁，使用这些版本的用户更新时下载更少。")}
      checked={enabled}
      disabled={toggle.isPending}
      error={failed(toggle.error, t)}
      onCheckedChange={(next) => toggle.mutate(next)}
    />
  );
}

function ReleaseApprovalRow({ appId, app }: { appId: string; app: App }) {
  const t = useText();
  const qc = useQueryClient();
  const enabled = Boolean(app.release_requires_human_approval);
  const toggle = useMutation({
    mutationFn: (next: boolean) => updateAppReleaseApproval(appId, next),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["apps"] }),
  });
  return (
    <SwitchRow
      title={t("Approve agent releases", "审批智能体发布")}
      description={t("A release an agent publishes with a deploy token waits until an app or organization admin approves it. Releases you publish here never wait.", "智能体用部署令牌发布的版本，须等应用或组织管理员批准后才会生效。您在这里发布的版本不受影响。")}
      checked={enabled}
      disabled={toggle.isPending}
      error={failed(toggle.error, t)}
      onCheckedChange={(next) => toggle.mutate(next)}
    />
  );
}

// --- Public pages -------------------------------------------------------------

function PublicPagesSection({ appId, app }: { appId: string; app: App }) {
  const t = useText();
  const qc = useQueryClient();
  const enabled = Boolean(app.public_history);
  const showDownloads = app.history_show_downloads !== 0;
  const channelsQuery = useQuery({ queryKey: ["channels", appId], queryFn: () => listChannels(appId) });
  // history_channels is a JSON array of slugs; null/empty = all channels shown.
  const selectedChannels: string[] = (() => {
    try {
      const parsed = app.history_channels ? JSON.parse(app.history_channels) : null;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  })();
  const refresh = () => qc.invalidateQueries({ queryKey: ["apps"] });
  const toggle = useMutation({
    mutationFn: (next: boolean) => updateAppPublicHistory(appId, next),
    onSuccess: refresh,
  });
  const channelsMutation = useMutation({
    mutationFn: (slugs: string[]) => updateAppHistoryChannels(appId, slugs.length ? slugs : null),
    onSuccess: refresh,
  });
  const downloadsToggle = useMutation({
    mutationFn: (next: boolean) => updateAppHistoryDownloads(appId, next),
    onSuccess: refresh,
  });
  const toggleChannel = (slug: string) => {
    const next = selectedChannels.includes(slug)
      ? selectedChannels.filter((s) => s !== slug)
      : [...selectedChannels, slug];
    channelsMutation.mutate(next);
  };
  const link = (path: string) => (
    <TextLink render={<a href={path} target="_blank" rel="noopener noreferrer" />} nativeButton={false} className="font-mono">
      {path}
      <TextLinkExternalIcon label={t("(opens in a new tab)", "（在新标签页打开）")} />
    </TextLink>
  );

  return (
    <SettingsSection id="settings-public" icon={<Globe />} title={t("Public pages", "公开页面")}>
      <ListRowGroup>
        <SwitchRow
          title={t("Version history", "版本历史")}
          description={
            enabled ? (
              <>
                {t("Anyone can read the notes and download published versions at ", "任何人都可以在这里查看更新说明并下载已发布版本：")}
                {link(`/apps/${app.slug}/history`)}
                {t(" and the latest at ", "，最新版本：")}
                {link(`/apps/${app.slug}/latest`)}
              </>
            ) : (
              t("A public page of published versions with their notes and downloads.", "公开展示已发布版本、更新说明和下载链接的页面。")
            )
          }
          checked={enabled}
          disabled={toggle.isPending}
          error={failed(toggle.error, t)}
          onCheckedChange={(next) => toggle.mutate(next)}
        />
        {enabled && (
          <ListRow variant="plain" interactive={false} attached role="group" aria-labelledby="history-channels-title">
            <ListRowBody>
              <ListRowTitle id="history-channels-title">{t("Channels shown", "显示的渠道")}</ListRowTitle>
              <ListRowDescription wrap>{t("With none checked, every channel.", "都不勾选时显示全部渠道。")}</ListRowDescription>
              <span className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
                {(channelsQuery.data?.channels ?? []).map((ch) => (
                  <label key={ch.id} className="flex items-center gap-2 text-callout">
                    <Checkbox
                      checked={selectedChannels.includes(ch.slug)}
                      disabled={channelsMutation.isPending}
                      onCheckedChange={() => toggleChannel(ch.slug)}
                    />
                    <span className="font-mono">{ch.slug}</span>
                  </label>
                ))}
              </span>
              <SaveStatus>{channelsMutation.error && <SaveStatusError>{failed(channelsMutation.error, t)}</SaveStatusError>}</SaveStatus>
            </ListRowBody>
          </ListRow>
        )}
        {enabled && (
          <SwitchRow
            title={t("Download buttons", "下载按钮")}
            description={t("Each version on the history, notes and latest pages has its download button. Off, the downloads answer 404.", "历史、更新说明和最新版本页面上每个版本都显示下载按钮。关闭后下载地址返回 404。")}
            checked={showDownloads}
            disabled={downloadsToggle.isPending}
            error={failed(downloadsToggle.error, t)}
            onCheckedChange={(next) => downloadsToggle.mutate(next)}
          />
        )}
      </ListRowGroup>
    </SettingsSection>
  );
}

// --- Feedback and crash reports ------------------------------------------------

function ReportsSection({ appId, app }: { appId: string; app: App }) {
  const t = useText();
  return (
    <SettingsSection id="settings-reports" icon={<MessageSquare />} title={t("Feedback and crash reports", "反馈和崩溃报告")}>
      <ListRowGroup className="@container">
        <ClientKeyRow appId={appId} />
        {app.platform === "ios" && <FeedbackBuildFilterRow appId={appId} />}
      </ListRowGroup>
    </SettingsSection>
  );
}

function ClientKeyRow({ appId }: { appId: string }) {
  const t = useText();
  const toast = useToast();
  const qc = useQueryClient();
  const [revealed, setRevealed] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const keyQuery = useQuery({ queryKey: ["client-key", appId], queryFn: () => getAppClientKey(appId) });
  const rotate = useMutation({
    mutationFn: () => rotateAppClientKey(appId),
    onSuccess: () => {
      setConfirmRotate(false);
      toast.show({ kind: "success", title: t("Client key rotated. Update your client configs.", "客户端密钥已轮换，请更新客户端配置。") });
      qc.invalidateQueries({ queryKey: ["client-key", appId] });
    },
    onError: (e) =>
      toast.show({ kind: "error", title: t("Rotate failed", "轮换失败"), description: errorMessage(e) }),
  });
  const key = keyQuery.data?.client_key ?? null;
  return (
    <ListRow variant="plain" interactive={false} className="@max-lg:flex-wrap">
      <ListRowBody>
        <ListRowTitle>{t("Client key", "客户端密钥")}</ListRowTitle>
        <ListRowDescription wrap>
          {t("Feedback and crash reports carry it in X-Hands-Client-Key (the older X-Quiver-Client-Key still works). It ships inside your builds; rotate it if it leaks.", "反馈和崩溃报告通过 X-Hands-Client-Key 携带此密钥（旧版 X-Quiver-Client-Key 仍可用）。密钥随构建分发，泄露时请轮换。")}
        </ListRowDescription>
        {key && revealed && <span className="mt-1 block font-mono text-footnote break-all">{key}</span>}
        {!key && !keyQuery.isLoading && (
          <span className="mt-1 block">
            <Badge appearance="soft" variant="warning">
              {t("No key: reports are accepted without one", "未设置密钥：报告无需密钥即可提交")}
            </Badge>
          </span>
        )}
      </ListRowBody>
      <div className="flex shrink-0 flex-wrap gap-2 @max-lg:basis-full">
        {key && (
          <>
            <Button variant="outline" onClick={() => setRevealed((v) => !v)}>
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
        <Button variant="outline" disabled={rotate.isPending} onClick={() => (key ? setConfirmRotate(true) : rotate.mutate())}>
          {key ? t("Rotate", "轮换") : t("Generate", "生成")}
        </Button>
      </div>
      <ConfirmActionDialog
        open={confirmRotate}
        title={t("Rotate the client key?", "轮换客户端密钥？")}
        objectLabel={t("Client key", "客户端密钥")}
        body={t("Builds that carry the current key stop reporting until they ship with the new one.", "携带当前密钥的构建将无法上报，直到更新为新密钥。")}
        confirmLabel={t("Rotate key", "轮换密钥")}
        confirmKind="warning"
        pending={rotate.isPending}
        onConfirm={() => rotate.mutate()}
        onCancel={() => setConfirmRotate(false)}
      />
    </ListRow>
  );
}

function FeedbackBuildFilterRow({ appId }: { appId: string }) {
  const t = useText();
  const qc = useQueryClient();
  const setting = useQuery({ queryKey: ["feedback-build-filter", appId], queryFn: () => getFeedbackBuildFilter(appId) });
  const enabled = setting.data?.default_enabled === 1;
  const update = useMutation({
    mutationFn: (next: boolean) => setFeedbackBuildFilter(appId, next),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["feedback-build-filter", appId] });
      qc.invalidateQueries({ queryKey: ["feedback", appId] });
      qc.invalidateQueries({ queryKey: ["feedback-stats", appId] });
      qc.invalidateQueries({ queryKey: ["crash-groups", appId] });
      qc.invalidateQueries({ queryKey: ["error-groups", appId] });
    },
  });
  return (
    <SwitchRow
      title={t("Separate external iOS reports", "分流外部 iOS 报告")}
      description={t("A report whose bundle ID matches none of this app's channels goes to the External view and sends no notification card; an unknown bundle ID stays in the main view. Clients send the bundle ID, so it proves nothing about who sent the report.", "报告的 Bundle ID 与此应用的渠道都不匹配时，进入外部视图，不发送通知卡片；未知的 Bundle ID 留在主视图。Bundle ID 由客户端提供，不能证明报告来源。")}
      checked={enabled}
      disabled={!setting.data || update.isPending}
      error={setting.error ? t("Could not load this setting.", "无法加载此设置。") : failed(update.error, t)}
      onCheckedChange={(next) => update.mutate(next)}
    />
  );
}

// --- Device groups ------------------------------------------------------------

function DeviceGroupsSection({ appId, openId, onOpen }: { appId: string; openId: string | null; onOpen: (id: string) => void }) {
  const t = useText();
  const [creating, setCreating] = useState(false);
  const groups = useQuery({ queryKey: ["device-groups", appId], queryFn: () => listDeviceGroups(appId) });
  const list = groups.data?.groups ?? [];
  return (
    <SettingsSection
      id="settings-device-groups"
      icon={<Smartphone />}
      title={t("Device groups", "设备组")}
      action={
        <TextLink className="text-footnote" onClick={() => setCreating(true)}>
          {t("New group", "新建设备组")}
        </TextLink>
      }
    >
      <ListRowGroup>
        {groups.isLoading && (
          <ListRow variant="plain" interactive={false}><Skeleton className="h-6 w-full" /></ListRow>
        )}
        {groups.error && (
          <ListRow variant="plain" interactive={false}>
            <ListRowBody><ListRowDescription wrap className="text-danger-strong">{errorMessage(groups.error)}</ListRowDescription></ListRowBody>
          </ListRow>
        )}
        {groups.data && list.length === 0 && (
          <ListRow variant="plain" interactive={false}>
            <ListRowBody>
              <ListRowDescription wrap>
                {t("No device groups yet. A group lets a release go to exactly the devices in it.", "还没有设备组。设备组可以让一个版本只发给组里的设备。")}
              </ListRowDescription>
            </ListRowBody>
          </ListRow>
        )}
        {list.map((group) => (
          <ListRow
            key={group.id}
            variant="plain"
            selected={openId === group.id}
            aria-current={openId === group.id || undefined}
            onClick={() => onOpen(group.id)}
          >
            <ListRowBody>
              <ListRowTitle>{group.name}</ListRowTitle>
              <ListRowSubtitle>
                {group.description ? `${group.description} · ` : ""}
                <span className="font-mono">{group.id}</span>
              </ListRowSubtitle>
            </ListRowBody>
            <ListRowMeta>
              {t(`${group.member_count} device${group.member_count === 1 ? "" : "s"}`, `${group.member_count} 台设备`)}
            </ListRowMeta>
            <ListRowChevron />
          </ListRow>
        ))}
      </ListRowGroup>
      <SectionNote>
        {t("Groups match the installation device ID that the Hands update SDK sends.", "设备组按 Hands 更新 SDK 发送的安装设备 ID 匹配。")}
      </SectionNote>
      {creating && <CreateDeviceGroupDialog appId={appId} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); onOpen(id); }} />}
    </SettingsSection>
  );
}

function CreateDeviceGroupDialog({ appId, onClose, onCreated }: { appId: string; onClose: () => void; onCreated: (id: string) => void }) {
  const t = useText();
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const create = useMutation({
    mutationFn: () => createDeviceGroup(appId, {
      name: name.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
    }),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ["device-groups", appId] });
      toast.show({ kind: "success", title: t("Device group created", "设备组已创建") });
      onCreated(res.id);
    },
    onError: (error) => toast.show({ kind: "error", title: t("Create failed", "创建失败"), description: errorMessage(error) }),
  });
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t("New device group", "新建设备组")}</DialogTitle></DialogHeader>
        <DialogBody>
          <form id="create-device-group" className="stack-y-4" onSubmit={(e) => { e.preventDefault(); if (name.trim()) create.mutate(); }}>
            <Field>
              <FieldLabel htmlFor="device-group-name">{t("Name", "名称")}</FieldLabel>
              <Input id="device-group-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("Test devices", "测试设备")} autoFocus aria-required />
            </Field>
            <Field>
              <FieldLabel htmlFor="device-group-note" optional>{t("Note", "备注")}</FieldLabel>
              <Input id="device-group-note" value={description} onChange={(e) => setDescription(e.target.value)} />
            </Field>
          </form>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" size="lg" onClick={onClose}>{t("Cancel", "取消")}</Button>
          <Button type="submit" form="create-device-group" variant="primary" size="lg" loading={create.isPending} disabled={!name.trim() || create.isPending}>
            {t("Create", "创建")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeviceGroupColumn({ appId, groupId, onClose }: { appId: string; groupId: string; onClose: () => void }) {
  const t = useText();
  const groups = useQuery({ queryKey: ["device-groups", appId], queryFn: () => listDeviceGroups(appId) });
  const group = groups.data?.groups.find((g) => g.id === groupId);
  if (!group) return null;
  return <DeviceGroupDetail appId={appId} group={group} onClose={onClose} label={t("Device group", "设备组")} />;
}

function DeviceGroupDetail({ appId, group, onClose, label }: { appId: string; group: DeviceGroup; onClose: () => void; label: string }) {
  const t = useText();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [deviceId, setDeviceId] = useState("");
  const [deviceLabel, setDeviceLabel] = useState("");
  const [groupName, setGroupName] = useState(group.name);
  const [groupDescription, setGroupDescription] = useState(group.description ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    setGroupName(group.name);
    setGroupDescription(group.description ?? "");
  }, [group.description, group.name]);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["device-groups", appId] });
  const update = useMutation({
    mutationFn: () => updateDeviceGroup(appId, group.id, deviceGroupUpdatePayload(groupName, groupDescription)),
    onSuccess: () => {
      void refresh();
      toast.show({ kind: "success", title: t("Device group updated", "设备组已更新") });
    },
    onError: (error) => toast.show({ kind: "error", title: t("Update failed", "更新失败"), description: errorMessage(error) }),
  });
  const add = useMutation({
    mutationFn: () => addDeviceGroupMember(appId, group.id, {
      device_id: deviceId.trim(),
      ...(deviceLabel.trim() ? { label: deviceLabel.trim() } : {}),
    }),
    onSuccess: () => {
      setDeviceId("");
      setDeviceLabel("");
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
      setConfirmDelete(false);
      void refresh();
      toast.show({ kind: "success", title: t("Device group deleted", "设备组已删除") });
      onClose();
    },
    onError: (error) => toast.show({ kind: "error", title: t("Delete failed", "删除失败"), description: errorMessage(error) }),
  });
  const dirty = groupName.trim() !== group.name || groupDescription.trim() !== (group.description ?? "");

  return (
    <DetailColumn label={`${label}: ${group.name}`} title={group.name} meta={<span className="font-mono">{group.id}</span>} onClose={onClose}>
      <DetailSection title={t("Name and note", "名称和备注")}>
        <form className="stack-y-3" onSubmit={(e) => { e.preventDefault(); if (dirty && groupName.trim()) update.mutate(); }}>
          <Field>
            <FieldLabel htmlFor="group-name">{t("Name", "名称")}</FieldLabel>
            <Input id="group-name" value={groupName} onChange={(e) => setGroupName(e.target.value)} aria-required />
          </Field>
          <Field>
            <FieldLabel htmlFor="group-note" optional>{t("Note", "备注")}</FieldLabel>
            <Input id="group-note" value={groupDescription} onChange={(e) => setGroupDescription(e.target.value)} />
          </Field>
          <div>
            <Button type="submit" variant="outline" loading={update.isPending} disabled={!dirty || !groupName.trim() || update.isPending}>
              {t("Save", "保存")}
            </Button>
          </div>
        </form>
      </DetailSection>

      <DetailSection title={t(`Devices · ${group.members.length}`, `设备 · ${group.members.length}`)}>
        <ListRowGroup>
          {group.members.length === 0 && (
            <ListRow variant="plain" interactive={false}>
              <ListRowBody><ListRowDescription wrap>{t("No devices yet.", "暂无设备。")}</ListRowDescription></ListRowBody>
            </ListRow>
          )}
          {group.members.map((member) => (
            <ListRow key={member.device_id} variant="plain" interactive={false}>
              <ListRowBody>
                <ListRowTitle>{member.label || t("Device", "设备")}</ListRowTitle>
                <ListRowSubtitle className="font-mono">{member.device_id}</ListRowSubtitle>
              </ListRowBody>
              <Button variant="outline" onClick={() => remove.mutate(member.device_id)} disabled={remove.isPending}>
                {t("Remove", "移除")}
              </Button>
            </ListRow>
          ))}
        </ListRowGroup>
        <form className="stack-y-3" onSubmit={(e) => { e.preventDefault(); if (deviceId.trim()) add.mutate(); }}>
          <Field>
            <FieldLabel htmlFor="member-device-id">{t("Installation device ID", "安装设备 ID")}</FieldLabel>
            <Input id="member-device-id" className="font-mono" value={deviceId} onChange={(e) => setDeviceId(e.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="member-label" optional>{t("Label", "标签")}</FieldLabel>
            <Input id="member-label" value={deviceLabel} onChange={(e) => setDeviceLabel(e.target.value)} />
          </Field>
          <div>
            <Button type="submit" variant="outline" loading={add.isPending} disabled={!deviceId.trim() || add.isPending}>
              {t("Add device", "添加设备")}
            </Button>
          </div>
        </form>
      </DetailSection>

      <DetailSection title={t("Danger zone", "危险操作")}>
        <ListRowGroup>
          <ListRow variant="plain" tone="danger" onClick={() => setConfirmDelete(true)} disabled={destroy.isPending}>
            <ListRowIcon><Trash2 /></ListRowIcon>
            <ListRowBody>
              <ListRowTitle>{t("Delete group", "删除设备组")}</ListRowTitle>
              <ListRowDescription wrap>{t("Releases scoped to this group reach none of its devices.", "限定到这个组的版本将不再发给这些设备。")}</ListRowDescription>
            </ListRowBody>
          </ListRow>
        </ListRowGroup>
      </DetailSection>
      <ConfirmActionDialog
        open={confirmDelete}
        title={t("Delete device group?", "删除设备组？")}
        objectLabel={group.name}
        objectHint={group.id}
        body={t(`The group and its ${group.members.length} devices are removed. This can't be undone.`, `设备组及其中 ${group.members.length} 台设备将被移除。此操作无法撤回。`)}
        confirmLabel={t("Delete group", "删除设备组")}
        confirmKind="danger"
        pending={destroy.isPending}
        onConfirm={() => destroy.mutate()}
        onCancel={() => setConfirmDelete(false)}
      />
    </DetailColumn>
  );
}

// --- Raft notifications -----------------------------------------------------------

// Off unless a destination opts in: upload progress (waiting, processing,
// processed) is followed by TestFlight's own "Ready for testing"; failures still post.
const RAFT_OPT_IN_EVENTS: WebhookEventType[] = ["testflight:upload_processing"];
const DEFAULT_RAFT_EVENTS = WEBHOOK_EVENT_TYPES.filter((event) => !RAFT_OPT_IN_EVENTS.includes(event));

function RaftEventPicker({ selected, onToggle }: { selected: WebhookEventType[]; onToggle: (event: WebhookEventType) => void }) {
  const t = useText();
  return (
    <div className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
      {WEBHOOK_EVENT_TYPES.map((event) => (
        <label key={event} className="flex min-w-0 items-start gap-2 text-callout">
          <Checkbox checked={selected.includes(event)} onCheckedChange={() => onToggle(event)} />
          <span className="min-w-0">
            <span className="font-mono text-footnote [overflow-wrap:anywhere]">{event}</span>
            {event === "testflight:upload_processing" && (
              <span className="block text-footnote text-foreground-muted">{t("Also App Store \"Waiting for upload\", \"Processing upload\" and \"Upload processed\". Off by default; a failed upload still posts.", "也包括 App Store 的「等待上传」「上传处理中」和「上传处理完成」。默认不选；上传失败仍会通知。")}</span>
            )}
          </span>
        </label>
      ))}
    </div>
  );
}

function RaftNotificationsSection({ appId, openId, onOpen }: { appId: string; openId: string | null; onOpen: (id: string) => void }) {
  const t = useText();
  const qc = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const config = useQuery({ queryKey: ["raft-notifications", appId], queryFn: () => getRaftNotificationConfig(appId) });
  const refresh = () => qc.invalidateQueries({ queryKey: ["raft-notifications", appId] });
  const connect = useMutation({
    mutationFn: () => connectRaftBot(appId),
    onSuccess: () => { toast.show({ kind: "success", title: t("Hands App Bot connected", "Hands App Bot 已连接") }); refresh(); },
    onError: (error) => toast.show({ kind: "error", title: t("Could not connect App Bot", "无法连接 App Bot"), description: errorMessage(error) }),
  });
  const bot = config.data?.bot;
  const subscriptions = config.data?.subscriptions ?? [];

  return (
    <SettingsSection
      id="settings-raft"
      icon={<Bell />}
      title={t("Raft notifications", "Raft 通知")}
      action={bot?.connected ? (
        <TextLink className="text-footnote" onClick={() => setAdding(true)}>{t("Add destination", "添加目标")}</TextLink>
      ) : undefined}
    >
      <ListRowGroup>
        {config.isLoading && <ListRow variant="plain" interactive={false}><Skeleton className="h-6 w-full" /></ListRow>}
        {config.error && (
          <ListRow variant="plain" interactive={false}>
            <ListRowBody>
              <ListRowDescription wrap className="text-danger-strong">
                {t("Could not load Raft notification settings:", "无法加载 Raft 通知设置：")} {errorMessage(config.error)}
              </ListRowDescription>
            </ListRowBody>
          </ListRow>
        )}
        {config.data && (
          <ListRow variant="plain" interactive={false}>
            <ListRowBody>
              <ListRowTitle>{t("Hands App Bot", "Hands App Bot")}</ListRowTitle>
              <ListRowDescription wrap>
                {bot?.connected
                  ? bot.handle ? t(`Posts as ${bot.handle}.`, `以 ${bot.handle} 发送。`) : t("Ready to post.", "已可以发送。")
                  : t("A Raft server owner or admin grants the bot first; then connect it here.", "需要 Raft 服务器所有者或管理员先授权 Bot，然后在这里连接。")}
              </ListRowDescription>
            </ListRowBody>
            {bot?.connected ? (
              <Badge appearance="soft" variant="success">{t("Connected", "已连接")}</Badge>
            ) : (
              <Button variant="outline" onClick={() => connect.mutate()} loading={connect.isPending} disabled={connect.isPending}>
                {t("Connect App Bot", "连接 App Bot")}
              </Button>
            )}
          </ListRow>
        )}
        {subscriptions.map((s) => (
          <DestinationRow
            key={s.id}
            subscription={s}
            selected={openId === s.id}
            onOpen={() => onOpen(s.id)}
          />
        ))}
        {bot?.connected && subscriptions.length === 0 && (
          <ListRow variant="plain" interactive={false}>
            <ListRowBody>
              <ListRowDescription wrap>{t("No destinations yet. Add a Raft channel to post this app's events in.", "还没有通知目标。添加一个 Raft 频道来接收此应用的事件。")}</ListRowDescription>
            </ListRowBody>
          </ListRow>
        )}
      </ListRowGroup>
      <SectionNote>
        {t("Add the bot to the channel, pick the events, then send a test. Feedback posts can quote what users wrote, and TestFlight posts can name test groups and quote testing notes: pick a channel whose members may see them. Release status cards update one message as App Store, external TestFlight or Google Play status changes. The bot key stays encrypted in Hands. ", "将 Bot 加入频道，选择事件，再发送测试。反馈通知可能引用用户提交的文字，TestFlight 通知可能包含测试组名称和测试说明：请选择成员可以查看这些内容的频道。App Store、外部 TestFlight 或 Google Play 状态变化时，版本状态卡片会更新同一条消息。Bot 密钥在 Hands 中加密保存。")}
        <TextLink render={<a href={t("/docs/admin-user-guide/#raft-notifications", "/docs/zh/admin-user-guide/#raft-notifications")} />} nativeButton={false}>
          {t("Setup guide", "设置指南")}
        </TextLink>
      </SectionNote>
      {adding && <AddDestinationDialog appId={appId} onClose={() => setAdding(false)} />}
    </SettingsSection>
  );
}

function DestinationRow({
  subscription,
  selected,
  onOpen,
}: {
  subscription: RaftNotificationSubscription;
  selected: boolean;
  onOpen: () => void;
}) {
  const t = useText();
  const n = subscription.events.length;
  return (
    <ListRow variant="plain" selected={selected} aria-current={selected || undefined} onClick={onOpen}>
      <ListRowBody>
        <ListRowTitle className="font-mono">{subscription.channel_target}</ListRowTitle>
        <ListRowSubtitle>
          {t(`${n} event${n === 1 ? "" : "s"}`, `${n} 个事件`)}
          {" · "}
          {subscription.card_updates ? t("status cards", "状态卡片") : t("text", "文字")}
        </ListRowSubtitle>
      </ListRowBody>
      {!subscription.enabled && <Badge appearance="outline">{t("Paused", "已暂停")}</Badge>}
      <ListRowChevron />
    </ListRow>
  );
}

function AddDestinationDialog({ appId, onClose }: { appId: string; onClose: () => void }) {
  const t = useText();
  const qc = useQueryClient();
  const toast = useToast();
  const [channelTarget, setChannelTarget] = useState("");
  const [events, setEvents] = useState<WebhookEventType[]>(DEFAULT_RAFT_EVENTS);
  const create = useMutation({
    mutationFn: () => createRaftNotification(appId, { channel_target: channelTarget.trim(), events }),
    onSuccess: () => {
      toast.show({ kind: "success", title: t("Raft notification destination added", "已添加 Raft 通知目标") });
      void qc.invalidateQueries({ queryKey: ["raft-notifications", appId] });
      onClose();
    },
    onError: (error) => toast.show({ kind: "error", title: t("Could not add destination", "无法添加通知目标"), description: errorMessage(error) }),
  });
  const toggleEvent = (event: WebhookEventType) => setEvents((current) => current.includes(event) ? current.filter((item) => item !== event) : [...current, event]);
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent size="lg">
        <DialogHeader><DialogTitle>{t("Add destination", "添加通知目标")}</DialogTitle></DialogHeader>
        <DialogBody>
          <form id="add-raft-destination" className="stack-y-4" onSubmit={(e) => { e.preventDefault(); if (channelTarget.trim() && events.length) create.mutate(); }}>
            <Field>
              <FieldLabel htmlFor={`raft-channel-${appId}`}>{t("Target channel", "目标频道")}</FieldLabel>
              <Input id={`raft-channel-${appId}`} value={channelTarget} onChange={(event) => setChannelTarget(event.target.value)} placeholder="#proj-mobile-release" autoFocus aria-required />
              <FieldDescription>{t("Add the Hands App Bot to this channel first.", "请先将 Hands App Bot 加入此频道。")}</FieldDescription>
            </Field>
            <fieldset className="stack-y-2">
              <legend className="mb-2 text-callout font-semibold">{t("Events", "事件")}</legend>
              <RaftEventPicker selected={events} onToggle={toggleEvent} />
            </fieldset>
          </form>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" size="lg" onClick={onClose}>{t("Cancel", "取消")}</Button>
          <Button type="submit" form="add-raft-destination" variant="primary" size="lg" loading={create.isPending} disabled={!channelTarget.trim() || events.length === 0 || create.isPending}>
            {t("Add", "添加")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DestinationColumn({ appId, subscriptionId, onClose }: { appId: string; subscriptionId: string; onClose: () => void }) {
  const config = useQuery({ queryKey: ["raft-notifications", appId], queryFn: () => getRaftNotificationConfig(appId) });
  const subscription = config.data?.subscriptions.find((s) => s.id === subscriptionId);
  if (!subscription) return null;
  return <DestinationDetail appId={appId} subscription={subscription} onClose={onClose} />;
}

function DestinationDetail({ appId, subscription, onClose }: { appId: string; subscription: RaftNotificationSubscription; onClose: () => void }) {
  const t = useText();
  const { locale } = useLocale();
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<WebhookEventType[]>(subscription.events);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ["raft-notifications", appId] });
  const failures = useQuery({
    queryKey: ["raft-notification-failures", appId, subscription.id],
    queryFn: () => listRaftNotificationFailures(appId, subscription.id),
  });
  const update = useMutation({
    mutationFn: (enabled: boolean) => updateRaftNotification(appId, subscription.id, { enabled }),
    onSuccess: refresh,
  });
  const updateCards = useMutation({
    mutationFn: (card_updates: boolean) => updateRaftNotification(appId, subscription.id, { card_updates }),
    onSuccess: (_result, card_updates) => {
      if (!card_updates) toast.show({ kind: "success", title: t("Text selected", "已选择文字"), description: t("In-flight card requests may still finish; later notifications will use text.", "进行中的卡片请求仍可能完成；后续通知将使用文字。") });
      refresh();
    },
  });
  const saveEvents = useMutation({
    mutationFn: () => updateRaftNotification(appId, subscription.id, { events: draft }),
    onSuccess: () => {
      toast.show({ kind: "success", title: t("Events updated", "事件已更新") });
      void refresh();
    },
    onError: (error) => toast.show({ kind: "error", title: t("Could not update events", "无法更新事件"), description: errorMessage(error) }),
  });
  const test = useMutation({
    mutationFn: () => testRaftNotification(appId, subscription.id),
    onSuccess: () => toast.show({ kind: "success", title: t("Test message sent", "测试消息已发送") }),
    onError: (error) => toast.show({ kind: "error", title: t("Test message failed", "测试消息发送失败"), description: errorMessage(error) }),
  });
  const remove = useMutation({
    mutationFn: () => deleteRaftNotification(appId, subscription.id),
    onSuccess: () => {
      setConfirmRemove(false);
      toast.show({ kind: "success", title: t("Raft notification destination removed", "已移除 Raft 通知目标") });
      void refresh();
      onClose();
    },
    onError: (error) => toast.show({ kind: "error", title: t("Could not remove destination", "无法移除通知目标"), description: errorMessage(error) }),
  });
  const retry = useMutation({
    mutationFn: (id: string) => retryRaftNotificationFailure(appId, subscription.id, id),
    onSuccess: () => {
      toast.show({ kind: "success", title: t("Retry scheduled", "已安排重试"), description: t("Hands will retry when the delivery service next runs.", "投递服务下次运行时，Hands 将重试。") });
      void qc.invalidateQueries({ queryKey: ["raft-notification-failures", appId, subscription.id] });
    },
    onError: (error) => toast.show({ kind: "error", title: t("Could not retry notification", "无法重试通知"), description: errorMessage(error) }),
  });
  const dirty = draft.length !== subscription.events.length || draft.some((e) => !subscription.events.includes(e));
  const failureList = failures.data?.failures ?? [];

  return (
    <DetailColumn
      label={subscription.channel_target}
      title={<span className="font-mono">{subscription.channel_target}</span>}
      meta={subscription.enabled ? t("Posting", "发送中") : t("Paused", "已暂停")}
      onClose={onClose}
    >
      <DetailSection title={t("Delivery", "投递")}>
        <ListRowGroup>
          <SwitchRow
            title={t("Post to this channel", "发送到此频道")}
            description={t("Off, events for this channel are skipped.", "关闭后不再向此频道发送事件。")}
            checked={subscription.enabled}
            disabled={update.isPending}
            error={failed(update.error, t)}
            onCheckedChange={(next) => update.mutate(next)}
          />
          <SwitchRow
            title={t("Release status cards", "版本状态卡片")}
            description={t("One message per release that updates as its state changes. Off, each change is a text message.", "每个版本一条消息，状态变化时更新。关闭后每次变化发送一条文字消息。")}
            checked={subscription.card_updates}
            disabled={updateCards.isPending}
            error={failed(updateCards.error, t)}
            onCheckedChange={(next) => updateCards.mutate(next)}
          />
          <ListRow variant="plain" interactive={false}>
            <ListRowBody>
              <ListRowTitle>{t("Test message", "测试消息")}</ListRowTitle>
              <ListRowDescription wrap>{t("Posts a test message to check the bot can reach the channel.", "发送一条测试消息，确认 Bot 可以发到此频道。")}</ListRowDescription>
            </ListRowBody>
            <Button variant="outline" onClick={() => test.mutate()} loading={test.isPending} disabled={!subscription.enabled || test.isPending}>
              {t("Send test", "发送测试")}
            </Button>
          </ListRow>
        </ListRowGroup>
      </DetailSection>

      <DetailSection title={t("Events", "事件")}>
        <RaftEventPicker selected={draft} onToggle={(event) => setDraft((current) => current.includes(event) ? current.filter((item) => item !== event) : [...current, event])} />
        <div>
          <Button variant="outline" onClick={() => saveEvents.mutate()} loading={saveEvents.isPending} disabled={!dirty || draft.length === 0 || saveEvents.isPending}>
            {t("Save events", "保存事件")}
          </Button>
        </div>
      </DetailSection>

      {(failureList.length > 0 || failures.isError) && (
        <DetailSection title={t("Failed posts", "发送失败")}>
          {failures.isError && <Text.Sans size="small" variant="muted">{t("Could not load failed notifications.", "无法加载失败的通知。")}</Text.Sans>}
          {failureList.length > 0 && (
            <ListRowGroup>
              {failureList.map((failure) => (
                <ListRow key={failure.id} variant="plain" interactive={false}>
                  <ListRowBody>
                    <ListRowTitle className="font-mono text-callout">{failure.event_type}</ListRowTitle>
                    <ListRowSubtitle>{new Date(failure.created_at).toLocaleString(locale)}</ListRowSubtitle>
                  </ListRowBody>
                  <Button variant="outline" onClick={() => retry.mutate(failure.id)} disabled={retry.isPending || !subscription.enabled}>
                    {t("Retry", "重试")}
                  </Button>
                </ListRow>
              ))}
            </ListRowGroup>
          )}
        </DetailSection>
      )}

      <DetailSection title={t("Danger zone", "危险操作")}>
        <ListRowGroup>
          <ListRow variant="plain" tone="danger" onClick={() => setConfirmRemove(true)} disabled={remove.isPending}>
            <ListRowIcon><Trash2 /></ListRowIcon>
            <ListRowBody>
              <ListRowTitle>{t("Remove destination", "移除通知目标")}</ListRowTitle>
              <ListRowDescription wrap>{t("This channel gets no more posts from this app.", "此频道将不再收到此应用的通知。")}</ListRowDescription>
            </ListRowBody>
          </ListRow>
        </ListRowGroup>
      </DetailSection>
      <ConfirmActionDialog
        open={confirmRemove}
        title={t("Remove this destination?", "移除此通知目标？")}
        objectLabel={subscription.channel_target}
        body={t("Its events and settings are removed. Add the channel again to post there.", "其事件和设置将被移除。需要时可以重新添加此频道。")}
        confirmLabel={t("Remove", "移除")}
        confirmKind="danger"
        pending={remove.isPending}
        onConfirm={() => remove.mutate()}
        onCancel={() => setConfirmRemove(false)}
      />
    </DetailColumn>
  );
}

// --- Danger zone ------------------------------------------------------------------

function DangerZone({ appId, app, isOrgAdmin }: { appId: string; app: App; isOrgAdmin: boolean }) {
  const t = useText();
  const qc = useQueryClient();
  const toast = useToast();
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [transferring, setTransferring] = useState(false);

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
    mutationFn: (archived: boolean) => archiveApp(appId, { archived }),
    onSuccess: (_, archived) => {
      toast.show({ kind: "success", title: archived ? t("App archived", "应用已归档") : t("App restored", "应用已恢复") });
      qc.invalidateQueries({ queryKey: ["apps"] });
      qc.invalidateQueries({ queryKey: ["builds", appId] });
      qc.invalidateQueries({ queryKey: ["releases", appId] });
      setConfirmArchive(false);
    },
    onError: (e) =>
      toast.show({ kind: "error", title: t("Archive failed", "归档失败"), description: errorMessage(e) }),
  });

  return (
    <SettingsSection id="settings-danger" icon={<AlertTriangle />} title={t("Danger zone", "危险操作")}>
      <ListRowGroup>
        <ListRow variant="plain" onClick={() => setTransferring(true)}>
          <ListRowIcon><ArrowRightLeft /></ListRowIcon>
          <ListRowBody>
            <ListRowTitle>{t("Transfer app", "转移应用")}</ListRowTitle>
            <ListRowDescription wrap>
              {t("Move the app, with its ID, releases, builds, channels and history, to another organization you belong to.", "将应用连同其 ID、版本、构建、渠道和历史记录转移到您所在的另一个组织。")}
            </ListRowDescription>
          </ListRowBody>
        </ListRow>
        {isOrgAdmin && (
          <ListRow variant="plain" onClick={() => setConfirmArchive(true)} disabled={archive.isPending}>
            <ListRowIcon>{app.archived ? <ArchiveRestore /> : <Archive />}</ListRowIcon>
            <ListRowBody>
              <ListRowTitle>{app.archived ? t("Restore app", "恢复应用") : t("Archive app", "归档应用")}</ListRowTitle>
              <ListRowDescription wrap>
                {app.archived
                  ? t(`Archived ${app.archived_at ? new Date(app.archived_at).toLocaleDateString() : ""}. It rejects new uploads until restored.`.replace("  ", " "), `已于 ${app.archived_at ? new Date(app.archived_at).toLocaleDateString() : ""} 归档。恢复前不接受新上传。`)
                  : t("The app stops accepting uploads and releases. Everything is kept, and you can restore it.", "应用将不再接受上传和发布。所有内容都会保留，可以恢复。")}
              </ListRowDescription>
            </ListRowBody>
          </ListRow>
        )}
        {isOrgAdmin && Boolean(app.archived) && (
          <ListRow variant="plain" tone="danger" onClick={() => setConfirmPurge(true)} disabled={purge.isPending}>
            <ListRowIcon><Trash2 /></ListRowIcon>
            <ListRowBody>
              <ListRowTitle>{t("Purge permanently", "永久删除")}</ListRowTitle>
              <ListRowDescription wrap>
                {t("Deletes the app and everything it owns. Its audit history is kept.", "删除应用及其所有内容，审计记录会保留。")}
              </ListRowDescription>
            </ListRowBody>
          </ListRow>
        )}
      </ListRowGroup>
      {!isOrgAdmin && (
        <SectionNote>{t("Only an organization owner or admin can archive or delete the app.", "只有组织所有者或管理员可以归档或删除应用。")}</SectionNote>
      )}

      {transferring && <TransferDialog appId={appId} app={app} onClose={() => setTransferring(false)} />}

      <ConfirmActionDialog
        open={confirmPurge}
        title={t("Purge this app permanently?", "永久删除此应用？")}
        objectLabel={app.name ?? app.slug ?? app.id}
        objectHint={`slug: ${app.slug}`}
        body={
          <>
            {t("Deletes the app and", "将删除应用及其")} <strong>{t("everything it owns", "所有内容")}</strong>{t(": builds, releases, share links, feedback tickets and uploaded files.", "，包括构建、版本、分享链接、反馈工单和上传文件。")}{" "}
            {t("Its audit history is kept for the record.", "审计记录会保留存档。")}{" "}
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
                {t("You can restore it: existing builds, releases, and assets are kept as-is. Archiving does not free up storage.", "此操作可以撤销：现有构建、版本和文件保持不变。归档不会释放存储空间。")}
              </span>
            </>
          )
        }
        confirmLabel={app.archived ? t("Restore app", "恢复应用") : t("Archive app", "归档应用")}
        cancelLabel={app.archived ? t("Keep archived", "保持归档") : t("Keep app", "保留应用")}
        confirmKind={app.archived ? "primary" : "warning"}
        pending={archive.isPending}
        onCancel={() => setConfirmArchive(false)}
        onConfirm={() => {
          archive.mutate(!app.archived);
          setConfirmArchive(false);
        }}
      />
    </SettingsSection>
  );
}

const NO_TARGET = "__none__";

function TransferDialog({ appId, app, onClose }: { appId: string; app: App; onClose: () => void }) {
  const t = useText();
  const toast = useToast();
  const qc = useQueryClient();
  const orgs = useQuery({ queryKey: ["orgs"], queryFn: listOrgs });
  const [target, setTarget] = useState("");
  const [confirm, setConfirm] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const transfer = useMutation({
    mutationFn: () => transferApp(appId, { target_org_id: target, expected_source_org_id: app.org_id ?? "", idempotency_key: idempotencyKey }),
    onSuccess: () => {
      toast.show({ kind: "success", title: t("App transferred", "应用已转移") });
      setConfirm("");
      setIdempotencyKey(crypto.randomUUID());
      void qc.invalidateQueries({ queryKey: ["apps"] });
      onClose();
    },
    onError: (e) => toast.show({ kind: "error", title: t("Transfer failed", "转移失败"), description: errorMessage(e) }),
  });
  const eligible = (orgs.data?.orgs ?? []).filter((o) => !o.archived && o.id !== app.org_id && o.org_role !== "viewer");
  const items = { [NO_TARGET]: t("Choose an organization", "选择组织"), ...Object.fromEntries(eligible.map((o) => [o.id, `${o.name} (${o.slug})`])) };
  return (
    <ConfirmActionDialog
      open
      title={t("Transfer this app?", "转移此应用？")}
      objectLabel={app.name}
      objectHint={`slug: ${app.slug}`}
      body={
        <div className="stack-y-4">
          <p>
            {t("The app keeps its ID, releases, builds, channels and history. You need to be an admin or owner of the organization that owns it and a member of the target; the target's admins can then manage it.", "应用保留 ID 及所有版本、构建、渠道和历史记录。你需要是应用所属组织的管理员或所有者，并且是目标组织的成员；转移后目标组织的管理员可以管理此应用。")}
          </p>
          <Field>
            <FieldLabel id="transfer-target-label">{t("Organization", "组织")}</FieldLabel>
            <Select items={items} value={target || NO_TARGET} onValueChange={(value) => setTarget(!value || value === NO_TARGET ? "" : String(value))}>
              <SelectTrigger className="w-full" aria-labelledby="transfer-target-label" disabled={transfer.isPending}>
                <SelectValue />
                <SelectIcon />
              </SelectTrigger>
              <SelectContent>
                <SelectList>
                  <SelectItem value={NO_TARGET}>{t("Choose an organization", "选择组织")}</SelectItem>
                  {eligible.map((o) => <SelectItem key={o.id} value={o.id}>{o.name} ({o.slug})</SelectItem>)}
                </SelectList>
              </SelectContent>
            </Select>
            {orgs.data && eligible.length === 0 && (
              <FieldDescription>{t("You are not an admin or member of another organization.", "您不是其他组织的管理员或成员。")}</FieldDescription>
            )}
          </Field>
        </div>
      }
      confirmLabel={t("Transfer", "转移")}
      confirmKind="warning"
      requiredText={app.slug}
      typedValue={confirm}
      onTypedChange={setConfirm}
      confirmDisabled={!target || confirm !== app.slug || !app.org_id}
      pending={transfer.isPending}
      onConfirm={() => transfer.mutate()}
      onCancel={onClose}
    />
  );
}
