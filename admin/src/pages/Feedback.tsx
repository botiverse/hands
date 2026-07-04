/**
 * Feedback ticket triage (task #66): list + filter tickets submitted from
 * the app SDK, inspect device context and attachments, move status, and
 * keep a comment trail.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  FeedbackTicket,
  addFeedbackComment,
  feedbackAttachmentUrl,
  getFeedback,
  listFeedback,
  updateFeedbackStatus,
} from "../lib/api";
import { useToast } from "../components/Toast";

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
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [kindFilter, setKindFilter] = useState<string>("");
  const [selected, setSelected] = useState<string | null>(null);

  const tickets = useQuery({
    queryKey: ["feedback", appId, statusFilter, kindFilter],
    queryFn: () =>
      listFeedback(appId, {
        status: statusFilter || undefined,
        kind: kindFilter || undefined,
      }),
  });

  const rows = tickets.data?.tickets ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-lg font-semibold">Feedback</h2>
          <p className="text-sm text-slate-500">
            Tickets submitted from the app (SDK <code>POST /public/v2/apps/&lt;slug&gt;/feedback</code>).
          </p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <select
            className="rounded border border-slate-300 px-2 py-1.5"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <select
            className="rounded border border-slate-300 px-2 py-1.5"
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
                  onClick={() => setSelected(t.id)}
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

      {selected && (
        <TicketDetail
          appId={appId}
          ticketId={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

function TicketDetail({
  appId,
  ticketId,
  onClose,
}: {
  appId: string;
  ticketId: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [comment, setComment] = useState("");

  const detail = useQuery({
    queryKey: ["feedback-detail", appId, ticketId],
    queryFn: () => getFeedback(appId, ticketId),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["feedback-detail", appId, ticketId] });
    queryClient.invalidateQueries({ queryKey: ["feedback", appId] });
  };

  const setStatus = useMutation({
    mutationFn: (status: string) => updateFeedbackStatus(appId, ticketId, status),
    onSuccess: (data) => {
      toast.show({ kind: "success", title: `Status → ${data.status}` });
      invalidate();
    },
    onError: (e) =>
      toast.show({ kind: "error", title: "Status update failed", description: (e as Error).message }),
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

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <div
        className="h-full w-full max-w-xl overflow-y-auto bg-white p-5 shadow-xl space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        {detail.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
        {detail.error && (
          <p className="text-sm text-red-600">{(detail.error as Error).message}</p>
        )}
        {t && (
          <>
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${KIND_STYLES[t.kind]}`}>{t.kind}</span>
                  <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_STYLES[t.status]}`}>{t.status}</span>
                </div>
                <h3 className="mt-2 text-base font-semibold">Ticket {t.id.slice(0, 8)}</h3>
                <p className="text-xs text-slate-500">
                  {new Date(t.created_at).toLocaleString()}
                  {t.contact ? ` · ${t.contact}` : ""}
                </p>
              </div>
              <button className="btn-secondary text-xs" onClick={onClose}>Close</button>
            </div>

            <div className="rounded border border-slate-200 bg-slate-50 p-3 text-sm whitespace-pre-wrap">
              {t.message}
            </div>

            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
              <dt className="text-slate-500">App version</dt>
              <dd>{t.version_name ?? "—"} {t.version_code ? `(${t.version_code})` : ""}</dd>
              <dt className="text-slate-500">Channel</dt>
              <dd>{t.channel ?? "—"}</dd>
              <dt className="text-slate-500">Device</dt>
              <dd>{t.device_model ?? "—"}</dd>
              <dt className="text-slate-500">OS / arch</dt>
              <dd>{[t.os_version, t.arch].filter(Boolean).join(" / ") || "—"}</dd>
              <dt className="text-slate-500">Locale</dt>
              <dd>{t.locale ?? "—"}</dd>
              <dt className="text-slate-500">Device id</dt>
              <dd className="font-mono">{t.device_id ?? "—"}</dd>
            </dl>

            {detail.data!.attachments.length > 0 && (
              <div>
                <h4 className="text-sm font-semibold mb-1">Attachments</h4>
                <ul className="space-y-1 text-sm">
                  {detail.data!.attachments.map((a) => (
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
              </div>
            )}

            <div>
              <h4 className="text-sm font-semibold mb-1">Status</h4>
              <div className="flex gap-2">
                {STATUSES.map((s) => (
                  <button
                    key={s}
                    className={
                      s === t.status
                        ? "rounded border border-slate-900 bg-slate-900 px-2 py-1 text-xs text-white"
                        : "rounded border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100"
                    }
                    disabled={setStatus.isPending || s === t.status}
                    onClick={() => setStatus.mutate(s)}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>

            <div>
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
    </div>
  );
}
