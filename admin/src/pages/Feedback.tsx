/**
 * Feedback ticket triage (task #66): list + filter tickets, and a routed
 * per-ticket page (/apps/:appId/feedback/:ticketId) so tickets are
 * shareable links. Tickets carry an assignee, status flow, and comments.
 */
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  addFeedbackComment,
  feedbackAttachmentUrl,
  feedbackAttachmentInlineUrl,
  getAuthMe,
  getFeedback,
  listFeedback,
  getDeviceDetail,
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

  const tickets = useQuery({
    queryKey: ["feedback", appId, statusFilter, kindFilter, deviceFilter, versionFilter],
    queryFn: () =>
      listFeedback(appId, {
        status: statusFilter || undefined,
        kind: kindFilter || undefined,
        deviceId: deviceFilter || undefined,
        versionCode: versionFilter ? Number(versionFilter) : undefined,
      }),
  });

  const clearScopeFilter = (key: "device_id" | "version_code") => {
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
        <div className="card !py-2 !px-3 flex items-center justify-between text-sm">
          <span>
            Filtered to version code <span className="font-mono">{versionFilter}</span>
          </span>
          <button className="text-blue-600 hover:underline text-xs" onClick={() => clearScopeFilter("version_code")}>
            clear
          </button>
        </div>
      )}
      {!deviceFilter && !versionFilter && <FeedbackTrends appId={appId} />}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-lg font-semibold">Feedback</h2>
          <p className="text-sm text-slate-500">
            Tickets submitted from the app (SDK <code>POST /public/v2/apps/&lt;slug&gt;/feedback</code>).
          </p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <select
            className="input !w-auto !py-1.5"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <select
            className="input !w-auto !py-1.5"
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
                    <span className={`rounded px-1.5 py-0.5 text-xs font-medium mr-2 ${KIND_STYLES[t.kind]}`}>
                      {t.kind}
                    </span>
                    <span className="align-middle">{t.message.slice(0, 80)}{t.message.length > 80 ? "…" : ""}</span>
                  </td>
                  <td className="py-2 pr-3">
                    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_STYLES[t.status]}`}>
                      {t.status}
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-xs text-slate-600">{t.assignee ?? "—"}</td>
                  <td className="py-2 pr-3 text-xs text-slate-600">
                    {t.version_name ?? "—"}{t.version_code ? ` (${t.version_code})` : ""}
                  </td>
                  <td className="py-2 pr-3 text-xs text-slate-600">
                    {[t.device_model, t.os_version && `Android ${t.os_version}`].filter(Boolean).join(" · ") || "—"}
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
    <div className="card !p-3">
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
            const url = feedbackAttachmentInlineUrl(appId, ticketId, a.id);
            return (
              <button
                key={a.id}
                type="button"
                className="group relative h-24 w-24 overflow-hidden rounded-md border border-slate-200 bg-slate-50"
                onClick={() => setLightbox(url)}
                title={a.filename}
              >
                <img
                  src={url}
                  alt={a.filename}
                  loading="lazy"
                  className="h-full w-full object-cover transition group-hover:opacity-90"
                />
              </button>
            );
          })}
        </div>
      )}

      {others.length > 0 && (
        <ul className="space-y-1 text-sm">
          {others.map((a) => (
            <li key={a.id}>
              <a
                className="text-blue-600 hover:underline"
                href={feedbackAttachmentUrl(appId, ticketId, a.id)}
                target="_blank"
                rel="noopener noreferrer"
              >
                {a.filename}
              </a>
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
                <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${KIND_STYLES[t.kind]}`}>{t.kind}</span>
                <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_STYLES[t.status]}`}>{t.status}</span>
                {t.assignee && (
                  <span className="rounded bg-violet-100 px-1.5 py-0.5 text-xs font-medium text-violet-800">
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
                      ? "rounded border border-slate-900 bg-slate-900 px-2 py-1 text-xs text-white"
                      : "rounded border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100"
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
                      className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100"
                      disabled={update.isPending}
                      onClick={() => update.mutate({ assignee: myName })}
                    >
                      Assign to me
                    </button>
                  )}
                  <button
                    className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100"
                    onClick={() => setAssigneeDraft(t.assignee ?? "")}
                  >
                    Edit
                  </button>
                  {t.assignee && (
                    <button
                      className="rounded border border-slate-300 px-2 py-1 text-xs text-red-600 hover:bg-red-50"
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
                    className="rounded border border-slate-300 px-2 py-1 text-sm"
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
            <h4 className="text-sm font-semibold mb-2">Device context</h4>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
              <dt className="text-slate-500">App version</dt>
              <dd>
                {t.version_name ?? "—"}{" "}
                {t.version_code ? (
                  <button
                    className="text-blue-600 hover:underline"
                    title="All feedback on this version"
                    onClick={() => navigate(`/apps/${appId}/feedback?version_code=${t.version_code}`)}
                  >
                    ({t.version_code})
                  </button>
                ) : null}
              </dd>
              <dt className="text-slate-500">Channel</dt>
              <dd>{t.channel ?? "—"}</dd>
              <dt className="text-slate-500">Device</dt>
              <dd>{t.device_model ?? "—"}</dd>
              <dt className="text-slate-500">OS / arch</dt>
              <dd>{[t.os_version, t.arch].filter(Boolean).join(" / ") || "—"}</dd>
              <dt className="text-slate-500">Locale</dt>
              <dd>{t.locale ?? "—"}</dd>
              <dt className="text-slate-500">Device id</dt>
              <dd className="font-mono">
                {t.device_id ? (
                  <button
                    className="text-blue-600 hover:underline font-mono"
                    title="This device's history"
                    onClick={() => navigate(`/apps/${appId}/feedback?device_id=${encodeURIComponent(t.device_id!)}`)}
                  >
                    {t.device_id}
                  </button>
                ) : (
                  "—"
                )}
              </dd>
            </dl>
          </div>

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
                <li key={cm.id} className="rounded border border-slate-200 p-2">
                  <div className="text-xs text-slate-500">
                    {cm.author_actor} · {new Date(cm.created_at).toLocaleString()}
                  </div>
                  <div className="whitespace-pre-wrap">{cm.body}</div>
                </li>
              ))}
            </ul>
            <div className="mt-2 flex gap-2">
              <input
                className="flex-1 rounded border border-slate-300 px-2 py-1.5 text-sm"
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
