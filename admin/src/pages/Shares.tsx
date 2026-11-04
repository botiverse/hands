/**
 * App-level share management (task #65 P1).
 *
 * Lists every share link for the app across releases with stats, lets
 * admins create (with optional password/expiry), copy the URL, and revoke
 * them. Shares have no default expiry — they live until revoked; an expiry
 * is opt-in and only shown when set. Legacy shares created before tokens
 * were stored have no recoverable URL.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Badge,
  Button, Input, Select, SelectTrigger, SelectValue, SelectIcon, SelectList, SelectContent, SelectItem, Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter, EmptyState, EmptyStateContent, EmptyStateIcon, EmptyStateTitle, EmptyStateDescription, Skeleton } from "raft-ui";
import { Share2 } from "lucide-react";
import type { BadgeProps } from "raft-ui";

type BadgeVariant = NonNullable<BadgeProps["variant"]>;
import {
  AppShare,
  createReleaseShare,
  listAppShares,
  listReleases,
  getRelease,
  rebindReleaseShare,
  renewReleaseShare,
  revokeReleaseShare,
} from "../lib/api";
import { useToast } from "../components/Toast";
import { useLocale, useText } from "../lib/locale";

export function AppShares({ appId }: { appId: string }) {
  const t = useText();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [rebindShare, setRebindShare] = useState<AppShare | null>(null);
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);

  const shares = useQuery({
    queryKey: ["app-shares", appId],
    queryFn: () => listAppShares(appId),
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["app-shares", appId] });

  const setExpiry = useMutation({
    mutationFn: ({ share, ttlDays }: { share: AppShare; ttlDays: number | null }) =>
      renewReleaseShare(appId, share.release_id, share.id, {
        // Explicit null clears the expiry (never expires).
        ...(ttlDays === null ? { expires_at: null } : { ttl_seconds: ttlDays * 24 * 60 * 60 }),
      }),
    onSuccess: (_data, vars) => {
      toast.show({
        kind: "success",
        title: vars.ttlDays === null ? t("Expiry removed — link lives until revoked", "已移除有效期，链接在撤销前一直有效") : t(`Expires in ${vars.ttlDays} days`, `${vars.ttlDays} 天后过期`),
      });
      invalidate();
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: t("Expiry update failed", "更新有效期失败"),
        description: (e as Error).message,
      }),
  });

  const setPassword = useMutation({
    mutationFn: ({ share, password }: { share: AppShare; password: string | null }) =>
      renewReleaseShare(appId, share.release_id, share.id, {
        // Omitting expiry keeps the share's current expiry unchanged.
        password,
      }),
    onSuccess: (_data, vars) => {
      toast.show({
        kind: "success",
        title: vars.password ? t("Password set", "已设置密码") : t("Password removed", "已移除密码"),
      });
      invalidate();
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: t("Password update failed", "更新密码失败"),
        description: (e as Error).message,
      }),
  });

  const revoke = useMutation({
    mutationFn: (share: AppShare) =>
      revokeReleaseShare(appId, share.release_id, share.id),
    onSuccess: () => {
      toast.show({ kind: "success", title: t("Share revoked", "分享已撤销") });
      invalidate();
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: t("Revoke failed", "撤销失败"),
        description: (e as Error).message,
      }),
  });

  const rows = shares.data?.shares ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold">{t("Shares", "分享")}</h2>
          <p className="text-sm text-foreground-muted">
            {t("Public download pages for this app's releases. Links remain valid until revoked or until their optional expiry, and their URLs can be re-copied here.", "此应用版本的公开下载页面。链接在撤销或设置的有效期届满前有效，可以在此重新复制。")}
          </p>
        </div>
        <Button variant="primary" className="text-sm" onClick={() => setShowCreate(true)}>
          {t("New share", "新建分享")}
        </Button>
      </div>

      {createdUrl && (
        <div className="flex flex-row items-center gap-3 rounded-md bg-fill-muted p-3 text-sm">
          <span className="font-mono break-all flex-1">{createdUrl}</span>
          <Button
            variant="outline"
            className="text-xs"
            onClick={() => {
              navigator.clipboard?.writeText(createdUrl);
              toast.show({ kind: "success", title: t("Copied share URL", "已复制分享链接") });
            }}
          >
            {t("Copy", "复制")}
          </Button>
          <Button variant="outline" className="text-xs" onClick={() => setCreatedUrl(null)}>
            {t("Dismiss", "关闭")}
          </Button>
        </div>
      )}

      <div className="overflow-x-auto">
        {shares.isLoading && (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        )}
        {shares.error && (
          <p className="text-sm text-danger">
            {t("Failed to load shares:", "加载分享失败：")} {(shares.error as Error).message}
          </p>
        )}
        {!shares.isLoading && rows.length === 0 && (
          <EmptyState>
            <EmptyStateContent>
              <EmptyStateIcon>
                <Share2 aria-hidden="true" />
              </EmptyStateIcon>
              <EmptyStateTitle>{t("No shares yet", "暂无分享")}</EmptyStateTitle>
              <EmptyStateDescription>
                {t("Create one here, from the CLI (", "可在此处、通过命令行（")}<code>hands releases share</code>{t("), or from the release workflow.", "）或在发布流程中创建。")}
              </EmptyStateDescription>
            </EmptyStateContent>
          </EmptyState>
        )}
        {rows.length > 0 && (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-foreground-muted border-b border-line-muted">
                <th className="py-2 pr-3">{t("Release", "版本")}</th>
                <th className="py-2 pr-3">{t("Status", "状态")}</th>
                <th className="py-2 pr-3">{t("Created", "创建时间")}</th>
                <th className="py-2 pr-3">URL</th>
                <th className="py-2 pr-3">{t("Views", "访问次数")}</th>
                <th className="py-2 pr-3">{t("Downloads", "下载次数")}</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((share) => (
                <ShareRow
                  key={share.id}
                  share={share}
                  onCopyUrl={() => {
                    if (!share.share_url) return;
                    navigator.clipboard?.writeText(share.share_url);
                    toast.show({ kind: "success", title: t("Copied share URL", "已复制分享链接") });
                  }}
                  onSetExpiry={() => {
                    const next = window.prompt(
                      t("Days until this link expires (leave empty for never):", "链接多少天后过期（留空表示永不过期）："),
                      share.expires_at
                        ? String(Math.max(1, Math.ceil((share.expires_at - Date.now()) / 86_400_000)))
                        : "",
                    );
                    if (next === null) return;
                    const trimmed = next.trim();
                    if (!trimmed) {
                      setExpiry.mutate({ share, ttlDays: null });
                      return;
                    }
                    const days = Number(trimmed);
                    if (!Number.isFinite(days) || days <= 0) {
                      toast.show({ kind: "error", title: t("Enter a positive number of days", "请输入大于零的天数") });
                      return;
                    }
                    setExpiry.mutate({ share, ttlDays: days });
                  }}
                  onRevoke={() => revoke.mutate(share)}
                  onRebind={() => setRebindShare(share)}
                  onSetPassword={() => {
                    const next = window.prompt(
                      share.has_password
                        ? t("New password (leave empty to remove the password):", "新密码（留空可移除密码）：")
                        : t("Password for this share:", "此分享的密码："),
                    );
                    if (next === null) return;
                    setPassword.mutate({
                      share,
                      password: next.trim() ? next.trim() : null,
                    });
                  }}
                  busy={revoke.isPending || setPassword.isPending || setExpiry.isPending}
                />
              ))}
            </tbody>
          </table>
        )}
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
    </div>
  );
}

function shareState(share: AppShare): { label: string; variant: BadgeVariant } {
  if (share.revoked_at) return { label: "revoked", variant: "muted" };
  // Legacy shares may still carry an expiry; new ones live until revoked.
  if (share.expires_at != null && share.expires_at <= Date.now()) {
    return { label: "expired", variant: "warning" };
  }
  return { label: "active", variant: "success" };
}

function ShareRow({
  share,
  onCopyUrl,
  onSetExpiry,
  onRevoke,
  onRebind,
  onSetPassword,
  busy,
}: {
  share: AppShare;
  onCopyUrl: () => void;
  onSetExpiry: () => void;
  onRevoke: () => void;
  onRebind: () => void;
  onSetPassword: () => void;
  busy: boolean;
}) {
  const t = useText();
  const { locale } = useLocale();
  const state = shareState(share);
  const stateZh: Record<string, string> = { revoked: "已撤销", expired: "已过期", active: "有效" };
  const actionable = !share.revoked_at;
  return (
    <tr className="border-b border-line-hairline last:border-0">
      <td className="py-2 pr-3">
        <span className="font-medium">
          {share.version_name} ({share.version_code})
        </span>
        <span className="ml-2 text-xs text-foreground-muted">{share.channel_slug}</span>
        <div className="text-xs text-foreground-hint">{t(`by ${share.created_by}`, `由 ${share.created_by} 创建`)}</div>
      </td>
      <td className="py-2 pr-3">
        <Badge variant={state.variant}>
          {t(state.label, stateZh[state.label] ?? state.label)}
        </Badge>
        {Boolean(share.has_password) && (
          <Badge variant="information" className="ml-1">
            {t("password", "有密码")}
          </Badge>
        )}
        {share.expires_at != null && !share.revoked_at && share.expires_at > Date.now() && (
          <div className="mt-0.5 text-xs text-foreground-hint">
            {t(`expires ${new Date(share.expires_at).toLocaleString(locale)}`, `${new Date(share.expires_at).toLocaleString(locale)} 过期`)}
          </div>
        )}
      </td>
      <td className="py-2 pr-3 text-xs text-foreground">
        {new Date(share.created_at).toLocaleString(locale)}
      </td>
      <td className="py-2 pr-3 text-xs">
        {share.share_url ? (
          <Button variant="link" size="sm" onClick={onCopyUrl}>
            {t("Copy URL", "复制链接")}
          </Button>
        ) : (
          <span className="text-foreground-hint" title={t("Created before URLs were stored; the link itself still works.", "此链接创建时尚未保存链接地址；链接本身仍然有效。") }>
            {t("unavailable (legacy)", "无法查看（旧链接）")}
          </span>
        )}
      </td>
      <td className="py-2 pr-3">
        {share.view_count}
        <span className="text-xs text-foreground-hint"> {t(`(${share.unique_view_count} uniq)`, `（去重后 ${share.unique_view_count}）`)}</span>
      </td>
      <td className="py-2 pr-3">
        {share.download_count}
        <span className="text-xs text-foreground-hint"> {t(`(${share.unique_download_count} uniq)`, `（去重后 ${share.unique_download_count}）`)}</span>
      </td>
      <td className="py-2 text-right text-xs whitespace-nowrap">
        {actionable && (
          <>
            <Button variant="link" size="sm" className="mr-2" onClick={onSetExpiry} disabled={busy}>
              {t("Expiry…", "有效期…")}
            </Button>
            <Button variant="link" size="sm" className="mr-2" onClick={onSetPassword} disabled={busy}>
              {share.has_password ? t("Password…", "密码…") : t("Set password", "设置密码")}
            </Button>
            <Button variant="link" size="sm" className="mr-2" onClick={onRebind} disabled={busy}>
              {t("Rebind release…", "更换关联版本…")}
            </Button>
            <Button variant="link" size="sm" className="text-danger" onClick={onRevoke} disabled={busy}>
              {t("Revoke", "撤销")}
            </Button>
          </>
        )}
      </td>
    </tr>
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
      description: (error as Error).message,
    }),
  });

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{t("Rebind share to another release", "将分享关联到其他版本")}</DialogTitle></DialogHeader>
        <DialogBody className="space-y-3">
          <p className="text-sm text-foreground">
            {t("The public URL stays the same. Its version, build, download, and checksum will all point to the selected release.", "公开链接不变；其中的版本、构建、下载文件和校验和都会指向所选版本。")}
          </p>
          <div className="rounded-md border border-line-muted p-3 text-sm">
            <div className="text-xs text-foreground-muted">{t("Current release", "当前版本")}</div>
            <strong>{share.version_name} ({share.version_code})</strong>
            <span className="ml-2 text-xs text-foreground-muted">{share.channel_slug}</span>
          </div>
          <label className="block text-xs text-foreground">
            {t("Target active release", "目标有效版本")}
            <Select
              items={{
                "": t("Select an active release…", "选择一个有效版本…"),
                ...Object.fromEntries(options.map((release) => [
                  release.id,
                  `${release.version_name ?? release.id.slice(0, 8)} (${release.version_code ?? "—"})`,
                ])),
              }}
              value={targetReleaseId}
              onValueChange={(value) => setTargetReleaseId(value as string)}
            >
              <SelectTrigger className="mt-1 py-1.5!"><SelectValue /><SelectIcon /></SelectTrigger>
              <SelectContent>
                <SelectList>
                <SelectItem value="">{t("Select an active release…", "选择一个有效版本…")}</SelectItem>
                {options.map((release) => (
                  <SelectItem key={release.id} value={release.id}>
                    {release.version_name ?? release.id.slice(0, 8)} ({release.version_code ?? "—"})
                  </SelectItem>
                ))}
              </SelectList>
              </SelectContent>
            </Select>
          </label>
          {target.isLoading && <Skeleton className="h-20 w-full" />}
          {target.data && (
            <div className="rounded-md border border-warning bg-warning-soft p-3 text-sm">
              <div><strong>{target.data.build.version_name}</strong> ({target.data.build.version_code})</div>
              <div className="mt-1 text-xs text-foreground">{t("Build:", "构建：")} <code>{target.data.build.id}</code></div>
              <div className="mt-1 break-all text-xs text-foreground">{t("Checksum:", "校验和：")} <code>{installable?.file_hash ?? t("No installable asset", "没有可安装文件")}</code></div>
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("Cancel", "取消")}</Button>
          <Button
            variant="primary"
            disabled={!targetReleaseId || !installable || rebind.isPending}
            onClick={() => rebind.mutate()}
          >
            {rebind.isPending ? t("Rebinding…", "更换中…") : t("Rebind release", "更换关联版本")}
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
        .filter((r: any) => r.status === "active" || r.status === "superseded")
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
        description: (e as Error).message,
      }),
  });

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("New share link", "新建分享链接")}</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <label className="block text-xs text-foreground">
            {t("Release", "版本")}
            <Select
              items={{
                "": t("Select a release…", "选择版本…"),
                ...Object.fromEntries(
                  options.map((r: any) => [r.id, `${r.version_name ?? r.id.slice(0, 8)} · ${t(r.status, r.status === "active" ? "有效" : r.status === "superseded" ? "已被替代" : r.status)}`]),
                ),
              }}
              value={releaseId}
              onValueChange={(v) => setReleaseId(v as string)}
            >
              <SelectTrigger className="mt-1 py-1.5!">
                <SelectValue />
                <SelectIcon />
              </SelectTrigger>
              <SelectContent>
                <SelectList>
                <SelectItem value="">{t("Select a release…", "选择版本…")}</SelectItem>
                {options.map((r: any) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.version_name ?? r.id.slice(0, 8)} · {t(r.status, r.status === "active" ? "有效" : r.status === "superseded" ? "已被替代" : r.status)}
                  </SelectItem>
                ))}
              </SelectList>
              </SelectContent>
            </Select>
          </label>
          <label className="block text-xs text-foreground">
            {t("Expires in days (optional)", "有效天数（可选）")}
            <Input
              type="number"
              min={1}
              value={ttlDays}
              onChange={(e) => setTtlDays(e.target.value)}
              placeholder={t("Leave empty — link lives until revoked", "留空表示链接在撤销前一直有效")}
              className="mt-1 py-1.5!"
            />
          </label>
          <label className="block text-xs text-foreground">
            {t("Password (optional)", "密码（可选）")}
            <Input
              type="text"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t("Leave empty for a public link", "留空则为公开链接")}
              className="mt-1 py-1.5!"
            />
          </label>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" className="text-sm" onClick={onClose} disabled={create.isPending}>
            {t("Cancel", "取消")}
          </Button>
          <Button
            variant="primary"
            className="text-sm"
            onClick={() => create.mutate()}
            disabled={create.isPending || !releaseId}
          >
            {create.isPending ? t("Creating…", "创建中…") : t("Create", "创建")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
