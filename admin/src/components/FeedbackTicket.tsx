/**
 * One feedback ticket: what the reporter wrote, the triage controls (state,
 * assignee, close with a reason), the exception and its symbolicated stack,
 * the crash log by section, breadcrumbs, attachments, the device it came
 * from, and the comments. The same view fills the column beside the
 * Feedback list and the ticket's own page (/apps/:appId/feedback/:ticketId),
 * the link people share.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, Download, FileText, X } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  Banner,
  BannerAction,
  BannerDescription,
  BannerTitle,
  Button,
  CodeBlock,
  CodeBlockActions,
  CodeBlockBody,
  CodeBlockHeader,
  CodeBlockTitle,
  DescriptionDetails,
  DescriptionItem,
  DescriptionList,
  DescriptionTerm,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Field,
  FieldLabel,
  Input,
  Lightbox,
  LightboxClose,
  LightboxContent,
  LightboxInfoActions,
  LightboxInfoBar,
  LightboxInfoDock,
  LightboxInfoTitle,
  LightboxMedia,
  LightboxStage,
  LightboxTitle,
  ListRow,
  ListRowBody,
  ListRowGroup,
  ListRowIcon,
  ListRowSubtitle,
  ListRowTitle,
  ScrollArea,
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlLabel,
  Skeleton,
  Text,
  TextLink,
  Textarea,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@botiverse/raft-ui";
import type { BadgeProps } from "@botiverse/raft-ui";
import { ButtonSplit, ButtonSplitMain, ButtonSplitMenu } from "@botiverse/raft-ui/wip";
import {
  addFeedbackComment,
  downloadFeedbackAttachment,
  getAuthMe,
  getFeedback,
  getFeedbackAttachmentBlob,
  getFeedbackAttachmentText,
  resymbolicateFeedback,
  updateFeedbackTicket,
  type CrashType,
  type FeedbackDetail,
  type FeedbackTicket,
} from "../lib/api";
import { errorMessage } from "../lib/errorMessage";
import { feedbackMessage } from "../lib/feedbackMessages";
import { useLocale, useText, type Locale } from "../lib/locale";
import { useToast } from "./Toast";
import { MarkdownText } from "./MarkdownText";
import { DetailSection } from "./ListPage";

// ---- Labels shared by the list, the ticket and the crash groups ----

export const TICKET_STATUSES = ["open", "in_progress", "resolved"] as const;
export const TICKET_KINDS = ["feedback", "bug", "crash", "error"] as const;

type TeamClosureReason = NonNullable<FeedbackTicket["closure_reason"]>;

const TEAM_CLOSURE_REASONS: Array<{ description: string; label: string; reason: TeamClosureReason }> = [
  { reason: "completed", label: "Completed", description: "The fix or improvement has been delivered." },
  { reason: "not_planned", label: "Not planned", description: "Keep the record, but do not work on it now." },
  { reason: "cannot_reproduce", label: "Cannot reproduce", description: "The issue cannot be reproduced with the available information." },
  { reason: "duplicate", label: "Duplicate", description: "Close as a duplicate and link the original ticket." },
];

const STATUS_EN: Record<string, string> = { open: "Open", in_progress: "In progress", resolved: "Resolved", closed: "Closed" };
const STATUS_ZH: Record<string, string> = { open: "待处理", in_progress: "处理中", resolved: "已解决", closed: "已关闭" };
const KIND_EN: Record<string, string> = { feedback: "Feedback", bug: "Bug", crash: "Crash", error: "Error" };
const KIND_ZH: Record<string, string> = { feedback: "反馈", bug: "缺陷", crash: "崩溃", error: "错误" };
const CLOSURE_ZH: Record<string, { label: string; description: string }> = {
  completed: { label: "已完成", description: "修复或改进已交付。" },
  not_planned: { label: "暂不计划", description: "保留记录，暂时不处理。" },
  cannot_reproduce: { label: "无法复现", description: "无法根据现有信息复现问题。" },
  duplicate: { label: "重复工单", description: "作为重复项关闭，并关联原工单。" },
  no_longer_needed: { label: "不再需要", description: "" },
};
const CRASH_SECTION_ZH: Record<string, string> = { summary: "摘要", stack: "调用栈", threads: "所有线程", process: "进程", fds: "文件描述符", logs: "日志", context: "应用上下文" };
const SYMBOLICATION_EN: Record<string, string> = { symbolicated: "Symbolicated", no_symbols: "No symbols", unsymbolicated: "Not symbolicated", not_applicable: "Not applicable", failed: "Failed", pending: "Pending", not_run: "Not run", done: "Done" };
const SYMBOLICATION_ZH: Record<string, string> = { symbolicated: "已符号化", no_symbols: "没有符号文件", unsymbolicated: "未能符号化", not_applicable: "不适用", failed: "失败", pending: "等待中", not_run: "尚未运行", done: "已完成" };
const ENVIRONMENT_ZH: Record<string, string> = {
  device_id: "设备 ID", device_model: "设备型号", platform: "平台", os_version: "系统版本",
  version_code: "版本号", version_name: "版本名称", fallback_version_code: "回退版本号", fallback_version_name: "回退版本名称",
  commit: "提交", git_commit: "Git 提交",
  bundle_id: "包标识符", app_version: "应用版本", build_number: "构建号", sdk_version: "SDK 版本",
  crash_exit_reason: "退出原因", crash_exit_reason_code: "退出原因代码", crash_exit_importance: "进程优先级 (importance)",
  crash_exit_pss: "系统记录 PSS (KB)", crash_exit_rss: "系统记录 RSS (KB)", crash_foreground: "是否前台",
  crash_foreground_change_age_ms: "前后台切换耗时 (ms)", crash_background_duration_ms: "退后台时长 (ms)",
  crash_process_uptime_ms: "进程存活时长 (ms)", crash_memory_pss_kb: "采样 PSS (KB)", crash_memory_rss_kb: "采样 RSS (KB)",
  crash_trim: "最近内存回收等级", crash_trim_level: "内存回收等级代码", crash_version_source: "版本来源",
};

export const CRASH_TYPE_LABELS: Record<CrashType, string> = {
  exception: "Exception",
  native: "Native crash",
  anr: "ANR",
  system_kill: "System kill",
  webview_renderer_gone: "WebView renderer gone",
};
export const CRASH_TYPE_LABELS_ZH: Record<CrashType, string> = {
  exception: "异常",
  native: "原生崩溃",
  anr: "无响应（ANR）",
  system_kill: "系统强杀",
  webview_renderer_gone: "WebView 渲染进程退出",
};

export function statusLabel(status: string, locale: Locale): string {
  return (locale === "zh-CN" ? STATUS_ZH : STATUS_EN)[status] ?? status;
}
export function kindLabel(kind: string, locale: Locale): string {
  return (locale === "zh-CN" ? KIND_ZH : KIND_EN)[kind] ?? kind;
}
function symbolicationLabel(status: string, locale: Locale): string {
  return (locale === "zh-CN" ? SYMBOLICATION_ZH : SYMBOLICATION_EN)[status] ?? status;
}
function closureReasonLabel(reason: FeedbackTicket["closure_reason"], locale: Locale): string {
  if (locale === "zh-CN") return CLOSURE_ZH[reason ?? ""]?.label ?? String(reason ?? "已关闭");
  if (reason === "no_longer_needed") return "No longer needed";
  return TEAM_CLOSURE_REASONS.find((item) => item.reason === reason)?.label ?? String(reason ?? "Closed");
}

/** What kind of report a ticket is, in words: the kind, or the crash's type. */
export function ticketKindText(
  t: Pick<FeedbackTicket, "kind" | "crash_type" | "background_system_kill">,
  locale: Locale,
): string {
  const zh = locale === "zh-CN";
  if (t.crash_type === "system_kill" && t.background_system_kill) return zh ? "后台被系统结束" : "Killed by the system in the background";
  if (t.crash_type && t.crash_type !== "exception") return zh ? CRASH_TYPE_LABELS_ZH[t.crash_type] : CRASH_TYPE_LABELS[t.crash_type];
  return kindLabel(t.kind, locale);
}

