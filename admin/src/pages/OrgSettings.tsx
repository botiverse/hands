import { errorMessage } from "../lib/errorMessage";
/**
 * OrgSettings — per-organization admin page.
 *
 * Tabs: General | Members | Invites | Audit
 *
 * Wires the new P5.3 endpoints:
 *   GET/POST /api/orgs/:orgId/invites  (list + create)
 *   POST/DELETE .../invites/:id/resend, /revoke
 *   GET/PATCH/DELETE /api/orgs/:orgId/members/:accountId
 *   GET /api/orgs/:orgId/audit-logs
 *
 * Owner / admin only. Members tab has change role + remove actions.
 * General tab still shows /me context (display name, principal_type, org).
 */

import { useState } from "react";
import { NavLink } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createOrgInvite,
  getAuthMe,
  listOrgAuditLogs,
  listOrgInvites,
  listOrgMembers,
  removeOrgMember,
  resendOrgInvite,
  revokeOrgInvite,
  updateOrgMember,
  createOrgWebhook,
  deleteOrgWebhook,
  listOrgWebhooks,
  listWebhookDeliveries,
  updateOrgWebhook,
  WEBHOOK_EVENT_TYPES,
  type OrgMember,
  type Webhook,
  type WebhookDelivery,
  type WebhookEventType,
} from "../lib/api";
import {
  collidingPrincipalLabels,
  needsServerBadge,
  principalServer,
} from "../lib/principalIdentity";
import { useToast } from "../components/Toast";
import { useText } from "../lib/locale";

type BadgeVariant = NonNullable<BadgeProps["variant"]>;
import {
  Badge,
  Button,
  Input,
  Select,
  SelectTrigger,
  SelectValue,
  SelectIcon,
  SelectList,
  SelectContent,
  SelectItem,
  Avatar,
  AvatarImage,
  AvatarFallback,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  Checkbox,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
  EmptyState,
  EmptyStateTitle,
  Skeleton,
  Tabs,
  Textarea,
  TabsList,
  TabsTab,
  TabsIndicator,
} from "raft-ui";
import type { BadgeProps } from "raft-ui";

const ORG_SETTINGS_TAB_LABELS: Record<OrgSettingsTab, string> = {
  general: "General",
  members: "Members",
  invites: "Invites",
  audit: "Audit",
  webhooks: "Webhooks",
};
const ORG_SETTINGS_TAB_LABELS_ZH: Record<OrgSettingsTab, string> = { general: "常规", members: "成员", invites: "邀请", audit: "审计", webhooks: "Webhook" };
const ROLE_ZH: Record<string, string> = { owner: "所有者", admin: "管理员", member: "成员", viewer: "查看者", publisher: "发布者" };
const INVITE_ZH: Record<string, string> = { pending: "待接受", accepted: "已接受", revoked: "已撤销", expired: "已过期" };
const roleText = (role: string, t: (english: string, chinese: string) => string) => t(role, ROLE_ZH[role] ?? role);

export const ORG_SETTINGS_TABS = [
  "general",
  "members",
  "invites",
  "audit",
  "webhooks",
] as const;

export type OrgSettingsTab = (typeof ORG_SETTINGS_TABS)[number];

export function isOrgSettingsTab(tab: string | undefined): tab is OrgSettingsTab {
  return ORG_SETTINGS_TABS.some((candidate) => candidate === tab);
}

