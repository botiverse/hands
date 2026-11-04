import { errorMessage } from "../lib/errorMessage";
/**
 * Feedback ticket triage (task #66): list + filter tickets, and a routed
 * per-ticket page (/apps/:appId/feedback/:ticketId) so tickets are
 * shareable links. Tickets carry an assignee, status flow, and comments.
 */
import { Fragment, useEffect, useMemo, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  addFeedbackComment,
  resymbolicateFeedback,
  downloadFeedbackAttachment,
  getAuthMe,
  getFeedback,
  getFeedbackBuildFilter,
  getFeedbackAttachmentBlob,
  listFeedback,
  getDeviceDetail,
  getFeedbackAttachmentText,
  updateFeedbackTicket,
} from "../lib/api";
import { feedbackMessage } from "../lib/feedbackMessages";
import { useLocale, useText, type Locale } from "../lib/locale";
import { useToast } from "../components/Toast";
import { FeedbackTrends } from "../components/FeedbackTrends";
import { FeedbackBuildScopeSelector, feedbackBuildScope } from "../components/FeedbackBuildScope";
import { MarkdownText } from "../components/MarkdownText";
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
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  EmptyStateTitle,
  Input,
  Select,
  SelectContent,
  SelectList,
  SelectIcon,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "raft-ui";
import type { BadgeProps } from "raft-ui";
import type { FeedbackTicket } from "../lib/api";

const STATUSES = ["open", "in_progress", "resolved"] as const;

type TeamClosureReason = NonNullable<FeedbackTicket["closure_reason"]>;

const TEAM_CLOSURE_REASONS: Array<{
  description: string;
  label: string;
  reason: TeamClosureReason;
}> = [
  { reason: "completed", label: "Completed", description: "The fix or improvement has been delivered." },
  { reason: "not_planned", label: "Not planned", description: "Keep the record, but do not work on it now." },
  { reason: "cannot_reproduce", label: "Cannot reproduce", description: "The issue cannot be reproduced with the available information." },
  { reason: "duplicate", label: "Duplicate", description: "Close as a duplicate and link the original ticket." },
];

const STATUS_ZH: Record<string, string> = { open: "待处理", in_progress: "处理中", resolved: "已解决", closed: "已关闭" };
const KIND_ZH: Record<string, string> = { feedback: "反馈", bug: "缺陷", crash: "崩溃", error: "错误" };
const CLOSURE_ZH: Record<string, { label: string; description: string }> = {
  completed: { label: "已完成", description: "修复或改进已交付。" },
  not_planned: { label: "暂不计划", description: "保留记录，暂时不处理。" },
  cannot_reproduce: { label: "无法复现", description: "无法根据现有信息复现问题。" },
  duplicate: { label: "重复工单", description: "作为重复项关闭，并关联原工单。" },
  no_longer_needed: { label: "不再需要", description: "" },
};
const CRASH_SECTION_ZH: Record<string, string> = { summary: "摘要", stack: "调用栈", threads: "所有线程", process: "进程", fds: "文件描述符", logs: "日志", context: "应用上下文" };
const SYMBOLICATION_ZH: Record<string, string> = { symbolicated: "已符号化", no_symbols: "没有符号文件", unsymbolicated: "未能符号化", not_applicable: "不适用", failed: "失败", pending: "等待中", not_run: "尚未运行", done: "已完成" };
const ENVIRONMENT_ZH: Record<string, string> = {
  device_id: "设备 ID", device_model: "设备型号", platform: "平台", os_version: "系统版本",
  version_code: "版本号", version_name: "版本名称", commit: "提交", git_commit: "Git 提交",
  bundle_id: "包标识符", app_version: "应用版本", build_number: "构建号", sdk_version: "SDK 版本",
};
function localizedValue(value: string, locale: Locale, dictionary: Record<string, string>): string {
  return locale === "zh-CN" ? (dictionary[value] ?? value) : value;
}
function closureReasonLabel(reason: FeedbackTicket["closure_reason"], locale: Locale): string {
  if (locale === "zh-CN") return CLOSURE_ZH[reason ?? ""]?.label ?? String(reason ?? "已关闭");
  if (reason === "no_longer_needed") return "No longer needed";
  return TEAM_CLOSURE_REASONS.find((item) => item.reason === reason)?.label ?? String(reason ?? "Closed");
}

type BadgeVariant = NonNullable<BadgeProps["variant"]>;

const STATUS_VARIANTS: Record<string, BadgeVariant> = {
  open: "danger",
  in_progress: "information",
  resolved: "success",
  closed: "muted",
};

const KIND_VARIANTS: Record<string, BadgeVariant> = {
  feedback: "muted",
  bug: "warning",
  crash: "danger",
};

