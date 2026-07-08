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
import { useToast } from "../components/Toast";

type Tab = "general" | "members" | "invites" | "audit" | "webhooks";

export function OrgSettings({ orgId }: { orgId: string }) {
  const [tab, setTab] = useState<Tab>("general");
  const me = useQuery({ queryKey: ["auth-me"], queryFn: () => getAuthMe() });
  const account = me.data?.account;
  const currentOrgId = account?.org_id ?? null;
  const currentRole = account?.org_role ?? null;
  const isOwnerOrAdmin = currentRole === "owner" || currentRole === "admin";
  const isCurrentOrg = currentOrgId === orgId;

  return (
    <div>
      <div className="mb-6">
        <div className="text-sm text-slate-500">Organization</div>
        <h1 className="text-2xl font-bold">
          {account
            ? `${account.server_slug ?? account.server_id} · Raft org`
            : "Settings"}
        </h1>
        <div className="text-sm text-slate-500 font-mono">{orgId}</div>
      </div>

      {me.isLoading && <p className="text-slate-500">Loading…</p>}

      {!isCurrentOrg && currentOrgId && (
        <div className="card !p-4 bg-yellow-50 border-yellow-200 text-yellow-800 text-sm mb-4">
          ⚠ The org in the URL ({orgId}) doesn't match your current org (
          {currentOrgId}). Multi-org support deferred to v2.
        </div>
      )}

      <div className="flex gap-2 mb-4 border-b border-slate-200">
        {(["general", "members", "invites", "audit", "webhooks"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-2 text-sm ${
              tab === t
                ? "border-b-2 border-blue-600 font-medium text-slate-900"
                : "text-slate-500 hover:text-slate-700"
            }`}
          >
            {t === "general"
              ? "General"
              : t === "members"
                ? "Members"
                : t === "invites"
                  ? "Invites"
                  : t === "audit"
                    ? "Audit"
                    : "Webhooks"}
          </button>
        ))}
      </div>

      {tab === "general" && (
        <div className="card !p-4 text-sm space-y-2">
          <Row k="External provider" v={account?.provider ?? "?"} />
          <Row k="External ID (Raft server_id)" v={account?.server_id ?? "?"} />
          <Row k="Server slug" v={account?.server_slug ?? "—"} />
          <Row
            k="Your principal type"
            v={
              account?.principal_type === "agent"
                ? "agent (Raft)"
                : account?.principal_type === "human"
                  ? "human (Raft)"
                  : "—"
            }
          />
          <Row k="Your org_id" v={currentOrgId ?? "—"} mono />
          <Row
            k="Your org_role"
            v={currentRole ?? "—"}
            color={
              currentRole === "owner"
                ? "#a855f7"
                : currentRole === "admin"
                  ? "#3b82f6"
                  : undefined
            }
          />
          <Row
            k="Your server_role (from Raft)"
            v={account?.server_role ?? "—"}
          />
          <p className="text-xs text-slate-500 pt-3 border-t border-slate-100">
            Future: editable org name + slug, danger zone (archive org),
            sign-up mode (open vs invite-only).
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
  const qc = useQueryClient();
  const toast = useToast();
  const isAdmin = currentRole === "admin" || currentRole === "owner";
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

  const update = useMutation({
    mutationFn: ({ accountId, role }: { accountId: string; role: OrgMember["org_role"] }) =>
      updateOrgMember(orgId, accountId, role),
    onSuccess: () => {
      toast.show({ kind: "success", title: "Member role updated" });
      qc.invalidateQueries({ queryKey: ["org-members", orgId] });
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: "Update failed",
        description: (e as Error).message,
      }),
  });

  const remove = useMutation({
    mutationFn: (accountId: string) => removeOrgMember(orgId, accountId),
    onSuccess: () => {
      toast.show({ kind: "success", title: "Member removed" });
      qc.invalidateQueries({ queryKey: ["org-members", orgId] });
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: "Remove failed",
        description: (e as Error).message,
      }),
  });

  return (
    <div className="card !p-4 text-sm">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-base font-semibold">Members</h3>
        <div className="flex items-center gap-2">
          <select
            className="input text-xs py-0.5"
            value={principalFilter}
            onChange={(e) =>
              setPrincipalFilter(e.target.value as "all" | "human" | "agent")
            }
            title="Filter by principal type"
          >
            <option value="all">All types</option>
            <option value="human">Humans only</option>
            <option value="agent">Agents only</option>
          </select>
          <span className="text-xs text-slate-500">
            {filteredMembers.length} member{filteredMembers.length === 1 ? "" : "s"}
            {principalFilter !== "all" && (
              <span className="ml-1">({principalFilter})</span>
            )}
          </span>
        </div>
      </div>
      {!isAdmin && (
        <p className="text-xs text-yellow-700 mb-2">
          ⚠ Your current role is "{currentRole ?? "—"}" — you can view
          members but not edit them.
        </p>
      )}
      {members.isLoading && <p className="text-slate-500">Loading…</p>}
      {members.error && (
        <p className="text-red-600">Failed: {(members.error as Error).message}</p>
      )}
      {members.data && filteredMembers.length === 0 && (
        <p className="text-slate-500">
          {principalFilter === "all"
            ? "No members yet."
            : `No ${principalFilter} members.`}
        </p>
      )}
      {members.data && filteredMembers.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-slate-500 text-left border-b border-slate-100">
              <th className="font-normal py-1 pr-2">Principal</th>
              <th className="font-normal py-1 pr-2">Type</th>
              <th className="font-normal py-1 pr-2">Role</th>
              <th className="font-normal py-1 pr-2">Joined</th>
              <th className="font-normal py-1 pr-2">Last login</th>
              {isAdmin && <th className="font-normal py-1">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {filteredMembers.map((m) => (
              <tr
                key={m.account_id}
                className="border-b border-slate-50 hover:bg-slate-50"
              >
                <td className="py-2 pr-2">
                  <div className="font-medium">
                    {m.display_name}
                    {m.account_id === currentAccountId && (
                      <span className="ml-1 text-xs text-slate-500">(you)</span>
                    )}
                  </div>
                  <div className="text-xs text-slate-500">
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
                    <span className="badge-purple text-xs">agent</span>
                  ) : (
                    <span className="text-xs">human</span>
                  )}
                </td>
                <td className="py-2 pr-2">
                  {isAdmin && m.account_id !== currentAccountId ? (
                    <select
                      className="input text-xs py-0.5"
                      value={m.org_role}
                      onChange={(e) =>
                        update.mutate({
                          accountId: m.account_id,
                          role: e.target.value as OrgMember["org_role"],
                        })
                      }
                      disabled={update.isPending}
                    >
                      {(["owner", "admin", "member", "viewer"] as const).map(
                        (r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ),
                      )}
                    </select>
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
                      {m.org_role}
                    </span>
                  )}
                </td>
                <td className="py-2 pr-2 text-xs text-slate-500">
                  {new Date(m.joined_at).toISOString().slice(0, 10)}
                </td>
                <td className="py-2 pr-2 text-xs text-slate-500">
                  {m.last_login_at
                    ? new Date(m.last_login_at).toISOString().slice(0, 10)
                    : "—"}
                </td>
                {isAdmin && (
                  <td className="py-2 text-xs">
                    {m.account_id !== currentAccountId && (
                      <button
                        className="text-red-600 hover:underline"
                        onClick={() => {
                          if (
                            confirm(
                              `Remove ${m.display_name} from this org?`,
                            )
                          ) {
                            remove.mutate(m.account_id);
                          }
                        }}
                        disabled={remove.isPending}
                      >
                        Remove
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function InvitesTab({
  orgId,
  canManage,
}: {
  orgId: string;
  canManage: boolean;
}) {
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
      toast.show({ kind: "success", title: "Invite revoked" });
      qc.invalidateQueries({ queryKey: ["org-invites", orgId] });
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: "Revoke failed",
        description: (e as Error).message,
      }),
  });

  const resend = useMutation({
    mutationFn: (inviteId: string) => resendOrgInvite(orgId, inviteId),
    onSuccess: (data) => {
      toast.show({
        kind: "success",
        title: "Invite link refreshed",
        description: `Copied URL: ${data.invite_url.slice(0, 60)}…`,
      });
      navigator.clipboard?.writeText(data.invite_url).catch(() => {});
      qc.invalidateQueries({ queryKey: ["org-invites", orgId] });
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: "Refresh failed",
        description: (e as Error).message,
      }),
  });

  return (
    <div className="card !p-4 text-sm">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-base font-semibold">Invites</h3>
        <div className="flex items-center gap-2">
          <select
            className="input text-xs py-0.5"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            title="Filter by invite status"
          >
            <option value="all">All statuses</option>
            <option value="pending">Pending</option>
            <option value="accepted">Accepted</option>
            <option value="revoked">Revoked</option>
            <option value="expired">Expired</option>
          </select>
          {canManage && (
            <button
              className="btn-primary text-xs"
              onClick={() => setShowCreate(true)}
            >
              + Invite link
            </button>
          )}
        </div>
      </div>
      {!canManage && (
        <p className="text-xs text-yellow-700 mb-2">
          ⚠ Owner / admin required to manage invites.
        </p>
      )}
      {invites.isLoading && <p className="text-slate-500">Loading…</p>}
      {invites.error && (
        <p className="text-red-600">Failed: {(invites.error as Error).message}</p>
      )}
      {invites.data && filteredInvites.length === 0 && (
        <p className="text-slate-500 text-sm">
          {statusFilter === "all"
            ? "No pending invites."
            : `No ${statusFilter} invites.`}
        </p>
      )}
      {invites.data && filteredInvites.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-slate-500 text-left border-b border-slate-100">
              <th className="font-normal py-1 pr-2">Email</th>
              <th className="font-normal py-1 pr-2">Role</th>
              <th className="font-normal py-1 pr-2">Status</th>
              <th className="font-normal py-1 pr-2">Expires</th>
              {canManage && <th className="font-normal py-1">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {filteredInvites.map((inv) => (
              <tr
                key={inv.id}
                className="border-b border-slate-50 hover:bg-slate-50"
              >
                <td className="py-2 pr-2 font-mono text-xs">{inv.email}</td>
                <td className="py-2 pr-2 text-xs">{inv.role}</td>
                <td className="py-2 pr-2 text-xs">
                  <InviteStatusBadge status={inv.status} />
                </td>
                <td className="py-2 pr-2 text-xs text-slate-500">
                  {new Date(inv.expires_at).toISOString().slice(0, 10)}
                </td>
                {canManage && inv.status === "pending" && (
                  <td className="py-2 text-xs space-x-2">
                    <button
                      className="text-blue-600 hover:underline"
                      onClick={() => resend.mutate(inv.id)}
                      disabled={resend.isPending}
                    >
                      Refresh link
                    </button>
                    <button
                      className="text-red-600 hover:underline"
                      onClick={() => {
                        if (confirm(`Revoke invite to ${inv.email}?`)) {
                          revoke.mutate(inv.id);
                        }
                      }}
                      disabled={revoke.isPending}
                    >
                      Revoke
                    </button>
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
    </div>
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
        title: `Invite link created for ${email}`,
        description: `Copied URL: ${data.invite_url.slice(0, 60)}…`,
      });
      // Copy invite URL to clipboard for the admin to share
      navigator.clipboard?.writeText(data.invite_url).catch(() => {});
      onCreated();
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: "Invite failed",
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
      <div className="card max-w-md w-full relative">
        <h2 className="text-lg font-bold mb-4">Create member invite link</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
          className="space-y-3"
        >
          <div>
            <label className="label">Email</label>
            <input
              type="email"
              className="input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
            />
          </div>
          <div>
            <label className="label">Role</label>
            <select
              className="input"
              value={role}
              onChange={(e) =>
                setRole(e.target.value as "member" | "viewer")
              }
            >
              <option value="member">member (default)</option>
              <option value="viewer">viewer (read-only)</option>
            </select>
          </div>
          <div>
            <label className="label">Message (optional)</label>
            <textarea
              className="input text-xs min-h-[60px]"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
          </div>
          <div className="flex gap-2 justify-end pt-2">
            <button
              type="button"
              className="btn-secondary"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn-primary"
              disabled={create.isPending || !email.trim()}
            >
              {create.isPending ? "Creating…" : "Create invite link"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function InviteStatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    pending: "badge-blue",
    accepted: "badge-green",
    revoked: "badge-gray",
    expired: "badge-orange",
  };
  return <span className={map[status] ?? "badge-gray"}>{status}</span>;
}

function AuditTab({
  orgId,
  canView,
}: {
  orgId: string;
  canView: boolean;
}) {
  const audit = useQuery({
    queryKey: ["org-audit", orgId],
    queryFn: () => listOrgAuditLogs(orgId, 100),
    enabled: canView,
  });
  return (
    <div className="card !p-4 text-sm">
      <h3 className="text-base font-semibold mb-3">Audit log</h3>
      {!canView && (
        <p className="text-xs text-yellow-700 mb-2">
          ⚠ Org member required to view audit log.
        </p>
      )}
      {audit.isLoading && <p className="text-slate-500">Loading…</p>}
      {audit.error && (
        <p className="text-red-600">Failed: {(audit.error as Error).message}</p>
      )}
      {audit.data && audit.data.logs.length === 0 && (
        <p className="text-slate-500 text-sm">No audit log entries yet.</p>
      )}
      {audit.data && audit.data.logs.length > 0 && (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-slate-500 text-left border-b border-slate-100">
              <th className="font-normal py-1 pr-2">When</th>
              <th className="font-normal py-1 pr-2">Actor</th>
              <th className="font-normal py-1 pr-2">App</th>
              <th className="font-normal py-1 pr-2">Action</th>
              <th className="font-normal py-1 pr-2">Payload</th>
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
                  className="border-b border-slate-50 hover:bg-slate-50"
                >
                  <td className="py-1 pr-2 text-slate-500 font-mono whitespace-nowrap">
                    {new Date(log.created_at).toISOString().slice(0, 19)}Z
                  </td>
                  <td className="py-1 pr-2">
                    <span className="inline-flex items-center gap-1">
                      {log.actor_avatar_url ? (
                        <img
                          src={log.actor_avatar_url}
                          alt=""
                          className="w-4 h-4 rounded-full object-cover"
                        />
                      ) : (
                        <span
                          className={`w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold ${
                            log.actor_type === "agent"
                              ? "bg-purple-200 text-purple-800"
                              : log.actor_type === "system"
                                ? "bg-slate-200 text-slate-600"
                                : "bg-blue-200 text-blue-800"
                          }`}
                        >
                          {actorName.slice(0, 1).toUpperCase()}
                        </span>
                      )}
                      <span>{actorName}</span>
                      {log.actor_type === "agent" && (
                        <span className="badge-purple text-[10px]">agent</span>
                      )}
                      {log.actor_type === "system" && (
                        <span className="badge-gray text-[10px]">system</span>
                      )}
                    </span>
                  </td>
                  <td className="py-1 pr-2 font-mono text-slate-500 whitespace-nowrap">
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
      )}
    </div>
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
      <div className="w-48 text-xs text-slate-500">{k}</div>
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
      toast.show({ kind: "success", title: "Webhook archived" });
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: "Delete failed",
        description: (e as Error).message,
      }),
  });

  const toggle = useMutation({
    mutationFn: (input: { id: string; enabled: boolean }) =>
      updateOrgWebhook(orgId, input.id, { enabled: input.enabled }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["org-webhooks", orgId] }),
  });

  return (
    <div className="space-y-3">
      <div className="card !p-4 text-sm">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-base font-semibold">Webhooks</h3>
            <p className="text-xs text-slate-500">
              Subscribe external HTTP endpoints to release and build events.
              Deliveries are signed with HMAC SHA-256
              (<code className="font-mono">X-Quiver-Signature</code>).
            </p>
          </div>
          {canManage && (
            <button
              className="btn-primary text-xs"
              onClick={() => setShowCreate(true)}
            >
              + Add webhook
            </button>
          )}
        </div>

        {!canManage && (
          <p className="text-xs text-yellow-700 mb-2">
            ⚠ Org owner / admin required to manage webhooks.
          </p>
        )}

        {webhooks.isLoading && <p className="text-slate-500">Loading…</p>}
        {webhooks.error && (
          <p className="text-red-600 text-xs">
            Failed: {(webhooks.error as Error).message}
          </p>
        )}
        {webhooks.data && webhooks.data.webhooks.length === 0 && (
          <p className="text-slate-500 text-sm">No webhooks configured yet.</p>
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
                  if (confirm(`Archive webhook ${w.url}?`)) remove.mutate(w.id);
                }}
                canManage={canManage}
              />
            ))}
          </div>
        )}
      </div>

      <div className="card !p-4 text-xs text-slate-600">
        <h4 className="font-semibold mb-1">Delivery semantics</h4>
        <ul className="list-disc pl-5 space-y-1">
          <li>
            Worker Cron Trigger (<code className="font-mono">*/5 * * * *</code>)
            reaps pending deliveries every 5 minutes.
          </li>
          <li>
            Retries use exponential backoff: 5m → 30m → 2h (3 attempts max),
            then marked permanently <code className="font-mono">failed</code>.
          </li>
          <li>
            Receiver must verify
            <code className="font-mono"> X-Quiver-Signature: sha256=&lt;hmac&gt;</code>
            using the webhook&apos;s secret.
          </li>
        </ul>
      </div>

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
    <div className="border border-slate-200 rounded p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={
                webhook.enabled === 1
                  ? "badge-green text-xs"
                  : "badge-gray text-xs"
              }
            >
              {webhook.enabled === 1 ? "enabled" : "disabled"}
            </span>
            <span className="font-mono text-xs truncate">{webhook.url}</span>
          </div>
          <div className="text-xs text-slate-500 mt-1">
            events:{" "}
            {events.length === 0 ? (
              <span className="italic">(all)</span>
            ) : (
              events.map((e) => (
                <span key={e} className="badge-blue text-xs mr-1">
                  {e}
                </span>
              ))
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {canManage && (
            <button
              className="btn-secondary text-xs"
              onClick={() => onToggleEnabled(webhook.enabled !== 1)}
              disabled={!onToggleEnabled}
            >
              {webhook.enabled === 1 ? "Disable" : "Enable"}
            </button>
          )}
          <button
            className="btn-secondary text-xs"
            onClick={onToggleExpand}
          >
            {expanded ? "Hide" : "Deliveries"}
          </button>
          {canManage && (
            <button className="btn-secondary text-xs" onClick={onDelete}>
              Archive
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="mt-3 pt-3 border-t border-slate-100">
          {deliveries.isLoading && (
            <p className="text-xs text-slate-500">Loading deliveries…</p>
          )}
          {deliveries.error && (
            <p className="text-red-600 text-xs">
              Failed: {(deliveries.error as Error).message}
            </p>
          )}
          {deliveries.data && deliveries.data.deliveries.length === 0 && (
            <p className="text-xs text-slate-500">No deliveries yet.</p>
          )}
          {deliveries.data && deliveries.data.deliveries.length > 0 && (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-slate-500 text-left border-b border-slate-100">
                  <th className="font-normal py-1 pr-2">When</th>
                  <th className="font-normal py-1 pr-2">Event</th>
                  <th className="font-normal py-1 pr-2">Status</th>
                  <th className="font-normal py-1 pr-2">Attempts</th>
                  <th className="font-normal py-1 pr-2">HTTP</th>
                  <th className="font-normal py-1 pr-2">Next / error</th>
                </tr>
              </thead>
              <tbody>
                {deliveries.data.deliveries.map((d: WebhookDelivery) => (
                  <tr
                    key={d.id}
                    className="border-b border-slate-50 hover:bg-slate-50"
                  >
                    <td className="py-1 pr-2 font-mono text-slate-500">
                      {new Date(d.created_at).toISOString().slice(0, 19)}Z
                    </td>
                    <td className="py-1 pr-2 font-mono">{d.event_type}</td>
                    <td className="py-1 pr-2">
                      <span
                        className={
                          d.status === "succeeded"
                            ? "badge-green text-xs"
                            : d.status === "failed"
                              ? "badge-red text-xs"
                              : "badge-blue text-xs"
                        }
                      >
                        {d.status}
                      </span>
                    </td>
                    <td className="py-1 pr-2 font-mono">
                      {d.attempts}/{d.max_attempts}
                    </td>
                    <td className="py-1 pr-2 font-mono">
                      {d.last_response_status ?? "—"}
                    </td>
                    <td className="py-1 pr-2 font-mono text-slate-500 truncate max-w-xs">
                      {d.last_error
                        ? d.last_error
                        : d.next_attempt_at
                          ? `next ${new Date(d.next_attempt_at).toISOString().slice(11, 19)}Z`
                          : d.completed_at
                            ? `done ${new Date(d.completed_at).toISOString().slice(11, 19)}Z`
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
      toast.show({ kind: "success", title: "Webhook created" });
      onCreated();
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: "Create failed",
        description: (e as Error).message,
      }),
  });

  const toggleEvent = (ev: WebhookEventType) => {
    setEvents((cur) =>
      cur.includes(ev) ? cur.filter((e) => e !== ev) : [...cur, ev],
    );
  };

  return (
    <div
      className="fixed inset-0 bg-black/30 flex items-center justify-center p-4 z-10"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="card max-w-lg w-full relative">
        <h2 className="text-lg font-bold mb-4">Add webhook</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
          className="space-y-3"
        >
          <div>
            <label className="label">URL</label>
            <input
              type="url"
              className="input"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/hooks/quiver"
              required
              autoFocus
            />
          </div>
          <div>
            <label className="label">Secret (HMAC)</label>
            <input
              type="text"
              className="input font-mono text-xs"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="at-least-16-random-bytes"
              required
            />
            <p className="text-xs text-slate-500 mt-1">
              Used to sign deliveries via{" "}
              <code className="font-mono">X-Quiver-Signature</code>. Choose a
              strong secret; receivers must verify the signature.
            </p>
          </div>
          <div>
            <label className="label">Events (empty = all)</label>
            <div className="grid grid-cols-2 gap-1">
              {WEBHOOK_EVENT_TYPES.map((ev) => (
                <label
                  key={ev}
                  className="flex items-center gap-2 text-xs cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={events.includes(ev)}
                    onChange={() => toggleEvent(ev)}
                  />
                  <span className="font-mono">{ev}</span>
                </label>
              ))}
            </div>
          </div>
          <div className="flex gap-2 justify-end pt-2">
            <button
              type="button"
              className="btn-secondary"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn-primary"
              disabled={
                create.isPending || !url.trim() || secret.trim().length < 8
              }
            >
              {create.isPending ? "Creating…" : "Create webhook"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