export function OrgSettings({
  orgId,
  tab,
}: {
  orgId: string;
  tab: OrgSettingsTab;
}) {
  const t = useText();
  const me = useQuery({ queryKey: ["auth-me"], queryFn: () => getAuthMe() });
  const account = me.data?.account;
  const currentOrgId = account?.org_id ?? null;
  const currentRole = account?.org_role ?? null;
  const isOwnerOrAdmin = currentRole === "owner" || currentRole === "admin";
  const isCurrentOrg = currentOrgId === orgId;

  return (
    <div>
      <div className="mb-6">
        <div className="text-sm text-foreground-muted">{t("Organization", "组织")}</div>
        <h1 className="text-2xl font-bold">
          {account
            ? t(`${account.server_slug ?? account.server_id} · Raft org`, `${account.server_slug ?? account.server_id} · Raft 组织`)
            : t("Settings", "设置")}
        </h1>
        <div className="text-sm text-foreground-muted font-mono">{orgId}</div>
      </div>

      {me.isLoading && <p className="text-foreground-muted">{t("Loading…", "加载中…")}</p>}

      {!isCurrentOrg && currentOrgId && (
        <div className="rounded-md bg-warning-soft px-4 py-3 text-warning-strong text-sm mb-4">
          {t(`⚠ The org in the URL (${orgId}) doesn't match your current org (${currentOrgId}). Multi-org support deferred to v2.`, `⚠ 链接中的组织（${orgId}）与当前组织（${currentOrgId}）不一致。多组织支持计划在 v2 提供。`)}
        </div>
      )}

      {/* Visual-only Tabs: navigation stays with NavLink; the controlled
          `value` is the active tab (already resolved from the route by the
          parent route component) so the sliding indicator tracks it. */}
      <Tabs value={tab} className="mb-4">
        <TabsList>
          {ORG_SETTINGS_TABS.map((item) => (
            <TabsTab
              key={item}
              value={item}
              render={<NavLink to={`/orgs/${orgId}/${item}`} end />}
            >
              {t(ORG_SETTINGS_TAB_LABELS[item], ORG_SETTINGS_TAB_LABELS_ZH[item])}
            </TabsTab>
          ))}
          <TabsIndicator />
        </TabsList>
      </Tabs>

      {tab === "general" && (
        <div className="text-sm space-y-2">
          <Row k={t("External provider", "外部服务提供方")} v={account?.provider ?? "?"} />
          <Row k={t("External ID (Raft server_id)", "外部 ID（Raft server_id）")} v={account?.server_id ?? "?"} />
          <Row k={t("Server slug", "服务器标识")} v={account?.server_slug ?? "—"} />
          <Row
            k={t("Your principal type", "您的身份类型")}
            v={
              account?.principal_type === "agent"
                ? t("agent (Raft)", "智能体（Raft）")
                : account?.principal_type === "human"
                  ? t("human (Raft)", "用户（Raft）")
                  : "—"
            }
          />
          <Row k={t("Your org_id", "您的组织 ID")} v={currentOrgId ?? "—"} mono />
          <Row
            k={t("Your org_role", "您的组织角色")}
            v={currentRole ? roleText(currentRole, t) : "—"}
            color={
              currentRole === "owner"
                ? "#a855f7"
                : currentRole === "admin"
                  ? "#3b82f6"
                  : undefined
            }
          />
          <Row
            k={t("Your server_role (from Raft)", "您的服务器角色（来自 Raft）")}
            v={account?.server_role ? roleText(account.server_role, t) : "—"}
          />
          <p className="text-xs text-foreground-muted pt-3 border-t border-line-hairline">
            {t("Future: editable org name + slug, danger zone (archive org), sign-up mode (open vs invite-only).", "后续计划：编辑组织名称和标识、危险操作（归档组织）及注册方式（开放或仅限邀请）。")}
          </p>
        </div>
      )}

      {tab === "members" && (
        <MembersTab
          orgId={orgId}
          currentAccountId={account?.id ?? null}
          currentRole={currentRole}
        />
      )}

      {tab === "invites" && (
        <InvitesTab orgId={orgId} canManage={isOwnerOrAdmin} />
      )}

      {tab === "audit" && (
        <AuditTab orgId={orgId} canView={isOwnerOrAdmin || currentRole === "member"} />
      )}

      {tab === "webhooks" && (
        <WebhooksTab orgId={orgId} canManage={isOwnerOrAdmin} />
      )}
    </div>
  );
}