/** Where the build that sent the report came from, when it isn't this app's. */
export function buildOriginText(origin: FeedbackTicket["build_origin"], locale: Locale): string | null {
  if (origin === "external") return locale === "zh-CN" ? "外部构建" : "External build";
  if (origin === "unknown") return locale === "zh-CN" ? "来源未知" : "Origin unknown";
  return null;
}

/** The ticket's state. Nothing here is red: every state can be changed back. */
export function TicketStatusBadge({ status }: { status: string }) {
  const { locale } = useLocale();
  const label = statusLabel(status, locale);
  const variant: BadgeProps["variant"] =
    status === "open" ? "warning" : status === "in_progress" ? "information" : status === "resolved" ? "success" : undefined;
  return variant
    ? <Badge appearance="soft" variant={variant}>{label}</Badge>
    : <Badge appearance="outline">{label}</Badge>;
}

/** The first line of a message, without Markdown heading or list marks. */
export function firstLine(message: string): string {
  const line = message.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.replace(/^(#+|[-*>]|\d+\.)\s+/, "");
}

export function formatBytes(bytes: number, locale: Locale): string {
  const fmt = (n: number) => n.toLocaleString(locale, { maximumFractionDigits: 1 });
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${fmt(bytes / 1024)} KB`;
  return `${fmt(bytes / 1024 / 1024)} MB`;
}

function parseMetadata(json: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* malformed metadata: show nothing */
  }
  return {};
}

// ---- The ticket ----

export function useFeedbackDetail(appId: string, ticketId: string) {
  return useQuery({
    queryKey: ["feedback-detail", appId, ticketId],
    queryFn: () => getFeedback(appId, ticketId),
  });
}

export function FeedbackTicketView({ appId, ticketId }: { appId: string; ticketId: string }) {
  const tx = useText();
  const { locale } = useLocale();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [pendingClosureReason, setPendingClosureReason] = useState<TeamClosureReason | null>(null);
  const [duplicateOfTicketId, setDuplicateOfTicketId] = useState("");

  const detail = useFeedbackDetail(appId, ticketId);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["feedback-detail", appId, ticketId] });
    void queryClient.invalidateQueries({ queryKey: ["feedback", appId] });
  };

  const update = useMutation({
    mutationFn: (body: {
      status?: string;
      assignee?: string | null;
      closure_reason?: FeedbackTicket["closure_reason"];
      duplicate_of_ticket_id?: string | null;
    }) => updateFeedbackTicket(appId, ticketId, body),
    onSuccess: invalidate,
    onError: (e) =>
      toast.show({ kind: "error", title: tx("Update failed", "更新失败"), description: errorMessage(e) }),
  });

  const t = detail.data?.ticket;
  const pendingClosure = TEAM_CLOSURE_REASONS.find((item) => item.reason === pendingClosureReason);
  const submitClosure = () => {
    if (!pendingClosureReason) return;
    update.mutate(
      {
        status: "closed",
        closure_reason: pendingClosureReason,
        duplicate_of_ticket_id: pendingClosureReason === "duplicate" ? duplicateOfTicketId.trim() : null,
      },
      {
        onSuccess: () => {
          setPendingClosureReason(null);
          setDuplicateOfTicketId("");
        },
      },
    );
  };

  if (detail.isLoading) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    );
  }
  if (detail.error || !t || !detail.data) {
    return (
      <Banner status="warning">
        <AlertTriangle aria-hidden="true" />
        <BannerTitle>{tx("Could not load this ticket", "无法加载此工单")}</BannerTitle>
        <BannerDescription>{detail.error ? errorMessage(detail.error) : null}</BannerDescription>
        <BannerAction>
          <Button variant="outline" onClick={() => void detail.refetch()}>{tx("Retry", "重试")}</Button>
        </BannerAction>
      </Banner>
    );
  }
  const data = detail.data;
  const meta = parseMetadata(t.metadata_json);
  const origin = buildOriginText(t.build_origin, locale);

  return (
    <>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <TicketStatusBadge status={t.status} />
          <Text.Sans size="small" variant="muted">
            {[ticketKindText(t, locale), origin, new Date(t.created_at).toLocaleString(locale), t.contact]
              .filter(Boolean)
              .join(" · ")}
          </Text.Sans>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl
            aria-label={tx("Status", "状态")}
            value={t.status === "closed" ? "" : t.status}
            disabled={update.isPending}
            onValueChange={(value) => {
              if (value && value !== t.status) update.mutate({ status: value as string });
            }}
            className="w-fit"
          >
            {TICKET_STATUSES.map((s) => (
              <SegmentedControlItem key={s} value={s}>
                <SegmentedControlLabel>{statusLabel(s, locale)}</SegmentedControlLabel>
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
          {t.status !== "closed" && (
            <ButtonSplit aria-label={tx("Close ticket", "关闭工单")}>
              <ButtonSplitMain
                variant="default"
                disabled={update.isPending}
                onClick={() => setPendingClosureReason("completed")}
              >
                <Check aria-hidden="true" />
                {tx("Completed", "已完成")}
              </ButtonSplitMain>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <ButtonSplitMenu
                      variant="default"
                      disabled={update.isPending}
                      aria-label={tx("Choose a close reason", "选择关闭原因")}
                    />
                  }
                />
                <DropdownMenuContent align="end" className="w-80 max-w-[calc(100vw-24px)]">
                  {TEAM_CLOSURE_REASONS.map((item) => (
                    <DropdownMenuItem
                      key={item.reason}
                      className="items-start whitespace-normal"
                      onClick={() => setPendingClosureReason(item.reason)}
                    >
                      <span>
                        <span className="block font-medium">{locale === "zh-CN" ? CLOSURE_ZH[item.reason]!.label : item.label}</span>
                        <span className="mt-0.5 block text-footnote text-foreground-muted">
                          {locale === "zh-CN" ? CLOSURE_ZH[item.reason]!.description : item.description}
                        </span>
                      </span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </ButtonSplit>
          )}
        </div>

        {t.status === "closed" && t.closure_reason && (
          <DescriptionList direction="horizontal">
            <DescriptionItem>
              <DescriptionTerm>{tx("Closed as", "关闭原因")}</DescriptionTerm>
              <DescriptionDetails>{closureReasonLabel(t.closure_reason, locale)}</DescriptionDetails>
            </DescriptionItem>
            {t.duplicate_of_ticket_id && (
              <DescriptionItem>
                <DescriptionTerm>{tx("Original ticket", "原工单")}</DescriptionTerm>
                <DescriptionDetails>
                  <TicketLink appId={appId} ticketId={t.duplicate_of_ticket_id} />
                </DescriptionDetails>
              </DescriptionItem>
            )}
          </DescriptionList>
        )}
      </div>

      <DetailSection title={tx("Message", "内容")}>
        <MarkdownText source={t.message} className="text-body leading-relaxed [overflow-wrap:anywhere]" />
      </DetailSection>

      <AssigneeSection
        assignee={t.assignee}
        pending={update.isPending}
        onChange={(assignee) => update.mutate({ assignee })}
      />

      {(t.kind === "crash" || t.kind === "error" || typeof meta.stacktrace === "string" || typeof meta.exception_class === "string") && (
        <CrashSection appId={appId} ticketId={ticketId} detail={data} meta={meta} onChanged={invalidate} />
      )}

      <Breadcrumbs meta={meta} />

      {data.attachments.length > 0 && (
        <AttachmentList appId={appId} ticketId={ticketId} attachments={data.attachments} />
      )}

      <EnvironmentSection appId={appId} meta={meta} />

      <CommentsSection appId={appId} ticketId={ticketId} comments={data.comments} onAdded={invalidate} />

      <AlertDialog
        open={pendingClosureReason !== null}
        onOpenChange={(open) => {
          if (!open && !update.isPending) {
            setPendingClosureReason(null);
            setDuplicateOfTicketId("");
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tx("Close this ticket?", "关闭此工单？")}</AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogBody className="flex flex-col gap-3">
            <AlertDialogDescription>
              {pendingClosure && (locale === "zh-CN" ? CLOSURE_ZH[pendingClosure.reason]!.description : pendingClosure.description)}
              {" "}
              {tx("You can open it again later.", "之后可以重新打开。")}
            </AlertDialogDescription>
            {pendingClosureReason === "duplicate" && (
              <Field>
                <FieldLabel>{tx("Original ticket ID", "原工单 ID")}</FieldLabel>
                <Input
                  value={duplicateOfTicketId}
                  onChange={(event) => setDuplicateOfTicketId(event.target.value)}
                  placeholder={tx("Full ID or a unique prefix", "完整 ID 或唯一前缀")}
                  autoFocus
                />
              </Field>
            )}
          </AlertDialogBody>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={update.isPending}>{tx("Cancel", "取消")}</AlertDialogCancel>
            <AlertDialogAction
              variant="primary"
              loading={update.isPending}
              disabled={update.isPending || (pendingClosureReason === "duplicate" && !duplicateOfTicketId.trim())}
              onClick={submitClosure}
            >
              {tx("Close ticket", "关闭工单")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function TicketLink({ appId, ticketId }: { appId: string; ticketId: string }) {
  const navigate = useNavigate();
  return (
    <TextLink className="font-mono [overflow-wrap:anywhere]" onClick={() => navigate(`/apps/${appId}/feedback/${ticketId}`)}>
      {ticketId}
    </TextLink>
  );
}

function AssigneeSection({
  assignee,
  pending,
  onChange,
}: {
  assignee: string | null;
  pending: boolean;
  onChange: (assignee: string | null) => void;
}) {
  const tx = useText();
  const me = useQuery({ queryKey: ["auth-me"], queryFn: getAuthMe });
  const myName = me.data?.account?.display_name ?? null;
  const [draft, setDraft] = useState<string | null>(null);
  // A saved change ends the edit.
  useEffect(() => setDraft(null), [assignee]);

  return (
    <DetailSection
      title={tx("Assignee", "负责人")}
      action={
        draft === null && (
          <span className="flex items-center gap-3">
            {myName && assignee !== myName && (
              <TextLink disabled={pending} onClick={() => onChange(myName)}>{tx("Assign to me", "分配给我")}</TextLink>
            )}
            <TextLink onClick={() => setDraft(assignee ?? "")}>{tx("Edit", "编辑")}</TextLink>
            {assignee && (
              <TextLink disabled={pending} onClick={() => onChange(null)}>{tx("Unassign", "取消分配")}</TextLink>
            )}
          </span>
        )
      }
    >
      {draft === null ? (
        <Text.Sans size="body" variant={assignee ? "default" : "muted"}>{assignee ?? tx("Unassigned", "未分配")}</Text.Sans>
      ) : (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            onChange(draft.trim() || null);
          }}
        >
          <Input
            className="min-w-0 flex-1 basis-48"
            value={draft}
            autoFocus
            aria-label={tx("Assignee", "负责人")}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={tx("Name of the person handling this", "负责人的姓名")}
          />
          <Button type="submit" variant="default" disabled={pending}>{tx("Save", "保存")}</Button>
          <Button type="button" variant="ghost" onClick={() => setDraft(null)}>{tx("Cancel", "取消")}</Button>
        </form>
      )}
    </DetailSection>
  );
}

// ---- Crash: exception, symbolication, the crash log ----

type CrashLogSection = { key: string; label: string; body: string };

/**
 * Split a Hands crash log into sections by its known headers, so the ticket
 * shows them one at a time (stack, all threads, process, logs, ...).
 */
export function parseCrashLog(text: string): CrashLogSection[] {
  const headers: Array<{ marker: string; key: string; label: string }> = [
    { marker: "Stack trace:", key: "stack", label: "Stack" },
    { marker: "All threads:", key: "threads", label: "All threads" },
    { marker: "Process info:", key: "process", label: "Process" },
    { marker: "Open file descriptors:", key: "fds", label: "File descriptors" },
    { marker: "Recent logcat:", key: "logs", label: "Logs" },
    { marker: "App context:", key: "context", label: "App context" },
  ];
  const lines = text.split("\n");
  // Everything before the first known header is the summary/device header.
  const marks: Array<{ i: number; key: string; label: string }> = [];
  lines.forEach((line, i) => {
    const h = headers.find((x) => line.trim() === x.marker);
    if (h) marks.push({ i, key: h.key, label: h.label });
  });
  const sections: CrashLogSection[] = [];
  const head = lines.slice(0, marks.length ? marks[0]!.i : lines.length).join("\n").trim();
  if (head) sections.push({ key: "summary", label: "Summary", body: head });
  marks.forEach((m, idx) => {
    const end = idx + 1 < marks.length ? marks[idx + 1]!.i : lines.length;
    const body = lines.slice(m.i + 1, end).join("\n").trimEnd();
    if (body.trim()) sections.push({ key: m.key, label: m.label, body });
  });
  return sections;
}

/** Code on the code surface; long logs scroll inside it, both ways. */
function CodeText({ title, actions, children }: { title?: string; actions?: ReactNode; children: string }) {
  return (
    <CodeBlock>
      {(title || actions) && (
        <CodeBlockHeader>
          {title && <CodeBlockTitle>{title}</CodeBlockTitle>}
          {actions && <CodeBlockActions>{actions}</CodeBlockActions>}
        </CodeBlockHeader>
      )}
      <CodeBlockBody>
        <ScrollArea orientation="both" className="max-h-112">
          <pre className="w-max min-w-full p-3 font-mono text-footnote leading-relaxed">{children}</pre>
        </ScrollArea>
      </CodeBlockBody>
    </CodeBlock>
  );
}

function CrashSection({
  appId,
  ticketId,
  detail,
  meta,
  onChanged,
}: {
  appId: string;
  ticketId: string;
  detail: FeedbackDetail;
  meta: Record<string, unknown>;
  onChanged: () => void;
}) {
  const tx = useText();
  const { locale } = useLocale();
  const toast = useToast();
  const t = detail.ticket;
  const isCrash = t.kind === "crash" || t.kind === "error";
  const stacktrace = typeof meta.stacktrace === "string" ? meta.stacktrace : null;
  const excClass = typeof meta.exception_class === "string" ? meta.exception_class : null;
  const excMsg = typeof meta.exception_message === "string" ? meta.exception_message : null;
  const log = detail.attachments.find((a) => (a.content_type?.startsWith("text/") ?? false) || /\.txt$/i.test(a.filename));
  const symStatus = t.symbolication_status;
  const symStack = t.symbolicated_stack ?? undefined;

  const resymbolicate = useMutation({
    mutationFn: () => resymbolicateFeedback(appId, ticketId),
    onSuccess: (r) => {
      onChanged();
      toast.show({
        kind: r.symbolication_status === "symbolicated" ? "success" : "info",
        title: `${tx("Symbolication", "符号化")}: ${symbolicationLabel(r.symbolication_status ?? "done", locale)}`,
      });
    },
    onError: (e) =>
      toast.show({ kind: "error", title: tx("Symbolicate failed", "符号化失败"), description: errorMessage(e) }),
  });

  const symVariant: BadgeProps["variant"] =
    symStatus === "symbolicated" ? "success" : symStatus === "no_symbols" || symStatus === "failed" ? "warning" : undefined;

  return (
    <DetailSection
      title={t.kind === "error" ? tx("Error", "错误") : t.kind === "crash" ? tx("Crash", "崩溃") : tx("Exception", "异常")}
      action={
        isCrash && (
          <Button variant="ghost" size="sm" loading={resymbolicate.isPending} loadingLabel={tx("Symbolicating…", "正在符号化…")} onClick={() => resymbolicate.mutate()}>
            {tx("Symbolicate again", "重新符号化")}
          </Button>
        )
      }
    >
      {excClass && (
        <Text.Mono size="code" className="[overflow-wrap:anywhere]">
          {excClass}{excMsg ? `: ${excMsg}` : ""}
        </Text.Mono>
      )}
      {isCrash && (
        <div className="flex flex-wrap items-center gap-2">
          <Text.Sans size="small" variant="muted">{tx("Symbolication", "符号化")}</Text.Sans>
          {symVariant ? (
            <Badge appearance="soft" variant={symVariant}>{symbolicationLabel(symStatus!, locale)}</Badge>
          ) : (
            <Badge appearance="outline">{symStatus ? symbolicationLabel(symStatus, locale) : tx("Not run", "尚未运行")}</Badge>
          )}
        </div>
      )}
      {isCrash && log ? (
        <CrashLogView appId={appId} ticketId={ticketId} attachmentId={log.id} deobfuscated={symStack} />
      ) : isCrash && symStack ? (
        <CodeText title={tx("Symbolicated stack", "符号化调用栈")}>{symStack}</CodeText>
      ) : stacktrace ? (
        <CodeText title={tx("Stack", "调用栈")}>{stacktrace}</CodeText>
      ) : null}
      {isCrash && !log && symStack && stacktrace && (
        <CodeText title={tx("Reported stack", "上报的调用栈")}>{stacktrace}</CodeText>
      )}
    </DetailSection>
  );
}

function CrashLogView({
  appId,
  ticketId,
  attachmentId,
  deobfuscated,
}: {
  appId: string;
  ticketId: string;
  attachmentId: string;
  deobfuscated?: string | undefined;
}) {
  const tx = useText();
  const { locale } = useLocale();
  const log = useQuery({
    queryKey: ["crash-log", appId, ticketId, attachmentId],
    queryFn: () => getFeedbackAttachmentText(appId, ticketId, attachmentId),
  });
  const [active, setActive] = useState<string>("stack");
  const [showDeobf, setShowDeobf] = useState(true);
  const sections = useMemo(() => (log.data ? parseCrashLog(log.data) : []), [log.data]);
  const activeSection = sections.find((x) => x.key === active) ?? sections[0];
  const sectionLabel = (s: CrashLogSection) => (locale === "zh-CN" ? CRASH_SECTION_ZH[s.key] ?? s.label : s.label);
  const onStack = activeSection?.key === "stack";

  if (log.isLoading) return <Skeleton className="h-32 w-full" />;
  if (log.error) return <Text.Sans size="small" variant="muted">{tx("Could not load the crash log.", "无法加载崩溃日志。")}</Text.Sans>;
  if (!activeSection) {
    return deobfuscated ? <CodeText title={tx("Symbolicated stack", "符号化调用栈")}>{deobfuscated}</CodeText> : null;
  }

  return (
    <div className="flex flex-col gap-2">
      <ScrollArea orientation="horizontal" className="w-full">
        <SegmentedControl
          aria-label={tx("Crash log section", "崩溃日志部分")}
          value={activeSection.key}
          onValueChange={(v) => setActive(v as string)}
          className="w-fit"
        >
          {sections.map((sec) => (
            <SegmentedControlItem key={sec.key} value={sec.key}>
              <SegmentedControlLabel>{sectionLabel(sec)}</SegmentedControlLabel>
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
      </ScrollArea>
      <CodeText
        title={onStack && deobfuscated ? (showDeobf ? tx("Symbolicated stack", "符号化调用栈") : tx("Raw stack", "原始调用栈")) : sectionLabel(activeSection)}
        actions={
          onStack && deobfuscated ? (
            <TextLink onClick={() => setShowDeobf((v) => !v)}>
              {showDeobf ? tx("Show raw", "查看原始") : tx("Show symbolicated", "查看符号化")}
            </TextLink>
          ) : undefined
        }
      >
        {onStack && deobfuscated && showDeobf ? deobfuscated : activeSection.body}
      </CodeText>
    </div>
  );
}

function Breadcrumbs({ meta }: { meta: Record<string, unknown> }) {
  const tx = useText();
  const { locale } = useLocale();
  let crumbs: Array<{ timestamp?: number; category?: string; message?: string; level?: string }> = [];
  if (Array.isArray(meta.breadcrumbs)) crumbs = meta.breadcrumbs as typeof crumbs;
  else if (typeof meta.breadcrumbs === "string") {
    try {
      const p = JSON.parse(meta.breadcrumbs);
      if (Array.isArray(p)) crumbs = p;
    } catch { /* ignore */ }
  }
  if (crumbs.length === 0) return null;
  return (
    <DetailSection title={`${tx("Breadcrumbs", "操作轨迹")} (${crumbs.length})`}>
      <ScrollArea className="max-h-60">
        <ol className="flex flex-col gap-1 text-footnote">
          {crumbs.map((bc, i) => (
            <li key={i} className="flex items-baseline gap-2">
              <span className="shrink-0 font-mono text-foreground-hint">
                {bc.timestamp ? new Date(bc.timestamp).toLocaleTimeString(locale) : "—"}
              </span>
              <span className="shrink-0 font-medium">{bc.category ?? tx("general", "常规")}</span>
              {bc.level && bc.level !== "info" && bc.level !== "debug" && (
                <span className={bc.level === "error" ? "shrink-0 text-warning-strong" : "shrink-0 text-foreground-muted"}>{bc.level}</span>
              )}
              <span className="[overflow-wrap:anywhere]">{bc.message ?? ""}</span>
            </li>
          ))}
        </ol>
      </ScrollArea>
    </DetailSection>
  );
}

// ---- Attachments ----

const IMAGE_EXTS = /\.(png|jpe?g|gif|webp|bmp|heic|heif)$/i;

function isImageAttachment(a: { content_type: string | null; filename: string }): boolean {
  return (a.content_type?.startsWith("image/") ?? false) || IMAGE_EXTS.test(a.filename);
}

type Attachment = FeedbackDetail["attachments"][number];

function AttachmentList({ appId, ticketId, attachments }: { appId: string; ticketId: string; attachments: Attachment[] }) {
  const tx = useText();
  const { locale } = useLocale();
  const [viewing, setViewing] = useState<{ attachment: Attachment; url: string } | null>(null);
  const images = attachments.filter(isImageAttachment);
  const others = attachments.filter((a) => !isImageAttachment(a));
  const download = (a: Attachment) => void downloadFeedbackAttachment(appId, ticketId, a.id, a.filename);

  return (
    <DetailSection title={`${tx("Attachments", "附件")} (${attachments.length})`}>
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {images.map((a) => (
            <AttachmentImage key={a.id} appId={appId} ticketId={ticketId} attachment={a} onOpen={(url) => setViewing({ attachment: a, url })} />
          ))}
        </div>
      )}
      {others.length > 0 && (
        <ListRowGroup>
          {others.map((a) => (
            <ListRow key={a.id} variant="plain" onClick={() => download(a)} aria-label={`${tx("Download", "下载")} ${a.filename}`}>
              <ListRowIcon><FileText /></ListRowIcon>
              <ListRowBody>
                <ListRowTitle className="font-mono">{a.filename}</ListRowTitle>
                <ListRowSubtitle>{[formatBytes(a.size_bytes, locale), a.content_type].filter(Boolean).join(" · ")}</ListRowSubtitle>
              </ListRowBody>
              <Download aria-hidden="true" className="size-4 shrink-0 text-foreground-muted" />
            </ListRow>
          ))}
        </ListRowGroup>
      )}

      <Lightbox open={viewing !== null} onOpenChange={(open) => { if (!open) setViewing(null); }}>
        {viewing && (
          <LightboxContent>
            <LightboxTitle className="sr-only">{viewing.attachment.filename}</LightboxTitle>
            <LightboxClose aria-label={tx("Close", "关闭")}>
              <X />
            </LightboxClose>
            <LightboxStage>
              <LightboxMedia render={<img src={viewing.url} alt={viewing.attachment.filename} />} />
              <LightboxInfoDock>
                <LightboxInfoBar>
                  <LightboxInfoTitle>{viewing.attachment.filename}</LightboxInfoTitle>
                  <LightboxInfoActions>
                    <Button variant="ghost" size="icon-md" aria-label={tx("Download", "下载")} onClick={() => download(viewing.attachment)}>
                      <Download />
                    </Button>
                  </LightboxInfoActions>
                </LightboxInfoBar>
              </LightboxInfoDock>
            </LightboxStage>
          </LightboxContent>
        )}
      </Lightbox>
    </DetailSection>
  );
}

function AttachmentImage({
  appId,
  ticketId,
  attachment,
  onOpen,
}: {
  appId: string;
  ticketId: string;
  attachment: { id: string; filename: string };
  onOpen: (url: string) => void;
}) {
  const image = useQuery({
    queryKey: ["feedback-attachment-image", appId, ticketId, attachment.id],
    queryFn: async () => URL.createObjectURL(await getFeedbackAttachmentBlob(appId, ticketId, attachment.id, true)),
    staleTime: Infinity,
  });

  useEffect(() => {
    const url = image.data;
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [image.data]);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={attachment.filename}
            className="relative size-24 overflow-hidden rounded-md border border-line-hairline bg-fill-muted"
            onClick={() => image.data && onOpen(image.data)}
            disabled={!image.data}
          >
            {image.data && (
              <img src={image.data} alt={attachment.filename} loading="lazy" className="size-full object-cover" />
            )}
          </button>
        }
      />
      <TooltipContent>{attachment.filename}</TooltipContent>
    </Tooltip>
  );
}

// ---- Device and app context ----

const SYSTEM_KILL_KEYS = new Set([
  "crash_exit_reason", "crash_exit_reason_code", "crash_exit_importance", "crash_exit_pss", "crash_exit_rss",
  "crash_foreground", "crash_foreground_change_age_ms", "crash_background_duration_ms", "crash_process_uptime_ms",
  "crash_memory_pss_kb", "crash_memory_rss_kb", "crash_trim", "crash_trim_level", "crash_version_source",
]);
const NOT_ENVIRONMENT = new Set(["breadcrumbs", "stacktrace", "exception_class", "exception_message", "top_frame", "handled"]);

function EnvironmentSection({ appId, meta }: { appId: string; meta: Record<string, unknown> }) {
  const tx = useText();
  const { locale } = useLocale();
  const navigate = useNavigate();
  // Every reported field, with no allowlist, so new SDK fields show up with
  // no UI change. crash_* keys belong to the crash, except the system-kill
  // facts; version_code and device_id lead to their filtered lists.
  const entries = Object.entries(meta)
    .filter(([k, v]) => (!k.startsWith("crash_") || SYSTEM_KILL_KEYS.has(k)) && !NOT_ENVIRONMENT.has(k) && v !== null && v !== undefined && v !== "")
    .sort(([a], [b]) => a.localeCompare(b));
  const label = (k: string) =>
    locale === "zh-CN" ? ENVIRONMENT_ZH[k] ?? k : (k.charAt(0).toUpperCase() + k.slice(1)).replace(/_/g, " ").replace(/\bid\b/gi, "ID").replace(/\bos\b/gi, "OS");
  const format = (v: unknown) => (typeof v === "object" ? JSON.stringify(v) : String(v));
  const mono = (k: string) => k === "device_id" || k === "commit" || k === "git_commit" || k === "version_code";

  return (
    <DetailSection title={tx("Device and app", "设备和应用")}>
      {entries.length === 0 ? (
        <Text.Sans size="small" variant="muted">{tx("The app reported no device details.", "应用没有上报设备信息。")}</Text.Sans>
      ) : (
        <DescriptionList direction="horizontal">
          {entries.map(([k, v]) => (
            <DescriptionItem key={k}>
              <DescriptionTerm>{label(k)}</DescriptionTerm>
              <DescriptionDetails className={mono(k) ? "font-mono [overflow-wrap:anywhere]" : "[overflow-wrap:anywhere]"}>
                {k === "version_code" || k === "device_id" ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <TextLink
                          className="font-mono [overflow-wrap:anywhere]"
                          onClick={() => navigate(`/apps/${appId}/feedback?${k}=${encodeURIComponent(format(v))}`)}
                        >
                          {format(v)}
                        </TextLink>
                      }
                    />
                    <TooltipContent>
                      {k === "version_code" ? tx("All feedback on this version", "此版本的全部反馈") : tx("This device's history", "此设备的历史记录")}
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  format(v)
                )}
              </DescriptionDetails>
            </DescriptionItem>
          ))}
        </DescriptionList>
      )}
    </DetailSection>
  );
}

// ---- Comments ----

function CommentsSection({
  appId,
  ticketId,
  comments,
  onAdded,
}: {
  appId: string;
  ticketId: string;
  comments: FeedbackDetail["comments"];
  onAdded: () => void;
}) {
  const tx = useText();
  const { locale } = useLocale();
  const toast = useToast();
  const [comment, setComment] = useState("");
  const addComment = useMutation({
    mutationFn: (internal: boolean) => addFeedbackComment(appId, ticketId, comment.trim(), internal),
    onSuccess: () => {
      setComment("");
      onAdded();
    },
    onError: (e) =>
      toast.show({ kind: "error", title: tx("Comment failed", "评论发送失败"), description: errorMessage(e) }),
  });

  return (
    <DetailSection title={`${tx("Comments", "评论")} (${comments.length})`}>
      {comments.length > 0 && (
        <ul className="flex flex-col">
          {comments.map((cm, index) => (
            <li key={cm.id} className={index === 0 ? "pb-3" : "border-t border-line-hairline py-3"}>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <Text.Sans size="small" className="font-bold">{cm.author_actor}</Text.Sans>
                <span className="font-mono text-footnote text-foreground-hint">{new Date(cm.created_at).toLocaleString(locale)}</span>
                <span className="ml-auto">
                  {cm.internal ? (
                    <Badge appearance="outline">{feedbackMessage("internalNote", [locale])}</Badge>
                  ) : (
                    <Badge appearance="soft" variant="information">{feedbackMessage("visibleToReporter", [locale])}</Badge>
                  )}
                </span>
              </div>
              <MarkdownText source={cm.body} className="mt-1.5 leading-relaxed [overflow-wrap:anywhere]" />
            </li>
          ))}
        </ul>
      )}
      <Textarea
        rows={3}
        aria-label={tx("Comment", "评论")}
        placeholder={tx("Add a comment…", "添加评论…")}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && comment.trim()) addComment.mutate(true);
        }}
      />
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="default" disabled={addComment.isPending || !comment.trim()} onClick={() => addComment.mutate(true)}>
          {feedbackMessage("addInternalNote", [locale])}
        </Button>
        <Button variant="primary" disabled={addComment.isPending || !comment.trim()} onClick={() => addComment.mutate(false)}>
          {feedbackMessage("sendToReporter", [locale])}
        </Button>
      </div>
    </DetailSection>
  );
}
