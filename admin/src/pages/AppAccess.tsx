/**
 * AppAccess — per-app member management.
 *
 * Tab on AppDetail ("Access"). Shows app_members (humans + agents granted
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
  getAuthMe,
  listApps,
  listAppMembers,
  listAppServerGrants,
  listOrgMembers,
  removeAppMember,
  removeAppServerGrant,
  updateAppMember,
  type AppMember,
  type App,
} from "../lib/api";
import { useToast } from "../components/Toast";

export function AppAccess({ appId }: { appId: string }) {
  const [showAddServer, setShowAddServer] = useState(false);
  const [showAddMember, setShowAddMember] = useState(false);
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
    <div className="space-y-4">
      <div className="card !p-4 text-sm">
        <div className="text-slate-600 mb-2">
          <strong>Access.</strong> Review inherited owner-server access,
          external Raft server visibility, and direct per-app member grants.
        </div>
        <div className="text-xs text-slate-500">
          Your current access: <span className="font-mono">{currentAccess ?? "—"}</span>{" "}
          {isOwningOrg && <span>(inherited from owning org)</span>}
          {!isOwningOrg && currentServerGrantRole && (
            <span>(server visibility)</span>
          )}
          {!isOwningOrg && currentAppRole && <span>(direct app member)</span>}{" "}
          {canManage ? "(can manage access)" : "(read-only)"}
        </div>
      </div>
      <AppServerGrantList
        appId={appId}
        app={app}
        isOwningOrg={isOwningOrg}
        canManage={canManage}
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
    </div>
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
  const qc = useQueryClient();
  const toast = useToast();
  const grants = useQuery({
    queryKey: ["app-server-grants", appId],
    queryFn: () => listAppServerGrants(appId),
  });

  const remove = useMutation({
    mutationFn: (grantKey: string) => removeAppServerGrant(appId, grantKey),
    onSuccess: () => {
      toast.show({ kind: "success", title: "Server grant removed" });
      qc.invalidateQueries({ queryKey: ["app-server-grants", appId] });
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: "Remove failed",
        description: (e as Error).message,
      }),
  });

  const rows = grants.data?.server_grants ?? [];
  const visibleRowCount = rows.length + (isOwningOrg ? 1 : 0);

  return (
    <div className="card !p-4 text-sm">
      {grants.isLoading && <p className="text-slate-500">Loading…</p>}
      {grants.error && (
        <p className="text-red-600">Failed: {(grants.error as Error).message}</p>
      )}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-base font-semibold">Server access</h3>
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500">
            {visibleRowCount} server{visibleRowCount === 1 ? "" : "s"}
          </span>
          {canManage && (
            <button className="btn-secondary !py-1 !px-2 !text-xs" onClick={onAdd}>
              + Add
            </button>
          )}
        </div>
      </div>
      {grants.data && visibleRowCount === 0 && (
        <p className="text-slate-500 text-sm">No server-level access rows visible.</p>
      )}
      {grants.data && visibleRowCount > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-slate-500 text-left border-b border-slate-100">
              <th className="font-normal py-1 pr-2">Server</th>
              <th className="font-normal py-1 pr-2">Server ID</th>
              <th className="font-normal py-1 pr-2">Access</th>
              <th className="font-normal py-1 pr-2">Source</th>
              {canManage && <th className="font-normal py-1">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {isOwningOrg && (
              <tr className="border-b border-slate-50 bg-slate-50/60">
                <td className="py-2 pr-2">
                  <div className="font-medium">
                    {currentServerSlug || app?.org_id || "Current server"}
                    <span className="ml-1 text-xs text-slate-500">(current)</span>
                  </div>
                </td>
                <td className="py-2 pr-2">
                  <span className="font-mono text-xs text-slate-600">
                    {currentServerId || "—"}
                  </span>
                </td>
                <td className="py-2 pr-2">
                  <span className="text-xs font-medium">Inherited</span>
                </td>
                <td className="py-2 pr-2 text-xs text-slate-500">
                  Owning org
                </td>
                {canManage && (
                  <td className="py-2 text-xs text-slate-400">Inherited</td>
                )}
              </tr>
            )}
            {rows.map((grant) => (
              <tr
                key={grant.id}
                className="border-b border-slate-50 hover:bg-slate-50"
              >
                <td className="py-2 pr-2">
                  <div className="font-medium">
                    {grant.server_slug || grant.server_id}
                    {(grant.server_id === currentServerId ||
                      (!!grant.server_slug && grant.server_slug === currentServerSlug)) && (
                      <span className="ml-1 text-xs text-slate-500">(current)</span>
                    )}
                  </div>
                </td>
                <td className="py-2 pr-2">
                  <span className="font-mono text-xs text-slate-600">
                    {grant.server_id || "—"}
                  </span>
                </td>
                <td className="py-2 pr-2">
                  <span className="text-xs font-medium">Visible</span>
                </td>
                <td className="py-2 pr-2 text-xs text-slate-500">
                  Server visibility
                </td>
                {canManage && (
                  <td className="py-2 text-xs">
                    <button
                      className="text-red-600 hover:underline"
                      onClick={() => {
                        if (
                          confirm(
                            `Remove server grant for ${grant.server_slug || grant.server_id}?`,
                          )
                        ) {
                          remove.mutate(grant.id);
                        }
                      }}
                      disabled={remove.isPending}
                    >
                      Remove
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {grants.data && isOwningOrg && rows.length === 0 && (
        <p className="text-xs text-slate-500 mt-2">
          No external server visibility grants yet. The current server has access because it owns this app.
        </p>
      )}
    </div>
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
  const qc = useQueryClient();
  const toast = useToast();
  const [serverId, setServerId] = useState("");
  const [serverSlug, setServerSlug] = useState("");

  const add = useMutation({
    mutationFn: () =>
      addAppServerGrant(appId, {
        server_id: serverId.trim() || null,
        server_slug: serverSlug.trim() || null,
        app_role: "viewer",
      }),
    onSuccess: () => {
      toast.show({ kind: "success", title: "Server grant added" });
      qc.invalidateQueries({ queryKey: ["app-server-grants", appId] });
      setServerId("");
      setServerSlug("");
      onAdded();
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: "Add failed",
        description: (e as Error).message,
      }),
  });

  return (
    <div
      className="fixed inset-0 bg-black/30 flex items-center justify-center p-4 z-10"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div className="card max-w-md w-full relative">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute top-3 right-3 text-slate-400 hover:text-slate-700 w-8 h-8 flex items-center justify-center rounded-md hover:bg-slate-100"
        >
          ×
        </button>
        <h2 className="text-lg font-bold mb-4 pr-8">Add Raft server</h2>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <div>
            <label className="label">Server slug</label>
            <input
              className="input"
              value={serverSlug}
              onChange={(e) => setServerSlug(e.target.value)}
              placeholder="server slug"
              autoFocus
            />
          </div>
          <div>
            <label className="label">Server ID</label>
            <input
              className="input"
              value={serverId}
              onChange={(e) => setServerId(e.target.value)}
              placeholder="optional"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" className="btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn-primary"
              disabled={(!serverId.trim() && !serverSlug.trim()) || add.isPending}
            >
              {add.isPending ? "Adding…" : "Add"}
            </button>
          </div>
        </form>
      </div>
    </div>
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

  const update = useMutation({
    mutationFn: ({ accountId, role }: { accountId: string; role: AppMember["app_role"] }) =>
      updateAppMember(appId, accountId, role),
    onSuccess: () => {
      toast.show({ kind: "success", title: "App member role updated" });
      qc.invalidateQueries({ queryKey: ["app-members", appId] });
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: "Update failed",
        description: (e as Error).message,
      }),
  });

  const remove = useMutation({
    mutationFn: (accountId: string) => removeAppMember(appId, accountId),
    onSuccess: () => {
      toast.show({ kind: "success", title: "App member removed" });
      qc.invalidateQueries({ queryKey: ["app-members", appId] });
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
      {members.isLoading && <p className="text-slate-500">Loading…</p>}
      {members.error && (
        <p className="text-red-600">Failed: {(members.error as Error).message}</p>
      )}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-base font-semibold">Direct app members</h3>
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
          {canManage && (
            <button className="btn-secondary !py-1 !px-2 !text-xs" onClick={onAdd}>
              + Add
            </button>
          )}
        </div>
      </div>
      {members.data && filteredMembers.length === 0 && (
        <p className="text-slate-500 text-sm">
          {principalFilter === "all"
            ? "No direct app members yet. Org members may still have inherited access."
            : `No ${principalFilter} app members.`}
        </p>
      )}
      {members.data && filteredMembers.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-slate-500 text-left border-b border-slate-100">
              <th className="font-normal py-1 pr-2">Principal</th>
              <th className="font-normal py-1 pr-2">Type</th>
              <th className="font-normal py-1 pr-2">App role</th>
              <th className="font-normal py-1 pr-2">Joined</th>
              <th className="font-normal py-1 pr-2">Last login</th>
              {canManage && <th className="font-normal py-1">Actions</th>}
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
                  {canManage && m.account_id !== currentAccountId ? (
                    <select
                      className="input text-xs py-0.5"
                      value={m.app_role}
                      onChange={(e) =>
                        update.mutate({
                          accountId: m.account_id,
                          role: e.target.value as AppMember["app_role"],
                        })
                      }
                      disabled={update.isPending}
                    >
                      {(["admin", "publisher", "viewer"] as const).map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="text-xs font-medium">{m.app_role}</span>
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
                {canManage && (
                  <td className="py-2 text-xs">
                    {m.account_id !== currentAccountId && (
                      <button
                        className="text-red-600 hover:underline"
                        onClick={() => {
                          if (
                            confirm(
                              `Remove ${m.display_name} from this app?`,
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

function AddAppMemberDialog({
  appId,
  onClose,
  onAdded,
}: {
  appId: string;
  onClose: () => void;
  onAdded: () => void;
}) {
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
  const [role, setRole] = useState<AppMember["app_role"]>("viewer");

  const add = useMutation({
    mutationFn: () =>
      addAppMember(appId, {
        account_id: selectedAccount,
        app_role: role,
      }),
    onSuccess: () => {
      toast.show({ kind: "success", title: "App member added" });
      qc.invalidateQueries({ queryKey: ["app-members", appId] });
      setSelectedAccount("");
      onAdded();
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: "Add failed",
        description: (e as Error).message,
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

  if (candidates.length === 0) {
    return (
      <div
        className="fixed inset-0 bg-black/30 flex items-center justify-center p-4 z-10"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div className="card max-w-md w-full relative text-sm">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="absolute top-3 right-3 text-slate-400 hover:text-slate-700 w-8 h-8 flex items-center justify-center rounded-md hover:bg-slate-100"
          >
            ×
          </button>
          <h2 className="text-lg font-bold mb-3 pr-8">Add direct app member</h2>
          <p className="text-slate-500">
            No eligible org members need a direct app grant.
          </p>
          <div className="flex justify-end pt-4">
            <button type="button" className="btn-secondary" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 bg-black/30 flex items-center justify-center p-4 z-10"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div className="card max-w-md w-full relative text-sm">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute top-3 right-3 text-slate-400 hover:text-slate-700 w-8 h-8 flex items-center justify-center rounded-md hover:bg-slate-100"
        >
          ×
        </button>
        <h2 className="text-lg font-bold mb-4 pr-8">Add direct app member</h2>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <div>
            <label className="label">Principal</label>
            <select
              className="input"
              value={selectedAccount}
              onChange={(e) => setSelectedAccount(e.target.value)}
              autoFocus
            >
              <option value="">— select —</option>
              {candidates.map((m) => (
                <option key={m.account_id} value={m.account_id}>
                  {m.display_name} ({m.username ?? m.provider_subject.slice(0, 8)})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Role</label>
            <select
              className="input"
              value={role}
              onChange={(e) => setRole(e.target.value as AppMember["app_role"])}
            >
              <option value="admin">admin</option>
              <option value="publisher">publisher</option>
              <option value="viewer">viewer</option>
            </select>
          </div>
          <p className="text-xs text-slate-500">
            Direct app members are for org members who need app-scoped access.
            Owners and org admins already inherit app administration.
          </p>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" className="btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn-primary"
              disabled={!selectedAccount || add.isPending}
            >
              {add.isPending ? "Adding…" : "Add"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function InviteToAppForm({ appId }: { appId: string }) {
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
        title: `Invite sent to ${email}`,
        description: `URL: ${data.invite_url.slice(0, 60)}…`,
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
        title: "Invite failed",
        description: (e as Error).message,
      }),
  });

  if (!orgId) return null;

  return (
    <div className="card !p-4 text-sm">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-base font-semibold">Invite to this app</h3>
        {!showForm && (
          <button
            className="btn-secondary text-xs"
            onClick={() => setShowForm(true)}
          >
            + Invite
          </button>
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
            <input
              type="email"
              className="input text-sm"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="email@example.com"
              required
              autoFocus
            />
            <select
              className="input text-sm"
              value={role}
              onChange={(e) =>
                setRole(e.target.value as "publisher" | "viewer")
              }
            >
              <option value="publisher">publisher</option>
              <option value="viewer">viewer</option>
            </select>
          </div>
          <textarea
            className="input text-xs min-h-[40px]"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Optional message"
          />
          <p className="text-xs text-slate-500">
            The invitee needs an account with this email; accepting the
            invite makes them an org viewer (auto) and grants app access
            with the role you pick. URL is copied to clipboard after send.
          </p>
          <div className="flex gap-2">
            <button
              type="submit"
              className="btn-primary text-xs"
              disabled={invite.isPending || !email.trim()}
            >
              {invite.isPending ? "Sending…" : "Send invite"}
            </button>
            <button
              type="button"
              className="btn-secondary text-xs"
              onClick={() => setShowForm(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <p className="text-xs text-slate-500">
          Send an invite to grant app access. The invitee is added to the
          org as a viewer automatically when they accept; the picked role
          (publisher / viewer) controls what they can do on this app.
        </p>
      )}
    </div>
  );
}
