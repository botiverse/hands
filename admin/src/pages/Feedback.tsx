/**
 * Feedback ticket triage (task #66): list + filter tickets, and a routed
 * per-ticket page (/apps/:appId/feedback/:ticketId) so tickets are
 * shareable links. Tickets carry an assignee, status flow, and comments.
 */
import { Fragment, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  addFeedbackComment,
  downloadFeedbackAttachment,
  getAuthMe,
  getFeedback,
  getFeedbackAttachmentBlob,
  listFeedback,
  getDeviceDetail,
  getFeedbackAttachmentText,
  updateFeedbackTicket,
} from "../lib/api";
import { useToast } from "../components/Toast";
import { FeedbackTrends } from "../components/FeedbackTrends";

const STATUSES = ["open", "in_progress", "resolved", "closed"] as const;

const STATUS_STYLES: Record<string, string> = {
  open: "bg-red-100 text-red-800",
  in_progress: "bg-sky-100 text-sky-800",
  resolved: "bg-emerald-100 text-emerald-800",
  closed: "bg-slate-200 text-slate-600",
};

const KIND_STYLES: Record<string, string> = {
  feedback: "bg-slate-100 text-slate-700",
  bug: "bg-amber-100 text-amber-800",
  crash: "bg-red-100 text-red-800",
};

