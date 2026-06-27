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
  type OrgMember,
} from "../lib/api";
import { useToast } from "../components/Toast";

type Tab = "general" | "members" | "invites" | "audit";

export function OrgSettings({ orgId }: { orgId: string }) {
  const [tab, setTab] = useState<Tab>("general");
  const me = useQuery({ queryKey: ["auth-me"], queryFn: () => getAuthMe() });
  const account = me.data?.account;
  const currentOrgId = account?.org_id ?? null;
  const currentRole = account?.org_role ?? null;
  const isOwnerOrAdmin = currentRole === "owner" || currentRole === "admin";
  const isCurrentOrg = currentOrgId === orgId;

  return (
    <div className="p-4">
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
        {(["general", "members", "invites", "audit"] as Tab[]).map((t) => (
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
                  : "Audit"}
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
        title: "Resent invite",
        description: `New invite URL: ${data.invite_url.slice(0, 60)}…`,
      });
      qc.invalidateQueries({ queryKey: ["org-invites", orgId] });
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: "Resend failed",
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
              + Invite member
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
                      Resend
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
        title: `Invite created for ${email}`,
        description: `Invite URL: ${data.invite_url.slice(0, 60)}…`,
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
        <h2 className="text-lg font-bold mb-4">Invite member</h2>
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
              <option value="member">member (humans default)</option>
              <option value="viewer">viewer (agents / read-only)</option>
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
              {create.isPending ? "Creating…" : "Create invite"}
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
            {audit.data.logs.map((log) => (
              <tr
                key={log.id}
                className="border-b border-slate-50 hover:bg-slate-50"
              >
                <td className="py-1 pr-2 text-slate-500 font-mono">
                  {new Date(log.created_at).toISOString().slice(0, 19)}Z
                </td>
                <td className="py-1 pr-2">
                  <span
                    className={
                      log.actor_type === "agent"
                        ? "badge-purple text-xs"
                        : "text-xs"
                    }
                  >
                    {log.actor || "—"}
                  </span>
                </td>
                <td className="py-1 pr-2 font-mono text-slate-500">
                  {log.app_id?.slice(0, 8) ?? "—"}
                </td>
                <td className="py-1 pr-2 font-mono">{log.action}</td>
                <td className="py-1 pr-2 font-mono truncate max-w-md">
                  {log.payload}
                </td>
              </tr>
            ))}
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