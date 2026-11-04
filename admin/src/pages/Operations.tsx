import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  listOperations,
  retryOperation,
  deleteOperation,
  streamOperations,
  type Operation,
} from "../lib/api";
import { useToast } from "../components/Toast";
import { Badge, Button, Progress, ProgressTrack, ProgressIndicator } from "raft-ui";
import { useLocale, useText } from "../lib/locale";

const STATUS_VARIANTS: Record<Operation["status"], "muted" | "information" | "success" | "danger"> = {
  pending: "muted",
  in_progress: "information",
  success: "success",
  failed: "danger",
  cancelled: "muted",
};
const STATUS_ZH: Record<Operation["status"], string> = { pending: "等待中", in_progress: "进行中", success: "成功", failed: "失败", cancelled: "已取消" };

export function Operations({ appId }: { appId: string }) {
  const t = useText();
  const qc = useQueryClient();
  const toast = useToast();
  const retryToastRef = useRef<string | null>(null);
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
    onMutate: () => {
      retryToastRef.current = toast.show({
        kind: "loading",
        title: t("Retrying operation...", "正在重试操作…"),
        ttlMs: 0,
      });
    },
    onSuccess: (op) => {
      const patch = {
        kind: "success",
        title: t(`Retry queued (attempt #${op.retry_count + 1})`, `已加入重试队列（第 ${op.retry_count + 1} 次尝试）`),
      } as const;
      if (retryToastRef.current !== null) toast.update(retryToastRef.current, patch);
      else toast.show(patch);
      retryToastRef.current = null;
      qc.invalidateQueries({ queryKey: ["operations", appId] });
    },
    onError: (e) => {
      const patch = {
        kind: "error",
        title: t("Retry failed", "重试失败"),
        description: (e as Error).message,
      } as const;
      if (retryToastRef.current !== null) toast.update(retryToastRef.current, patch);
      else toast.show(patch);
      retryToastRef.current = null;
    },
  });

  const remove = useMutation({
    mutationFn: (opId: string) => deleteOperation(appId, opId),
    onSuccess: () => {
      toast.show({ kind: "success", title: t("Operation log removed", "操作日志已删除") });
      qc.invalidateQueries({ queryKey: ["operations", appId] });
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: t("Delete failed", "删除失败"),
        description: (e as Error).message,
      }),
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold">{t("Operations", "操作记录")}</h2>
        <span className="text-xs text-foreground-muted">
          {live.size > 0 ? t("live (SSE)", "实时更新（SSE）") : t("polling (5s)", "轮询（5 秒）")} · {t(`${data?.operations.length ?? 0} recent`, `最近 ${data?.operations.length ?? 0} 条`)}
        </span>
      </div>

      {isLoading && <p className="text-foreground-muted text-sm">{t("Loading…", "加载中…")}</p>}
      {error && (
        <p className="text-danger text-sm">{t("Failed:", "加载失败：")} {(error as Error).message}</p>
      )}

      <div className="space-y-6">
        {data?.operations.length === 0 && (
          <p className="text-foreground-muted text-sm">{t("No operations yet. Upload an APK to start.", "暂无操作记录。上传 APK 即可开始。")}</p>
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
  const t = useText();
  const { locale } = useLocale();
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
    <section className="border-t border-line-hairline pt-5">
      <div className="flex items-center gap-3">
        <Badge variant={STATUS_VARIANTS[op.status]}>{t(op.status, STATUS_ZH[op.status] ?? op.status)}</Badge>
        <span className="font-mono text-sm">{op.kind}</span>
        <span className="text-xs text-foreground-muted">
          {timeAgo(op.created_at, locale)}
        </span>
        {op.retry_count > 0 && (
          <span className="text-xs text-foreground-hint">{t(`retry #${op.retry_count + 1}`, `第 ${op.retry_count + 1} 次重试`)}</span>
        )}
        <div className="flex-1" />
        {op.status === "failed" && (
          <Button
            onClick={onRetry}
            disabled={busy}
            variant="outline"
            className="text-xs"
          >
            {t("Retry", "重试")}
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setExpanded(!expanded)}
          aria-label={expanded ? t("Collapse", "收起") : t("Expand", "展开")}
        >
          {expanded ? "▲" : "▼"}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="hover:text-danger"
          onClick={onDelete}
          disabled={busy}
          aria-label={t("Delete", "删除")}
        >
          ×
        </Button>
      </div>

      {op.status === "in_progress" && (
        <Progress value={Math.round(op.progress * 100)} className="mt-2 gap-0">
          <ProgressTrack className="h-1 bg-layer-inset rounded-sm overflow-hidden">
            <ProgressIndicator className="bg-info transition-all" />
          </ProgressTrack>
        </Progress>
      )}

      {op.error && (
        <div className="mt-2 text-xs text-danger-strong bg-danger-soft p-2 rounded-sm">
          {op.error}
        </div>
      )}

      {expanded && (
        <div className="mt-3 space-y-2 text-xs">
          <details>
            <summary className="cursor-pointer text-foreground-muted font-medium">
              {t("Input", "输入")}
            </summary>
            <pre className="mt-1 bg-layer-inset p-2 rounded-sm overflow-x-auto">
              {JSON.stringify(inputPayload, null, 2)}
            </pre>
          </details>
          {op.output !== "{}" && (
            <details>
              <summary className="cursor-pointer text-foreground-muted font-medium">
                {t("Output", "输出")}
              </summary>
              <pre className="mt-1 bg-layer-inset p-2 rounded-sm overflow-x-auto">
                {JSON.stringify(outputPayload, null, 2)}
              </pre>
            </details>
          )}
          <div className="text-foreground-hint font-mono">id: {op.id}</div>
        </div>
      )}
      </section>
  );
}

function timeAgo(ts: number, locale: string): string {
  const diff = Date.now() - ts;
  if (locale === "zh-CN") {
    if (diff < 60_000) return `${Math.floor(diff / 1000)} 秒前`;
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
    return `${Math.floor(diff / 86_400_000)} 天前`;
  }
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}
