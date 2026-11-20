import { errorMessage } from "../lib/errorMessage";
/**
 * An app's share links (/apps/:appId/shares): a page of a list.
 *
 * One row per share link across the app's releases: the release, its
 * channel and author, views and downloads, and its state. Opening a row puts
 * the share in a column beside the list: its link to copy, its details, and
 * its actions (expiry, password, rebinding to another release, revoking).
 * New share opens a dialog. Shares have no default expiry: they live until
 * revoked; an expiry is opt-in and only shown when set. Legacy shares made
 * before tokens were stored have no recoverable URL.
 */
import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CalendarClock, KeyRound, Link2Off, Plus, Repeat, Share2, Trash2 } from "lucide-react";
import {
  Badge,
  Banner,
  BannerAction,
  BannerDescription,
  BannerTitle,
  Button,
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
  Select,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectList,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Text,
} from "@botiverse/raft-ui";
import { ListRowSkeleton } from "@botiverse/raft-ui/wip";
import {
  type AppShare,
  createReleaseShare,
  listAppShares,
  listReleases,
  getRelease,
  rebindReleaseShare,
  renewReleaseShare,
  revokeReleaseShare,
} from "../lib/api";
import { useToast } from "../components/Toast";
import { ConfirmActionDialog } from "../components/ConfirmActionDialog";
import { DetailColumn, DetailSection, ListPage } from "../components/ListPage";
import { useLocale, useText } from "../lib/locale";
import { timeAgo } from "./Operations";

type T = ReturnType<typeof useText>;
type ShareState = "active" | "expired" | "revoked";
const DAY = 86_400_000;

export function shareState(share: AppShare, now = Date.now()): ShareState {
  if (share.revoked_at) return "revoked";
  // Legacy shares may still carry an expiry; new ones live until revoked.
  if (share.expires_at != null && share.expires_at <= now) return "expired";
  return "active";
}

function stateLabel(state: ShareState, t: T) {
  return state === "revoked" ? t("Revoked", "已撤销") : state === "expired" ? t("Expired", "已过期") : t("Active", "有效");
}

function StateBadge({ state }: { state: ShareState }) {
  const t = useText();
  if (state === "active") return <Badge appearance="soft" variant="success" className="shrink-0">{stateLabel(state, t)}</Badge>;
  if (state === "expired") return <Badge appearance="soft" variant="warning" className="shrink-0">{stateLabel(state, t)}</Badge>;
  return <Badge appearance="outline" className="shrink-0">{stateLabel(state, t)}</Badge>;
}

function releaseLabel(share: AppShare) {
  return `${share.version_name} (${share.version_code})`;
}

