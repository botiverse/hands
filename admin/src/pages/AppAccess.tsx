import { errorMessage } from "../lib/errorMessage";
/**
 * AppAccess — per-app member management.
 *
 * Access section in App Settings. Shows app_members (humans + agents granted
 * per-app roles). Admin / publisher only.
 *
 * Wires the new P5.3 endpoints:
 *   GET /api/apps/:appId/members
 *   POST /api/apps/:appId/members  (admin only)
 *   PATCH /api/apps/:appId/members/:accountId  (admin only)
 *   DELETE /api/apps/:appId/members/:accountId  (admin only)
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  addAppMember,
  addAppServerGrant,
  createOrgInvite,
  createAppDeployToken,
  getAppPermissionModel,
  getAuthMe,
  listApps,
  listAppMembers,
  listAppDeployTokens,
  listAppServerGrants,
  listOrgMembers,
  removeAppMember,
  removeAppServerGrant,
  revokeAppDeployToken,
  updateAppMember,
  type AppMember,
  type AppDeployToken,
  type AppPermission,
  type App,
} from "../lib/api";
import { appAccessMessage } from "../lib/appAccessMessages";
import { PERMISSION_ZH } from "../lib/permissionMessages";
import { useLocale, useText } from "../lib/locale";
import {
  collidingPrincipalLabels,
  needsServerBadge,
  principalOptionLabel,
  principalServer,
} from "../lib/principalIdentity";
import { useToast } from "../components/Toast";
import {
  buildTokenGrantDisplay,
  resolveGrantPreview,
} from "../lib/appPermissionDisplay";
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
  DialogClose,
  EmptyState,
  EmptyStateTitle,
  Checkbox,
  Skeleton,
  Textarea,
} from "raft-ui";

const ROLE_ZH: Record<string, string> = { owner: "所有者", admin: "管理员", publisher: "发布者", viewer: "查看者", member: "成员" };
const roleText = (role: string, t: (english: string, chinese: string) => string) => t(role, ROLE_ZH[role] ?? role);

export function AppAccess({ appId }: { appId: string }) {
  const t = useText();
  const { locale } = useLocale();
  const [showAddServer, setShowAddServer] = useState(false);
  const [showAddMember, setShowAddMember] = useState(false);
  const [showAddDeployToken, setShowAddDeployToken] = useState(false);
  const me = useQuery({ queryKey: ["auth-me"], queryFn: () => getAuthMe() });
  const account = me.data?.account;
  const orgRole = account?.org_role ?? null;
  const isOrgAdmin = orgRole === "owner" || orgRole === "admin";
  const apps = useQuery({ queryKey: ["apps"], queryFn: () => listApps() });
  const app = apps.data?.apps.find((a) => a.id === appId) ?? null;
  const isOwningOrg = !!app?.org_id && app.org_id === account?.org_id;
  const appMembers = useQuery({
    queryKey: ["app-members", appId],
    queryFn: () => listAppMembers(appId),
    enabled: !!account?.id,
  });
  const serverGrants = useQuery({
    queryKey: ["app-server-grants", appId],
    queryFn: () => listAppServerGrants(appId),
    enabled: !!account?.server_id,
  });
  const currentAppRole =
    appMembers.data?.members.find((m) => m.account_id === account?.id)?.app_role ??
    null;
  const currentServerGrantRole =
    serverGrants.data?.server_grants.find(
      (g) =>
        g.server_id === account?.server_id ||
        (!!g.server_slug && g.server_slug === account?.server_slug),
    )?.app_role ?? null;
  const canManage =
    isOrgAdmin || currentAppRole === "admin" || currentServerGrantRole === "admin";
  const inheritedRole = isOwningOrg ? orgRole : null;
  const currentAccess = currentAppRole ?? currentServerGrantRole ?? inheritedRole ?? null;

  return (
    <section aria-labelledby="app-access-heading" className="space-y-4">
      <header className="space-y-2">
        <h2 id="app-access-heading" className="text-lg font-semibold">{appAccessMessage("title", locale)}</h2>
        <p className="text-sm text-foreground">{appAccessMessage("description", locale)}</p>
        <div className="text-xs text-foreground-muted">
          {t("Your current access:", "您的当前权限：")} <span className="font-mono">{currentAccess ? roleText(currentAccess, t) : "—"}</span>{" "}
          {isOwningOrg && <span>{t("(inherited from owning org)", "（继承自所属组织）")}</span>}
          {!isOwningOrg && currentServerGrantRole && (
            <span>{t("(server visibility)", "（服务器可见权限）")}</span>
          )}
          {!isOwningOrg && currentAppRole && <span>{t("(direct app member)", "（应用直接成员）")}</span>}{" "}
          {canManage ? t("(can manage access)", "（可管理权限）") : t("(read-only)", "（只读）")}
        </div>
      </header>
      <AppServerGrantList
        appId={appId}
        app={app}
        isOwningOrg={isOwningOrg}
        // Co-owner servers are the owning org's decision: the server only lets an
        // admin/owner of the org that owns the app add or remove them.
        canManage={isOrgAdmin && isOwningOrg}
        onAdd={() => setShowAddServer(true)}
        orgRole={orgRole}
        currentServerId={account?.server_id ?? null}
        currentServerSlug={account?.server_slug ?? null}
      />
      <AppMemberList
        appId={appId}
        canManage={canManage}
        currentAccountId={account?.id ?? null}
        onAdd={() => setShowAddMember(true)}
      />
      {canManage && (
        <AppDeployTokenList
          appId={appId}
          onAdd={() => setShowAddDeployToken(true)}
        />
      )}
      {canManage && <InviteToAppForm appId={appId} />}
      {showAddServer && (
        <AddAppServerGrantDialog
          appId={appId}
          onClose={() => setShowAddServer(false)}
          onAdded={() => setShowAddServer(false)}
        />
      )}
      {showAddMember && (
        <AddAppMemberDialog
          appId={appId}
          onClose={() => setShowAddMember(false)}
          onAdded={() => setShowAddMember(false)}
        />
      )}
      {showAddDeployToken && (
        <AddAppDeployTokenDialog
          appId={appId}
          onClose={() => setShowAddDeployToken(false)}
          onAdded={() => setShowAddDeployToken(false)}
        />
      )}
    </section>
  );
}

function AppServerGrantList({
  appId,
  app,
  isOwningOrg,
  canManage,
  onAdd,
  orgRole,
  currentServerId,
  currentServerSlug,
}: {
  appId: string;
  app: App | null;
  isOwningOrg: boolean;
  canManage: boolean;
  onAdd: () => void;
  orgRole: string | null;
  currentServerId: string | null;
  currentServerSlug: string | null;
}) {
  const t = useText();
  const qc = useQueryClient();
  const toast = useToast();
  const grants = useQuery({
    queryKey: ["app-server-grants", appId],
    queryFn: () => listAppServerGrants(appId),
  });
  const rows = grants.data?.server_grants ?? [];

  const remove = useMutation({
    mutationFn: (grantKey: string) => removeAppServerGrant(appId, grantKey),
    onSuccess: () => {
      toast.show({ kind: "success", title: t("Server grant removed", "服务器授权已移除") });
      qc.invalidateQueries({ queryKey: ["app-server-grants", appId] });
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: t("Remove failed", "移除失败"),
        description: errorMessage(e),
      }),
  });

  const visibleRowCount = rows.length + (isOwningOrg ? 1 : 0);

  return (
    <section className="border-t border-line-hairline pt-5">
      {grants.isLoading && (
        <div className="space-y-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      )}
      {grants.error && (
        <p className="text-danger">{t("Failed:", "加载失败：")} {errorMessage(grants.error)}</p>
      )}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-foreground-strong">{t("Server access", "服务器访问权限")}</h3>
        <div className="flex items-center gap-2">
          <span className="text-xs text-foreground-muted whitespace-nowrap">
            {t(`${visibleRowCount} server${visibleRowCount === 1 ? "" : "s"}`, `${visibleRowCount} 个服务器`)}
          </span>
          {canManage && (
            <Button variant="outline" className="py-1! px-2! text-xs! whitespace-nowrap" onClick={onAdd}>
              {t("+ Add", "+ 添加")}
            </Button>
          )}
        </div>
      </div>
      {grants.data && visibleRowCount === 0 && (
        <EmptyState>
          <EmptyStateTitle>{t("No server-level access rows visible.", "没有可见的服务器级授权记录。")}</EmptyStateTitle>
        </EmptyState>
      )}
      {grants.data && visibleRowCount > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-foreground-muted text-left border-b border-line-hairline">
              <th className="font-normal py-1 pr-2">{t("Server", "服务器")}</th>
              <th className="font-normal py-1 pr-2">{t("Access", "权限")}</th>
              <th className="font-normal py-1 pr-2">{t("Source", "来源")}</th>
              {canManage && <th className="font-normal py-1">{t("Actions", "操作")}</th>}
            </tr>
          </thead>
          <tbody>
            {isOwningOrg && (
              <tr className="border-b border-line-hairline bg-layer-canvas-muted/60">
                <td className="py-2 pr-2">
                  <div className="font-medium">
                    {currentServerSlug || app?.org_id || t("Current server", "当前服务器")}
                    <span className="ml-1 text-xs text-foreground-muted">{t("(current)", "（当前）")}</span>
                  </div>
                </td>
                <td className="py-2 pr-2">
                  <span className="text-xs font-medium">{t("Owner server", "所属服务器")}</span>
                </td>
                <td className="py-2 pr-2 text-xs text-foreground-muted">
                  {t("Owning org", "所属组织")}
                </td>
                {canManage && (
                  <td className="py-2 text-xs text-foreground-hint">{t("Inherited", "继承")}</td>
                )}
              </tr>
            )}
            {rows.map((grant) => (
              <tr
                key={grant.id}
                className="border-b border-line-hairline hover:bg-fill-muted"
              >
                <td className="py-2 pr-2">
                  <div className="font-medium">
                    {grant.server_slug || grant.server_id}
                    {(grant.server_id === currentServerId ||
                      (!!grant.server_slug && grant.server_slug === currentServerSlug)) && (
                      <span className="ml-1 text-xs text-foreground-muted">{t("(current)", "（当前）")}</span>
                    )}
                  </div>
                </td>
                <td className="py-2 pr-2">
                  <span className="text-xs font-medium">
                    {grant.access_model === "owner_server"
                      ? t("Owner server", "所属服务器")
                      : t(`Legacy ${grant.app_role}`, `旧版权限：${roleText(grant.app_role, t)}`)}
                  </span>
                </td>
                <td className="py-2 pr-2 text-xs text-foreground-muted">
                  {grant.access_model === "owner_server"
                    ? t("Additional owner", "附加所属服务器")
                    : t("Existing role preserved; remove and re-add to adopt owner-server access", "保留现有角色；移除并重新添加后可使用所属服务器权限")}
                </td>
                {canManage && (
                  <td className="py-2 text-xs">
                    <Button
                      variant="link"
                      size="sm"
                      className="text-danger"
                      onClick={() => {
                        if (
                          confirm(
                            t(`Remove server grant for ${grant.server_slug || grant.server_id}?`, `移除服务器 ${grant.server_slug || grant.server_id} 的授权？`),
                          )
                        ) {
                          remove.mutate(grant.id);
                        }
                      }}
                      disabled={remove.isPending}
                    >
                      {t("Remove", "移除")}
                    </Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {grants.data && isOwningOrg && rows.length === 0 && (
        <p className="text-xs text-foreground-muted mt-2">
          {t("No additional owner servers yet. The current server owns this app.", "暂无附加所属服务器。当前服务器拥有此应用。")}
        </p>
      )}
    </section>
  );
}

function AddAppServerGrantDialog({
  appId,
  onClose,
  onAdded,
}: {
  appId: string;
  onClose: () => void;
  onAdded: () => void;
}) {
  const t = useText();
  const qc = useQueryClient();
  const toast = useToast();
  const [serverId, setServerId] = useState("");
  const [serverSlug, setServerSlug] = useState("");

  const add = useMutation({
    mutationFn: () =>
      addAppServerGrant(appId, {
        server_id: serverId.trim() || null,
        server_slug: serverSlug.trim() || null,
      }),
    onSuccess: () => {
      toast.show({ kind: "success", title: t("Server grant added", "服务器授权已添加") });
      qc.invalidateQueries({ queryKey: ["app-server-grants", appId] });
      setServerId("");
      setServerSlug("");
      onAdded();
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: t("Add failed", "添加失败"),
        description: errorMessage(e),
      }),
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogClose
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("Close", "关闭")}
              className="absolute top-3 right-3 text-foreground-hint hover:text-foreground-strong"
            />
          }
        >
          ×
        </DialogClose>
        <DialogHeader>
          <DialogTitle>{t("Add Raft server", "添加 Raft 服务器")}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <form
            id="add-app-server-grant-form"
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!confirm(
                t(`Make ${serverSlug.trim() || serverId.trim()} an owner server for this app? Its members receive the same role-based access as the creating server.`, `将 ${serverSlug.trim() || serverId.trim()} 设为此应用的所属服务器？其成员将获得与创建服务器相同的基于角色的权限。`),
              )) {
                return;
              }
              add.mutate();
            }}
          >
            <div>
              <Label>{t("Server slug", "服务器标识")}</Label>
              <Input
                value={serverSlug}
                onChange={(e) => setServerSlug(e.target.value)}
                placeholder={t("server slug", "服务器标识")}
                autoFocus
              />
            </div>
            <div>
              <Label>{t("Server ID", "服务器 ID")}</Label>
              <Input
                value={serverId}
                onChange={(e) => setServerId(e.target.value)}
                placeholder={t("optional", "可选")}
              />
            </div>
            <p className="text-xs text-foreground-muted">
              {t("An additional owner server uses the same role mapping as the server that created the app: server owners/admins can publish releases and manage access; members keep the same bounded member actions as on the creating server; viewers have read-only access.", "附加的所属服务器使用与创建应用的服务器相同的角色映射：服务器所有者和管理员可发布版本并管理权限；成员拥有与创建服务器相同的有限操作权限；查看者拥有只读权限。")}
            </p>
          </form>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" type="button" onClick={onClose}>
            {t("Cancel", "取消")}
          </Button>
          <Button
            type="submit"
            form="add-app-server-grant-form"
            variant="primary"
            disabled={(!serverId.trim() && !serverSlug.trim()) || add.isPending}
          >
            {add.isPending ? t("Adding…", "添加中…") : t("Add", "添加")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AppMemberList({
  appId,
  canManage,
  currentAccountId,
  onAdd,
}: {
  appId: string;
  canManage: boolean;
  currentAccountId: string | null;
  onAdd: () => void;
}) {
  const t = useText();
  const qc = useQueryClient();
  const toast = useToast();
  const [principalFilter, setPrincipalFilter] = useState<"all" | "human" | "agent">("all");
  const members = useQuery({
    queryKey: ["app-members", appId],
    queryFn: () => listAppMembers(appId),
  });
  const filteredMembers = (members.data?.members ?? []).filter((m) =>
    principalFilter === "all"
      ? true
      : m.principal_type === principalFilter,
  );
  // Computed over the WHOLE filtered collection, never per row: a row cannot
  // see its peers, and a per-page computation would label one row and not the
  // other (see principalIdentity.ts). Filtering first is intentional — the
  // badge answers "can I tell these rows apart on screen right now?".
  const collidingLabels = collidingPrincipalLabels(filteredMembers);

  const update = useMutation({
    mutationFn: ({ accountId, role }: { accountId: string; role: AppMember["app_role"] }) =>
      updateAppMember(appId, accountId, role),
    onSuccess: () => {
      toast.show({ kind: "success", title: t("App member role updated", "应用成员角色已更新") });
      qc.invalidateQueries({ queryKey: ["app-members", appId] });
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: t("Update failed", "更新失败"),
        description: errorMessage(e),
      }),
  });

  const remove = useMutation({
    mutationFn: (accountId: string) => removeAppMember(appId, accountId),
    onSuccess: () => {
      toast.show({ kind: "success", title: t("App member removed", "应用成员已移除") });
      qc.invalidateQueries({ queryKey: ["app-members", appId] });
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: t("Remove failed", "移除失败"),
        description: errorMessage(e),
      }),
  });

  return (
    <section className="border-t border-line-hairline pt-5">
      {members.isLoading && (
        <div className="space-y-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      )}
      {members.error && (
        <p className="text-danger">{t("Failed:", "加载失败：")} {errorMessage(members.error)}</p>
      )}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-foreground-strong">{t("Direct app members", "应用直接成员")}</h3>
        <div className="flex items-center gap-2">
          <Select
            items={{ all: t("All types", "全部类型"), human: t("Humans only", "仅用户"), agent: t("Agents only", "仅智能体") }}
            value={principalFilter}
            onValueChange={(v) =>
              setPrincipalFilter(v as "all" | "human" | "agent")
            }
          >
            <Tooltip>
              <TooltipTrigger
                render={
                  <SelectTrigger className="w-auto! text-xs py-0.5 pr-7">
                    <SelectValue />
                    <SelectIcon />
                  </SelectTrigger>
                }
              />
              <TooltipContent>{t("Filter by principal type", "按身份类型筛选")}</TooltipContent>
            </Tooltip>
            <SelectContent>
              <SelectList>
              <SelectItem value="all">{t("All types", "全部类型")}</SelectItem>
              <SelectItem value="human">{t("Humans only", "仅用户")}</SelectItem>
              <SelectItem value="agent">{t("Agents only", "仅智能体")}</SelectItem>
            </SelectList>
            </SelectContent>
          </Select>
          <span className="text-xs text-foreground-muted whitespace-nowrap">
            {t(`${filteredMembers.length} member${filteredMembers.length === 1 ? "" : "s"}`, `${filteredMembers.length} 位成员`)}
            {principalFilter !== "all" && (
              <span className="ml-1">({t(principalFilter, principalFilter === "human" ? "用户" : "智能体")})</span>
            )}
          </span>
          {canManage && (
            <Button variant="outline" className="py-1! px-2! text-xs! whitespace-nowrap" onClick={onAdd}>
              {t("+ Add", "+ 添加")}
            </Button>
          )}
        </div>
      </div>
      {members.data && filteredMembers.length === 0 && (
        <EmptyState>
          <EmptyStateTitle>
            {principalFilter === "all"
              ? t("No direct app members yet. Org members may still have inherited access.", "暂无应用直接成员。组织成员仍可能拥有继承的权限。")
              : t(`No ${principalFilter} app members.`, `暂无${principalFilter === "human" ? "用户" : "智能体"}应用成员。`)}
          </EmptyStateTitle>
        </EmptyState>
      )}
      {members.data && filteredMembers.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-foreground-muted text-left border-b border-line-hairline">
              <th className="font-normal py-1 pr-2">{t("Principal", "身份")}</th>
              <th className="font-normal py-1 pr-2">{t("Type", "类型")}</th>
              <th className="font-normal py-1 pr-2">{t("App role", "应用角色")}</th>
              <th className="font-normal py-1 pr-2">{t("Joined", "加入日期")}</th>
              <th className="font-normal py-1 pr-2">{t("Last login", "上次登录")}</th>
              {canManage && <th className="font-normal py-1">{t("Actions", "操作")}</th>}
            </tr>
          </thead>
          <tbody>
            {filteredMembers.map((m) => (
              <tr
                key={m.account_id}
                className="border-b border-line-hairline hover:bg-fill-muted"
              >
                <td className="py-2 pr-2">
                  <div className="font-medium">
                    {m.display_name}
                    {needsServerBadge(m, collidingLabels) && principalServer(m) && (
                      <Badge variant="muted" className="ml-1.5 align-middle">
                        {principalServer(m)}
                      </Badge>
                    )}
                    {m.account_id === currentAccountId && (
                      <span className="ml-1 text-xs text-foreground-muted">{t("(you)", "（您）")}</span>
                    )}
                  </div>
                  <div className="text-xs text-foreground-muted">
                    {m.username ? (
                      <span className="font-mono">@{m.username}</span>
                    ) : (
                      <span className="font-mono">
                        {m.provider_subject.slice(0, 16)}…
                      </span>
                    )}
                  </div>
                </td>
                <td className="py-2 pr-2">
                  {m.principal_type === "agent" ? (
                    <Badge variant="accent">{t("agent", "智能体")}</Badge>
                  ) : (
                    <span className="text-xs">{t("human", "用户")}</span>
                  )}
                </td>
                <td className="py-2 pr-2">
                  {canManage && m.account_id !== currentAccountId ? (
                    <Select
                      items={{ admin: roleText("admin", t), publisher: roleText("publisher", t), viewer: roleText("viewer", t) }}
                      value={m.app_role}
                      onValueChange={(v) =>
                        update.mutate({
                          accountId: m.account_id,
                          role: v as AppMember["app_role"],
                        })
                      }
                      disabled={update.isPending}
                    >
                      <SelectTrigger className="text-xs py-0.5">
                        <SelectValue />
                        <SelectIcon />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectList>
                        {(["admin", "publisher", "viewer"] as const).map((r) => (
                          <SelectItem key={r} value={r}>
                            {roleText(r, t)}
                          </SelectItem>
                        ))}
                      </SelectList>
                      </SelectContent>
                    </Select>
                  ) : (
                    <span className="text-xs font-medium">{roleText(m.app_role, t)}</span>
                  )}
                </td>
                <td className="py-2 pr-2 text-xs text-foreground-muted">
                  {new Date(m.joined_at).toISOString().slice(0, 10)}
                </td>
                <td className="py-2 pr-2 text-xs text-foreground-muted">
                  {m.last_login_at
                    ? new Date(m.last_login_at).toISOString().slice(0, 10)
                    : "—"}
                </td>
                {canManage && (
                  <td className="py-2 text-xs">
                    {m.account_id !== currentAccountId && (
                      <Button
                        variant="link"
                        size="sm"
                        className="text-danger"
                        onClick={() => {
                          if (
                            confirm(
                              t(`Remove ${m.display_name} from this app?`, `将 ${m.display_name} 从此应用移除？`),
                            )
                          ) {
                            remove.mutate(m.account_id);
                          }
                        }}
                        disabled={remove.isPending}
                      >
                        {t("Remove", "移除")}
                      </Button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function AppDeployTokenList({
  appId,
  onAdd,
}: {
  appId: string;
  onAdd: () => void;
}) {
  const t = useText();
  const qc = useQueryClient();
  const toast = useToast();
  const tokens = useQuery({
    queryKey: ["app-deploy-tokens", appId],
    queryFn: () => listAppDeployTokens(appId),
  });
  const permissionModel = useQuery({
    queryKey: ["app-permissions"],
    queryFn: getAppPermissionModel,
  });
  const revoke = useMutation({
    mutationFn: (tokenId: string) => revokeAppDeployToken(appId, tokenId),
    onSuccess: () => {
      toast.show({ kind: "success", title: t("Deploy token revoked", "部署令牌已撤销") });
      qc.invalidateQueries({ queryKey: ["app-deploy-tokens", appId] });
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: t("Revoke failed", "撤销失败"),
        description: errorMessage(e),
      }),
  });
  const rows = tokens.data?.deploy_tokens ?? [];

  return (
    <section className="border-t border-line-hairline pt-5">
      {tokens.isLoading && (
        <div className="space-y-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      )}
      {tokens.error && (
        <p className="text-danger">{t("Failed:", "加载失败：")} {errorMessage(tokens.error)}</p>
      )}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-foreground-strong">{t("Deploy tokens", "部署令牌")}</h3>
        <div className="flex items-center gap-2">
          <span className="text-xs text-foreground-muted whitespace-nowrap">
            {t(`${rows.length} token${rows.length === 1 ? "" : "s"}`, `${rows.length} 个令牌`)}
          </span>
          <Button variant="outline" className="py-1! px-2! text-xs! whitespace-nowrap" onClick={onAdd}>
            {t("+ Add", "+ 添加")}
          </Button>
        </div>
      </div>
      {tokens.data && rows.length === 0 && (
        <EmptyState>
          <EmptyStateTitle>{t("No deploy tokens yet.", "暂无部署令牌。")}</EmptyStateTitle>
        </EmptyState>
      )}
      {tokens.data && rows.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-foreground-muted text-left border-b border-line-hairline">
              <th className="font-normal py-1 pr-2">{t("Name", "名称")}</th>
              <th className="font-normal py-1 pr-2">{t("Prefix", "前缀")}</th>
              <th className="font-normal py-1 pr-2">{t("Grant", "授权")}</th>
              <th className="font-normal py-1 pr-2">{t("Expires", "过期时间")}</th>
              <th className="font-normal py-1 pr-2">{t("Last used", "上次使用")}</th>
              <th className="font-normal py-1">{t("Actions", "操作")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((token) => {
              const display = buildTokenGrantDisplay(token, permissionModel.data);
              const shownPermissions = display.permissions.slice(0, 4);
              return (
                <tr
                  key={token.id}
                  className="border-b border-line-hairline hover:bg-fill-muted"
                >
                <td className="py-2 pr-2">
                  <div className="font-medium">{token.name}</div>
                  <div className="text-xs text-foreground-muted">
                    {t(`by ${token.created_by_actor}`, `由 ${token.created_by_actor} 创建`)}
                  </div>
                </td>
                <td className="py-2 pr-2">
                  <span className="font-mono text-xs text-foreground">
                    {token.token_prefix}
                  </span>
                </td>
                <td className="py-2 pr-2">
                  <div className="max-w-sm space-y-1">
                    <div className="flex flex-wrap gap-1 text-xs">
                      <span className="rounded bg-foreground-strong px-1.5 py-0.5 font-medium text-foreground-inverse">
                        {t(display.roleLabel, token.app_role ? `角色 · ${roleText(token.app_role, t)}` : "仅自定义权限")}
                      </span>
                      {!display.valid && (
                        <span className="rounded bg-danger-soft px-1.5 py-0.5 font-medium text-danger">
                          {t("Invalid grant", "授权无效")}
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-1 text-xs">
                      {shownPermissions.map(({ permission, label, extra }) => (
                        <span
                          key={permission}
                          title={permission}
                          className={extra
                            ? "rounded border border-warning bg-warning-soft px-1.5 py-0.5 text-warning-strong"
                            : "rounded border border-line-muted bg-layer-canvas-muted px-1.5 py-0.5 text-foreground"}
                        >
                          {t(label, PERMISSION_ZH[permission]?.label ?? label)}{extra ? t(" · Extra", " · 额外权限") : ""}
                        </span>
                      ))}
                      {display.permissions.length > shownPermissions.length && (
                        <span className="rounded border border-line-muted px-1.5 py-0.5 text-foreground-muted">
                          +{display.permissions.length - shownPermissions.length}
                        </span>
                      )}
                    </div>
                  </div>
                </td>
                <td className="py-2 pr-2 text-xs text-foreground-muted">
                  {token.expires_at
                    ? new Date(token.expires_at).toISOString().slice(0, 10)
                    : t("Never", "永不过期")}
                </td>
                <td className="py-2 pr-2 text-xs text-foreground-muted">
                  {token.last_used_at
                    ? new Date(token.last_used_at).toISOString().slice(0, 10)
                    : "—"}
                </td>
                <td className="py-2 text-xs">
                  <Button
                    variant="link"
                    size="sm"
                    className="text-danger"
                    onClick={() => {
                      if (confirm(t(`Revoke deploy token ${token.name}?`, `撤销部署令牌 ${token.name}？`))) {
                        revoke.mutate(token.id);
                      }
                    }}
                    disabled={revoke.isPending}
                  >
                    {t("Revoke", "撤销")}
                  </Button>
                </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="text-xs text-foreground-muted mt-2">
        {t("Tokens are app-scoped bearer credentials for CI. The raw token is only shown once after creation.", "令牌是供 CI 使用、作用范围限于此应用的持有者凭据。原始令牌创建后只显示一次。")}
      </p>
    </section>
  );
}

function AddAppDeployTokenDialog({
  appId,
  onClose,
  onAdded,
}: {
  appId: string;
  onClose: () => void;
  onAdded: () => void;
}) {
  const t = useText();
  const qc = useQueryClient();
  const toast = useToast();
  const permissionModel = useQuery({
    queryKey: ["app-permissions"],
    queryFn: getAppPermissionModel,
  });
  const [name, setName] = useState("");
  const [role, setRole] = useState<"publisher" | "viewer" | "none">("publisher");
  const [scopes, setScopes] = useState<AppPermission[]>([]);
  const [expiry, setExpiry] = useState<"30d" | "90d" | "365d" | "never">("365d");
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const selectedRole = role === "none" ? null : role;
  const grantPreview = resolveGrantPreview(permissionModel.data, selectedRole, scopes);

  const expiresAt = () => {
    if (expiry === "never") return null;
    const days = expiry === "30d" ? 30 : expiry === "90d" ? 90 : 365;
    return Date.now() + days * 24 * 60 * 60 * 1000;
  };

  const create = useMutation({
    mutationFn: () =>
      createAppDeployToken(appId, {
        name: name.trim(),
        ...(role === "none" ? {} : { app_role: role }),
        ...(scopes.length > 0 ? { scopes } : {}),
        expires_at: expiresAt(),
      }),
    onSuccess: (data) => {
      toast.show({ kind: "success", title: t("Deploy token created", "部署令牌已创建") });
      qc.invalidateQueries({ queryKey: ["app-deploy-tokens", appId] });
      setCreatedToken(data.token);
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: t("Create failed", "创建失败"),
        description: errorMessage(e),
      }),
  });

  const closeAfterCreate = () => {
    setCreatedToken(null);
    onAdded();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          if (createdToken) closeAfterCreate();
          else onClose();
        }
      }}
    >
      <DialogContent className="max-w-lg text-sm">
        <DialogClose
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("Close", "关闭")}
              className="absolute top-3 right-3 text-foreground-hint hover:text-foreground-strong"
            />
          }
        >
          ×
        </DialogClose>
        <DialogHeader>
          <DialogTitle>{t("Add deploy token", "添加部署令牌")}</DialogTitle>
        </DialogHeader>
        {createdToken ? (
          <>
            <DialogBody className="space-y-3">
              <p className="text-sm text-foreground">
                {t("Copy this token now. It will not be shown again.", "请立即复制此令牌，之后不会再次显示。")}
              </p>
              <Textarea
                className="font-mono text-xs min-h-[96px]"
                value={createdToken}
                readOnly
                onFocus={(e) => e.currentTarget.select()}
              />
            </DialogBody>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  navigator.clipboard?.writeText(createdToken).catch(() => {});
                  toast.show({ kind: "success", title: t("Token copied", "令牌已复制") });
                }}
              >
                {t("Copy", "复制")}
              </Button>
              <Button type="button" variant="primary" onClick={closeAfterCreate}>
                {t("Done", "完成")}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogBody>
              <form
                id="add-app-deploy-token-form"
                className="space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  create.mutate();
                }}
              >
                <div>
                  <Label>{t("Name", "名称")}</Label>
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="github-actions-main"
                    autoFocus
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>{t("Role bundle", "角色权限集")}</Label>
                    <Select
                      items={{ publisher: roleText("publisher", t), viewer: roleText("viewer", t), none: t("No role", "无角色") }}
                      value={role}
                      onValueChange={(v) => {
                        const nextRole = v as typeof role;
                        const nextPreview = resolveGrantPreview(
                          permissionModel.data,
                          nextRole === "none" ? null : nextRole,
                          [],
                        );
                        setRole(nextRole);
                        setScopes((current) => current.filter(
                          (permission) => !nextPreview.bundled.includes(permission),
                        ));
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue />
                        <SelectIcon />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectList>
                        <SelectItem value="publisher">{roleText("publisher", t)}</SelectItem>
                        <SelectItem value="viewer">{roleText("viewer", t)}</SelectItem>
                        <SelectItem value="none">{t("No role (custom only)", "无角色（仅自定义权限）")}</SelectItem>
                      </SelectList>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>{t("Expires", "过期时间")}</Label>
                    <Select
                      items={{ "30d": t("30 days", "30 天"), "90d": t("90 days", "90 天"), "365d": t("1 year", "1 年"), never: t("Never", "永不过期") }}
                      value={expiry}
                      onValueChange={(v) =>
                        setExpiry(v as "30d" | "90d" | "365d" | "never")
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                        <SelectIcon />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectList>
                        <SelectItem value="30d">{t("30 days", "30 天")}</SelectItem>
                        <SelectItem value="90d">{t("90 days", "90 天")}</SelectItem>
                        <SelectItem value="365d">{t("1 year", "1 年")}</SelectItem>
                        <SelectItem value="never">{t("Never", "永不过期")}</SelectItem>
                      </SelectList>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="space-y-2 rounded-md border border-line-muted p-3">
                  <div className="text-xs font-medium text-foreground-strong">{t("Additional permissions", "额外权限")}</div>
                  {permissionModel.isPending && (
                    <p className="text-xs text-foreground-muted">{t("Loading permission registry…", "正在加载权限列表…")}</p>
                  )}
                  {permissionModel.isError && (
                    <p className="text-xs text-danger">
                      {t("Permission registry could not be loaded. Try again before creating a token.", "无法加载权限列表，请重试后再创建令牌。")}
                    </p>
                  )}
                  {(permissionModel.data?.permissions ?? []).map((permission) => (
                    <label key={permission.permission} className="flex items-center gap-2 text-sm text-foreground-strong">
                      <Checkbox
                        checked={grantPreview.bundled.includes(permission.permission)
                          || scopes.includes(permission.permission)}
                        disabled={grantPreview.bundled.includes(permission.permission)}
                        onCheckedChange={(checked) => {
                          setScopes((current) => checked
                            ? [...new Set([...current, permission.permission])]
                            : current.filter((value) => value !== permission.permission));
                        }}
                      />
                      <span>{t(permission.description, PERMISSION_ZH[permission.permission]?.description ?? permission.description)}</span>
                      <code className="text-xs text-foreground-hint">{permission.permission}</code>
                      {grantPreview.bundled.includes(permission.permission) && (
                        <span className="text-xs text-foreground-hint">{t("Included by role", "角色已包含")}</span>
                      )}
                    </label>
                  ))}
                </div>
                <div className="space-y-2 rounded-md bg-layer-canvas-muted p-3">
                  <div className="text-xs font-medium text-foreground-strong">{t("Effective permissions", "实际生效的权限")}</div>
                  <div className="flex flex-wrap gap-1 text-xs">
                    {grantPreview.effective.map((permission) => {
                      const definition = permissionModel.data?.permissions.find(
                        (entry) => entry.permission === permission,
                      );
                      const extra = grantPreview.extras.includes(permission);
                      return (
                        <span
                          key={permission}
                          title={permission}
                          className={extra
                            ? "rounded border border-warning bg-warning-soft px-1.5 py-0.5 text-warning-strong"
                            : "rounded border border-line-muted bg-layer-panel px-1.5 py-0.5 text-foreground"}
                        >
                          {t(definition?.label ?? permission, PERMISSION_ZH[permission]?.label ?? definition?.label ?? permission)}{extra ? t(" · Extra", " · 额外权限") : ""}
                        </span>
                      );
                    })}
                  </div>
                </div>
                <p className="text-xs text-foreground-muted">
                  {t("The role expands to its permission bundle. Additional permissions are unioned into the token's effective permissions.", "角色会展开为其权限集；额外权限与角色权限合并，构成令牌的实际权限。")}
                </p>
              </form>
            </DialogBody>
            <DialogFooter>
              <Button variant="outline" type="button" onClick={onClose}>
                {t("Cancel", "取消")}
              </Button>
              <Button
                type="submit"
                form="add-app-deploy-token-form"
                variant="primary"
                disabled={
                  !name.trim()
                  || (role === "none" && scopes.length === 0)
                  || permissionModel.isPending
                  || permissionModel.isError
                  || create.isPending
                }
              >
                {create.isPending ? t("Creating…", "创建中…") : t("Create", "创建")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function AddAppMemberDialog({
  appId,
  onClose,
  onAdded,
}: {
  appId: string;
  onClose: () => void;
  onAdded: () => void;
}) {
  const t = useText();
  const qc = useQueryClient();
  const toast = useToast();
  const me = useQuery({ queryKey: ["auth-me"], queryFn: () => getAuthMe() });
  const currentAccountId = me.data?.account.id ?? null;
  const orgId = me.data?.account.org_id ?? null;

  const orgMembers = useQuery({
    queryKey: ["org-members", orgId],
    queryFn: () => listOrgMembers(orgId!),
    enabled: !!orgId,
  });

  const appMembers = useQuery({
    queryKey: ["app-members", appId],
    queryFn: () => listAppMembers(appId),
  });

  const [selectedAccount, setSelectedAccount] = useState<string>("");
  const [accountId, setAccountId] = useState("");
  const [role, setRole] = useState<AppMember["app_role"]>("viewer");
  const targetAccountId = accountId.trim() || selectedAccount;

  const add = useMutation({
    mutationFn: () =>
      addAppMember(appId, {
        account_id: targetAccountId,
        app_role: role,
      }),
    onSuccess: () => {
      toast.show({ kind: "success", title: t("App member added", "应用成员已添加") });
      qc.invalidateQueries({ queryKey: ["app-members", appId] });
      setSelectedAccount("");
      setAccountId("");
      onAdded();
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: t("Add failed", "添加失败"),
        description: errorMessage(e),
      }),
  });

  // Filter out principals that already have direct app access or inherited
  // org-admin access. The form is for app-scoped grants, not re-adding yourself.
  const appAccountIds = new Set(
    appMembers.data?.members.map((m) => m.account_id) ?? [],
  );
  const candidates =
    orgMembers.data?.members.filter((m) =>
      m.account_id !== currentAccountId &&
      !appAccountIds.has(m.account_id) &&
      m.org_role !== "owner" &&
      m.org_role !== "admin",
    ) ??
    [];
  // Same rule as the member tables: the server is only shown when the name
  // would otherwise be ambiguous, computed over the whole candidate list (a
  // single option cannot know whether its label collides).
  const collidingLabels = collidingPrincipalLabels(candidates);

  // `name (username)`, plus ` · server` only when the name collides.
  const candidateLabel = (m: (typeof candidates)[number]) =>
    principalOptionLabel(m, collidingLabels);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-md text-sm">
        <DialogClose
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("Close", "关闭")}
              className="absolute top-3 right-3 text-foreground-hint hover:text-foreground-strong"
            />
          }
        >
          ×
        </DialogClose>
        <DialogHeader>
          <DialogTitle>{t("Add direct app member", "添加应用直接成员")}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <form
            id="add-app-member-form"
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              add.mutate();
            }}
          >
            {candidates.length > 0 ? (
              <div>
                <Label>{t("Choose someone from this organization", "选择此组织中的成员")}</Label>
                <Select
                  items={{
                    "": t("— select —", "— 请选择 —"),
                    ...Object.fromEntries(
                      candidates.map((m) => [m.account_id, candidateLabel(m)]),
                    ),
                  }}
                  value={selectedAccount}
                  onValueChange={(v) => {
                    setSelectedAccount(v as string);
                    if (v) setAccountId("");
                  }}
                >
                  <SelectTrigger autoFocus>
                    <SelectValue />
                    <SelectIcon />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectList>
                    <SelectItem value="">{t("— select —", "— 请选择 —")}</SelectItem>
                    {candidates.map((m) => (
                      <SelectItem key={m.account_id} value={m.account_id}>
                        {candidateLabel(m)}
                      </SelectItem>
                    ))}
                  </SelectList>
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <p className="text-xs text-foreground-muted">
                {t("Everyone in this organization already has access or is already listed as a direct app member.", "此组织中的成员都已拥有权限或已列为应用直接成员。")}
              </p>
            )}
            <div className="border-t border-line-muted pt-3">
              <Label>{t("Add one account from another Raft server", "添加其他 Raft 服务器的账号")}</Label>
              <Input
                value={accountId}
                onChange={(e) => {
                  setAccountId(e.target.value);
                  if (e.target.value.trim()) setSelectedAccount("");
                }}
                placeholder={t("Paste their Hands account ID", "粘贴其 Hands 账号 ID")}
                autoFocus={candidates.length === 0}
                spellCheck={false}
                className="font-mono"
              />
              <p className="mt-1 text-xs text-foreground-muted">
                {t("Ask that person or Agent to open Hands once, or run the Hands Raft integration", "请对方或智能体打开一次 Hands，或运行 Hands Raft 集成的")}
                <span className="font-mono"> whoami</span> {t("action, then send you the returned account ID. Cross-server accounts are not listed here because servers are an identity-isolation boundary.", "操作，然后将返回的账号 ID 发给您。服务器是身份隔离边界，因此这里不会列出跨服务器账号。")}
              </p>
            </div>
            <div>
              <Label>{t("Role", "角色")}</Label>
              <Select
                items={{ admin: roleText("admin", t), publisher: roleText("publisher", t), viewer: roleText("viewer", t) }}
                value={role}
                onValueChange={(v) => setRole(v as AppMember["app_role"])}
              >
                <SelectTrigger>
                  <SelectValue />
                  <SelectIcon />
                </SelectTrigger>
                <SelectContent>
                  <SelectList>
                  <SelectItem value="admin">{roleText("admin", t)}</SelectItem>
                  <SelectItem value="publisher">{roleText("publisher", t)}</SelectItem>
                  <SelectItem value="viewer">{roleText("viewer", t)}</SelectItem>
                </SelectList>
                </SelectContent>
              </Select>
            </div>
            <p className="text-xs text-foreground-muted">
              {t("Direct app members receive access only to this app. Owners and org admins already inherit app administration.", "应用直接成员只能访问此应用。所有者和组织管理员已继承应用管理权限。")}
            </p>
          </form>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" type="button" onClick={onClose}>
            {t("Cancel", "取消")}
          </Button>
          <Button
            type="submit"
            form="add-app-member-form"
            variant="primary"
            disabled={!targetAccountId || add.isPending}
          >
            {add.isPending ? t("Adding…", "添加中…") : t("Add", "添加")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InviteToAppForm({ appId }: { appId: string }) {
  const t = useText();
  const qc = useQueryClient();
  const toast = useToast();
  const me = useQuery({ queryKey: ["auth-me"], queryFn: () => getAuthMe() });
  const orgId = me.data?.account.org_id ?? null;
  const [showForm, setShowForm] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"publisher" | "viewer">("publisher");
  const [message, setMessage] = useState("");

  const invite = useMutation({
    mutationFn: () =>
      createOrgInvite(orgId!, {
        email: email.trim().toLowerCase(),
        role,
        app_id: appId,
        message: message.trim() ? message.trim() : null,
      }),
    onSuccess: (data) => {
      toast.show({
        kind: "success",
        title: t(`Invite link created for ${email}`, `已为 ${email} 创建邀请链接`),
        description: t(`Copied URL: ${data.invite_url.slice(0, 60)}…`, `已复制链接：${data.invite_url.slice(0, 60)}…`),
      });
      navigator.clipboard?.writeText(data.invite_url).catch(() => {});
      qc.invalidateQueries({ queryKey: ["org-invites", orgId!] });
      qc.invalidateQueries({ queryKey: ["org-members", orgId!] });
      setEmail("");
      setMessage("");
      setShowForm(false);
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: t("Invite failed", "邀请失败"),
        description: errorMessage(e),
      }),
  });

  if (!orgId) return null;

  return (
    <section className="border-t border-line-hairline pt-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-foreground-strong">{t("Create app invite link", "创建应用邀请链接")}</h3>
        {!showForm && (
          <Button
            variant="outline"
            className="text-xs"
            onClick={() => setShowForm(true)}
          >
            {t("+ Link", "+ 创建链接")}
          </Button>
        )}
      </div>
      {showForm ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            invite.mutate();
          }}
          className="space-y-2"
        >
          <div className="grid grid-cols-2 gap-2">
            <Input
              type="email"
              className="text-sm"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="email@example.com"
              required
              autoFocus
            />
            <Select
              items={{ publisher: roleText("publisher", t), viewer: roleText("viewer", t) }}
              value={role}
              onValueChange={(v) =>
                setRole(v as "publisher" | "viewer")
              }
            >
              <SelectTrigger className="text-sm">
                <SelectValue />
                <SelectIcon />
              </SelectTrigger>
              <SelectContent>
                <SelectList>
                <SelectItem value="publisher">{roleText("publisher", t)}</SelectItem>
                <SelectItem value="viewer">{roleText("viewer", t)}</SelectItem>
              </SelectList>
              </SelectContent>
            </Select>
          </div>
          <Textarea
            className="text-xs min-h-[40px]"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={t("Optional message", "附言（可选）")}
          />
          <p className="text-xs text-foreground-muted">
            {t("The invitee needs an account with this email; accepting the invite makes them an org viewer (auto) and grants app access with the role you pick. The URL is copied to clipboard after creation.", "受邀者需要使用此邮箱的账号；接受邀请后会自动成为组织查看者，并获得您选择的应用角色。链接创建后会复制到剪贴板。")}
          </p>
          <div className="flex gap-2">
            <Button
              type="submit"
              variant="primary"
              className="text-xs"
              disabled={invite.isPending || !email.trim()}
            >
              {invite.isPending ? t("Creating…", "创建中…") : t("Create invite link", "创建邀请链接")}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="text-xs"
              onClick={() => setShowForm(false)}
            >
              {t("Cancel", "取消")}
            </Button>
          </div>
        </form>
      ) : (
        <p className="text-xs text-foreground-muted">
          {t("Create an invite link to grant app access, then share the copied URL manually. The invitee is added to the org as a viewer automatically when they accept; the picked role controls what they can do on this app.", "创建邀请链接以授予应用访问权限，然后手动分享复制的链接。受邀者接受后会自动成为组织查看者；所选角色决定其在此应用中的操作权限。")}
        </p>
      )}
    </section>
  );
}
