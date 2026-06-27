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
  getAuthMe,
  listAppMembers,
  listOrgMembers,
  removeAppMember,
  updateAppMember,
  type AppMember,
} from "../lib/api";
import { useToast } from "../components/Toast";

export function AppAccess({ appId }: { appId: string }) {
  const me = useQuery({ queryKey: ["auth-me"], queryFn: () => getAuthMe() });
  const account = me.data?.account;
  const orgRole = account?.org_role ?? null;
  const isOrgAdmin = orgRole === "owner" || orgRole === "admin";

  return (
    <div className="space-y-4">
      <div className="card !p-4 text-sm">
        <div className="text-slate-600 mb-2">
          <strong>App Access tab.</strong> Manage which principals can publish
          to this app. App members have per-app roles in addition to their
          org role.
        </div>
        <div className="text-xs text-slate-500">
          Your current access: <span className="font-mono">{orgRole ?? "—"}</span>{" "}
          {isOrgAdmin ? "(can manage members)" : "(read-only)"}
        </div>
      </div>
      <AppMemberList appId={appId} canManage={isOrgAdmin} currentAccountId={account?.id ?? null} />
      {isOrgAdmin && <AddAppMemberForm appId={appId} />}
    </div>
  );
}

function AppMemberList({
  appId,
  canManage,
  currentAccountId,
}: {
  appId: string;
  canManage: boolean;
  currentAccountId: string | null;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const members = useQuery({
    queryKey: ["app-members", appId],
    queryFn: () => listAppMembers(appId),
  });

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
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-base font-semibold">App members</h3>
        <span className="text-xs text-slate-500">
          {members.data?.members.length ?? "—"} member
          {members.data?.members.length === 1 ? "" : "s"}
        </span>
      </div>
      {members.isLoading && <p className="text-slate-500">Loading…</p>}
      {members.error && (
        <p className="text-red-600">Failed: {(members.error as Error).message}</p>
      )}
      {members.data && members.data.members.length === 0 && (
        <p className="text-slate-500 text-sm">
          No app members yet. Add someone below or wait for them to accept
          an invite.
        </p>
      )}
      {members.data && members.data.members.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-slate-500 text-left border-b border-slate-100">
              <th className="font-normal py-1 pr-2">Principal</th>
              <th className="font-normal py-1 pr-2">Type</th>
              <th className="font-normal py-1 pr-2">App role</th>
              <th className="font-normal py-1 pr-2">Joined</th>
              {canManage && <th className="font-normal py-1">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {members.data.members.map((m) => (
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
                  <div className="text-xs text-slate-500 font-mono">
                    {m.provider_subject.slice(0, 16)}…
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

function AddAppMemberForm({ appId }: { appId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const me = useQuery({ queryKey: ["auth-me"], queryFn: () => getAuthMe() });
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
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: "Add failed",
        description: (e as Error).message,
      }),
  });

  // Filter out members already on this app
  const appAccountIds = new Set(
    appMembers.data?.members.map((m) => m.account_id) ?? [],
  );
  const candidates =
    orgMembers.data?.members.filter((m) => !appAccountIds.has(m.account_id)) ??
    [];

  if (candidates.length === 0) {
    return (
      <div className="card !p-4 text-sm text-slate-500">
        All org members are already on this app.
      </div>
    );
  }

  return (
    <div className="card !p-4 text-sm">
      <h3 className="text-base font-semibold mb-3">Add app member</h3>
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex-1 min-w-48">
          <label className="label">Principal</label>
          <select
            className="input"
            value={selectedAccount}
            onChange={(e) => setSelectedAccount(e.target.value)}
          >
            <option value="">— select —</option>
            {candidates.map((m) => (
              <option key={m.account_id} value={m.account_id}>
                {m.display_name} ({m.username ?? m.provider_subject.slice(0, 8)})
              </option>
            ))}
          </select>
        </div>
        <div className="w-32">
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
        <button
          className="btn-primary"
          onClick={() => add.mutate()}
          disabled={!selectedAccount || add.isPending}
        >
          {add.isPending ? "Adding…" : "Add"}
        </button>
      </div>
      <p className="text-xs text-slate-500 mt-2">
        Direct add — principal must already be an org member. For inviting
        new people, use the Org settings → Invites tab.
      </p>
    </div>
  );
}