export function AppShares({ appId }: { appId: string }) {
  const t = useText();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [rebindShare, setRebindShare] = useState<AppShare | null>(null);
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [stateFilter, setStateFilter] = useState<"" | ShareState>("");

  const shares = useQuery({
    queryKey: ["app-shares", appId],
    queryFn: () => listAppShares(appId),
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["app-shares", appId] });

  const all = shares.data?.shares ?? [];
  const rows = stateFilter ? all.filter((s) => shareState(s) === stateFilter) : all;
  const open = all.find((s) => s.id === openId) ?? null;

  const stateItems: Record<string, string> = {
    "": t("All states", "全部状态"),
    active: t("Active", "有效"),
    expired: t("Expired", "已过期"),
    revoked: t("Revoked", "已撤销"),
  };

  return (
    <ListPage
      icon={<Share2 aria-hidden="true" />}
      title={t("Shares", "分享")}
      count={shares.data ? rows.length : undefined}
      busy={shares.isLoading}
      toolbar={
        <>
          <Select items={stateItems} value={stateFilter} onValueChange={(v) => setStateFilter(((v as string) || "") as "" | ShareState)}>
            <SelectTrigger aria-label={t("State", "状态")} className="min-w-0 flex-1 sm:w-auto sm:min-w-36 sm:flex-none">
              <SelectValue />
              <SelectIcon />
            </SelectTrigger>
            <SelectContent>
              <SelectList>
                {Object.entries(stateItems).map(([value, label]) => (
                  <SelectItem key={value || "all"} value={value}>{label}</SelectItem>
                ))}
              </SelectList>
            </SelectContent>
          </Select>
          <Button variant="primary" className="ml-auto" onClick={() => setShowCreate(true)}>
            <Plus aria-hidden="true" />
            {t("New share", "新建分享")}
          </Button>
        </>
      }
      detail={
        open && (
          <ShareDetail
            key={open.id}
            appId={appId}
            share={open}
            onClose={() => setOpenId(null)}
            onRebind={() => setRebindShare(open)}
            onChanged={invalidate}
          />
        )
      }
    >
      {createdUrl && (
        <div className="px-(--column-margin)">
          <Banner status="success">
            <Share2 aria-hidden="true" />
            <BannerTitle>{t("Share link created", "分享链接已创建")}</BannerTitle>
            <BannerDescription>
              <CopyableCodeRoot size="sm" className="mt-1" onCopy={() => { toast.show({ kind: "success", title: t("Copied share URL", "已复制分享链接") }); }}>
                <CopyableCode className="[overflow-wrap:anywhere]">{createdUrl}</CopyableCode>
                <CopyableCodeAction aria-label={t("Copy share URL", "复制分享链接")} />
              </CopyableCodeRoot>
            </BannerDescription>
            <BannerAction>
              <Button variant="outline" onClick={() => setCreatedUrl(null)}>{t("Dismiss", "关闭")}</Button>
            </BannerAction>
          </Banner>
        </div>
      )}

      <div className="flex flex-col gap-0.5">
        {shares.isLoading && [0, 1, 2].map((n) => <ListRowSkeleton key={n} cell />)}

        {shares.error && (
          <div className="px-(--column-margin)">
            <Banner status="warning">
              <AlertTriangle aria-hidden="true" />
              <BannerTitle>{t("Could not load shares", "无法加载分享")}</BannerTitle>
              <BannerDescription>{errorMessage(shares.error)}</BannerDescription>
              <BannerAction>
                <Button variant="outline" onClick={() => void shares.refetch()}>{t("Retry", "重试")}</Button>
              </BannerAction>
            </Banner>
          </div>
        )}

        {shares.data && rows.length === 0 && (
          <EmptyState className="py-16">
            <EmptyStateContent>
              <EmptyStateIcon><Share2 aria-hidden="true" /></EmptyStateIcon>
              {all.length > 0 ? (
                <>
                  <EmptyStateTitle>{t("No shares in this state", "没有这个状态的分享")}</EmptyStateTitle>
                  <EmptyStateDescription>{t("Pick another state to see the other links.", "选择其他状态查看其余链接。")}</EmptyStateDescription>
                </>
              ) : (
                <>
                  <EmptyStateTitle>{t("No shares yet", "还没有分享")}</EmptyStateTitle>
                  <EmptyStateDescription>
                    {t("A share is a public download page for one release. Create one here, with ", "分享是某个版本的公开下载页面。可以在这里创建，也可以用 ")}
                    <code className="font-mono">hands releases share</code>
                    {t(" or from the release workflow.", " 命令或在发布流程中创建。")}
                  </EmptyStateDescription>
                </>
              )}
            </EmptyStateContent>
          </EmptyState>
        )}

        {rows.map((share) => (
          <ShareRow key={share.id} share={share} selected={openId === share.id} onOpen={() => setOpenId(share.id)} />
        ))}
      </div>

      {showCreate && (
        <CreateShareModal
          appId={appId}
          onClose={() => setShowCreate(false)}
          onCreated={(url) => {
            setShowCreate(false);
            setCreatedUrl(url);
            invalidate();
          }}
        />
      )}
      {rebindShare && (
        <RebindShareModal
          appId={appId}
          share={rebindShare}
          onClose={() => setRebindShare(null)}
          onRebound={() => {
            setRebindShare(null);
            invalidate();
          }}
        />
      )}
    </ListPage>
  );
}

