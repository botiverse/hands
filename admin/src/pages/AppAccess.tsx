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
    <section aria-labelledby="app-access-heading" className="space-y-4">
      <header className="space-y-2">
        <h2 id="app-access-heading" className="text-lg font-semibold">{appAccessMessage("title")}</h2>
        <p className="text-sm text-foreground">{appAccessMessage("description")}</p>
        <div className="text-xs text-foreground-muted">
          Your current access: <span className="font-mono">{currentAccess ?? "—"}</span>{" "}
          {isOwningOrg && <span>(inherited from owning org)</span>}
          {!isOwningOrg && currentServerGrantRole && (
            <span>(server visibility)</span>
          )}
          {!isOwningOrg && currentAppRole && <span>(direct app member)</span>}{" "}
          {canManage ? "(can manage access)" : "(read-only)"}
        </div>
      </header>
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
        <p className="text-danger">Failed: {(grants.error as Error).message}</p>
      )}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-foreground-strong">Server access</h3>
        <div className="flex items-center gap-2">
          <span className="text-xs text-foreground-muted whitespace-nowrap">
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
            <tr className="text-foreground-muted text-left border-b border-line-hairline">
              <th className="font-normal py-1 pr-2">Server</th>
              <th className="font-normal py-1 pr-2">Access</th>
              <th className="font-normal py-1 pr-2">Source</th>
              {canManage && <th className="font-normal py-1">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {isOwningOrg && (
              <tr className="border-b border-line-hairline bg-layer-canvas-muted/60">
                <td className="py-2 pr-2">
                  <div className="font-medium">
                    {currentServerSlug || app?.org_id || "Current server"}
                    <span className="ml-1 text-xs text-foreground-muted">(current)</span>
                  </div>
                </td>
                <td className="py-2 pr-2">
                  <span className="text-xs font-medium">Owner server</span>
                </td>
                <td className="py-2 pr-2 text-xs text-foreground-muted">
                  Owning org
                </td>
                {canManage && (
                  <td className="py-2 text-xs text-foreground-hint">Inherited</td>
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
                      <span className="ml-1 text-xs text-foreground-muted">(current)</span>
                    )}
                  </div>
                </td>
                <td className="py-2 pr-2">
                  <span className="text-xs font-medium">
                    {grant.access_model === "owner_server"
                      ? "Owner server"
                      : `Legacy ${grant.app_role}`}
                  </span>
                </td>
                <td className="py-2 pr-2 text-xs text-foreground-muted">
                  {grant.access_model === "owner_server"
                    ? "Additional owner"
                    : "Existing role preserved; remove and re-add to adopt owner-server access"}
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
        <p className="text-xs text-foreground-muted mt-2">
          No additional owner servers yet. The current server owns this app.
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
              className="absolute top-3 right-3 text-foreground-hint hover:text-foreground-strong"
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
              if (!confirm(
                `Make ${serverSlug.trim() || serverId.trim()} an owner server for this app? Its members receive the same role-based access as the creating server.`,
              )) {
                return;
              }
              add.mutate();
            }}
          >
            <div>
              <Label>Server slug</Label>
              <Input
                value={serverSlug}
                onChange={(e) => setServerSlug(e.target.value)}
                placeholder="server slug"
                autoFocus
              />
            </div>
            <div>
              <Label>Server ID</Label>
              <Input
                value={serverId}
                onChange={(e) => setServerId(e.target.value)}
                placeholder="optional"
              />
            </div>
            <p className="text-xs text-foreground-muted">
              An additional owner server uses the same role mapping as the server that created the app:
              server owners/admins can publish releases and manage access; members keep the same
              bounded member actions as on the creating server; viewers have read-only access.
            </p>
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
    <section className="border-t border-line-hairline pt-5">
      {members.isLoading && (
        <div className="space-y-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      )}
      {members.error && (
        <p className="text-danger">Failed: {(members.error as Error).message}</p>
      )}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-foreground-strong">Direct app members</h3>
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
              <SelectList>
              <SelectItem value="all">All types</SelectItem>
              <SelectItem value="human">Humans only</SelectItem>
              <SelectItem value="agent">Agents only</SelectItem>
            </SelectList>
            </SelectContent>
          </Select>
          <span className="text-xs text-foreground-muted whitespace-nowrap">
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
            <tr className="text-foreground-muted text-left border-b border-line-hairline">
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
                className="border-b border-line-hairline hover:bg-fill-muted"
              >
                <td className="py-2 pr-2">
                  <div className="font-medium">
                    {m.display_name}
                    {m.account_id === currentAccountId && (
                      <span className="ml-1 text-xs text-foreground-muted">(you)</span>
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
                    <Badge variant="accent">agent</Badge>
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
                        <SelectList>
                        {(["admin", "publisher", "viewer"] as const).map((r) => (
                          <SelectItem key={r} value={r}>
                            {r}
                          </SelectItem>
                        ))}
                      </SelectList>
                      </SelectContent>
                    </Select>
                  ) : (
                    <span className="text-xs font-medium">{m.app_role}</span>
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
    <section className="border-t border-line-hairline pt-5">
      {tokens.isLoading && (
        <div className="space-y-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      )}
      {tokens.error && (
        <p className="text-danger">Failed: {(tokens.error as Error).message}</p>
      )}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-foreground-strong">Deploy tokens</h3>
        <div className="flex items-center gap-2">
          <span className="text-xs text-foreground-muted whitespace-nowrap">
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
            <tr className="text-foreground-muted text-left border-b border-line-hairline">
              <th className="font-normal py-1 pr-2">Name</th>
              <th className="font-normal py-1 pr-2">Prefix</th>
              <th className="font-normal py-1 pr-2">Grant</th>
              <th className="font-normal py-1 pr-2">Expires</th>
              <th className="font-normal py-1 pr-2">Last used</th>
              <th className="font-normal py-1">Actions</th>
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
                    by {token.created_by_actor}
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
                        {display.roleLabel}
                      </span>
                      {!display.valid && (
                        <span className="rounded bg-danger-soft px-1.5 py-0.5 font-medium text-danger">
                          Invalid grant
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
                          {label}{extra ? " · Extra" : ""}
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
                    : "Never"}
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
              );
            })}
          </tbody>
        </table>
      )}
      <p className="text-xs text-foreground-muted mt-2">
        Tokens are app-scoped bearer credentials for CI. The raw token is only
        shown once after creation.
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
              className="absolute top-3 right-3 text-foreground-hint hover:text-foreground-strong"
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
              <p className="text-sm text-foreground">
                Copy this token now. It will not be shown again.
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
                  <Label>Name</Label>
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="github-actions-main"
                    autoFocus
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>Role bundle</Label>
                    <Select
                      items={{ publisher: "publisher", viewer: "viewer", none: "No role" }}
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
                        <SelectItem value="publisher">publisher</SelectItem>
                        <SelectItem value="viewer">viewer</SelectItem>
                        <SelectItem value="none">No role (custom only)</SelectItem>
                      </SelectList>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>Expires</Label>
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
                        <SelectList>
                        <SelectItem value="30d">30 days</SelectItem>
                        <SelectItem value="90d">90 days</SelectItem>
                        <SelectItem value="365d">1 year</SelectItem>
                        <SelectItem value="never">Never</SelectItem>
                      </SelectList>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="space-y-2 rounded-md border border-line-muted p-3">
                  <div className="text-xs font-medium text-foreground-strong">Additional permissions</div>
                  {permissionModel.isPending && (
                    <p className="text-xs text-foreground-muted">Loading permission registry…</p>
                  )}
                  {permissionModel.isError && (
                    <p className="text-xs text-danger">
                      Permission registry could not be loaded. Try again before creating a token.
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
                      <span>{permission.description}</span>
                      <code className="text-xs text-foreground-hint">{permission.permission}</code>
                      {grantPreview.bundled.includes(permission.permission) && (
                        <span className="text-xs text-foreground-hint">Included by role</span>
                      )}
                    </label>
                  ))}
                </div>
                <div className="space-y-2 rounded-md bg-layer-canvas-muted p-3">
                  <div className="text-xs font-medium text-foreground-strong">Effective permissions</div>
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
                          {definition?.label ?? permission}{extra ? " · Extra" : ""}
                        </span>
                      );
                    })}
                  </div>
                </div>
                <p className="text-xs text-foreground-muted">
                  The role expands to its permission bundle. Additional permissions
                  are unioned into the token's effective permissions.
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
                disabled={
                  !name.trim()
                  || (role === "none" && scopes.length === 0)
                  || permissionModel.isPending
                  || permissionModel.isError
                  || create.isPending
                }
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
      toast.show({ kind: "success", title: "App member added" });
      qc.invalidateQueries({ queryKey: ["app-members", appId] });
      setSelectedAccount("");
      setAccountId("");
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
              className="absolute top-3 right-3 text-foreground-hint hover:text-foreground-strong"
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
            {candidates.length > 0 ? (
              <div>
                <Label>Choose someone from this organization</Label>
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
                    <SelectItem value="">— select —</SelectItem>
                    {candidates.map((m) => (
                      <SelectItem key={m.account_id} value={m.account_id}>
                        {m.display_name} ({m.username ?? m.provider_subject.slice(0, 8)})
                      </SelectItem>
                    ))}
                  </SelectList>
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <p className="text-xs text-foreground-muted">
                Everyone in this organization already has access or is already listed as a
                direct app member.
              </p>
            )}
            <div className="border-t border-line-muted pt-3">
              <Label>Add one account from another Raft server</Label>
              <Input
                value={accountId}
                onChange={(e) => {
                  setAccountId(e.target.value);
                  if (e.target.value.trim()) setSelectedAccount("");
                }}
                placeholder="Paste their Hands account ID"
                autoFocus={candidates.length === 0}
                spellCheck={false}
                className="font-mono"
              />
              <p className="mt-1 text-xs text-foreground-muted">
                Ask that person or Agent to open Hands once, or run the Hands Raft integration
                <span className="font-mono"> whoami</span> action, then send you the returned
                account ID. Cross-server accounts are not listed here because servers are an
                identity-isolation boundary.
              </p>
            </div>
            <div>
              <Label>Role</Label>
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
                  <SelectList>
                  <SelectItem value="admin">admin</SelectItem>
                  <SelectItem value="publisher">publisher</SelectItem>
                  <SelectItem value="viewer">viewer</SelectItem>
                </SelectList>
                </SelectContent>
              </Select>
            </div>
            <p className="text-xs text-foreground-muted">
              Direct app members receive access only to this app. Owners and org admins already
              inherit app administration.
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
            disabled={!targetAccountId || add.isPending}
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
    <section className="border-t border-line-hairline pt-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-foreground-strong">Create app invite link</h3>
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
                <SelectList>
                <SelectItem value="publisher">publisher</SelectItem>
                <SelectItem value="viewer">viewer</SelectItem>
              </SelectList>
              </SelectContent>
            </Select>
          </div>
          <Textarea
            className="text-xs min-h-[40px]"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Optional message"
          />
          <p className="text-xs text-foreground-muted">
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
        <p className="text-xs text-foreground-muted">
          Create an invite link to grant app access, then share the copied URL
          manually. The invitee is added to the org as a viewer automatically
          when they accept; the picked role controls what they can do on this app.
        </p>
      )}
    </section>
  );
}