function MembersTab({
  orgId,
  currentAccountId,
  currentRole,
}: {
  orgId: string;
  currentAccountId: string | null;
  currentRole: string | null;
}) {
  const t = useText();
  const qc = useQueryClient();
  const toast = useToast();
  const isAdmin = currentRole === "admin" || currentRole === "owner";
  // Admins can assign up to admin; only an owner can assign owner.
  const assignableRoles = currentRole === "owner"
    ? (["owner", "admin", "member", "viewer"] as const)
    : (["admin", "member", "viewer"] as const);
  const [principalFilter, setPrincipalFilter] = useState<"all" | "human" | "agent">("all");
  const members = useQuery({
    queryKey: ["org-members", orgId],
    queryFn: () => listOrgMembers(orgId),
  });
  const filteredMembers = (members.data?.members ?? []).filter((m) =>
    principalFilter === "all"
      ? true
      : m.principal_type === principalFilter,
  );
  // Computed over the whole filtered collection, never per row: a row cannot see
  // its peers (see lib/principalIdentity.ts).
  const collidingLabels = collidingPrincipalLabels(filteredMembers);

  const update = useMutation({
    mutationFn: ({ accountId, role }: { accountId: string; role: OrgMember["org_role"] }) =>
      updateOrgMember(orgId, accountId, role),
    onSuccess: () => {
      toast.show({ kind: "success", title: t("Member role updated", "成员角色已更新") });
      qc.invalidateQueries({ queryKey: ["org-members", orgId] });
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: t("Update failed", "更新失败"),
        description: errorMessage(e),
      }),
  });

  const remove = useMutation({
    mutationFn: (accountId: string) => removeOrgMember(orgId, accountId),
    onSuccess: () => {
      toast.show({ kind: "success", title: t("Member removed", "成员已移除") });
      qc.invalidateQueries({ queryKey: ["org-members", orgId] });
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
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-foreground-strong">{t("Members", "成员")}</h3>
        <div className="flex items-center gap-2">
          <Select
            items={{
              all: t("All types", "全部类型"),
              human: t("Humans only", "仅用户"),
              agent: t("Agents only", "仅智能体"),
            }}
            value={principalFilter}
            onValueChange={(v) =>
              setPrincipalFilter(v as "all" | "human" | "agent")
            }
          >
            <Tooltip>
              <TooltipTrigger
                render={
                  <SelectTrigger className="text-xs py-0.5">
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
          <span className="text-xs text-foreground-muted">
            {t(`${filteredMembers.length} member${filteredMembers.length === 1 ? "" : "s"}`, `${filteredMembers.length} 位成员`)}
            {principalFilter !== "all" && (
              <span className="ml-1">({t(principalFilter, principalFilter === "human" ? "用户" : "智能体")})</span>
            )}
          </span>
        </div>
      </div>
      {!isAdmin && (
        <p className="text-xs text-warning mb-2">
          {t(`⚠ Your current role is "${currentRole ?? "—"}" — you can view members but not edit them.`, `⚠ 您的当前角色为“${currentRole ? roleText(currentRole, t) : "—"}”，可以查看成员但不能编辑。`)}
        </p>
      )}
      {members.isLoading && (
        <div className="space-y-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      )}
      {members.error && (
        <p className="text-danger">{t("Failed:", "加载失败：")} {errorMessage(members.error)}</p>
      )}
      {members.data && filteredMembers.length === 0 && (
        <EmptyState>
          <EmptyStateTitle>
            {principalFilter === "all"
              ? t("No members yet.", "暂无成员。")
              : t(`No ${principalFilter} members.`, `暂无${principalFilter === "human" ? "用户" : "智能体"}成员。`)}
          </EmptyStateTitle>
        </EmptyState>
      )}
      {members.data && filteredMembers.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-foreground-muted text-left border-b border-line-hairline">
              <th className="font-normal py-1 pr-2">{t("Principal", "身份")}</th>
              <th className="font-normal py-1 pr-2">{t("Type", "类型")}</th>
              <th className="font-normal py-1 pr-2">{t("Role", "角色")}</th>
              <th className="font-normal py-1 pr-2">{t("Joined", "加入日期")}</th>
              <th className="font-normal py-1 pr-2">{t("Last login", "上次登录")}</th>
              {isAdmin && <th className="font-normal py-1">{t("Actions", "操作")}</th>}
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
                  {isAdmin && m.account_id !== currentAccountId
                    // Only an owner can grant or change the owner role.
                    && (currentRole === "owner" || m.org_role !== "owner") ? (
                    <Select
                      items={Object.fromEntries(
                        assignableRoles.map((r) => [r, roleText(r, t)]),
                      )}
                      value={m.org_role}
                      onValueChange={(v) =>
                        update.mutate({
                          accountId: m.account_id,
                          role: v as OrgMember["org_role"],
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
                        {assignableRoles.map((r) => (
                          <SelectItem key={r} value={r}>
                            {roleText(r, t)}
                          </SelectItem>
                        ))}
                      </SelectList>
                      </SelectContent>
                    </Select>
                  ) : (
                    <span
                      className="text-xs font-medium"
                      style={{
                        color:
                          m.org_role === "owner"
                            ? "#a855f7"
                            : m.org_role === "admin"
                              ? "#3b82f6"
                              : "#374151",
                      }}
                    >
                      {roleText(m.org_role, t)}
                    </span>
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
                {isAdmin && (
                  <td className="py-2 text-xs">
                    {m.account_id !== currentAccountId && (
                      <Button
                        variant="link"
                        size="sm"
                        className="text-danger"
                        onClick={() => {
                          if (
                            confirm(
                              t(`Remove ${m.display_name} from this org?`, `将 ${m.display_name} 从此组织移除？`),
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

function InvitesTab({
  orgId,
  canManage,
}: {
  orgId: string;
  canManage: boolean;
}) {
  const t = useText();
  const qc = useQueryClient();
  const toast = useToast();
  const [showCreate, setShowCreate] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const invites = useQuery({
    queryKey: ["org-invites", orgId],
    queryFn: () => listOrgInvites(orgId, statusFilter === "all" ? undefined : statusFilter),
    enabled: statusFilter !== "all" || true,
  });
  const filteredInvites = invites.data?.invites ?? [];

  const revoke = useMutation({
    mutationFn: (inviteId: string) => revokeOrgInvite(orgId, inviteId),
    onSuccess: () => {
      toast.show({ kind: "success", title: t("Invite revoked", "邀请已撤销") });
      qc.invalidateQueries({ queryKey: ["org-invites", orgId] });
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: t("Revoke failed", "撤销失败"),
        description: errorMessage(e),
      }),
  });

  const resend = useMutation({
    mutationFn: (inviteId: string) => resendOrgInvite(orgId, inviteId),
    onSuccess: (data) => {
      toast.show({
        kind: "success",
        title: t("Invite link refreshed", "邀请链接已刷新"),
        description: t(`Copied URL: ${data.invite_url.slice(0, 60)}…`, `已复制链接：${data.invite_url.slice(0, 60)}…`),
      });
      navigator.clipboard?.writeText(data.invite_url).catch(() => {});
      qc.invalidateQueries({ queryKey: ["org-invites", orgId] });
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: t("Refresh failed", "刷新失败"),
        description: errorMessage(e),
      }),
  });

  return (
    <section className="border-t border-line-hairline pt-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-foreground-strong">{t("Invites", "邀请")}</h3>
        <div className="flex items-center gap-2">
          <Select
            items={{
              all: t("All statuses", "全部状态"),
              pending: t("Pending", "待接受"),
              accepted: t("Accepted", "已接受"),
              revoked: t("Revoked", "已撤销"),
              expired: t("Expired", "已过期"),
            }}
            value={statusFilter}
            onValueChange={(v) => setStatusFilter(v as string)}
          >
            <Tooltip>
              <TooltipTrigger
                render={
                  <SelectTrigger className="text-xs py-0.5">
                    <SelectValue />
                    <SelectIcon />
                  </SelectTrigger>
                }
              />
              <TooltipContent>{t("Filter by invite status", "按邀请状态筛选")}</TooltipContent>
            </Tooltip>
            <SelectContent>
              <SelectList>
              <SelectItem value="all">{t("All statuses", "全部状态")}</SelectItem>
              <SelectItem value="pending">{t("Pending", "待接受")}</SelectItem>
              <SelectItem value="accepted">{t("Accepted", "已接受")}</SelectItem>
              <SelectItem value="revoked">{t("Revoked", "已撤销")}</SelectItem>
              <SelectItem value="expired">{t("Expired", "已过期")}</SelectItem>
            </SelectList>
            </SelectContent>
          </Select>
          {canManage && (
            <Button
              variant="primary"
              className="text-xs"
              onClick={() => setShowCreate(true)}
            >
              {t("+ Invite link", "+ 邀请链接")}
            </Button>
          )}
        </div>
      </div>
      {!canManage && (
        <p className="text-xs text-warning mb-2">
          {t("⚠ Owner / admin required to manage invites.", "⚠ 管理邀请需要所有者或管理员权限。")}
        </p>
      )}
      {invites.isLoading && (
        <div className="space-y-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      )}
      {invites.error && (
        <p className="text-danger">{t("Failed:", "加载失败：")} {errorMessage(invites.error)}</p>
      )}
      {invites.data && filteredInvites.length === 0 && (
        <EmptyState>
          <EmptyStateTitle>
            {statusFilter === "all"
              ? t("No pending invites.", "暂无待接受的邀请。")
              : t(`No ${statusFilter} invites.`, `暂无${INVITE_ZH[statusFilter] ?? statusFilter}的邀请。`)}
          </EmptyStateTitle>
        </EmptyState>
      )}
      {invites.data && filteredInvites.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-foreground-muted text-left border-b border-line-hairline">
              <th className="font-normal py-1 pr-2">{t("Email", "邮箱")}</th>
              <th className="font-normal py-1 pr-2">{t("Role", "角色")}</th>
              <th className="font-normal py-1 pr-2">{t("Status", "状态")}</th>
              <th className="font-normal py-1 pr-2">{t("Expires", "过期时间")}</th>
              {canManage && <th className="font-normal py-1">{t("Actions", "操作")}</th>}
            </tr>
          </thead>
          <tbody>
            {filteredInvites.map((inv) => (
              <tr
                key={inv.id}
                className="border-b border-line-hairline hover:bg-fill-muted"
              >
                <td className="py-2 pr-2 font-mono text-xs">{inv.email}</td>
                <td className="py-2 pr-2 text-xs">{roleText(inv.role, t)}</td>
                <td className="py-2 pr-2 text-xs">
                  <InviteStatusBadge status={inv.status} />
                </td>
                <td className="py-2 pr-2 text-xs text-foreground-muted">
                  {new Date(inv.expires_at).toISOString().slice(0, 10)}
                </td>
                {canManage && inv.status === "pending" && (
                  <td className="py-2 text-xs space-x-2">
                    <Button
                      variant="link"
                      size="sm"
                      onClick={() => resend.mutate(inv.id)}
                      disabled={resend.isPending}
                    >
                      {t("Refresh link", "刷新链接")}
                    </Button>
                    <Button
                      variant="link"
                      size="sm"
                      className="text-danger"
                      onClick={() => {
                        if (confirm(t(`Revoke invite to ${inv.email}?`, `撤销发给 ${inv.email} 的邀请？`))) {
                          revoke.mutate(inv.id);
                        }
                      }}
                      disabled={revoke.isPending}
                    >
                      {t("Revoke", "撤销")}
                    </Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showCreate && (
        <CreateInviteDialog
          orgId={orgId}
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            qc.invalidateQueries({ queryKey: ["org-invites", orgId] });
          }}
        />
      )}
    </section>
  );
}

function CreateInviteDialog({
  orgId,
  onClose,
  onCreated,
}: {
  orgId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const t = useText();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "viewer">("member");
  const [message, setMessage] = useState("");
  const toast = useToast();
  const create = useMutation({
    mutationFn: () =>
      createOrgInvite(orgId, {
        email: email.trim().toLowerCase(),
        role,
        message: message.trim() ? message.trim() : null,
      }),
    onSuccess: (data) => {
      toast.show({
        kind: "success",
        title: t(`Invite link created for ${email}`, `已为 ${email} 创建邀请链接`),
        description: t(`Copied URL: ${data.invite_url.slice(0, 60)}…`, `已复制链接：${data.invite_url.slice(0, 60)}…`),
      });
      // Copy invite URL to clipboard for the admin to share
      navigator.clipboard?.writeText(data.invite_url).catch(() => {});
      onCreated();
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: t("Invite failed", "邀请失败"),
        description: errorMessage(e),
      }),
  });
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("Create member invite link", "创建成员邀请链接")}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <form
            id="create-invite-form"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
            className="space-y-3"
          >
            <div>
              <label className="block text-sm font-medium text-foreground-strong mb-1">{t("Email", "邮箱")}</label>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-foreground-strong mb-1">{t("Role", "角色")}</label>
              <Select
                items={{
                  member: t("member (default)", "成员（默认）"),
                  viewer: t("viewer (read-only)", "查看者（只读）"),
                }}
                value={role}
                onValueChange={(v) => setRole(v as "member" | "viewer")}
              >
                <SelectTrigger>
                  <SelectValue />
                  <SelectIcon />
                </SelectTrigger>
                <SelectContent>
                  <SelectList>
                  <SelectItem value="member">{t("member (default)", "成员（默认）")}</SelectItem>
                  <SelectItem value="viewer">{t("viewer (read-only)", "查看者（只读）")}</SelectItem>
                </SelectList>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="block text-sm font-medium text-foreground-strong mb-1">{t("Message (optional)", "附言（可选）")}</label>
              <Textarea
                className="text-xs min-h-[60px]"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
            </div>
          </form>
        </DialogBody>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
          >
            {t("Cancel", "取消")}
          </Button>
          <Button
            type="submit"
            form="create-invite-form"
            variant="primary"
            disabled={create.isPending || !email.trim()}
          >
            {create.isPending ? t("Creating…", "创建中…") : t("Create invite link", "创建邀请链接")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InviteStatusBadge({ status }: { status: string }) {
  const t = useText();
  const map: Record<string, BadgeVariant> = {
    pending: "information",
    accepted: "success",
    revoked: "muted",
    expired: "warning",
  };
  return <Badge variant={map[status] ?? "muted"}>{t(status, INVITE_ZH[status] ?? status)}</Badge>;
}

function AuditTab({
  orgId,
  canView,
}: {
  orgId: string;
  canView: boolean;
}) {
  const t = useText();
  const audit = useQuery({
    queryKey: ["org-audit", orgId],
    queryFn: () => listOrgAuditLogs(orgId, 100),
    enabled: canView,
  });
  return (
    <section className="border-t border-line-hairline pt-5">
      <h3 className="text-sm font-medium text-foreground-strong mb-3">{t("Audit log", "审计日志")}</h3>
      {!canView && (
        <p className="text-xs text-warning mb-2">
          {t("⚠ Org member required to view audit log.", "⚠ 查看审计日志需要组织成员权限。")}
        </p>
      )}
      {audit.isLoading && (
        <div className="space-y-2">
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
        </div>
      )}
      {audit.error && (
        <p className="text-danger">{t("Failed:", "加载失败：")} {errorMessage(audit.error)}</p>
      )}
      {audit.data && audit.data.logs.length === 0 && (
        <EmptyState>
          <EmptyStateTitle>{t("No audit log entries yet.", "暂无审计日志。")}</EmptyStateTitle>
        </EmptyState>
      )}
      {audit.data && audit.data.logs.length > 0 && (
        <div className="overflow-x-auto max-w-full">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-foreground-muted text-left border-b border-line-hairline">
              <th className="font-normal py-1 pr-2">{t("When", "时间")}</th>
              <th className="font-normal py-1 pr-2">{t("Actor", "操作者")}</th>
              <th className="font-normal py-1 pr-2">{t("App", "应用")}</th>
              <th className="font-normal py-1 pr-2">{t("Action", "操作")}</th>
              <th className="font-normal py-1 pr-2">{t("Payload", "内容")}</th>
            </tr>
          </thead>
          <tbody>
            {audit.data.logs.map((log) => {
              const actorName =
                log.actor_display_name ||
                (log.actor_username ? `@${log.actor_username}` : null) ||
                log.actor ||
                "—";
              return (
                <tr
                  key={log.id}
                  className="border-b border-line-hairline hover:bg-fill-muted"
                >
                  <td className="py-1 pr-2 text-foreground-muted font-mono whitespace-nowrap">
                    {new Date(log.created_at).toISOString().slice(0, 19)}Z
                  </td>
                  <td className="py-1 pr-2">
                    <span className="inline-flex items-center gap-1">
                      <Avatar
                        size="xs"
                        type={log.actor_type === "agent" ? "agent" : "human"}
                      >
                        {log.actor_avatar_url ? (
                          <AvatarImage src={log.actor_avatar_url} alt="" />
                        ) : null}
                        <AvatarFallback>
                          {actorName.slice(0, 1).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <span>{actorName}</span>
                      {log.actor_type === "agent" && (
                        <Badge variant="accent">{t("agent", "智能体")}</Badge>
                      )}
                      {log.actor_type === "system" && (
                        <Badge variant="muted">{t("system", "系统")}</Badge>
                      )}
                    </span>
                  </td>
                  <td className="py-1 pr-2 font-mono text-foreground-muted whitespace-nowrap">
                    {log.app_slug ?? log.app_id?.slice(0, 8) ?? "—"}
                  </td>
                  <td className="py-1 pr-2 font-mono whitespace-nowrap">{log.action}</td>
                  <td className="py-1 pr-2 font-mono truncate max-w-md">
                    {log.payload}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      )}
    </section>
  );
}

function Row({
  k,
  v,
  mono,
  color,
}: {
  k: string;
  v: string;
  mono?: boolean | undefined;
  color?: string | undefined;
}) {
  return (
    <div className="flex items-center gap-2">
      <div className="w-48 text-xs text-foreground-muted">{k}</div>
      <div
        className={mono ? "font-mono text-xs" : "text-sm"}
        style={{ color }}
      >
        {v}
      </div>
    </div>
  );
}

// ============================================================================
// Webhooks tab (P2.5.8)
// ============================================================================

function WebhooksTab({
  orgId,
  canManage,
}: {
  orgId: string;
  canManage: boolean;
}) {
  const t = useText();
  const qc = useQueryClient();
  const toast = useToast();
  const [showCreate, setShowCreate] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const webhooks = useQuery({
    queryKey: ["org-webhooks", orgId],
    queryFn: () => listOrgWebhooks(orgId),
    enabled: canManage,
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteOrgWebhook(orgId, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["org-webhooks", orgId] });
      toast.show({ kind: "success", title: t("Webhook archived", "Webhook 已归档") });
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: t("Delete failed", "删除失败"),
        description: errorMessage(e),
      }),
  });

  const toggle = useMutation({
    mutationFn: (input: { id: string; enabled: boolean }) =>
      updateOrgWebhook(orgId, input.id, { enabled: input.enabled }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["org-webhooks", orgId] }),
  });

  return (
    <div className="space-y-6">
      <section className="border-t border-line-hairline pt-5">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-medium text-foreground-strong">Webhooks</h3>
            <p className="text-xs text-foreground-muted">
              {t("Subscribe external HTTP endpoints to release and build events. Deliveries are signed with HMAC SHA-256", "让外部 HTTP 接收地址订阅发布和构建事件。投递使用 HMAC SHA-256 签名")}
              (<code className="font-mono">X-Hands-Signature</code>){t(".", "。")}
            </p>
          </div>
          {canManage && (
            <Button
              variant="primary"
              className="text-xs"
              onClick={() => setShowCreate(true)}
            >
              {t("+ Add webhook", "+ 添加 Webhook")}
            </Button>
          )}
        </div>

        {!canManage && (
          <p className="text-xs text-warning mb-2">
            {t("⚠ Org owner / admin required to manage webhooks.", "⚠ 管理 Webhook 需要组织所有者或管理员权限。")}
          </p>
        )}

        {webhooks.isLoading && (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        )}
        {webhooks.error && (
          <p className="text-danger text-xs">
            {t("Failed:", "加载失败：")} {errorMessage(webhooks.error)}
          </p>
        )}
        {webhooks.data && webhooks.data.webhooks.length === 0 && (
          <EmptyState>
            <EmptyStateTitle>{t("No webhooks configured yet.", "尚未配置 Webhook。")}</EmptyStateTitle>
          </EmptyState>
        )}

        {webhooks.data && webhooks.data.webhooks.length > 0 && (
          <div className="space-y-2">
            {webhooks.data.webhooks.map((w) => (
              <WebhookRow
                key={w.id}
                orgId={orgId}
                webhook={w}
                expanded={expandedId === w.id}
                onToggleExpand={() =>
                  setExpandedId((cur) => (cur === w.id ? null : w.id))
                }
                onToggleEnabled={(enabled) =>
                  toggle.mutate({ id: w.id, enabled })
                }
                onDelete={() => {
                  if (confirm(t(`Archive webhook ${w.url}?`, `归档 Webhook ${w.url}？`))) remove.mutate(w.id);
                }}
                canManage={canManage}
              />
            ))}
          </div>
        )}
      </section>

      <section className="border-t border-line-hairline pt-5 text-xs text-foreground">
        <h4 className="text-sm font-medium text-foreground-strong mb-1">{t("Delivery semantics", "投递规则")}</h4>
        <ul className="list-disc pl-5 space-y-1">
          <li>
            {t("Pending deliveries are retried every 5 minutes.", "待投递的消息每 5 分钟重试一次。")}
          </li>
          <li>
            {t("Retries use exponential backoff: 5m → 30m → 2h (3 attempts max), then marked permanently", "重试采用指数退避：5 分钟 → 30 分钟 → 2 小时（最多尝试 3 次），之后永久标记为")} <code className="font-mono">failed</code>{t(".", "。")}
          </li>
          <li>
            {t("Receiver must verify", "接收方必须使用 Webhook 的密钥验证")}
            <code className="font-mono"> X-Hands-Signature: sha256=&lt;hmac&gt;</code>
            {t("using the webhook's secret (legacy", "（仍会发送旧版")}{" "}
            <code className="font-mono">X-Quiver-Signature</code>{t(" is still sent too).", "）。")}
          </li>
        </ul>
      </section>

      {showCreate && (
        <CreateWebhookDialog
          orgId={orgId}
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            qc.invalidateQueries({ queryKey: ["org-webhooks", orgId] });
          }}
        />
      )}
    </div>
  );
}

function WebhookRow({
  orgId,
  webhook,
  expanded,
  onToggleExpand,
  onToggleEnabled,
  onDelete,
  canManage,
}: {
  orgId: string;
  webhook: Webhook;
  expanded: boolean;
  onToggleExpand: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  onDelete: () => void;
  canManage: boolean;
}) {
  const t = useText();
  const statusZh: Record<string, string> = { pending: "待投递", succeeded: "成功", failed: "失败", retrying: "重试中" };
  let events: string[] = [];
  try {
    events = JSON.parse(webhook.events_json);
  } catch {
    events = [];
  }
  const deliveries = useQuery({
    queryKey: ["webhook-deliveries", orgId, webhook.id],
    queryFn: () => listWebhookDeliveries(orgId, webhook.id),
    enabled: expanded,
  });
  return (
    <div className="rounded-md bg-fill-muted p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <Badge variant={webhook.enabled === 1 ? "success" : "muted"}>
              {webhook.enabled === 1 ? t("enabled", "已启用") : t("disabled", "已停用")}
            </Badge>
            <span className="font-mono text-xs truncate">{webhook.url}</span>
          </div>
          <div className="text-xs text-foreground-muted mt-1">
            {t("events:", "事件：")}{" "}
            {events.length === 0 ? (
              <span className="italic">{t("(all)", "（全部）")}</span>
            ) : (
              events.map((e) => (
                <Badge key={e} variant="information" className="mr-1">
                  {e}
                </Badge>
              ))
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {canManage && (
            <Button
              variant="outline"
              className="text-xs"
              onClick={() => onToggleEnabled(webhook.enabled !== 1)}
              disabled={!onToggleEnabled}
            >
              {webhook.enabled === 1 ? t("Disable", "停用") : t("Enable", "启用")}
            </Button>
          )}
          <Button
            variant="outline"
            className="text-xs"
            onClick={onToggleExpand}
          >
            {expanded ? t("Hide", "隐藏") : t("Deliveries", "投递记录")}
          </Button>
          {canManage && (
            <Button variant="outline" className="text-xs" onClick={onDelete}>
              {t("Archive", "归档")}
            </Button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="mt-3 pt-3 border-t border-line-hairline">
          {deliveries.isLoading && (
            <p className="text-xs text-foreground-muted">{t("Loading deliveries…", "正在加载投递记录…")}</p>
          )}
          {deliveries.error && (
            <p className="text-danger text-xs">
              {t("Failed:", "加载失败：")} {errorMessage(deliveries.error)}
            </p>
          )}
          {deliveries.data && deliveries.data.deliveries.length === 0 && (
            <p className="text-xs text-foreground-muted">{t("No deliveries yet.", "暂无投递记录。")}</p>
          )}
          {deliveries.data && deliveries.data.deliveries.length > 0 && (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-foreground-muted text-left border-b border-line-hairline">
                  <th className="font-normal py-1 pr-2">{t("When", "时间")}</th>
                  <th className="font-normal py-1 pr-2">{t("Event", "事件")}</th>
                  <th className="font-normal py-1 pr-2">{t("Status", "状态")}</th>
                  <th className="font-normal py-1 pr-2">{t("Attempts", "尝试次数")}</th>
                  <th className="font-normal py-1 pr-2">HTTP</th>
                  <th className="font-normal py-1 pr-2">{t("Next / error", "下次尝试 / 错误")}</th>
                </tr>
              </thead>
              <tbody>
                {deliveries.data.deliveries.map((d: WebhookDelivery) => (
                  <tr
                    key={d.id}
                    className="border-b border-line-hairline hover:bg-fill-muted"
                  >
                    <td className="py-1 pr-2 font-mono text-foreground-muted">
                      {new Date(d.created_at).toISOString().slice(0, 19)}Z
                    </td>
                    <td className="py-1 pr-2 font-mono">{d.event_type}</td>
                    <td className="py-1 pr-2">
                      <Badge
                        variant={
                          d.status === "succeeded"
                            ? "success"
                            : d.status === "failed"
                              ? "danger"
                              : "information"
                        }
                      >
                        {t(d.status, statusZh[d.status] ?? d.status)}
                      </Badge>
                    </td>
                    <td className="py-1 pr-2 font-mono">
                      {d.attempts}/{d.max_attempts}
                    </td>
                    <td className="py-1 pr-2 font-mono">
                      {d.last_response_status ?? "—"}
                    </td>
                    <td className="py-1 pr-2 font-mono text-foreground-muted truncate max-w-xs">
                      {d.last_error
                        ? d.last_error
                        : d.next_attempt_at
                          ? t(`next ${new Date(d.next_attempt_at).toISOString().slice(11, 19)}Z`, `下次 ${new Date(d.next_attempt_at).toISOString().slice(11, 19)}Z`)
                          : d.completed_at
                            ? t(`done ${new Date(d.completed_at).toISOString().slice(11, 19)}Z`, `完成于 ${new Date(d.completed_at).toISOString().slice(11, 19)}Z`)
                            : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

function CreateWebhookDialog({
  orgId,
  onClose,
  onCreated,
}: {
  orgId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const t = useText();
  const toast = useToast();
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [events, setEvents] = useState<WebhookEventType[]>([]);

  const create = useMutation({
    mutationFn: () =>
      createOrgWebhook(orgId, {
        url: url.trim(),
        secret: secret.trim(),
        events,
      }),
    onSuccess: () => {
      toast.show({ kind: "success", title: t("Webhook created", "Webhook 已创建") });
      onCreated();
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: t("Create failed", "创建失败"),
        description: errorMessage(e),
      }),
  });

  const toggleEvent = (ev: WebhookEventType) => {
    setEvents((cur) =>
      cur.includes(ev) ? cur.filter((e) => e !== ev) : [...cur, ev],
    );
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("Add webhook", "添加 Webhook")}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <form
            id="create-webhook-form"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
            className="space-y-3"
          >
            <div>
              <label className="block text-sm font-medium text-foreground-strong mb-1">URL</label>
              <Input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/hooks/quiver"
                required
                autoFocus
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-foreground-strong mb-1">{t("Secret (HMAC)", "密钥（HMAC）")}</label>
              <Input
                type="text"
                className="font-mono text-xs"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder={t("at-least-16-random-bytes", "至少 16 个随机字节")}
                required
              />
              <p className="text-xs text-foreground-muted mt-1">
                {t("Used to sign deliveries via", "用于通过")} {" "}
                <code className="font-mono">X-Hands-Signature</code>{t(". Choose a strong secret; receivers must verify the signature.", "对投递进行签名。请选择强密钥；接收方必须验证签名。")}
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-foreground-strong mb-1">{t("Events (empty = all)", "事件（不选则为全部）")}</label>
              <div className="grid grid-cols-2 gap-1">
                {WEBHOOK_EVENT_TYPES.map((ev) => (
                  <label
                    key={ev}
                    className="flex items-center gap-2 text-xs cursor-pointer"
                  >
                    <Checkbox
                      checked={events.includes(ev)}
                      onCheckedChange={() => toggleEvent(ev)}
                    />
                    <span className="font-mono">{ev}</span>
                  </label>
                ))}
              </div>
            </div>
          </form>
        </DialogBody>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
          >
            {t("Cancel", "取消")}
          </Button>
          <Button
            type="submit"
            form="create-webhook-form"
            variant="primary"
            disabled={
              create.isPending || !url.trim() || secret.trim().length < 8
            }
          >
            {create.isPending ? t("Creating…", "创建中…") : t("Create webhook", "创建 Webhook")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