function ShareRow({ share, selected, onOpen }: { share: AppShare; selected: boolean; onOpen: () => void }) {
  const t = useText();
  const { locale } = useLocale();
  const state = shareState(share);
  return (
    <ListRow
      cell
      selected={selected}
      aria-current={selected || undefined}
      tone={state === "revoked" ? "muted" : "default"}
      onClick={onOpen}
    >
      <ListRowBody>
        <ListRowTop>
          <ListRowTitle>{releaseLabel(share)}</ListRowTitle>
          <ListRowMeta>{timeAgo(share.created_at, locale)}</ListRowMeta>
        </ListRowTop>
        <ListRowSubtitle>
          {share.channel_slug} · {t(`by ${share.created_by}`, `由 ${share.created_by} 创建`)}
        </ListRowSubtitle>
        <ListRowBottom>
          <ListRowDescription>
            {t(
              `${share.view_count} views · ${share.download_count} downloads`,
              `${share.view_count} 次访问 · ${share.download_count} 次下载`,
            )}
          </ListRowDescription>
          {Boolean(share.has_password) && <Badge appearance="outline" className="shrink-0">{t("Password", "有密码")}</Badge>}
          {share.expires_at != null && state === "active" && (
            <Badge appearance="outline" className="shrink-0">
              {t(`Expires ${new Date(share.expires_at).toLocaleDateString(locale)}`, `${new Date(share.expires_at).toLocaleDateString(locale)} 过期`)}
            </Badge>
          )}
          {!share.share_url && <Badge appearance="outline" className="shrink-0">{t("Legacy", "旧链接")}</Badge>}
          <StateBadge state={state} />
        </ListRowBottom>
      </ListRowBody>
    </ListRow>
  );
}