export function AppFeedback({ appId }: { appId: string }) {
  const tx = useText();
  const { locale } = useLocale();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [kindFilter, setKindFilter] = useState<string>(searchParams.get("kind") ?? "");
  const deviceFilter = searchParams.get("device_id") ?? "";
  const versionFilter = searchParams.get("version_code") ?? "";
  const signatureFilter = searchParams.get("signature") ?? "";
  const buildScope = feedbackBuildScope(searchParams.get("build_scope"));
  const originPolicy = useQuery({
    queryKey: ["feedback-build-filter", appId],
    queryFn: () => getFeedbackBuildFilter(appId),
  });

  const tickets = useQuery({
    queryKey: ["feedback", appId, statusFilter, kindFilter, deviceFilter, versionFilter, signatureFilter, buildScope],
    queryFn: () =>
      listFeedback(appId, {
        status: statusFilter || undefined,
        // Feedback tab = user feedback + bugs; crashes live in the Crashes
        // tab. An explicit kind/signature filter overrides this.
        kind: kindFilter || (signatureFilter ? "crash,error" : "feedback,bug"),
        deviceId: deviceFilter || undefined,
        versionCode: versionFilter ? Number(versionFilter) : undefined,
        signature: signatureFilter || undefined,
        buildScope,
      }),
  });

  const clearScopeFilter = (key: "device_id" | "version_code" | "signature") => {
    const next = new URLSearchParams(searchParams);
    next.delete(key);
    setSearchParams(next);
  };

  const rows = tickets.data?.tickets ?? [];

  return (
    <div className="space-y-4">
      {deviceFilter && (
        <DeviceScopeBanner
          appId={appId}
          deviceId={deviceFilter}
          onClear={() => clearScopeFilter("device_id")}
        />
      )}
      {versionFilter && (
        <div className="flex flex-row items-center justify-between rounded-md bg-fill-muted px-3 py-1.5 text-sm">
          <span className="text-foreground-muted">
            {tx("Filtered to version code", "按版本号筛选")} <span className="font-mono text-foreground">{versionFilter}</span>
          </span>
          <Button variant="link" size="sm" className="text-xs" onClick={() => clearScopeFilter("version_code")}>
            {tx("clear", "清除")}
          </Button>
        </div>
      )}
      {signatureFilter && (
        <div className="rounded-md bg-fill-muted p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs text-foreground-muted">{tx("Crash signature", "崩溃特征")}</div>
              <code className="text-xs break-all">{signatureFilter}</code>
              {rows.length > 0 && (
                <div className="mt-1 text-xs text-foreground-muted">
                  {locale === "zh-CN" ? `${rows.length} 条记录` : `${rows.length} instance${rows.length === 1 ? "" : "s"}`} ·{" "}
                  {new Set(rows.map((r) => r.version_code).filter(Boolean)).size} {tx("version(s)", "个版本")} ·{" "}
                  {new Set(rows.map((r) => r.device_id).filter(Boolean)).size} {tx("device(s)", "台设备")}
                </div>
              )}
            </div>
            <Button variant="link" size="sm" className="text-xs flex-none" onClick={() => clearScopeFilter("signature")}>
              {tx("clear", "清除")}
            </Button>
          </div>
        </div>
      )}
      {!deviceFilter && !versionFilter && !signatureFilter && <FeedbackTrends appId={appId} buildScope={buildScope} />}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-lg font-semibold">{tx("Feedback", "反馈")}</h2>
          <p className="text-sm text-foreground-muted">
            {tx("Feedback and crash reports submitted from this app.", "此应用提交的反馈和崩溃报告。")}
          </p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Select
            items={{ "": tx("All statuses", "所有状态"), ...Object.fromEntries(STATUSES.map((s) => [s, localizedValue(s, locale, STATUS_ZH)])) }}
            value={statusFilter}
            onValueChange={(v) => setStatusFilter(v as string)}
          >
            <SelectTrigger className="w-auto! py-1.5!">
              <SelectValue />
              <SelectIcon />
            </SelectTrigger>
            <SelectContent>
              <SelectList>
              <SelectItem value="">{tx("All statuses", "所有状态")}</SelectItem>
              {STATUSES.map((s) => (
                <SelectItem key={s} value={s}>{localizedValue(s, locale, STATUS_ZH)}</SelectItem>
              ))}
            </SelectList>
            </SelectContent>
          </Select>
          <Select
            items={{ "": tx("All kinds", "所有类型"), ...Object.fromEntries(Object.keys(KIND_ZH).map((kind) => [kind, localizedValue(kind, locale, KIND_ZH)])) }}
            value={kindFilter}
            onValueChange={(v) => setKindFilter(v as string)}
          >
            <SelectTrigger className="w-auto! py-1.5!">
              <SelectValue />
              <SelectIcon />
            </SelectTrigger>
            <SelectContent>
              <SelectList>
              <SelectItem value="">{tx("All kinds", "所有类型")}</SelectItem>
              <SelectItem value="feedback">{localizedValue("feedback", locale, KIND_ZH)}</SelectItem>
              <SelectItem value="bug">{localizedValue("bug", locale, KIND_ZH)}</SelectItem>
              <SelectItem value="crash">{localizedValue("crash", locale, KIND_ZH)}</SelectItem>
            </SelectList>
            </SelectContent>
          </Select>
        </div>
      </div>


      {originPolicy.data?.default_enabled === 1 && (
        <FeedbackBuildScopeSelector value={buildScope} onChange={(value) => {
          const next = new URLSearchParams(searchParams);
          if (value === "standard") next.delete("build_scope"); else next.set("build_scope", value);
          setSearchParams(next, { replace: true });
        }} />
      )}
      <div className="overflow-x-auto">
        {tickets.isLoading && (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        )}
        {tickets.error && (
          <p className="text-sm text-danger">
            {tx("Failed to load feedback:", "加载反馈失败：")} {errorMessage(tickets.error)}
          </p>
        )}
        {!tickets.isLoading && rows.length === 0 && (
          <EmptyState>
            <EmptyStateTitle>{tx("No feedback tickets yet.", "暂无反馈工单。")}</EmptyStateTitle>
          </EmptyState>
        )}
        {rows.length > 0 && (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-foreground-muted border-b border-line-muted">
                <th className="py-2 pr-3">{tx("Ticket", "工单")}</th>
                <th className="py-2 pr-3">{tx("Status", "状态")}</th>
                <th className="py-2 pr-3">{tx("Assignee", "负责人")}</th>
                <th className="py-2 pr-3">{tx("App version", "应用版本")}</th>
                <th className="py-2 pr-3">{tx("Device", "设备")}</th>
                <th className="py-2 pr-3">{tx("Created", "创建时间")}</th>
                <th className="py-2 pr-3">📎</th>
                <th className="py-2 pr-3">💬</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr
                  key={t.id}
                  className="border-b border-line-hairline last:border-0 cursor-pointer hover:bg-fill-muted"
                  onClick={() => navigate(`/apps/${appId}/feedback/${t.id}`)}
                >
                  <td className="py-2 pr-3 max-w-md">
                    <Badge variant={KIND_VARIANTS[t.kind] ?? "muted"} className="mr-2">
                      {localizedValue(t.kind, locale, KIND_ZH)}
                    </Badge>
                    {t.crash_type === "anr" && (
                      <Badge variant="warning" className="mr-2">
                        ANR
                      </Badge>
                    )}
                    {t.build_origin === "external" && <Badge variant="warning" className="mr-2">{tx("External", "外部构建")}</Badge>}
                    {t.build_origin === "unknown" && <Badge variant="muted" className="mr-2">{tx("Origin unknown", "来源未知")}</Badge>}
                    <span className="align-middle">{t.message.slice(0, 80)}{t.message.length > 80 ? "…" : ""}</span>
                  </td>
                  <td className="py-2 pr-3">
                    <Badge variant={STATUS_VARIANTS[t.status] ?? "muted"}>
                      {localizedValue(t.status, locale, STATUS_ZH)}
                    </Badge>
                  </td>
                  <td className="py-2 pr-3 text-xs text-foreground">{t.assignee ?? "—"}</td>
                  <td className="py-2 pr-3 text-xs text-foreground">
                    {t.version_name ?? "—"}{t.version_code ? ` (${t.version_code})` : ""}
                  </td>
                  <td className="py-2 pr-3 text-xs text-foreground">
                    {[t.device_model, t.os_version].filter(Boolean).join(" · ") || "—"}
                  </td>
                  <td className="py-2 pr-3 text-xs text-foreground">
                    {new Date(t.created_at).toLocaleString(locale)}
                  </td>
                  <td className="py-2 pr-3 text-xs">{t.attachment_count || ""}</td>
                  <td className="py-2 pr-3 text-xs">{t.comment_count || ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

type CrashSection = { key: string; label: string; body: string };

/**
 * Split a Hands crash log into sections by its known headers, so the ticket
 * UI can present them as tabs (like Bugly's stack / scene / logs panels).
 */
function parseCrashLog(text: string): CrashSection[] {
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
  const sections: CrashSection[] = [];
  const head = lines.slice(0, marks.length ? marks[0]!.i : lines.length).join("\n").trim();
  if (head) sections.push({ key: "summary", label: "Summary", body: head });
  marks.forEach((m, idx) => {
    const end = idx + 1 < marks.length ? marks[idx + 1]!.i : lines.length;
    const body = lines.slice(m.i + 1, end).join("\n").trimEnd();
    if (body.trim()) sections.push({ key: m.key, label: m.label, body });
  });
  return sections;
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
  const activeSection =
    sections.find((x) => x.key === active) ?? sections[0];

  return (
    <section className="border-t border-line-hairline pt-5">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-medium text-foreground-strong">{tx("Crash detail", "崩溃详情")}</h4>
        {deobfuscated && (active === "stack" || (activeSection?.key === "stack")) && (
          <div className="flex overflow-hidden rounded-md bg-fill-muted text-xs">
            <Button
              size="sm"
              variant={showDeobf ? "default" : "ghost"}
              onClick={() => setShowDeobf(true)}
            >
              {tx("Deobfuscated", "已还原")}
            </Button>
            <Button
              size="sm"
              variant={!showDeobf ? "default" : "ghost"}
              onClick={() => setShowDeobf(false)}
            >
              {tx("Raw", "原始")}
            </Button>
          </div>
        )}
      </div>

      {log.isLoading && <p className="text-xs text-foreground-muted">{tx("Loading…", "加载中…")}</p>}
      {log.error && <p className="text-xs text-danger">{tx("Could not load crash log.", "无法加载崩溃日志。")}</p>}

      {sections.length > 0 && (
        <>
          <div className="mb-2 flex flex-wrap gap-1 border-b border-line-hairline pb-2 text-xs">
            {sections.map((sec) => (
              <Button
                key={sec.key}
                size="sm"
                variant={(activeSection?.key ?? "") === sec.key ? "default" : "ghost"}
                onClick={() => setActive(sec.key)}
              >
                {localizedValue(sec.key, locale, CRASH_SECTION_ZH) === sec.key ? sec.label : localizedValue(sec.key, locale, CRASH_SECTION_ZH)}
              </Button>
            ))}
          </div>
          <pre className="max-h-112 overflow-auto rounded-md bg-layer-hud p-3 text-xs leading-relaxed text-layer-hud-foreground">
            {activeSection?.key === "stack" && deobfuscated && showDeobf
              ? deobfuscated
              : activeSection?.body}
          </pre>
        </>
      )}
    </section>
  );
}

function DeviceScopeBanner({
  appId,
  deviceId,
  onClear,
}: {
  appId: string;
  deviceId: string;
  onClear: () => void;
}) {
  const tx = useText();
  const { locale } = useLocale();
  const detail = useQuery({
    queryKey: ["device-detail", appId, deviceId],
    queryFn: () => getDeviceDetail(appId, deviceId),
  });
  const d = detail.data?.device;
  return (
    <div className="rounded-md bg-fill-muted p-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold">
          {tx("Device", "设备")} <span className="font-mono text-xs">{deviceId}</span>
        </h4>
        <Button variant="link" size="sm" className="text-xs" onClick={onClear}>
          {tx("clear", "清除")}
        </Button>
      </div>
      {d ? (
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
          <div>
            <dt className="text-foreground-muted">{tx("Latest version", "最新版本")}</dt>
            <dd>{d.version_name ?? "—"}{d.version_code ? ` (${d.version_code})` : ""}</dd>
          </div>
          <div>
            <dt className="text-foreground-muted">{tx("Model", "型号")}</dt>
            <dd>{d.device_model ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-foreground-muted">{tx("Platform / OS", "平台 / 系统")}</dt>
            <dd>{[d.platform, d.os_version].filter(Boolean).join(" · ") || "—"}</dd>
          </div>
          <div>
            <dt className="text-foreground-muted">{tx("Last seen", "最后活动时间")}</dt>
            <dd>{new Date(d.last_seen).toLocaleString(locale)}</dd>
          </div>
        </dl>
      ) : (
        <p className="mt-1 text-xs text-foreground-muted">
          {tx("No analytics ping from this device yet — showing its tickets below.", "尚未收到此设备的统计数据；下方显示其工单。")}
        </p>
      )}
    </div>
  );
}

const IMAGE_EXTS = /\.(png|jpe?g|gif|webp|bmp|heic|heif)$/i;

function isImageAttachment(a: { content_type: string | null; filename: string }): boolean {
  return (a.content_type?.startsWith("image/") ?? false) || IMAGE_EXTS.test(a.filename);
}

function AttachmentList({
  appId,
  ticketId,
  attachments,
}: {
  appId: string;
  ticketId: string;
  attachments: Array<{ id: string; filename: string; content_type: string | null; size_bytes: number }>;
}) {
  const tx = useText();
  const [lightbox, setLightbox] = useState<string | null>(null);
  const images = attachments.filter(isImageAttachment);
  const others = attachments.filter((a) => !isImageAttachment(a));

  return (
    <section className="border-t border-line-hairline pt-5">
      <h4 className="mb-3 text-sm font-medium text-foreground-strong">{tx("Attachments", "附件")}</h4>

      {images.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {images.map((a) => {
            return (
              <AttachmentImage
                key={a.id}
                appId={appId}
                ticketId={ticketId}
                attachment={a}
                onOpen={setLightbox}
              />
            );
          })}
        </div>
      )}

      {others.length > 0 && (
        <ul className="space-y-1 text-sm">
          {others.map((a) => (
            <li key={a.id}>
              <Button
                type="button"
                variant="link"
                size="sm"
                onClick={() => void downloadFeedbackAttachment(appId, ticketId, a.id, a.filename)}
              >
                {a.filename}
              </Button>
              <span className="ml-2 text-xs text-foreground-hint">
                {(a.size_bytes / 1024).toFixed(1)} KB
              </span>
            </li>
          ))}
        </ul>
      )}

      {lightbox && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
          onClick={() => setLightbox(null)}
        >
          <img
            src={lightbox}
            alt=""
            className="max-h-full max-w-full rounded-md shadow-lg"
            onClick={(e) => e.stopPropagation()}
          />
          <Button
            variant="ghost"
            size="icon-sm"
            className="absolute right-5 top-5 text-2xl leading-none text-white/90 hover:text-white"
            onClick={() => setLightbox(null)}
            aria-label={tx("Close", "关闭")}
          >
            ×
          </Button>
        </div>
      )}
    </section>
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
    queryFn: async () => URL.createObjectURL(
      await getFeedbackAttachmentBlob(appId, ticketId, attachment.id, true),
    ),
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
            className="group relative h-24 w-24 overflow-hidden rounded-md bg-layer-canvas-muted"
            onClick={() => image.data && onOpen(image.data)}
            disabled={!image.data}
          >
            {image.data && (
              <img
                src={image.data}
                alt={attachment.filename}
                loading="lazy"
                className="h-full w-full object-cover transition group-hover:opacity-90"
              />
            )}
          </button>
        }
      />
      <TooltipContent>{attachment.filename}</TooltipContent>
    </Tooltip>
  );
}

export function FeedbackTicketPage({
  appId,
  ticketId,
}: {
  appId: string;
  ticketId: string;
}) {
  const tx = useText();
  const { locale } = useLocale();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [comment, setComment] = useState("");
  const [assigneeDraft, setAssigneeDraft] = useState<string | null>(null);
  const [pendingClosureReason, setPendingClosureReason] =
    useState<TeamClosureReason | null>(null);
  const [duplicateOfTicketId, setDuplicateOfTicketId] = useState("");

  const detail = useQuery({
    queryKey: ["feedback-detail", appId, ticketId],
    queryFn: () => getFeedback(appId, ticketId),
  });
  const me = useQuery({ queryKey: ["auth-me"], queryFn: getAuthMe });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["feedback-detail", appId, ticketId] });
    queryClient.invalidateQueries({ queryKey: ["feedback", appId] });
  };

  const update = useMutation({
    mutationFn: (body: {
      status?: string;
      assignee?: string | null;
      closure_reason?: FeedbackTicket["closure_reason"];
      duplicate_of_ticket_id?: string | null;
    }) =>
      updateFeedbackTicket(appId, ticketId, body),
    onSuccess: () => {
      setAssigneeDraft(null);
      invalidate();
    },
    onError: (e) =>
      toast.show({ kind: "error", title: tx("Update failed", "更新失败"), description: errorMessage(e) }),
  });

  const addComment = useMutation({
    mutationFn: (internal: boolean) =>
      addFeedbackComment(appId, ticketId, comment.trim(), internal),
    onSuccess: () => {
      setComment("");
      invalidate();
    },
    onError: (e) =>
      toast.show({ kind: "error", title: tx("Comment failed", "评论发送失败"), description: errorMessage(e) }),
  });

  const resymbolicate = useMutation({
    mutationFn: () => resymbolicateFeedback(appId, ticketId),
    onSuccess: (r) => {
      invalidate();
      toast.show({
        kind: r.symbolication_status === "symbolicated" ? "success" : "info",
        title: `${tx("Symbolication", "符号化")}: ${localizedValue(r.symbolication_status ?? "done", locale, SYMBOLICATION_ZH)}`,
      });
    },
    onError: (e) =>
      toast.show({ kind: "error", title: tx("Symbolicate failed", "符号化失败"), description: errorMessage(e) }),
  });

  const t = detail.data?.ticket;
  const myName = me.data?.account?.display_name ?? null;
  const pendingClosure = TEAM_CLOSURE_REASONS.find(
    (item) => item.reason === pendingClosureReason,
  );
  const submitClosure = () => {
    if (!pendingClosureReason) return;
    update.mutate(
      {
        status: "closed",
        closure_reason: pendingClosureReason,
        duplicate_of_ticket_id:
          pendingClosureReason === "duplicate" ? duplicateOfTicketId.trim() : null,
      },
      {
        onSuccess: () => {
          setPendingClosureReason(null);
          setDuplicateOfTicketId("");
        },
      },
    );
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center gap-2 text-sm">
        <Link to={`/apps/${appId}/feedback`} className="text-info-strong hover:underline">
          ← {tx("Feedback", "反馈")}
        </Link>
      </div>

      {detail.isLoading && <p className="text-sm text-foreground-muted">{tx("Loading…", "加载中…")}</p>}
      {detail.error && (
        <p className="text-sm text-danger">{errorMessage(detail.error)}</p>
      )}
      {t && (
        <>
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <div className="flex items-center gap-2">
                <Badge variant={KIND_VARIANTS[t.kind] ?? "muted"}>{localizedValue(t.kind, locale, KIND_ZH)}</Badge>
                <Badge variant={STATUS_VARIANTS[t.status] ?? "muted"}>{localizedValue(t.status, locale, STATUS_ZH)}</Badge>
                {t.assignee && (
                  <span className="rounded-sm bg-accent-soft px-1.5 py-0.5 text-xs font-medium text-accent-strong">
                    {t.assignee}
                  </span>
                )}
              </div>
              <h2 className="mt-2 text-lg font-semibold">{tx("Ticket", "工单")} {t.id.slice(0, 8)}</h2>
              <p className="text-xs text-foreground-muted">
                {new Date(t.created_at).toLocaleString(locale)}
                {t.contact ? ` · ${t.contact}` : ""}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {STATUSES.map((s) => (
                <Button
                  key={s}
                  size="sm"
                  variant={s === t.status ? "default" : "ghost"}
                  disabled={update.isPending || s === t.status}
                  onClick={() => update.mutate({ status: s })}
                >
                  {localizedValue(s, locale, STATUS_ZH)}
                </Button>
              ))}
              {t.status !== "closed" && (
                <div className="inline-flex">
                  <Button
                    size="sm"
                    variant="primary"
                    className="rounded-r-none"
                    disabled={update.isPending}
                    onClick={() => setPendingClosureReason("completed")}
                  >
                    {tx("Completed", "已完成")}
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          type="button"
                          size="sm"
                          variant="primary"
                          className="min-w-11 rounded-l-none border-l-0 px-3"
                          disabled={update.isPending}
                          aria-label={tx("Choose a close reason", "选择关闭原因")}
                        />
                      }
                    >
                      <ChevronDown aria-hidden="true" className="size-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-80 max-w-[calc(100vw-24px)]">
                      {TEAM_CLOSURE_REASONS.map((item) => (
                        <DropdownMenuItem
                          key={item.reason}
                          className="items-start whitespace-normal"
                          onClick={() => setPendingClosureReason(item.reason)}
                        >
                          {item.reason === "completed" ? (
                            <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                          ) : (
                            <span aria-hidden="true" className="size-4 shrink-0" />
                          )}
                          <span>
                            <strong className="block">{locale === "zh-CN" ? CLOSURE_ZH[item.reason]!.label : item.label}</strong>
                            <span className="mt-0.5 block text-xs text-foreground-muted">
                              {locale === "zh-CN" ? CLOSURE_ZH[item.reason]!.description : item.description}
                            </span>
                          </span>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              )}
            </div>
          </div>

          {t.status === "closed" && t.closure_reason && (
            <div className="rounded-md bg-fill-muted p-3 text-sm">
              <div className="font-medium text-foreground-strong">{tx("Closed as", "关闭原因：")} {closureReasonLabel(t.closure_reason, locale)}</div>
              {t.duplicate_of_ticket_id && (
                <Link
                  to={`/apps/${appId}/feedback/${t.duplicate_of_ticket_id}`}
                  className="mt-1 inline-block font-mono text-xs text-info-strong hover:underline"
                >
                  {tx("Original ticket", "原工单")} {t.duplicate_of_ticket_id}
                </Link>
              )}
            </div>
          )}

          <MarkdownText source={t.message} className="text-sm leading-relaxed" />

          <section className="border-t border-line-hairline pt-5">
            <h4 className="mb-2 text-sm font-medium text-foreground-strong">{tx("Assignee", "负责人")}</h4>
            <div className="flex items-center gap-2 text-sm flex-wrap">
              {assigneeDraft === null ? (
                <>
                  <span>{t.assignee ?? tx("Unassigned", "未分配")}</span>
                  {myName && t.assignee !== myName && (
                    <Button
                      variant="link"
                      size="sm"
                      className="text-xs"
                      disabled={update.isPending}
                      onClick={() => update.mutate({ assignee: myName })}
                    >
                      {tx("Assign to me", "分配给我")}
                    </Button>
                  )}
                  <Button
                    variant="link"
                    size="sm"
                    className="text-xs"
                    onClick={() => setAssigneeDraft(t.assignee ?? "")}
                  >
                    {tx("Edit", "编辑")}
                  </Button>
                  {t.assignee && (
                    <Button
                      variant="link"
                      size="sm"
                      className="text-xs text-danger"
                      disabled={update.isPending}
                      onClick={() => update.mutate({ assignee: null })}
                    >
                      {tx("Unassign", "取消分配")}
                    </Button>
                  )}
                </>
              ) : (
                <>
                  <Input
                    className="max-w-64 text-sm"
                    value={assigneeDraft}
                    autoFocus
                    onChange={(e) => setAssigneeDraft(e.target.value)}
                    placeholder={tx("Name of the person handling this", "负责人的姓名")}
                  />
                  <Button
                    variant="primary"
                    className="text-xs"
                    disabled={update.isPending}
                    onClick={() => update.mutate({ assignee: assigneeDraft.trim() || null })}
                  >
                    {tx("Save", "保存")}
                  </Button>
                  <Button variant="outline" className="text-xs" onClick={() => setAssigneeDraft(null)}>
                    {tx("Cancel", "取消")}
                  </Button>
                </>
              )}
            </div>
          </section>

          <section className="border-t border-line-hairline pt-5">
            <h4 className="mb-2 text-sm font-medium text-foreground-strong">{tx("Environment", "环境")}</h4>
            {(() => {
              // Generic render of every reported environment field (task #105):
              // no hardcoded property allowlist — parse the ticket metadata and
              // list each field, so new SDK-reported fields show up with zero
              // UI changes. crash_* keys feed the symbolication panel below and
              // are excluded here. version_code / device_id keep their filter
              // links; commit is shown monospace.
              let meta: Record<string, unknown> = {};
              try {
                const parsed = JSON.parse(t.metadata_json || "{}");
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                  meta = parsed as Record<string, unknown>;
                }
              } catch {
                /* malformed metadata — fall through to empty */
              }
              const entries = Object.entries(meta)
                .filter(
                  ([k, v]) =>
                    !k.startsWith("crash_") &&
                    k !== "breadcrumbs" &&
                    k !== "stacktrace" &&
                    k !== "exception_class" &&
                    k !== "exception_message" &&
                    k !== "top_frame" &&
                    k !== "handled" &&
                    v !== null &&
                    v !== undefined &&
                    v !== "",
                )
                .sort(([a], [b]) => a.localeCompare(b));
              if (entries.length === 0) {
                return (
                  <p className="text-xs text-foreground-muted">
                    {tx("No environment data reported.", "未报告环境信息。")}
                  </p>
                );
              }
              const label = (k: string) =>
                locale === "zh-CN" ? (ENVIRONMENT_ZH[k] ?? k) : k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
              const format = (v: unknown) =>
                typeof v === "object" ? JSON.stringify(v) : String(v);
              const mono = (k: string) =>
                k === "device_id" || k === "commit" || k === "git_commit";
              return (
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                  {entries.map(([k, v]) => (
                    <Fragment key={k}>
                      <dt className="text-foreground-muted">{label(k)}</dt>
                      <dd className={mono(k) ? "font-mono break-all" : "break-all"}>
                        {k === "version_code" ? (
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Button
                                  variant="link"
                                  size="sm"
                                  onClick={() =>
                                    navigate(
                                      `/apps/${appId}/feedback?version_code=${encodeURIComponent(format(v))}`,
                                    )
                                  }
                                >
                                  {format(v)}
                                </Button>
                              }
                            />
                            <TooltipContent>{tx("All feedback on this version", "此版本的全部反馈")}</TooltipContent>
                          </Tooltip>
                        ) : k === "device_id" ? (
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Button
                                  variant="link"
                                  size="sm"
                                  className="font-mono break-all"
                                  onClick={() =>
                                    navigate(
                                      `/apps/${appId}/feedback?device_id=${encodeURIComponent(format(v))}`,
                                    )
                                  }
                                >
                                  {format(v)}
                                </Button>
                              }
                            />
                            <TooltipContent>{tx("This device's history", "此设备的历史记录")}</TooltipContent>
                          </Tooltip>
                        ) : (
                          format(v)
                        )}
                      </dd>
                    </Fragment>
                  ))}
                </dl>
              );
            })()}
          </section>

          {(() => {
            let meta: Record<string, unknown> = {};
            try {
              const parsed = JSON.parse(t.metadata_json || "{}");
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) meta = parsed as Record<string, unknown>;
            } catch { /* ignore */ }
            const stacktrace = typeof meta.stacktrace === "string" ? meta.stacktrace : null;
            const excClass = typeof meta.exception_class === "string" ? meta.exception_class : null;
            const excMsg = typeof meta.exception_message === "string" ? meta.exception_message : null;
            if (!stacktrace && !excClass) return null;
            return (
              <section className="border-t border-line-hairline pt-5">
                <h4 className="mb-2 text-sm font-medium text-foreground-strong">{tx("Exception", "异常")}</h4>
                {excClass && (
                  <p className="text-sm font-mono text-danger mb-2 break-all">
                    {excClass}{excMsg ? `: ${excMsg}` : ""}
                  </p>
                )}
                {stacktrace && (
                  <pre className="text-xs bg-layer-canvas-muted rounded p-3 overflow-x-auto max-h-80 overflow-y-auto whitespace-pre-wrap break-all">
                    {stacktrace}
                  </pre>
                )}
              </section>
            );
          })()}

          {(() => {
            let meta: Record<string, unknown> = {};
            try {
              const parsed = JSON.parse(t.metadata_json || "{}");
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) meta = parsed as Record<string, unknown>;
            } catch { /* ignore */ }
            let crumbs: Array<{ timestamp?: number; category?: string; message?: string; level?: string }> = [];
            if (Array.isArray(meta.breadcrumbs)) crumbs = meta.breadcrumbs as typeof crumbs;
            else if (typeof meta.breadcrumbs === "string") {
              try { const p = JSON.parse(meta.breadcrumbs); if (Array.isArray(p)) crumbs = p; } catch { /* ignore */ }
            }
            if (crumbs.length === 0) return null;
            const levelColor = (l?: string) =>
              l === "error" ? "text-danger" : l === "warning" ? "text-warning" : "text-foreground";
            return (
              <section className="border-t border-line-hairline pt-5">
                <h4 className="mb-2 text-sm font-medium text-foreground-strong">{tx("Breadcrumbs", "操作轨迹")} ({crumbs.length})</h4>
                <ol className="space-y-1 text-xs max-h-60 overflow-y-auto">
                  {crumbs.map((bc, i) => (
                    <li key={i} className="flex gap-2 items-baseline">
                      <span className="text-foreground-hint tabular-nums shrink-0">
                        {bc.timestamp ? new Date(bc.timestamp).toLocaleTimeString(locale) : "—"}
                      </span>
                      <span className="font-medium text-foreground-strong shrink-0">{bc.category ?? tx("general", "常规")}</span>
                      <span className={`break-all ${levelColor(bc.level)}`}>{bc.message ?? ""}</span>
                    </li>
                  ))}
                </ol>
              </section>
            );
          })()}

          {(t.kind === "crash" || t.kind === "error") &&
            (() => {
              const log = detail.data!.attachments.find(
                (a) => (a.content_type?.startsWith("text/") ?? false) || /\.txt$/i.test(a.filename),
              );
              const symStatus = t.symbolication_status;
              const symStack = t.symbolicated_stack ?? undefined;
              const badgeVariant: BadgeVariant =
                symStatus === "symbolicated"
                  ? "success"
                  : symStatus === "no_symbols"
                    ? "warning"
                    : symStatus === "failed"
                      ? "danger"
                      : "muted";
              return (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-medium">{tx("Symbolication", "符号化")}</span>
                    <Badge variant={badgeVariant}>
                      {symStatus ? localizedValue(symStatus, locale, SYMBOLICATION_ZH) : tx("not run", "尚未运行")}
                    </Badge>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={resymbolicate.isPending}
                      onClick={() => resymbolicate.mutate()}
                    >
                      {resymbolicate.isPending ? tx("Symbolicating…", "正在符号化…") : tx("Re-run", "重新运行")}
                    </Button>
                  </div>
                  {log ? (
                    <CrashLogView
                      appId={appId}
                      ticketId={ticketId}
                      attachmentId={log.id}
                      deobfuscated={symStack}
                    />
                  ) : symStack ? (
                    <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-layer-canvas-muted p-3 text-xs">
                      {symStack}
                    </pre>
                  ) : null}
                </div>
              );
            })()}

          {detail.data!.attachments.length > 0 && (
            <AttachmentList
              appId={appId}
              ticketId={ticketId}
              attachments={detail.data!.attachments}
            />
          )}

          <section className="border-t border-line-hairline pt-5">
            <h4 className="mb-3 text-sm font-medium text-foreground-strong">
              {tx("Comments", "评论")} ({detail.data!.comments.length})
            </h4>
            <ul className="space-y-4 text-sm">
              {detail.data!.comments.map((cm, index) => (
                <li
                  key={cm.id}
                  className={index === 0 ? "" : "border-t border-line-hairline pt-4"}
                >
                  <div className="flex items-center justify-between gap-2 text-xs text-foreground-muted">
                    <span>
                      <span className="font-medium text-foreground-strong">{cm.author_actor}</span> ·{" "}
                      {new Date(cm.created_at).toLocaleString(locale)}
                    </span>
                    {cm.internal ? (
                      <Badge variant="warning">{feedbackMessage("internalNote", [locale])}</Badge>
                    ) : (
                      <Badge variant="muted">{feedbackMessage("visibleToReporter", [locale])}</Badge>
                    )}
                  </div>
                  <MarkdownText source={cm.body} className="mt-1.5 leading-relaxed" />
                </li>
              ))}
            </ul>
            <div className="mt-4">
              <textarea
                rows={3}
                className="w-full resize-y rounded-md border border-line-muted bg-layer-panel px-2 py-1.5 text-sm"
                placeholder={tx("Add a comment…", "添加评论…")}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && comment.trim()) {
                    addComment.mutate(true);
                  }
                }}
              />
              <div className="mt-2 flex justify-end gap-2">
                <Button
                  className="text-sm"
                  disabled={addComment.isPending || !comment.trim()}
                  onClick={() => addComment.mutate(true)}
                >
                  {feedbackMessage("addInternalNote", [locale])}
                </Button>
                <Button
                  variant="primary"
                  className="text-sm"
                  disabled={addComment.isPending || !comment.trim()}
                  onClick={() => addComment.mutate(false)}
                >
                  {feedbackMessage("sendToReporter", [locale])}
                </Button>
              </div>
            </div>
          </section>
        </>
      )}
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
          <AlertDialogBody className="space-y-3">
            <AlertDialogDescription>
              {pendingClosure && (locale === "zh-CN" ? CLOSURE_ZH[pendingClosure.reason]!.description : pendingClosure.description)}
            </AlertDialogDescription>
            {pendingClosureReason === "duplicate" && (
              <label className="block text-sm font-medium">
                {tx("Original ticket ID", "原工单 ID")}
                <Input
                  className="mt-1"
                  value={duplicateOfTicketId}
                  onChange={(event) => setDuplicateOfTicketId(event.target.value)}
                  placeholder={tx("Full ID or a unique prefix", "完整 ID 或唯一前缀")}
                  autoFocus
                />
              </label>
            )}
          </AlertDialogBody>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={update.isPending}>{tx("Cancel", "取消")}</AlertDialogCancel>
            <AlertDialogAction
              variant="primary"
              loading={update.isPending}
              disabled={
                update.isPending
                || (pendingClosureReason === "duplicate" && !duplicateOfTicketId.trim())
              }
              onClick={submitClosure}
            >
              {tx("Close ticket", "关闭工单")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
