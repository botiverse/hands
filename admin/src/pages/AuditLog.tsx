import { useQuery } from "@tanstack/react-query";
import { Avatar, AvatarImage, AvatarFallback } from "raft-ui";
import { listAuditLogs, type AuditLogEntry } from "../lib/api";

export function AuditLog({ appId }: { appId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["audit", appId],
    queryFn: () => listAuditLogs(appId),
  });

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Audit log</h1>
      {isLoading && <p className="text-slate-500">Loading...</p>}
      {error && (
        <p className="text-red-600">Failed: {(error as Error).message}</p>
      )}
      {data && data.logs.length === 0 && (
        <p className="text-slate-500 text-sm">No audit log entries yet.</p>
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
    <div className="card">
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <span className="badge-blue">{entry.action}</span>
          <ActorBadge
            displayName={actorName}
            username={entry.actor_username}
            actorType={entry.actor_type}
            avatarUrl={entry.actor_avatar_url}
          />
        </div>
        <span className="text-xs text-slate-500">
          {new Date(entry.created_at).toLocaleString()}
        </span>
      </div>
      <pre className="text-xs bg-slate-50 p-2 rounded-sm overflow-x-auto">
        {JSON.stringify(payload, null, 2)}
      </pre>
    </div>
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
    <span className="inline-flex items-center gap-1.5">
      <Avatar size="xs" type={isAgent ? "agent" : "human"}>
        {avatarUrl ? <AvatarImage src={avatarUrl} alt="" /> : null}
        <AvatarFallback>{displayName.slice(0, 1).toUpperCase()}</AvatarFallback>
      </Avatar>
      <span className="text-sm font-medium">{displayName}</span>
      {isAgent && <span className="badge-purple text-[10px]">agent</span>}
      {isSystem && <span className="badge-gray text-[10px]">system</span>}
      {username && (
        <span className="text-xs text-slate-500">@{username}</span>
      )}
    </span>
  );
}