export function AppFeedback({ appId }: { appId: string }) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [kindFilter, setKindFilter] = useState<string>(searchParams.get("kind") ?? "");
  const deviceFilter = searchParams.get("device_id") ?? "";
  const versionFilter = searchParams.get("version_code") ?? "";
  const signatureFilter = searchParams.get("signature") ?? "";

  const tickets = useQuery({
    queryKey: ["feedback", appId, statusFilter, kindFilter, deviceFilter, versionFilter, signatureFilter],
    queryFn: () =>
      listFeedback(appId, {
        status: statusFilter || undefined,
        // Feedback tab = user feedback + bugs; crashes live in the Crashes
        // tab. An explicit kind/signature filter overrides this.
        kind: kindFilter || (signatureFilter ? "crash" : "feedback,bug"),
        deviceId: deviceFilter || undefined,
        versionCode: versionFilter ? Number(versionFilter) : undefined,
        signature: signatureFilter || undefined,
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
        <div className="card py-2! px-3! flex items-center justify-between text-sm">
          <span>
            Filtered to version code <span className="font-mono">{versionFilter}</span>
          </span>
          <button className="text-blue-600 hover:underline text-xs" onClick={() => clearScopeFilter("version_code")}>
            clear
          </button>
        </div>
      )}
      {signatureFilter && (
        <div className="card p-3!">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs text-slate-500">Crash signature</div>
              <code className="text-xs break-all">{signatureFilter}</code>
              {rows.length > 0 && (
                <div className="mt-1 text-xs text-slate-500">
                  {rows.length} instance{rows.length === 1 ? "" : "s"} ·{" "}
                  {new Set(rows.map((r) => r.version_code).filter(Boolean)).size} version(s) ·{" "}
                  {new Set(rows.map((r) => r.device_id).filter(Boolean)).size} device(s)
                </div>
              )}
            </div>
            <button className="text-blue-600 hover:underline text-xs flex-none" onClick={() => clearScopeFilter("signature")}>
              clear
            </button>
          </div>
        </div>
      )}
      {!deviceFilter && !versionFilter && !signatureFilter && <FeedbackTrends appId={appId} />}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-lg font-semibold">Feedback</h2>
          <p className="text-sm text-slate-500">
            Tickets submitted from the app (SDK <code>POST /public/v2/apps/&lt;slug&gt;/feedback</code>).
          </p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <select
            className="input w-auto! py-1.5!"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <select
            className="input w-auto! py-1.5!"
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value)}
          >
            <option value="">All kinds</option>
            <option value="feedback">feedback</option>
            <option value="bug">bug</option>
            <option value="crash">crash</option>
          </select>
        </div>
      </div>


      <div className="card overflow-x-auto">
        {tickets.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
        {tickets.error && (
          <p className="text-sm text-red-600">
            Failed to load feedback: {(tickets.error as Error).message}
          </p>
        )}
        {!tickets.isLoading && rows.length === 0 && (
          <p className="text-sm text-slate-500">No feedback tickets yet.</p>
        )}
        {rows.length > 0 && (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                <th className="py-2 pr-3">Ticket</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2 pr-3">Assignee</th>
                <th className="py-2 pr-3">App version</th>
                <th className="py-2 pr-3">Device</th>
                <th className="py-2 pr-3">Created</th>
                <th className="py-2 pr-3">📎</th>
                <th className="py-2 pr-3">💬</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr
                  key={t.id}
                  className="border-b border-slate-100 last:border-0 cursor-pointer hover:bg-slate-50"
                  onClick={() => navigate(`/apps/${appId}/feedback/${t.id}`)}
                >
                  <td className="py-2 pr-3 max-w-md">
                    <span className={`rounded-sm px-1.5 py-0.5 text-xs font-medium mr-2 ${KIND_STYLES[t.kind]}`}>
                      {t.kind}
                    </span>
                    <span className="align-middle">{t.message.slice(0, 80)}{t.message.length > 80 ? "…" : ""}</span>
                  </td>
                  <td className="py-2 pr-3">
                    <span className={`rounded-sm px-1.5 py-0.5 text-xs font-medium ${STATUS_STYLES[t.status]}`}>
                      {t.status}
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-xs text-slate-600">{t.assignee ?? "—"}</td>
                  <td className="py-2 pr-3 text-xs text-slate-600">
                    {t.version_name ?? "—"}{t.version_code ? ` (${t.version_code})` : ""}
                  </td>
                  <td className="py-2 pr-3 text-xs text-slate-600">
                    {[t.device_model, t.os_version].filter(Boolean).join(" · ") || "—"}
                  </td>
                  <td className="py-2 pr-3 text-xs text-slate-600">
                    {new Date(t.created_at).toLocaleString()}
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
    <div className="card">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">Crash detail</h4>
        {deobfuscated && (active === "stack" || (activeSection?.key === "stack")) && (
          <div className="flex overflow-hidden rounded-md border border-slate-200 text-xs">
            <button
              className={`px-2 py-0.5 ${showDeobf ? "bg-slate-100 font-medium" : "text-slate-500"}`}
              onClick={() => setShowDeobf(true)}
            >
              Deobfuscated
            </button>
            <button
              className={`px-2 py-0.5 ${!showDeobf ? "bg-slate-100 font-medium" : "text-slate-500"}`}
              onClick={() => setShowDeobf(false)}
            >
              Raw
            </button>
          </div>
        )}
      </div>

      {log.isLoading && <p className="text-xs text-slate-500">Loading…</p>}
      {log.error && <p className="text-xs text-red-600">Could not load crash log.</p>}

      {sections.length > 0 && (
        <>
          <div className="mb-2 flex flex-wrap gap-1 border-b border-slate-100 pb-2 text-xs">
            {sections.map((sec) => (
              <button
                key={sec.key}
                className={`rounded-md px-2 py-1 ${
                  (activeSection?.key ?? "") === sec.key
                    ? "bg-slate-100 font-medium text-slate-950"
                    : "text-slate-600 hover:bg-slate-50"
                }`}
                onClick={() => setActive(sec.key)}
              >
                {sec.label}
              </button>
            ))}
          </div>
          <pre className="max-h-112 overflow-auto rounded-md bg-slate-950 p-3 text-xs leading-relaxed text-slate-100">
            {activeSection?.key === "stack" && deobfuscated && showDeobf
              ? deobfuscated
              : activeSection?.body}
          </pre>
        </>
      )}
    </div>
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
  const detail = useQuery({
    queryKey: ["device-detail", appId, deviceId],
    queryFn: () => getDeviceDetail(appId, deviceId),
  });
  const d = detail.data?.device;
  return (
    <div className="card p-3!">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold">
          Device <span className="font-mono text-xs">{deviceId}</span>
        </h4>
        <button className="text-blue-600 hover:underline text-xs" onClick={onClear}>
          clear
        </button>
      </div>
      {d ? (
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
          <div>
            <dt className="text-slate-500">Latest version</dt>
            <dd>{d.version_name ?? "—"}{d.version_code ? ` (${d.version_code})` : ""}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Model</dt>
            <dd>{d.device_model ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Platform / OS</dt>
            <dd>{[d.platform, d.os_version].filter(Boolean).join(" · ") || "—"}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Last seen</dt>
            <dd>{new Date(d.last_seen).toLocaleString()}</dd>
          </div>
        </dl>
      ) : (
        <p className="mt-1 text-xs text-slate-500">
          No analytics ping from this device yet — showing its tickets below.
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
  const [lightbox, setLightbox] = useState<string | null>(null);
  const images = attachments.filter(isImageAttachment);
  const others = attachments.filter((a) => !isImageAttachment(a));

  return (
    <div className="card">
      <h4 className="text-sm font-semibold mb-2">Attachments</h4>

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
              <button
                type="button"
                className="text-blue-600 hover:underline"
                onClick={() => void downloadFeedbackAttachment(appId, ticketId, a.id, a.filename)}
              >
                {a.filename}
              </button>
              <span className="ml-2 text-xs text-slate-400">
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
          <button
            className="absolute right-5 top-5 text-2xl leading-none text-white/90 hover:text-white"
            onClick={() => setLightbox(null)}
            aria-label="Close"
          >
            ×
          </button>
        </div>
      )}
    </div>
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
    <button
      type="button"
      className="group relative h-24 w-24 overflow-hidden rounded-md border border-slate-200 bg-slate-50"
      onClick={() => image.data && onOpen(image.data)}
      title={attachment.filename}
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
  );
}

export function FeedbackTicketPage({
  appId,
  ticketId,
}: {
  appId: string;
  ticketId: string;
}) {
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [comment, setComment] = useState("");
  const [assigneeDraft, setAssigneeDraft] = useState<string | null>(null);

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
    mutationFn: (body: { status?: string; assignee?: string | null }) =>
      updateFeedbackTicket(appId, ticketId, body),
    onSuccess: () => {
      setAssigneeDraft(null);
      invalidate();
    },
    onError: (e) =>
      toast.show({ kind: "error", title: "Update failed", description: (e as Error).message }),
  });

  const addComment = useMutation({
    mutationFn: () => addFeedbackComment(appId, ticketId, comment.trim()),
    onSuccess: () => {
      setComment("");
      invalidate();
    },
    onError: (e) =>
      toast.show({ kind: "error", title: "Comment failed", description: (e as Error).message }),
  });

  const t = detail.data?.ticket;
  const myName = me.data?.account?.display_name ?? null;

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex items-center gap-2 text-sm">
        <Link to={`/apps/${appId}/feedback`} className="text-blue-600 hover:underline">
          ← Feedback
        </Link>
      </div>

      {detail.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {detail.error && (
        <p className="text-sm text-red-600">{(detail.error as Error).message}</p>
      )}
      {t && (
        <>
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <div className="flex items-center gap-2">
                <span className={`rounded-sm px-1.5 py-0.5 text-xs font-medium ${KIND_STYLES[t.kind]}`}>{t.kind}</span>
                <span className={`rounded-sm px-1.5 py-0.5 text-xs font-medium ${STATUS_STYLES[t.status]}`}>{t.status}</span>
                {t.assignee && (
                  <span className="rounded-sm bg-violet-100 px-1.5 py-0.5 text-xs font-medium text-violet-800">
                    {t.assignee}
                  </span>
                )}
              </div>
              <h2 className="mt-2 text-lg font-semibold">Ticket {t.id.slice(0, 8)}</h2>
              <p className="text-xs text-slate-500">
                {new Date(t.created_at).toLocaleString()}
                {t.contact ? ` · ${t.contact}` : ""}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {STATUSES.map((s) => (
                <button
                  key={s}
                  className={
                    s === t.status
                      ? "rounded-sm border border-slate-900 bg-slate-900 px-2 py-1 text-xs text-white"
                      : "rounded-sm border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100"
                  }
                  disabled={update.isPending || s === t.status}
                  onClick={() => update.mutate({ status: s })}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          <div className="card text-sm whitespace-pre-wrap">{t.message}</div>

          <div className="card">
            <h4 className="text-sm font-semibold mb-2">Assignee</h4>
            <div className="flex items-center gap-2 text-sm flex-wrap">
              {assigneeDraft === null ? (
                <>
                  <span>{t.assignee ?? "Unassigned"}</span>
                  {myName && t.assignee !== myName && (
                    <button
                      className="rounded-sm border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100"
                      disabled={update.isPending}
                      onClick={() => update.mutate({ assignee: myName })}
                    >
                      Assign to me
                    </button>
                  )}
                  <button
                    className="rounded-sm border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100"
                    onClick={() => setAssigneeDraft(t.assignee ?? "")}
                  >
                    Edit
                  </button>
                  {t.assignee && (
                    <button
                      className="rounded-sm border border-slate-300 px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                      disabled={update.isPending}
                      onClick={() => update.mutate({ assignee: null })}
                    >
                      Unassign
                    </button>
                  )}
                </>
              ) : (
                <>
                  <input
                    className="rounded-sm border border-slate-300 px-2 py-1 text-sm"
                    value={assigneeDraft}
                    autoFocus
                    onChange={(e) => setAssigneeDraft(e.target.value)}
                    placeholder="Name of the person handling this"
                  />
                  <button
                    className="btn-primary text-xs"
                    disabled={update.isPending}
                    onClick={() => update.mutate({ assignee: assigneeDraft.trim() || null })}
                  >
                    Save
                  </button>
                  <button className="btn-secondary text-xs" onClick={() => setAssigneeDraft(null)}>
                    Cancel
                  </button>
                </>
              )}
            </div>
          </div>

          <div className="card">
            <h4 className="text-sm font-semibold mb-2">Environment</h4>
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
                    v !== null &&
                    v !== undefined &&
                    v !== "",
                )
                .sort(([a], [b]) => a.localeCompare(b));
              if (entries.length === 0) {
                return (
                  <p className="text-xs text-slate-500">
                    No environment data reported.
                  </p>
                );
              }
              const label = (k: string) =>
                k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
              const format = (v: unknown) =>
                typeof v === "object" ? JSON.stringify(v) : String(v);
              const mono = (k: string) =>
                k === "device_id" || k === "commit" || k === "git_commit";
              return (
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                  {entries.map(([k, v]) => (
                    <Fragment key={k}>
                      <dt className="text-slate-500">{label(k)}</dt>
                      <dd className={mono(k) ? "font-mono break-all" : "break-all"}>
                        {k === "version_code" ? (
                          <button
                            className="text-blue-600 hover:underline"
                            title="All feedback on this version"
                            onClick={() =>
                              navigate(
                                `/apps/${appId}/feedback?version_code=${encodeURIComponent(format(v))}`,
                              )
                            }
                          >
                            {format(v)}
                          </button>
                        ) : k === "device_id" ? (
                          <button
                            className="text-blue-600 hover:underline font-mono break-all"
                            title="This device's history"
                            onClick={() =>
                              navigate(
                                `/apps/${appId}/feedback?device_id=${encodeURIComponent(format(v))}`,
                              )
                            }
                          >
                            {format(v)}
                          </button>
                        ) : (
                          format(v)
                        )}
                      </dd>
                    </Fragment>
                  ))}
                </dl>
              );
            })()}
          </div>

          {t.kind === "crash" &&
            (() => {
              const log = detail.data!.attachments.find(
                (a) => (a.content_type?.startsWith("text/") ?? false) || /\.txt$/i.test(a.filename),
              );
              const deobfuscated = detail.data!.comments.find(
                (cm) => cm.author_actor === "quiver-retrace" || cm.author_actor === "quiver-symbolicate",
              )?.body;
              return log ? (
                <CrashLogView
                  appId={appId}
                  ticketId={ticketId}
                  attachmentId={log.id}
                  deobfuscated={deobfuscated}
                />
              ) : null;
            })()}

          {detail.data!.attachments.length > 0 && (
            <AttachmentList
              appId={appId}
              ticketId={ticketId}
              attachments={detail.data!.attachments}
            />
          )}

          <div className="card">
            <h4 className="text-sm font-semibold mb-1">
              Comments ({detail.data!.comments.length})
            </h4>
            <ul className="space-y-2 text-sm">
              {detail.data!.comments.map((cm) => (
                <li key={cm.id} className="rounded-sm border border-slate-200 p-2">
                  <div className="text-xs text-slate-500">
                    {cm.author_actor} · {new Date(cm.created_at).toLocaleString()}
                  </div>
                  <div className="whitespace-pre-wrap">{cm.body}</div>
                </li>
              ))}
            </ul>
            <div className="mt-2 flex gap-2">
              <input
                className="flex-1 rounded-sm border border-slate-300 px-2 py-1.5 text-sm"
                placeholder="Add a comment…"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && comment.trim()) addComment.mutate();
                }}
              />
              <button
                className="btn-primary text-sm"
                disabled={addComment.isPending || !comment.trim()}
                onClick={() => addComment.mutate()}
              >
                Send
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
