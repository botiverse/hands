import { useQuery } from "@tanstack/react-query";
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
      <pre className="text-xs bg-slate-50 p-2 rounded overflow-x-auto">
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
      {avatarUrl ? (
        <img
          src={avatarUrl}
          alt=""
          className="w-5 h-5 rounded-full object-cover"
        />
      ) : (
        <span
          className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
            isAgent
              ? "bg-purple-200 text-purple-800"
              : isSystem
                ? "bg-slate-200 text-slate-600"
                : "bg-blue-200 text-blue-800"
          }`}
        >
          {displayName.slice(0, 1).toUpperCase()}
        </span>
      )}
      <span className="text-sm font-medium">{displayName}</span>
      {isAgent && <span className="badge-purple text-[10px]">agent</span>}
      {isSystem && <span className="badge-gray text-[10px]">system</span>}
      {username && (
        <span className="text-xs text-slate-500">@{username}</span>
      )}
    </span>
  );
}