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
  type App,
} from "../lib/api";
import { useToast } from "../components/Toast";
import {
  Button,
  Input,
  Select,
  SelectTrigger,
  SelectValue,
  SelectIcon,
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
  Skeleton,
} from "raft-ui";

export function AppAccess({ appId }: { appId: string }) {
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
    <div className="space-y-4">
      <div className="card p-4! text-sm">
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
    <div className="card p-4! text-sm">
      {grants.isLoading && (
        <div className="space-y-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      )}
      {grants.error && (
        <p className="text-red-600">Failed: {(grants.error as Error).message}</p>
      )}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-base font-semibold">Server access</h3>
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500 whitespace-nowrap">
            {visibleRowCount} server{visibleRowCount === 1 ? "" : "s"}
          </span>
          {canManage && (
            <Button variant="outline" className="py-1! px-2! text-xs! whitespace-nowrap" onClick={onAdd}>
              + Add
            </Button>
          )}
        </div>
      </div>
      {grants.data && visibleRowCount === 0 && (
        <EmptyState>
          <EmptyStateTitle>No server-level access rows visible.</EmptyStateTitle>
        </EmptyState>
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
                    <Button
                      variant="link"
                      size="sm"
                      className="text-red-600"
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
                    </Button>
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
              aria-label="Close"
              className="absolute top-3 right-3 text-slate-400 hover:text-slate-700"
            />
          }
        >
          ×
        </DialogClose>
        <DialogHeader>
          <DialogTitle>Add Raft server</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <form
            id="add-app-server-grant-form"
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              add.mutate();
            }}
          >
            <div>
              <label className="label">Server slug</label>
              <Input
                value={serverSlug}
                onChange={(e) => setServerSlug(e.target.value)}
                placeholder="server slug"
                autoFocus
              />
            </div>
            <div>
              <label className="label">Server ID</label>
              <Input
                value={serverId}
                onChange={(e) => setServerId(e.target.value)}
                placeholder="optional"
              />
            </div>
          </form>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="add-app-server-grant-form"
            variant="primary"
            disabled={(!serverId.trim() && !serverSlug.trim()) || add.isPending}
          >
            {add.isPending ? "Adding…" : "Add"}
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
    <div className="card p-4! text-sm">
      {members.isLoading && (
        <div className="space-y-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      )}
      {members.error && (
        <p className="text-red-600">Failed: {(members.error as Error).message}</p>
      )}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-base font-semibold">Direct app members</h3>
        <div className="flex items-center gap-2">
          <Select
            items={{ all: "All types", human: "Humans only", agent: "Agents only" }}
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
              <TooltipContent>Filter by principal type</TooltipContent>
            </Tooltip>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              <SelectItem value="human">Humans only</SelectItem>
              <SelectItem value="agent">Agents only</SelectItem>
            </SelectContent>
          </Select>
          <span className="text-xs text-slate-500 whitespace-nowrap">
            {filteredMembers.length} member{filteredMembers.length === 1 ? "" : "s"}
            {principalFilter !== "all" && (
              <span className="ml-1">({principalFilter})</span>
            )}
          </span>
          {canManage && (
            <Button variant="outline" className="py-1! px-2! text-xs! whitespace-nowrap" onClick={onAdd}>
              + Add
            </Button>
          )}
        </div>
      </div>
      {members.data && filteredMembers.length === 0 && (
        <EmptyState>
          <EmptyStateTitle>
            {principalFilter === "all"
              ? "No direct app members yet. Org members may still have inherited access."
              : `No ${principalFilter} app members.`}
          </EmptyStateTitle>
        </EmptyState>
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
                    <Select
                      items={{ admin: "admin", publisher: "publisher", viewer: "viewer" }}
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
                        {(["admin", "publisher", "viewer"] as const).map((r) => (
                          <SelectItem key={r} value={r}>
                            {r}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
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
                      <Button
                        variant="link"
                        size="sm"
                        className="text-red-600"
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
                      </Button>
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

function AppDeployTokenList({
  appId,
  onAdd,
}: {
  appId: string;
  onAdd: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const tokens = useQuery({
    queryKey: ["app-deploy-tokens", appId],
    queryFn: () => listAppDeployTokens(appId),
  });
  const revoke = useMutation({
    mutationFn: (tokenId: string) => revokeAppDeployToken(appId, tokenId),
    onSuccess: () => {
      toast.show({ kind: "success", title: "Deploy token revoked" });
      qc.invalidateQueries({ queryKey: ["app-deploy-tokens", appId] });
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: "Revoke failed",
        description: (e as Error).message,
      }),
  });
  const rows = tokens.data?.deploy_tokens ?? [];

  return (
    <div className="card p-4! text-sm">
      {tokens.isLoading && (
        <div className="space-y-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      )}
      {tokens.error && (
        <p className="text-red-600">Failed: {(tokens.error as Error).message}</p>
      )}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-base font-semibold">Deploy tokens</h3>
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500 whitespace-nowrap">
            {rows.length} token{rows.length === 1 ? "" : "s"}
          </span>
          <Button variant="outline" className="py-1! px-2! text-xs! whitespace-nowrap" onClick={onAdd}>
            + Add
          </Button>
        </div>
      </div>
      {tokens.data && rows.length === 0 && (
        <EmptyState>
          <EmptyStateTitle>No deploy tokens yet.</EmptyStateTitle>
        </EmptyState>
      )}
      {tokens.data && rows.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-slate-500 text-left border-b border-slate-100">
              <th className="font-normal py-1 pr-2">Name</th>
              <th className="font-normal py-1 pr-2">Prefix</th>
              <th className="font-normal py-1 pr-2">Role</th>
              <th className="font-normal py-1 pr-2">Expires</th>
              <th className="font-normal py-1 pr-2">Last used</th>
              <th className="font-normal py-1">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((token) => (
              <tr
                key={token.id}
                className="border-b border-slate-50 hover:bg-slate-50"
              >
                <td className="py-2 pr-2">
                  <div className="font-medium">{token.name}</div>
                  <div className="text-xs text-slate-500">
                    by {token.created_by_actor}
                  </div>
                </td>
                <td className="py-2 pr-2">
                  <span className="font-mono text-xs text-slate-600">
                    {token.token_prefix}
                  </span>
                </td>
                <td className="py-2 pr-2">
                  <span className="text-xs font-medium">{token.app_role}</span>
                </td>
                <td className="py-2 pr-2 text-xs text-slate-500">
                  {token.expires_at
                    ? new Date(token.expires_at).toISOString().slice(0, 10)
                    : "Never"}
                </td>
                <td className="py-2 pr-2 text-xs text-slate-500">
                  {token.last_used_at
                    ? new Date(token.last_used_at).toISOString().slice(0, 10)
                    : "—"}
                </td>
                <td className="py-2 text-xs">
                  <Button
                    variant="link"
                    size="sm"
                    className="text-red-600"
                    onClick={() => {
                      if (confirm(`Revoke deploy token ${token.name}?`)) {
                        revoke.mutate(token.id);
                      }
                    }}
                    disabled={revoke.isPending}
                  >
                    Revoke
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="text-xs text-slate-500 mt-2">
        Tokens are app-scoped bearer credentials for CI. The raw token is only
        shown once after creation.
      </p>
    </div>
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
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState("");
  const [role, setRole] = useState<AppDeployToken["app_role"]>("publisher");
  const [expiry, setExpiry] = useState<"30d" | "90d" | "365d" | "never">("365d");
  const [createdToken, setCreatedToken] = useState<string | null>(null);

  const expiresAt = () => {
    if (expiry === "never") return null;
    const days = expiry === "30d" ? 30 : expiry === "90d" ? 90 : 365;
    return Date.now() + days * 24 * 60 * 60 * 1000;
  };

  const create = useMutation({
    mutationFn: () =>
      createAppDeployToken(appId, {
        name: name.trim(),
        app_role: role,
        expires_at: expiresAt(),
      }),
    onSuccess: (data) => {
      toast.show({ kind: "success", title: "Deploy token created" });
      qc.invalidateQueries({ queryKey: ["app-deploy-tokens", appId] });
      setCreatedToken(data.token);
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: "Create failed",
        description: (e as Error).message,
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
              aria-label="Close"
              className="absolute top-3 right-3 text-slate-400 hover:text-slate-700"
            />
          }
        >
          ×
        </DialogClose>
        <DialogHeader>
          <DialogTitle>Add deploy token</DialogTitle>
        </DialogHeader>
        {createdToken ? (
          <>
            <DialogBody className="space-y-3">
              <p className="text-sm text-slate-600">
                Copy this token now. It will not be shown again.
              </p>
              <textarea
                className="input font-mono text-xs min-h-[96px]"
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
                  toast.show({ kind: "success", title: "Token copied" });
                }}
              >
                Copy
              </Button>
              <Button type="button" variant="primary" onClick={closeAfterCreate}>
                Done
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
                  <label className="label">Name</label>
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="github-actions-main"
                    autoFocus
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="label">Role</label>
                    <Select
                      items={{ publisher: "publisher", viewer: "viewer" }}
                      value={role}
                      onValueChange={(v) =>
                        setRole(v as AppDeployToken["app_role"])
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                        <SelectIcon />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="publisher">publisher</SelectItem>
                        <SelectItem value="viewer">viewer</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <label className="label">Expires</label>
                    <Select
                      items={{ "30d": "30 days", "90d": "90 days", "365d": "1 year", never: "Never" }}
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
                        <SelectItem value="30d">30 days</SelectItem>
                        <SelectItem value="90d">90 days</SelectItem>
                        <SelectItem value="365d">1 year</SelectItem>
                        <SelectItem value="never">Never</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <p className="text-xs text-slate-500">
                  Publisher tokens can upload builds, create releases, and create
                  share pages for this app only.
                </p>
              </form>
            </DialogBody>
            <DialogFooter>
              <Button variant="outline" type="button" onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                form="add-app-deploy-token-form"
                variant="primary"
                disabled={!name.trim() || create.isPending}
              >
                {create.isPending ? "Creating…" : "Create"}
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
                aria-label="Close"
                className="absolute top-3 right-3 text-slate-400 hover:text-slate-700"
              />
            }
          >
            ×
          </DialogClose>
          <DialogHeader>
            <DialogTitle>Add direct app member</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <p className="text-slate-500">
              No eligible org members need a direct app grant.
            </p>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" type="button" onClick={onClose}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

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
              aria-label="Close"
              className="absolute top-3 right-3 text-slate-400 hover:text-slate-700"
            />
          }
        >
          ×
        </DialogClose>
        <DialogHeader>
          <DialogTitle>Add direct app member</DialogTitle>
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
            <div>
              <label className="label">Principal</label>
              <Select
                items={{
                  "": "— select —",
                  ...Object.fromEntries(
                    candidates.map((m) => [
                      m.account_id,
                      `${m.display_name} (${m.username ?? m.provider_subject.slice(0, 8)})`,
                    ]),
                  ),
                }}
                value={selectedAccount}
                onValueChange={(v) => setSelectedAccount(v as string)}
              >
                <SelectTrigger autoFocus>
                  <SelectValue />
                  <SelectIcon />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">— select —</SelectItem>
                  {candidates.map((m) => (
                    <SelectItem key={m.account_id} value={m.account_id}>
                      {m.display_name} ({m.username ?? m.provider_subject.slice(0, 8)})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="label">Role</label>
              <Select
                items={{ admin: "admin", publisher: "publisher", viewer: "viewer" }}
                value={role}
                onValueChange={(v) => setRole(v as AppMember["app_role"])}
              >
                <SelectTrigger>
                  <SelectValue />
                  <SelectIcon />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">admin</SelectItem>
                  <SelectItem value="publisher">publisher</SelectItem>
                  <SelectItem value="viewer">viewer</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <p className="text-xs text-slate-500">
              Direct app members are for org members who need app-scoped access.
              Owners and org admins already inherit app administration.
            </p>
          </form>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="add-app-member-form"
            variant="primary"
            disabled={!selectedAccount || add.isPending}
          >
            {add.isPending ? "Adding…" : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
        title: `Invite link created for ${email}`,
        description: `Copied URL: ${data.invite_url.slice(0, 60)}…`,
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
    <div className="card p-4! text-sm">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-base font-semibold">Create app invite link</h3>
        {!showForm && (
          <Button
            variant="outline"
            className="text-xs"
            onClick={() => setShowForm(true)}
          >
            + Link
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
              items={{ publisher: "publisher", viewer: "viewer" }}
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
                <SelectItem value="publisher">publisher</SelectItem>
                <SelectItem value="viewer">viewer</SelectItem>
              </SelectContent>
            </Select>
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
            with the role you pick. The URL is copied to clipboard after creation.
          </p>
          <div className="flex gap-2">
            <Button
              type="submit"
              variant="primary"
              className="text-xs"
              disabled={invite.isPending || !email.trim()}
            >
              {invite.isPending ? "Creating…" : "Create invite link"}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="text-xs"
              onClick={() => setShowForm(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <p className="text-xs text-slate-500">
          Create an invite link to grant app access, then share the copied URL
          manually. The invitee is added to the org as a viewer automatically
          when they accept; the picked role controls what they can do on this app.
        </p>
      )}
    </div>
  );
}