function ShareDetail({
  appId,
  share,
  onClose,
  onRebind,
  onChanged,
}: {
  appId: string;
  share: AppShare;
  onClose: () => void;
  onRebind: () => void;
  onChanged: () => void;
}) {
  const t = useText();
  const { locale } = useLocale();
  const toast = useToast();
  const [editing, setEditing] = useState<"expiry" | "password" | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const state = shareState(share);
  const actionable = !share.revoked_at;
  const date = (at: number) => new Date(at).toLocaleString(locale);

  const setExpiry = useMutation({
    mutationFn: (ttlDays: number | null) =>
      renewReleaseShare(appId, share.release_id, share.id, {
        // Explicit null clears the expiry (never expires).
        ...(ttlDays === null ? { expires_at: null } : { ttl_seconds: ttlDays * 24 * 60 * 60 }),
      }),
    onSuccess: (_data, ttlDays) => {
      toast.show({
        kind: "success",
        title: ttlDays === null ? t("Expiry removed. The link works until it is revoked.", "已移除有效期，链接在撤销前一直有效") : t(`Expires in ${ttlDays} days`, `${ttlDays} 天后过期`),
      });
      setEditing(null);
      onChanged();
    },
    onError: (e) => toast.show({ kind: "error", title: t("Expiry update failed", "更新有效期失败"), description: errorMessage(e) }),
  });

  const setPassword = useMutation({
    mutationFn: (password: string | null) =>
      // Omitting expiry keeps the share's current expiry unchanged.
      renewReleaseShare(appId, share.release_id, share.id, { password }),
    onSuccess: (_data, password) => {
      toast.show({ kind: "success", title: password ? t("Password set", "已设置密码") : t("Password removed", "已移除密码") });
      setEditing(null);
      onChanged();
    },
    onError: (e) => toast.show({ kind: "error", title: t("Password update failed", "更新密码失败"), description: errorMessage(e) }),
  });

  const revoke = useMutation({
    mutationFn: () => revokeReleaseShare(appId, share.release_id, share.id),
    onSuccess: () => {
      toast.show({ kind: "success", title: t("Share revoked", "分享已撤销") });
      setConfirmRevoke(false);
      onChanged();
    },
    onError: (e) => toast.show({ kind: "error", title: t("Revoke failed", "撤销失败"), description: errorMessage(e) }),
  });

  const busy = revoke.isPending || setPassword.isPending || setExpiry.isPending;

  return (
    <DetailColumn
      label={releaseLabel(share)}
      title={releaseLabel(share)}
      meta={<span className="font-mono">{share.channel_slug}</span>}
      onClose={onClose}
    >
      <DetailSection title={t("Link", "链接")}>
        {share.share_url ? (
          <CopyableCodeRoot size="sm" onCopy={() => { toast.show({ kind: "success", title: t("Copied share URL", "已复制分享链接") }); }}>
            <CopyableCode className="[overflow-wrap:anywhere]">{share.share_url}</CopyableCode>
            <CopyableCodeAction aria-label={t("Copy share URL", "复制分享链接")} />
          </CopyableCodeRoot>
        ) : (
          <Text.Sans size="small" variant="muted">
            {t("This link was made before Hands kept share URLs, so it can't be shown again. The link itself still works.", "此链接创建时 Hands 尚未保存分享地址，因此无法再次显示。链接本身仍然有效。")}
          </Text.Sans>
        )}
      </DetailSection>

      <DetailSection title={t("Details", "详情")}>
        <DescriptionList direction="horizontal">
          <DescriptionItem>
            <DescriptionTerm>{t("State", "状态")}</DescriptionTerm>
            <DescriptionDetails><StateBadge state={state} /></DescriptionDetails>
          </DescriptionItem>
          <DescriptionItem>
            <DescriptionTerm>{t("Created", "创建")}</DescriptionTerm>
            <DescriptionDetails>{date(share.created_at)} · {share.created_by}</DescriptionDetails>
          </DescriptionItem>
          <DescriptionItem>
            <DescriptionTerm>{t("Expires", "有效期")}</DescriptionTerm>
            <DescriptionDetails>
              {share.expires_at != null ? date(share.expires_at) : share.revoked_at != null ? "—" : t("Never: until revoked", "不过期，直到撤销")}
            </DescriptionDetails>
          </DescriptionItem>
          {share.revoked_at != null && (
            <DescriptionItem>
              <DescriptionTerm>{t("Revoked", "撤销")}</DescriptionTerm>
              <DescriptionDetails>{date(share.revoked_at)}</DescriptionDetails>
            </DescriptionItem>
          )}
          <DescriptionItem>
            <DescriptionTerm>{t("Password", "密码")}</DescriptionTerm>
            <DescriptionDetails>{share.has_password ? t("Required", "需要") : t("None: anyone with the link", "无，拿到链接即可访问")}</DescriptionDetails>
          </DescriptionItem>
          <DescriptionItem>
            <DescriptionTerm>{t("Views", "访问")}</DescriptionTerm>
            <DescriptionDetails>
              <span className="font-mono">{share.view_count}</span>{" "}
              <span className="text-foreground-muted">{t(`(${share.unique_view_count} unique)`, `（去重后 ${share.unique_view_count}）`)}</span>
            </DescriptionDetails>
          </DescriptionItem>
          <DescriptionItem>
            <DescriptionTerm>{t("Downloads", "下载")}</DescriptionTerm>
            <DescriptionDetails>
              <span className="font-mono">{share.download_count}</span>{" "}
              <span className="text-foreground-muted">{t(`(${share.unique_download_count} unique)`, `（去重后 ${share.unique_download_count}）`)}</span>
            </DescriptionDetails>
          </DescriptionItem>
          <DescriptionItem>
            <DescriptionTerm>{t("Release", "版本")}</DescriptionTerm>
            <DescriptionDetails>
              {t(
                share.release_status === "active" ? "Active" : share.release_status === "superseded" ? "Superseded by a newer release" : share.release_status === "cancelled" ? "Cancelled" : share.release_status,
                share.release_status === "active" ? "有效" : share.release_status === "superseded" ? "已被新版本替代" : share.release_status === "cancelled" ? "已取消" : share.release_status,
              )}
            </DescriptionDetails>
          </DescriptionItem>
        </DescriptionList>
      </DetailSection>

      {actionable && (
        <DetailSection title={t("Actions", "操作")}>
          <ListRowGroup>
            <ListRow variant="plain" onClick={() => setEditing("expiry")} disabled={busy}>
              <ListRowIcon><CalendarClock /></ListRowIcon>
              <ListRowBody>
                <ListRowTitle>{share.expires_at != null ? t("Change expiry", "修改有效期") : t("Set an expiry", "设置有效期")}</ListRowTitle>
                <ListRowDescription wrap>{t("The link stops working on that day.", "到期后链接失效。")}</ListRowDescription>
              </ListRowBody>
            </ListRow>
            <ListRow variant="plain" onClick={() => setEditing("password")} disabled={busy}>
              <ListRowIcon><KeyRound /></ListRowIcon>
              <ListRowBody>
                <ListRowTitle>{share.has_password ? t("Change password", "修改密码") : t("Set a password", "设置密码")}</ListRowTitle>
                <ListRowDescription wrap>{t("People enter it before they can download.", "下载前需要输入密码。")}</ListRowDescription>
              </ListRowBody>
            </ListRow>
            <ListRow variant="plain" onClick={onRebind} disabled={busy}>
              <ListRowIcon><Repeat /></ListRowIcon>
              <ListRowBody>
                <ListRowTitle>{t("Point to another release", "更换关联版本")}</ListRowTitle>
                <ListRowDescription wrap>{t("Same link, another active release of this channel.", "链接不变，改为此渠道的另一个有效版本。")}</ListRowDescription>
              </ListRowBody>
            </ListRow>
          </ListRowGroup>
        </DetailSection>
      )}

      {actionable && (
        <DetailSection title={t("Danger zone", "危险操作")}>
          <ListRowGroup>
            <ListRow variant="plain" tone="danger" onClick={() => setConfirmRevoke(true)} disabled={busy}>
              <ListRowIcon><Trash2 /></ListRowIcon>
              <ListRowBody>
                <ListRowTitle>{t("Revoke share", "撤销分享")}</ListRowTitle>
                <ListRowDescription wrap>{t("The link stops working for everyone. This can't be undone.", "所有人都无法再使用此链接。此操作无法撤回。")}</ListRowDescription>
              </ListRowBody>
            </ListRow>
          </ListRowGroup>
        </DetailSection>
      )}

      {!actionable && (
        <Text.Sans size="small" variant="muted" className="flex items-center gap-2">
          <Link2Off className="size-4" aria-hidden="true" />
          {t("A revoked link can't be changed.", "已撤销的链接不能再修改。")}
        </Text.Sans>
      )}

      {editing === "expiry" && (
        <ExpiryDialog share={share} pending={setExpiry.isPending} onClose={() => setEditing(null)} onSave={(days) => setExpiry.mutate(days)} />
      )}
      {editing === "password" && (
        <PasswordDialog share={share} pending={setPassword.isPending} onClose={() => setEditing(null)} onSave={(password) => setPassword.mutate(password)} />
      )}
      <ConfirmActionDialog
        open={confirmRevoke}
        title={t("Revoke this share?", "撤销此分享？")}
        objectLabel={releaseLabel(share)}
        objectHint={share.channel_slug}
        body={t(
          "Anyone opening the link gets a page saying it was revoked. The release and its files are kept. This can't be undone; create a new share to give people a link again.",
          "打开链接的人会看到链接已撤销。版本和文件会保留。此操作无法撤回；如需再次提供链接，请新建分享。",
        )}
        confirmLabel={t("Revoke share", "撤销分享")}
        confirmKind="danger"
        pending={revoke.isPending}
        onConfirm={() => revoke.mutate()}
        onCancel={() => setConfirmRevoke(false)}
      />
    </DetailColumn>
  );
}

