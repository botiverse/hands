import { useQuery } from "@tanstack/react-query";
import { Avatar, AvatarImage, AvatarFallback, Badge, Card } from "raft-ui";
import { listAuditLogs, type AuditLogEntry } from "../lib/api";

export function AuditLog({ appId }: { appId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["audit", appId],
    queryFn: () => listAuditLogs(appId),
  });

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
      <div className="space-y-2">
        {data?.logs.map((entry) => (
          <AuditEntry key={entry.id} entry={entry} />
        ))}
      </div>
    </div>
  );
}

function AuditEntry({ entry }: { entry: AuditLogEntry }) {
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
    <Card>
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          <Badge variant="information">{entry.action}</Badge>
          <ActorBadge
            displayName={actorName}
            username={entry.actor_username}
            actorType={entry.actor_type}
            avatarUrl={entry.actor_avatar_url}
          />
        </div>
        <span className="text-xs text-foreground-muted">
          {new Date(entry.created_at).toLocaleString()}
        </span>
      </div>
      <pre className="text-xs bg-layer-canvas-muted p-2 rounded-sm overflow-x-auto max-w-full whitespace-pre">
        {JSON.stringify(payload, null, 2)}
      </pre>
    </Card>
  );
}

function ActorBadge({
  displayName,
  username,
  actorType,
  avatarUrl,
}: {
  displayName: string;
  username?: string | null | undefined;
  actorType?: "human" | "agent" | "system" | null | undefined;
  avatarUrl?: string | null | undefined;
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
      {isAgent && <Badge variant="accent">agent</Badge>}
      {isSystem && <Badge variant="muted">system</Badge>}
      {username && (
        <span className="text-xs text-foreground-muted">@{username}</span>
      )}
    </span>
  );
}