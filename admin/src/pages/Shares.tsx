/**
 * App-level share management (task #65 P1).
 *
 * Lists every share link for the app across releases with stats, lets
 * admins create (with optional password), renew, and revoke them. The
 * share URL is only visible at creation time — tokens are stored hashed.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Input, Select, SelectTrigger, SelectValue, SelectIcon, SelectContent, SelectItem, Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter, EmptyState, EmptyStateTitle, EmptyStateDescription, Skeleton } from "raft-ui";
import {
  AppShare,
  createReleaseShare,
  listAppShares,
  listReleases,
  renewReleaseShare,
  revokeReleaseShare,
} from "../lib/api";
import { useToast } from "../components/Toast";

const WEEK_SECONDS = 7 * 24 * 60 * 60;

export function AppShares({ appId }: { appId: string }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);

  const shares = useQuery({
    queryKey: ["app-shares", appId],
    queryFn: () => listAppShares(appId),
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["app-shares", appId] });

  const renew = useMutation({
    mutationFn: (share: AppShare) =>
      renewReleaseShare(appId, share.release_id, share.id, {
        ttl_seconds: WEEK_SECONDS,
      }),
    onSuccess: () => {
      toast.show({ kind: "success", title: "Share extended by 7 days" });
      invalidate();
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: "Renew failed",
        description: (e as Error).message,
      }),
  });

  const setPassword = useMutation({
    mutationFn: ({ share, password }: { share: AppShare; password: string | null }) =>
      renewReleaseShare(appId, share.release_id, share.id, {
        // PATCH requires an expiry; keep the current one.
        expires_at: share.expires_at,
        password,
      }),
    onSuccess: (_data, vars) => {
      toast.show({
        kind: "success",
        title: vars.password ? "Password set" : "Password removed",
      });
      invalidate();
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: "Password update failed",
        description: (e as Error).message,
      }),
  });

  const revoke = useMutation({
    mutationFn: (share: AppShare) =>
      revokeReleaseShare(appId, share.release_id, share.id),
    onSuccess: () => {
      toast.show({ kind: "success", title: "Share revoked" });
      invalidate();
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: "Revoke failed",
        description: (e as Error).message,
      }),
  });

  const rows = shares.data?.shares ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold">Shares</h2>
          <p className="text-sm text-slate-500">
            Public download pages for this app's releases. URLs are shown only
            once at creation — tokens are stored hashed.
          </p>
        </div>
        <Button variant="primary" className="text-sm" onClick={() => setShowCreate(true)}>
          New share
        </Button>
      </div>

      {createdUrl && (
        <div className="card flex items-center gap-3 text-sm">
          <span className="font-mono break-all flex-1">{createdUrl}</span>
          <Button
            variant="outline"
            className="text-xs"
            onClick={() => {
              navigator.clipboard?.writeText(createdUrl);
              toast.show({ kind: "success", title: "Copied share URL" });
            }}
          >
            Copy
          </Button>
          <Button variant="outline" className="text-xs" onClick={() => setCreatedUrl(null)}>
            Dismiss
          </Button>
        </div>
      )}

      <div className="card overflow-x-auto">
        {shares.isLoading && (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        )}
        {shares.error && (
          <p className="text-sm text-red-600">
            Failed to load shares: {(shares.error as Error).message}
          </p>
        )}
        {!shares.isLoading && rows.length === 0 && (
          <EmptyState>
            <EmptyStateTitle>No shares yet.</EmptyStateTitle>
            <EmptyStateDescription>
              Create one here, from the CLI (<code>hands releases share</code>),
              or from the release workflow.
            </EmptyStateDescription>
          </EmptyState>
        )}
        {rows.length > 0 && (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                <th className="py-2 pr-3">Release</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2 pr-3">Created</th>
                <th className="py-2 pr-3">Expires</th>
                <th className="py-2 pr-3">Views</th>
                <th className="py-2 pr-3">Downloads</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((share) => (
                <ShareRow
                  key={share.id}
                  share={share}
                  onRenew={() => renew.mutate(share)}
                  onRevoke={() => revoke.mutate(share)}
                  onSetPassword={() => {
                    const next = window.prompt(
                      share.has_password
                        ? "New password (leave empty to remove the password):"
                        : "Password for this share:",
                    );
                    if (next === null) return;
                    setPassword.mutate({
                      share,
                      password: next.trim() ? next.trim() : null,
                    });
                  }}
                  busy={renew.isPending || revoke.isPending || setPassword.isPending}
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
    </div>
  );
}

function shareState(share: AppShare): { label: string; className: string } {
  if (share.revoked_at) return { label: "revoked", className: "bg-slate-200 text-slate-600" };
  if (share.expires_at <= Date.now()) return { label: "expired", className: "bg-amber-100 text-amber-800" };
  return { label: "active", className: "bg-emerald-100 text-emerald-800" };
}

function ShareRow({
  share,
  onRenew,
  onRevoke,
  onSetPassword,
  busy,
}: {
  share: AppShare;
  onRenew: () => void;
  onRevoke: () => void;
  onSetPassword: () => void;
  busy: boolean;
}) {
  const state = shareState(share);
  const actionable = !share.revoked_at;
  return (
    <tr className="border-b border-slate-100 last:border-0">
      <td className="py-2 pr-3">
        <span className="font-medium">
          {share.version_name} ({share.version_code})
        </span>
        <span className="ml-2 text-xs text-slate-500">{share.channel_slug}</span>
        <div className="text-xs text-slate-400">by {share.created_by}</div>
      </td>
      <td className="py-2 pr-3">
        <span className={`rounded-sm px-1.5 py-0.5 text-xs font-medium ${state.className}`}>
          {state.label}
        </span>
        {Boolean(share.has_password) && (
          <span className="ml-1 rounded-sm bg-sky-100 px-1.5 py-0.5 text-xs font-medium text-sky-800">
            password
          </span>
        )}
      </td>
      <td className="py-2 pr-3 text-xs text-slate-600">
        {new Date(share.created_at).toLocaleString()}
      </td>
      <td className="py-2 pr-3 text-xs text-slate-600">
        {new Date(share.expires_at).toLocaleString()}
      </td>
      <td className="py-2 pr-3">
        {share.view_count}
        <span className="text-xs text-slate-400"> ({share.unique_view_count} uniq)</span>
      </td>
      <td className="py-2 pr-3">
        {share.download_count}
        <span className="text-xs text-slate-400"> ({share.unique_download_count} uniq)</span>
      </td>
      <td className="py-2 text-right text-xs whitespace-nowrap">
        {actionable && (
          <>
            <Button variant="link" size="sm" className="mr-2" onClick={onRenew} disabled={busy}>
              +7 days
            </Button>
            <Button variant="link" size="sm" className="mr-2" onClick={onSetPassword} disabled={busy}>
              {share.has_password ? "Password…" : "Set password"}
            </Button>
            <Button variant="link" size="sm" className="text-red-600" onClick={onRevoke} disabled={busy}>
              Revoke
            </Button>
          </>
        )}
      </td>
    </tr>
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
  const toast = useToast();
  const [releaseId, setReleaseId] = useState("");
  const [password, setPassword] = useState("");
  const [ttlDays, setTtlDays] = useState(7);

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
      createReleaseShare(appId, releaseId, {
        ttl_seconds: ttlDays * 24 * 60 * 60,
        ...(password.trim() ? { password: password.trim() } : {}),
      }),
    onSuccess: (data) => {
      toast.show({
        kind: "success",
        title: data.has_password ? "Password-protected share created" : "Share created",
      });
      onCreated(data.share_url);
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: "Create share failed",
        description: (e as Error).message,
      }),
  });

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New share link</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <label className="block text-xs text-slate-600">
            Release
            <Select
              items={{
                "": "Select a release…",
                ...Object.fromEntries(
                  options.map((r: any) => [r.id, `${r.version_name ?? r.id.slice(0, 8)} · ${r.status}`]),
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
                <SelectItem value="">Select a release…</SelectItem>
                {options.map((r: any) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.version_name ?? r.id.slice(0, 8)} · {r.status}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="block text-xs text-slate-600">
            Lifetime (days)
            <Input
              type="number"
              min={1}
              max={30}
              value={ttlDays}
              onChange={(e) => setTtlDays(Math.min(30, Math.max(1, Number(e.target.value) || 7)))}
              className="mt-1 py-1.5!"
            />
          </label>
          <label className="block text-xs text-slate-600">
            Password (optional)
            <Input
              type="text"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Leave empty for a public link"
              className="mt-1 py-1.5!"
            />
          </label>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" className="text-sm" onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            className="text-sm"
            onClick={() => create.mutate()}
            disabled={create.isPending || !releaseId}
          >
            {create.isPending ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