function ExpiryDialog({
  share,
  pending,
  onClose,
  onSave,
}: {
  share: AppShare;
  pending: boolean;
  onClose: () => void;
  onSave: (days: number | null) => void;
}) {
  const t = useText();
  const [days, setDays] = useState(
    share.expires_at ? String(Math.max(1, Math.ceil((share.expires_at - Date.now()) / DAY))) : "",
  );
  const trimmed = days.trim();
  const value = Number(trimmed);
  const invalid = trimmed !== "" && (!Number.isFinite(value) || value <= 0);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (invalid) return;
    onSave(trimmed ? value : null);
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{t("Expiry", "有效期")}</DialogTitle>
          <DialogClose />
        </DialogHeader>
        <form className="contents" onSubmit={submit}>
          <DialogBody className="grid gap-5">
            <Field invalid={invalid}>
              <FieldLabel htmlFor="share-expiry-days" optional>{t("Days until the link expires", "链接多少天后过期")}</FieldLabel>
              <Input id="share-expiry-days" type="number" min={1} aria-invalid={invalid || undefined} value={days} onChange={(e) => setDays(e.target.value)} autoFocus />
              <FieldDescription>
                {invalid ? t("Enter a positive number of days.", "请输入大于零的天数。") : t("Leave empty and the link works until it is revoked.", "留空表示链接在撤销前一直有效。")}
              </FieldDescription>
            </Field>
          </DialogBody>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="ghost" size="lg" />}>{t("Cancel", "取消")}</DialogClose>
            <Button type="submit" variant="primary" size="lg" disabled={invalid} loading={pending} loadingLabel={t("Saving", "正在保存")}>
              {t("Save", "保存")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PasswordDialog({
  share,
  pending,
  onClose,
  onSave,
}: {
  share: AppShare;
  pending: boolean;
  onClose: () => void;
  onSave: (password: string | null) => void;
}) {
  const t = useText();
  const [password, setPasswordValue] = useState("");
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{share.has_password ? t("Change password", "修改密码") : t("Set a password", "设置密码")}</DialogTitle>
          <DialogClose />
        </DialogHeader>
        <form className="contents" onSubmit={(e) => { e.preventDefault(); onSave(password.trim() ? password.trim() : null); }}>
          <DialogBody className="grid gap-5">
            <Field>
              <FieldLabel htmlFor="share-password" optional={Boolean(share.has_password)}>{t("Password", "密码")}</FieldLabel>
              <Input id="share-password" type="text" value={password} onChange={(e) => setPasswordValue(e.target.value)} autoFocus />
              <FieldDescription>
                {share.has_password
                  ? t("Leave empty to remove the password and make the link public.", "留空则移除密码，链接改为公开。")
                  : t("People enter it on the share page before they can download.", "在分享页面下载前需要输入。")}
              </FieldDescription>
            </Field>
          </DialogBody>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="ghost" size="lg" />}>{t("Cancel", "取消")}</DialogClose>
            <Button
              type="submit"
              variant="primary"
              size="lg"
              disabled={!share.has_password && !password.trim()}
              loading={pending}
              loadingLabel={t("Saving", "正在保存")}
            >
              {share.has_password && !password.trim() ? t("Remove password", "移除密码") : t("Save", "保存")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RebindShareModal({
  appId,
  share,
  onClose,
  onRebound,
}: {
  appId: string;
  share: AppShare;
  onClose: () => void;
  onRebound: () => void;
}) {
  const t = useText();
  const toast = useToast();
  const [targetReleaseId, setTargetReleaseId] = useState("");
  const releases = useQuery({
    queryKey: ["releases", appId],
    queryFn: () => listReleases(appId),
  });
  const options = useMemo(
    () => (releases.data?.releases ?? [])
      .filter((release) => release.status === "active"
        && release.id !== share.release_id
        && release.channel_id === share.channel_id),
    [releases.data, share.channel_id, share.release_id],
  );
  const target = useQuery({
    queryKey: ["release", appId, targetReleaseId],
    queryFn: () => getRelease(appId, targetReleaseId),
    enabled: Boolean(targetReleaseId),
  });
  const installable = target.data?.assets.find((asset) => asset.artifact_kind === "installable");
  const rebind = useMutation({
    mutationFn: () => rebindReleaseShare(appId, share.id, {
      expected_release_id: share.release_id,
      target_release_id: targetReleaseId,
    }),
    onSuccess: (data) => {
      toast.show({
        kind: "success",
        title: t(`Share now points to ${data.target.version_name} (${data.target.version_code})`, `分享现已关联 ${data.target.version_name}（${data.target.version_code}）`),
      });
      onRebound();
    },
    onError: (error) => toast.show({
      kind: "error",
      title: t("Release rebind failed", "更换关联版本失败"),
      description: errorMessage(error),
    }),
  });
  const items: Record<string, string> = {
    "": t("Select an active release…", "选择一个有效版本…"),
    ...Object.fromEntries(options.map((release) => [
      release.id,
      `${release.version_name ?? release.id.slice(0, 8)} (${release.version_code ?? "—"})`,
    ])),
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{t("Point to another release", "更换关联版本")}</DialogTitle>
          <DialogClose />
        </DialogHeader>
        <DialogBody className="grid gap-5">
          <DialogDescription>
            {t("The public URL stays the same. Its version, build, download, and checksum will all point to the selected release.", "公开链接不变；其中的版本、构建、下载文件和校验和都会指向所选版本。")}
          </DialogDescription>
          <DescriptionList direction="horizontal">
            <DescriptionItem>
              <DescriptionTerm>{t("Current release", "当前版本")}</DescriptionTerm>
              <DescriptionDetails>
                <strong>{releaseLabel(share)}</strong> <span className="font-mono text-foreground-muted">{share.channel_slug}</span>
              </DescriptionDetails>
            </DescriptionItem>
          </DescriptionList>
          <Field>
            <FieldLabel id="rebind-target-label">{t("Target active release", "目标有效版本")}</FieldLabel>
            <Select items={items} value={targetReleaseId} onValueChange={(value) => setTargetReleaseId(value as string)}>
              <SelectTrigger aria-labelledby="rebind-target-label"><SelectValue /><SelectIcon /></SelectTrigger>
              <SelectContent>
                <SelectList>
                  {Object.entries(items).map(([id, label]) => (
                    <SelectItem key={id || "none"} value={id}>{label}</SelectItem>
                  ))}
                </SelectList>
              </SelectContent>
            </Select>
            {options.length === 0 && releases.data && (
              <FieldDescription>{t("This channel has no other active release.", "此渠道没有其他有效版本。")}</FieldDescription>
            )}
          </Field>
          {target.isLoading && <Skeleton className="h-20 w-full" />}
          {target.data && (
            <Banner status="warning">
              <AlertTriangle aria-hidden="true" />
              <BannerTitle>{target.data.build.version_name} ({target.data.build.version_code})</BannerTitle>
              <BannerDescription>
                <span className="block">{t("Build:", "构建：")} <code className="font-mono">{target.data.build.id}</code></span>
                <span className="block [overflow-wrap:anywhere]">{t("Checksum:", "校验和：")} <code className="font-mono">{installable?.file_hash ?? t("No installable asset", "没有可安装文件")}</code></span>
              </BannerDescription>
            </Banner>
          )}
        </DialogBody>
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="ghost" size="lg" />}>{t("Cancel", "取消")}</DialogClose>
          <Button
            variant="primary"
            size="lg"
            disabled={!targetReleaseId || !installable}
            loading={rebind.isPending}
            loadingLabel={t("Rebinding", "正在更换")}
            onClick={() => rebind.mutate()}
          >
            {t("Rebind release", "更换关联版本")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreateShareModal({
  appId,
  onClose,
  onCreated,
}: {
  appId: string;
  onClose: () => void;
  onCreated: (url: string) => void;
}) {
  const t = useText();
  const toast = useToast();
  const [releaseId, setReleaseId] = useState("");
  const [password, setPassword] = useState("");
  const [ttlDays, setTtlDays] = useState("");

  const releases = useQuery({
    queryKey: ["releases", appId],
    queryFn: () => listReleases(appId),
  });
  const options = useMemo(
    () =>
      (releases.data?.releases ?? [])
        .filter((r) => r.status === "active" || r.status === "superseded")
        .slice(0, 30),
    [releases.data],
  );

  const create = useMutation({
    mutationFn: () =>
      // No ttl (the default): the share lives until revoked.
      createReleaseShare(appId, releaseId, {
        ...(ttlDays.trim() ? { ttl_seconds: Number(ttlDays) * 24 * 60 * 60 } : {}),
        ...(password.trim() ? { password: password.trim() } : {}),
      }),
    onSuccess: (data) => {
      toast.show({
        kind: "success",
        title: data.has_password ? t("Password-protected share created", "已创建受密码保护的分享") : t("Share created", "已创建分享"),
      });
      onCreated(data.share_url);
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: t("Create share failed", "创建分享失败"),
        description: errorMessage(e),
      }),
  });

  const statusText = (status: string) => t(status, status === "active" ? "有效" : status === "superseded" ? "已被替代" : status);
  const items: Record<string, string> = {
    "": t("Select a release…", "选择版本…"),
    ...Object.fromEntries(options.map((r) => [r.id, `${r.version_name ?? r.id.slice(0, 8)} · ${statusText(r.status)}`])),
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{t("New share", "新建分享")}</DialogTitle>
          <DialogClose />
        </DialogHeader>
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            if (releaseId && !create.isPending) create.mutate();
          }}
        >
          <DialogBody className="grid gap-5">
            <Field>
              <FieldLabel id="new-share-release-label">{t("Release", "版本")}</FieldLabel>
              <Select items={items} value={releaseId} onValueChange={(v) => setReleaseId(v as string)}>
                <SelectTrigger aria-labelledby="new-share-release-label">
                  <SelectValue />
                  <SelectIcon />
                </SelectTrigger>
                <SelectContent>
                  <SelectList>
                    {Object.entries(items).map(([id, label]) => (
                      <SelectItem key={id || "none"} value={id}>{label}</SelectItem>
                    ))}
                  </SelectList>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="new-share-days" optional>{t("Expires in days", "有效天数")}</FieldLabel>
              <Input id="new-share-days" type="number" min={1} value={ttlDays} onChange={(e) => setTtlDays(e.target.value)} />
              <FieldDescription>{t("Leave empty and the link works until it is revoked.", "留空表示链接在撤销前一直有效。")}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="new-share-password" optional>{t("Password", "密码")}</FieldLabel>
              <Input id="new-share-password" type="text" value={password} onChange={(e) => setPassword(e.target.value)} />
              <FieldDescription>{t("Leave empty for a public link.", "留空则为公开链接。")}</FieldDescription>
            </Field>
          </DialogBody>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="ghost" size="lg" />}>{t("Cancel", "取消")}</DialogClose>
            <Button
              type="submit"
              variant="primary"
              size="lg"
              disabled={!releaseId}
              loading={create.isPending}
              loadingLabel={t("Creating share", "正在创建分享")}
            >
              {t("Create share", "创建分享")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
