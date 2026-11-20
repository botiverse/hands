/**
 * Channels — a page of a list: one row per channel with its slug, its
 * newest live release and how far that release is rolled out. Opening a row
 * shows the channel beside the list: its settings, the live release per
 * product type, Edit (a dialog) and Delete channel. New channel is the
 * toolbar's action.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Radio, Plus, Trash2 } from "lucide-react";
import {
  Badge,
  Banner,
  BannerAction,
  BannerDescription,
  BannerTitle,
  Button,
  DescriptionDetails,
  DescriptionItem,
  DescriptionList,
  DescriptionTerm,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
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
  Text,
  TextLink,
  TextLinkExternalIcon,
} from "@botiverse/raft-ui";
import { ListRowSkeleton } from "@botiverse/raft-ui/wip";
import {
  createChannel,
  deleteChannel,
  listApps,
  listChannels,
  listReleases,
  updateChannel,
  type App,
  type Channel,
  type Release,
} from "../lib/api";
import { errorMessage } from "../lib/errorMessage";
import { useLocale, useText } from "../lib/locale";
import { useToast } from "../components/Toast";
import { ConfirmActionDialog, TypedConfirmField } from "../components/ConfirmActionDialog";
import { latestReleaseByChannel } from "../components/LatestReleases";
import { DetailColumn, DetailSection, ListPage } from "../components/ListPage";
import { RolloutBadge } from "../components/ReleaseBadges";
import { timeAgo } from "./Operations";

type AppWithDefault = App & { default_channel_id?: string | null };

export function AppChannels({ appId }: { appId: string }) {
  const t = useText();
  const qc = useQueryClient();
  const apps = useQuery({ queryKey: ["apps"], queryFn: listApps });
  const app = apps.data?.apps.find((a) => a.id === appId) as AppWithDefault | undefined;
  const channels = useQuery({
    queryKey: ["channels", appId],
    queryFn: () => listChannels(appId),
  });
  const releases = useQuery({
    queryKey: ["releases", appId],
    queryFn: () => listReleases(appId),
  });
  const [showCreateChannel, setShowCreateChannel] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const list = channels.data?.channels ?? [];
  const live = latestReleaseByChannel(releases.data?.releases ?? []);
  const open = list.find((c) => c.id === openId) ?? null;
  const editing = list.find((c) => c.id === editingId) ?? null;
  const refresh = () => qc.invalidateQueries({ queryKey: ["channels", appId] });

  return (
    <ListPage
      icon={<Radio aria-hidden="true" />}
      title={t("Channels", "渠道")}
      count={channels.data ? list.length : undefined}
      busy={channels.isLoading}
      toolbar={
        <Button variant="primary" className="ml-auto" onClick={() => setShowCreateChannel(true)}>
          <Plus aria-hidden="true" />
          {t("New channel", "新建渠道")}
        </Button>
      }
      detail={
        open && (
          <ChannelDetail
            key={open.id}
            appId={appId}
            app={app}
            channel={open}
            releases={(releases.data?.releases ?? []).filter((r) => r.channel_id === open.id && r.status === "active")}
            onClose={() => setOpenId(null)}
            onEdit={() => setEditingId(open.id)}
            onDeleted={() => {
              setOpenId(null);
              void refresh();
            }}
          />
        )
      }
    >
      <div className="flex flex-col gap-0.5">
        {channels.isLoading && [0, 1, 2].map((n) => <ListRowSkeleton key={n} cell />)}

        {channels.error && (
          <div className="px-(--column-margin)">
            <Banner status="warning">
              <AlertTriangle aria-hidden="true" />
              <BannerTitle>{t("Could not load channels", "无法加载渠道")}</BannerTitle>
              <BannerDescription>{errorMessage(channels.error)}</BannerDescription>
              <BannerAction>
                <Button variant="outline" onClick={() => void channels.refetch()}>{t("Retry", "重试")}</Button>
              </BannerAction>
            </Banner>
          </div>
        )}

        {channels.data && list.length === 0 && (
          <EmptyState className="py-16">
            <EmptyStateContent>
              <EmptyStateIcon><Radio aria-hidden="true" /></EmptyStateIcon>
              <EmptyStateTitle>{t("No channels yet", "还没有渠道")}</EmptyStateTitle>
              <EmptyStateDescription>
                {t("Releases go out through channels. Create one to publish the first release.", "版本通过渠道发布。先创建一个渠道，再发布第一个版本。")}
              </EmptyStateDescription>
            </EmptyStateContent>
          </EmptyState>
        )}

        {list.map((c) => (
          <ChannelListRow
            key={c.id}
            channel={c}
            isDefault={app?.default_channel_id === c.id}
            entry={live.get(c.id)}
            releasesLoading={releases.isLoading}
            selected={openId === c.id}
            onOpen={() => setOpenId(c.id)}
          />
        ))}
      </div>

      {showCreateChannel && (
        <CreateChannelDialog
          appId={appId}
          onClose={() => setShowCreateChannel(false)}
          onCreated={() => {
            setShowCreateChannel(false);
            void refresh();
          }}
        />
      )}
      {editing && (
        <EditChannelDialog
          appId={appId}
          channel={editing}
          onClose={() => setEditingId(null)}
          onSaved={() => {
            setEditingId(null);
            void refresh();
          }}
        />
      )}
    </ListPage>
  );
}

function versionLabel(r: Release, t: ReturnType<typeof useText>) {
  return `${r.version_name ?? t("Unknown version", "未知版本")}${r.version_code != null ? ` (${r.version_code})` : ""}`;
}

function ChannelListRow({
  channel: c,
  isDefault,
  entry,
  releasesLoading,
  selected,
  onOpen,
}: {
  channel: Channel;
  isDefault: boolean;
  entry: { latest: Release; liveTypes: number } | undefined;
  releasesLoading: boolean;
  selected: boolean;
  onOpen: () => void;
}) {
  const t = useText();
  const { locale } = useLocale();
  const r = entry?.latest;
  const more = entry && entry.liveTypes > 1
    ? t(` · ${entry.liveTypes} product types live`, ` · ${entry.liveTypes} 种产品类型在线`)
    : "";
  const facts = [
    c.bundle_id ? t("Own bundle ID", "独立 Bundle ID") : null,
    c.password ? t("Password for downloads", "下载需要密码") : null,
  ].filter(Boolean);

  return (
    <ListRow cell selected={selected} aria-current={selected || undefined} onClick={onOpen}>
      <ListRowBody>
        <ListRowTop>
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <ListRowTitle>{c.name}</ListRowTitle>
            {isDefault && <Badge appearance="outline" className="shrink-0">{t("default", "默认")}</Badge>}
          </span>
          {r && <ListRowMeta>{timeAgo(r.activated_at ?? r.created_at, locale)}</ListRowMeta>}
        </ListRowTop>
        <ListRowSubtitle>
          <span className="font-mono">{c.slug}</span>
          {facts.length > 0 && <> · {facts.join(" · ")}</>}
        </ListRowSubtitle>
        <ListRowBottom>
          <ListRowDescription>
            {releasesLoading
              ? t("Loading…", "加载中…")
              : r
                ? `${versionLabel(r, t)} · ${r.product_type}${more}`
                : t("No live release", "没有生效中的版本")}
          </ListRowDescription>
          {r && <RolloutBadge release={r} />}
        </ListRowBottom>
      </ListRowBody>
    </ListRow>
  );
}

function ChannelDetail({
  appId,
  app,
  channel,
  releases,
  onClose,
  onEdit,
  onDeleted,
}: {
  appId: string;
  app: AppWithDefault | undefined;
  channel: Channel;
  /** The channel's active releases. */
  releases: Release[];
  onClose: () => void;
  onEdit: () => void;
  onDeleted: () => void;
}) {
  const t = useText();
  const { locale } = useLocale();
  const toast = useToast();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [typedConfirm, setTypedConfirm] = useState("");
  const isDefault = app?.default_channel_id === channel.id;

  const remove = useMutation({
    mutationFn: () => deleteChannel(appId, channel.id),
    onSuccess: () => {
      toast.show({ kind: "success", title: t(`Channel '${channel.slug}' deleted`, `渠道“${channel.slug}”已删除`) });
      onDeleted();
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: t("Delete failed", "删除失败"),
        description: errorMessage(e),
      }),
  });

  // The newest live release of each product type on this channel.
  const byType = new Map<string, Release>();
  for (const r of releases) {
    const prev = byType.get(r.product_type);
    if (!prev || (r.activated_at ?? r.created_at) > (prev.activated_at ?? prev.created_at)) byType.set(r.product_type, r);
  }
  const liveRows = [...byType.values()];

  return (
    <DetailColumn label={channel.name} title={channel.name} meta={<span className="font-mono">{channel.slug}</span>} onClose={onClose}>
      <div className="flex flex-wrap gap-2">
        <Button variant="default" onClick={onEdit}>{t("Edit channel", "编辑渠道")}</Button>
        <Button variant="ghost" render={<Link to={`/apps/${appId}/releases?channel=${encodeURIComponent(channel.slug)}`} />} nativeButton={false}>
          {t("Show its releases", "查看它的版本")}
        </Button>
      </div>

      <DetailSection title={t("Live now", "当前版本")}>
        {liveRows.length === 0 ? (
          <Text.Sans size="small" variant="muted">{t("Nothing is live on this channel yet.", "这个渠道还没有生效中的版本。")}</Text.Sans>
        ) : (
          <ListRowGroup>
            {liveRows.map((r) => {
              return (
                <ListRow key={r.id} variant="plain" interactive={false}>
                  <ListRowBody>
                    <ListRowTitle>{versionLabel(r, t)}</ListRowTitle>
                    <ListRowSubtitle>
                      {r.product_type} · {timeAgo(r.activated_at ?? r.created_at, locale)}
                      {r.should_force_update ? t(" · force update", " · 强制更新") : ""}
                    </ListRowSubtitle>
                  </ListRowBody>
                  <RolloutBadge release={r} />
                </ListRow>
              );
            })}
          </ListRowGroup>
        )}
      </DetailSection>

      <DetailSection title={t("Settings", "设置")}>
        <DescriptionList direction="horizontal">
          <DescriptionItem>
            <DescriptionTerm>{t("Slug", "标识")}</DescriptionTerm>
            <DescriptionDetails><span className="font-mono">{channel.slug}</span></DescriptionDetails>
          </DescriptionItem>
          <DescriptionItem>
            <DescriptionTerm>{t("Default", "默认渠道")}</DescriptionTerm>
            <DescriptionDetails>
              {isDefault
                ? t("Yes: New release starts here", "是：新建版本时默认选择")
                : t("No (change it in Settings)", "否（可在设置中修改）")}
            </DescriptionDetails>
          </DescriptionItem>
          <DescriptionItem>
            <DescriptionTerm>{t("Bundle ID", "Bundle ID")}</DescriptionTerm>
            <DescriptionDetails>
              {channel.bundle_id
                ? <span className="font-mono [overflow-wrap:anywhere]">{channel.bundle_id}</span>
                : <span className="text-foreground-muted">{t("The app's", "使用应用的")}</span>}
            </DescriptionDetails>
          </DescriptionItem>
          <DescriptionItem>
            <DescriptionTerm>{t("Downloads", "下载")}</DescriptionTerm>
            <DescriptionDetails>
              {channel.password ? t("Need a password", "需要密码") : t("Open", "无需密码")}
            </DescriptionDetails>
          </DescriptionItem>
          <DescriptionItem>
            <DescriptionTerm>{t("Git", "Git")}</DescriptionTerm>
            <DescriptionDetails>
              {channel.git_url ? (
                <TextLink
                  className="[overflow-wrap:anywhere]"
                  render={<a href={channel.git_url} target="_blank" rel="noreferrer" />}
                  nativeButton={false}
                >
                  {channel.git_url}
                  <TextLinkExternalIcon label={t("(opens in a new tab)", "（在新标签页打开）")} />
                </TextLink>
              ) : (
                <span className="text-foreground-muted">{t("None", "无")}</span>
              )}
            </DescriptionDetails>
          </DescriptionItem>
        </DescriptionList>
      </DetailSection>

      <DetailSection title={t("Danger zone", "危险操作")}>
        <ListRowGroup>
          <ListRow variant="plain" tone="danger" onClick={() => setConfirmDelete(true)} disabled={remove.isPending}>
            <ListRowIcon><Trash2 /></ListRowIcon>
            <ListRowBody>
              <ListRowTitle>{t("Delete channel", "删除渠道")}</ListRowTitle>
              <ListRowDescription wrap>
                {t("Clients asking this channel for updates get nothing. This can't be undone.", "向这个渠道检查更新的客户端将得不到结果。此操作无法撤回。")}
              </ListRowDescription>
            </ListRowBody>
          </ListRow>
        </ListRowGroup>
      </DetailSection>

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
            {t("Deleting this channel removes it from this app.", "删除渠道会将其从此应用移除。")}{" "}
            <strong>
              {t("Cancel or move every release on this channel first", "必须先取消或转移所有指向此渠道的版本")}
            </strong>
            {t(", or the public API will answer its clients with 404.", "，否则公开 API 将对客户端返回 404。")}
            {isDefault && (
              <Banner status="warning" size="sm" className="mt-2">
                <BannerDescription>
                  {t("This is the app's default release channel. Afterwards New release starts on the oldest channel.", "这是应用的默认发布渠道。删除后，新建版本将默认选择最早创建的渠道。")}
                </BannerDescription>
              </Banner>
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
    </DetailColumn>
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
  const canCreate = slug.trim().length > 0 && name.trim().length > 0 && !create.isPending;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{t("New channel", "新建渠道")}</DialogTitle>
          <DialogClose />
        </DialogHeader>
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            if (canCreate) create.mutate();
          }}
        >
          <DialogBody className="grid gap-5">
            <Field>
              <FieldLabel htmlFor="new-channel-name">{t("Name", "名称")}</FieldLabel>
              <Input id="new-channel-name" value={name} onChange={(e) => setName(e.target.value)} aria-required autoFocus />
            </Field>
            <Field>
              <FieldLabel htmlFor="new-channel-slug">{t("Slug", "标识")}</FieldLabel>
              <Input id="new-channel-slug" className="font-mono" value={slug} onChange={(e) => setSlug(e.target.value)} aria-required />
              <FieldDescription>{t("Clients and the CLI name the channel by it. It can't be changed later.", "客户端和命令行用它指定渠道，创建后不能修改。")}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="new-channel-bundle" optional>{t("Bundle ID", "Bundle ID")}</FieldLabel>
              <Input
                id="new-channel-bundle"
                className="font-mono"
                value={bundleId}
                onChange={(e) => setBundleId(e.target.value)}
                placeholder="com.example.myapp.beta"
              />
              <FieldDescription>{t("Only when this channel ships under its own bundle ID.", "仅当这个渠道使用独立的 Bundle ID 时填写。")}</FieldDescription>
            </Field>
          </DialogBody>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="ghost" size="lg" />}>{t("Cancel", "取消")}</DialogClose>
            <Button
              type="submit"
              variant="primary"
              size="lg"
              disabled={!canCreate}
              loading={create.isPending}
              loadingLabel={t("Creating channel", "正在创建渠道")}
            >
              {t("Create channel", "创建渠道")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditChannelDialog({
  appId,
  channel,
  onClose,
  onSaved,
}: {
  appId: string;
  channel: Channel;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useText();
  const toast = useToast();
  const [name, setName] = useState(channel.name);
  const [bundleId, setBundleId] = useState(channel.bundle_id ?? "");
  const [password, setPassword] = useState(channel.password ?? "");
  const [gitUrl, setGitUrl] = useState(channel.git_url ?? "");

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

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{t(`Edit ${channel.name}`, `编辑 ${channel.name}`)}</DialogTitle>
          <DialogClose />
        </DialogHeader>
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim() && !save.isPending) save.mutate();
          }}
        >
          <DialogBody className="grid gap-5" unstable_scrollArea>
            <Field>
              <FieldLabel htmlFor="edit-channel-slug">{t("Slug", "标识")}</FieldLabel>
              <Input id="edit-channel-slug" className="font-mono" value={channel.slug} readOnly />
              <FieldDescription>{t("A channel's slug can't be changed.", "渠道标识不能修改。")}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="edit-channel-name">{t("Name", "名称")}</FieldLabel>
              <Input id="edit-channel-name" value={name} onChange={(e) => setName(e.target.value)} aria-required autoFocus />
            </Field>
            <Field>
              <FieldLabel htmlFor="edit-channel-bundle" optional>{t("Bundle ID", "Bundle ID")}</FieldLabel>
              <Input
                id="edit-channel-bundle"
                className="font-mono"
                value={bundleId}
                onChange={(e) => setBundleId(e.target.value)}
                placeholder="com.example.myapp.beta"
              />
              <FieldDescription>{t("Only when this channel ships under its own bundle ID.", "仅当这个渠道使用独立的 Bundle ID 时填写。")}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="edit-channel-password" optional>{t("Download password", "下载密码")}</FieldLabel>
              <Input
                id="edit-channel-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <FieldDescription>{t("Leave it empty to let anyone with the link download.", "留空则任何拿到链接的人都能下载。")}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="edit-channel-git" optional>{t("Git URL", "Git 地址")}</FieldLabel>
              <Input
                id="edit-channel-git"
                className="font-mono"
                value={gitUrl}
                onChange={(e) => setGitUrl(e.target.value)}
                placeholder="https://github.com/foo/bar/tree/beta"
              />
            </Field>
          </DialogBody>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="ghost" size="lg" />}>{t("Cancel", "取消")}</DialogClose>
            <Button
              type="submit"
              variant="primary"
              size="lg"
              disabled={!name.trim() || save.isPending}
              loading={save.isPending}
              loadingLabel={t("Saving", "保存中")}
            >
              {t("Save", "保存")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
