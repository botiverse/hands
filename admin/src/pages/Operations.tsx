import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  listOperations,
  retryOperation,
  deleteOperation,
  streamOperations,
  type Operation,
} from "../lib/api";
import { useToast } from "../components/Toast";

const STATUS_COLORS: Record<Operation["status"], string> = {
  pending: "badge-gray",
  in_progress: "badge-blue",
  success: "badge-green",
  failed: "bg-red-100 text-red-800",
  cancelled: "badge-gray",
};

export function Operations({ appId }: { appId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading, error } = useQuery({
    queryKey: ["operations", appId],
    queryFn: () => listOperations(appId, 50),
    refetchInterval: 5000, // polling fallback in case SSE doesn't connect
  });
  const [live, setLive] = useState<Set<string>>(new Set());

  // SSE stream — when new ops come in, invalidate the cache so they show.
  useEffect(() => {
    const es = streamOperations(
      appId,
      (op) => {
        setLive((prev) => new Set([...prev, op.id]));
        qc.invalidateQueries({ queryKey: ["operations", appId] });
      },
      () => {
        // ignore — polling fallback will keep us synced
      },
    );
    return () => es.close();
  }, [appId, qc]);

  const retry = useMutation({
    mutationFn: (opId: string) => retryOperation(appId, opId),
    onMutate: (opId) =>
      toast.show({ kind: "loading", title: "Retrying operation…", ttlMs: 0 }),
    onSuccess: (op) => {
      toast.show({
        kind: "success",
        title: `Retry queued (attempt #${op.retry_count + 1})`,
      });
      qc.invalidateQueries({ queryKey: ["operations", appId] });
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: "Retry failed",
        description: (e as Error).message,
      }),
  });

  const remove = useMutation({
    mutationFn: (opId: string) => deleteOperation(appId, opId),
    onSuccess: () => {
      toast.show({ kind: "success", title: "Operation log removed" });
      qc.invalidateQueries({ queryKey: ["operations", appId] });
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: "Delete failed",
        description: (e as Error).message,
      }),
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold">Operations</h2>
        <span className="text-xs text-slate-500">
          {live.size > 0 ? "live (SSE)" : "polling (5s)"} · {data?.operations.length ?? 0} recent
        </span>
      </div>

      {isLoading && <p className="text-slate-500 text-sm">Loading…</p>}
      {error && (
        <p className="text-red-600 text-sm">Failed: {(error as Error).message}</p>
      )}

      <div className="space-y-2">
        {data?.operations.length === 0 && (
          <p className="text-slate-500 text-sm">No operations yet. Upload an APK to start.</p>
        )}
        {data?.operations.map((op) => (
          <OperationRow
            key={op.id}
            op={op}
            isLive={live.has(op.id)}
            onRetry={() => retry.mutate(op.id)}
            onDelete={() => remove.mutate(op.id)}
            busy={retry.isPending || remove.isPending}
          />
        ))}
      </div>
    </div>
  );
}

function OperationRow({
  op,
  isLive,
  onRetry,
  onDelete,
  busy,
}: {
  op: Operation;
  isLive: boolean;
  onRetry: () => void;
  onDelete: () => void;
  busy: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  let inputPayload: any = {};
  let outputPayload: any = {};
  try {
    inputPayload = JSON.parse(op.input);
  } catch {
    // ignore
  }
  try {
    outputPayload = JSON.parse(op.output);
  } catch {
    // ignore
  }

  return (
    <div
      className={`card !p-3 ${isLive ? "ring-2 ring-blue-200" : ""}`}
    >
      <div className="flex items-center gap-3">
        <span className={`${STATUS_COLORS[op.status]} font-medium text-xs`}>
          {op.status}
        </span>
        <span className="font-mono text-sm">{op.kind}</span>
        <span className="text-xs text-slate-500">
          {timeAgo(op.created_at)}
        </span>
        {op.retry_count > 0 && (
          <span className="text-xs text-slate-400">retry #{op.retry_count + 1}</span>
        )}
        <div className="flex-1" />
        {op.status === "failed" && (
          <button
            onClick={onRetry}
            disabled={busy}
            className="btn-secondary text-xs"
          >
            Retry
          </button>
        )}
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-slate-400 hover:text-slate-700 w-7 h-7 flex items-center justify-center rounded"
          aria-label={expanded ? "Collapse" : "Expand"}
        >
          {expanded ? "▲" : "▼"}
        </button>
        <button
          onClick={onDelete}
          disabled={busy}
          className="text-slate-400 hover:text-red-600 w-7 h-7 flex items-center justify-center rounded"
          aria-label="Delete"
        >
          ×
        </button>
      </div>

      {op.status === "in_progress" && (
        <div className="mt-2 h-1 bg-slate-100 rounded overflow-hidden">
          <div
            className="h-full bg-blue-500 transition-all"
            style={{ width: `${Math.round(op.progress * 100)}%` }}
          />
        </div>
      )}

      {op.error && (
        <div className="mt-2 text-xs text-red-700 bg-red-50 p-2 rounded">
          {op.error}
        </div>
      )}

      {expanded && (
        <div className="mt-3 space-y-2 text-xs">
          <details>
            <summary className="cursor-pointer text-slate-600 font-medium">
              Input
            </summary>
            <pre className="mt-1 bg-slate-50 p-2 rounded overflow-x-auto">
              {JSON.stringify(inputPayload, null, 2)}
            </pre>
          </details>
          {op.output !== "{}" && (
            <details>
              <summary className="cursor-pointer text-slate-600 font-medium">
                Output
              </summary>
              <pre className="mt-1 bg-slate-50 p-2 rounded overflow-x-auto">
                {JSON.stringify(outputPayload, null, 2)}
              </pre>
            </details>
          )}
          <div className="text-slate-400 font-mono">id: {op.id}</div>
        </div>
      )}
    </div>
  );
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}