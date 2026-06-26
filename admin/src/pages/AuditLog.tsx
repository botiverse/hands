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
  return (
    <div className="card">
      <div className="flex items-center justify-between mb-2">
        <span className="badge-blue">{entry.action}</span>
        <span className="text-xs text-slate-500">
          {new Date(entry.created_at).toLocaleString()} · {entry.actor}
        </span>
      </div>
      <pre className="text-xs bg-slate-50 p-2 rounded overflow-x-auto">
        {JSON.stringify(payload, null, 2)}
      </pre>
    </div>
  );
}