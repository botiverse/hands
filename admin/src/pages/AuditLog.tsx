import { useQuery } from "@tanstack/react-query";
import { Avatar, AvatarImage, AvatarFallback, Badge } from "raft-ui";
import { listAuditLogs, type AuditLogEntry } from "../lib/api";
import { collidingPrincipalLabels, needsServerBadge } from "../lib/principalIdentity";

export function AuditLog({ appId }: { appId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["audit", appId],
    queryFn: () => listAuditLogs(appId),
  });
  // Audit rows are individual entries, not a member directory, so the badge
  // rule is applied over the entries actually loaded: if the same actor name
  // appears from two different servers in this view, both get the badge.
  // Computed once for the collection — never per row (see principalIdentity).
  const collidingLabels = collidingPrincipalLabels(
    (data?.logs ?? []).map((entry) => ({
      account_id: entry.actor_id ?? undefined,
      display_name: entry.actor_display_name ?? null,
      username: entry.actor_username ?? null,
      server_slug: entry.actor_server_slug ?? null,
    })),
  );

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Audit log</h1>
      {isLoading && <p className="text-foreground-muted">Loading...</p>}
      {error && (
        <p className="text-danger">Failed: {(error as Error).message}</p>
      )}
      {data && data.logs.length === 0 && (
        <p className="text-foreground-muted text-sm">No audit log entries yet.</p>
      )}
      <div className="space-y-6">
        {data?.logs.map((entry) => (
          <AuditEntry key={entry.id} entry={entry} collidingLabels={collidingLabels} />
        ))}
      </div>
    </div>
  );
}

function AuditEntry({
  entry,
  collidingLabels,
}: {
  entry: AuditLogEntry;
  collidingLabels: ReadonlySet<string>;
}) {
  let payload: any = {};
  try {
    payload = JSON.parse(entry.payload);
  } catch {
    payload = { raw: entry.payload };
  }
  const actorName =
    entry.actor_display_name ||
    (entry.actor_username ? `@${entry.actor_username}` : null) ||
    entry.actor;
  return (
    <section className="border-t border-line-hairline pt-5">
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          <Badge variant="information">{entry.action}</Badge>
          <ActorBadge
            displayName={actorName}
            username={entry.actor_username}
            actorType={entry.actor_type}
            avatarUrl={entry.actor_avatar_url}
            serverSlug={
              needsServerBadge(
                {
                  account_id: entry.actor_id ?? undefined,
                  display_name: entry.actor_display_name ?? null,
                  username: entry.actor_username ?? null,
                  server_slug: entry.actor_server_slug ?? null,
                },
                collidingLabels,
              )
                ? (entry.actor_server_slug ?? null)
                : null
            }
          />
        </div>
        <span className="text-xs text-foreground-muted">
          {new Date(entry.created_at).toLocaleString()}
        </span>
      </div>
      <pre className="text-xs bg-layer-canvas-muted p-2 rounded-sm overflow-x-auto max-w-full whitespace-pre">
        {JSON.stringify(payload, null, 2)}
      </pre>
    </section>
  );
}

function ActorBadge({
  displayName,
  username,
  actorType,
  avatarUrl,
  serverSlug,
}: {
  displayName: string;
  username?: string | null | undefined;
  actorType?: "human" | "agent" | "system" | null | undefined;
  avatarUrl?: string | null | undefined;
  /** Only set when this actor name collides with another server. */
  serverSlug?: string | null | undefined;
}) {
  const isAgent = actorType === "agent";
  const isSystem = actorType === "system";
  return (
    <span className="inline-flex items-center gap-1.5 flex-wrap min-w-0">
      <Avatar size="xs" type={isAgent ? "agent" : "human"}>
        {avatarUrl ? <AvatarImage src={avatarUrl} alt="" /> : null}
        <AvatarFallback>{displayName.slice(0, 1).toUpperCase()}</AvatarFallback>
      </Avatar>
      <span className="text-sm font-medium min-w-0 break-words">{displayName}</span>
      {serverSlug && <Badge variant="muted">{serverSlug}</Badge>}
      {isAgent && <Badge variant="accent">agent</Badge>}
      {isSystem && <Badge variant="muted">system</Badge>}
      {username && (
        <span className="text-xs text-foreground-muted">@{username}</span>
      )}
    </span>
  );
}