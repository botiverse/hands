import { errorMessage } from "../lib/errorMessage";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  listOperations,
  retryOperation,
  streamOperations,
  type Operation,
} from "../lib/api";
import { useToast } from "../components/Toast";
import {
  Badge,
  Button,
  CodeBlock,
  CodeBlockBody,
  CodeBlockPre,
  ListRow,
  ListRowBody,
  ListRowDescription,
  ListRowGroup,
  ListRowSubtitle,
  ListRowTitle,
  Progress,
  ProgressIndicator,
  ProgressTrack,
  Skeleton,
  Text,
  TextLink,
} from "@botiverse/raft-ui";
import { Link } from "react-router-dom";
import { Activity, ChevronDown, ChevronUp } from "lucide-react";
import { OverviewEmpty, OverviewSection } from "../components/OverviewSection";
import { useLocale, useText } from "../lib/locale";

// Failed is orange: something went wrong and Retry can fix it (red is for what cannot be undone).
const STATUS_VARIANTS: Record<Operation["status"], "muted" | "information" | "success" | "warning"> = {
  pending: "muted",
  in_progress: "information",
  success: "success",
  failed: "warning",
  cancelled: "muted",
};
const STATUS_EN: Record<Operation["status"], string> = { pending: "Pending", in_progress: "In progress", success: "Succeeded", failed: "Failed", cancelled: "Cancelled" };
const RECENT_LIMIT = 10;
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
  const [showAll, setShowAll] = useState(false);

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
        description: errorMessage(e),
      } as const;
      if (retryToastRef.current !== null) toast.update(retryToastRef.current, patch);
      else toast.show(patch);
      retryToastRef.current = null;
    },
  });


  const operations = data?.operations ?? [];
  const shown = showAll ? operations : operations.slice(0, RECENT_LIMIT);

  return (
    <OverviewSection
      id="overview-operations"
      icon={<Activity />}
      title={t("Recent operations", "最近操作")}
      hint={live.size > 0 ? t("Live", "实时") : t("Refreshes every 5 seconds", "每 5 秒刷新")}
    >
      {isLoading && <Skeleton className="h-28 w-full" />}
      {error && (
        <Text.Sans size="small" variant="warning">
          {t("Could not load operations:", "无法加载操作记录：")} {errorMessage(error)}
        </Text.Sans>
      )}
      {data && operations.length === 0 && (
        <OverviewEmpty
          icon={<Activity />}
          title={t("No operations yet", "还没有操作记录")}
          description={t(
            "Uploads, parses and publishes show up here while they run.",
            "上传、解析和发布在运行时会显示在这里。",
          )}
          action={
            <TextLink render={<Link to={`/apps/${appId}/builds`} />} nativeButton={false} role="link">
              {t("Go to Builds", "前往构建")}
            </TextLink>
          }
        />
      )}
      {shown.length > 0 && (
        <ListRowGroup>
          {shown.map((op) => (
            <OperationRow
              key={op.id}
              op={op}
              isLive={live.has(op.id)}
              onRetry={() => retry.mutate(op.id)}
              busy={retry.isPending}
            />
          ))}
        </ListRowGroup>
      )}
      {operations.length > RECENT_LIMIT && (
        <TextLink variant="muted" className="self-start text-footnote" onClick={() => setShowAll(!showAll)}>
          {showAll
            ? t("Show fewer", "收起")
            : t(`Show all ${operations.length}`, `显示全部 ${operations.length} 条`)}
        </TextLink>
      )}
    </OverviewSection>
  );
}

const KIND_LABELS: Record<Operation["kind"], [string, string]> = {
  parse: ["Parse", "解析"],
  upload: ["Upload", "上传"],
  publish: ["Publish", "发布"],
  signed_url: ["Signed URL", "签名链接"],
  "testflight-upload": ["TestFlight upload", "TestFlight 上传"],
  "testflight-publish": ["TestFlight publish", "TestFlight 发布"],
};

function OperationRow({
  op,
  isLive,
  onRetry,
  busy,
}: {
  op: Operation;
  isLive: boolean;
  onRetry: () => void;
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
  const kindLabel = KIND_LABELS[op.kind] ? t(...KIND_LABELS[op.kind]) : op.kind;
  const detailsId = `operation-${op.id}-details`;

  return (
    <>
      <ListRow variant="plain" interactive={false} data-live={isLive || undefined}>
        <ListRowBody>
          <ListRowTitle>{kindLabel}</ListRowTitle>
          <ListRowSubtitle>
            {timeAgo(op.created_at, locale)}
            {op.retry_count > 0 && <> · {t(`retry #${op.retry_count + 1}`, `第 ${op.retry_count + 1} 次重试`)}</>}
          </ListRowSubtitle>
          {op.error && (
            <ListRowDescription wrap className="text-warning-strong">{op.error}</ListRowDescription>
          )}
          {op.status === "in_progress" && (
            <Progress value={Math.round(op.progress * 100)} className="mt-2 gap-0" aria-label={t("Progress", "进度")}>
              <ProgressTrack className="h-1 rounded-full bg-fill-muted">
                <ProgressIndicator className="bg-info transition-all" />
              </ProgressTrack>
            </Progress>
          )}
        </ListRowBody>
        <Badge appearance="soft" variant={STATUS_VARIANTS[op.status]} className="shrink-0">
          {t(STATUS_EN[op.status], STATUS_ZH[op.status] ?? op.status)}
        </Badge>
        {op.status === "failed" && (
          <Button onClick={onRetry} disabled={busy} size="md" className="shrink-0">
            {t("Retry", "重试")}
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-md"
          className="shrink-0"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          aria-controls={detailsId}
          aria-label={expanded ? t("Hide details", "收起详情") : t("Show details", "查看详情")}
        >
          {expanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
        </Button>
      </ListRow>
      {expanded && (
        <ListRow variant="plain" interactive={false} attached id={detailsId}>
          <ListRowBody className="grid gap-2 text-xs">
            <Text.Sans size="caption" variant="muted">{t("Input", "输入")}</Text.Sans>
            <CodeBlock>
              <CodeBlockBody>
                <CodeBlockPre aria-label={t("Input", "输入")}>
                  <code>{JSON.stringify(inputPayload, null, 2)}</code>
                </CodeBlockPre>
              </CodeBlockBody>
            </CodeBlock>
            {op.output !== "{}" && (
              <>
                <Text.Sans size="caption" variant="muted">{t("Output", "输出")}</Text.Sans>
                <CodeBlock>
                  <CodeBlockBody>
                    <CodeBlockPre aria-label={t("Output", "输出")}>
                      <code>{JSON.stringify(outputPayload, null, 2)}</code>
                    </CodeBlockPre>
                  </CodeBlockBody>
                </CodeBlock>
              </>
            )}
            <span className="font-mono text-foreground-hint">id: {op.id}</span>
          </ListRowBody>
        </ListRow>
      )}
    </>
  );
}

export function timeAgo(ts: number, locale: string): string {
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
