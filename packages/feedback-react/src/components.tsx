import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  EmptyState,
  EmptyStateTitle,
  Input,
  Skeleton,
} from "raft-ui";
import { useHandsFeedback } from "./provider.js";
import type {
  FeedbackKind,
  FeedbackTicketSummary,
  FeedbackTicketDetail,
} from "./types.js";

export const MAX_FEEDBACK_ATTACHMENTS = 3;
export const MAX_FEEDBACK_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const FEEDBACK_ATTACHMENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

export function mergeTicketPages(
  current: FeedbackTicketSummary[],
  incoming: FeedbackTicketSummary[],
): FeedbackTicketSummary[] {
  const merged = new Map(current.map((ticket) => [ticket.id, ticket]));
  for (const ticket of incoming) merged.set(ticket.id, ticket);
  return [...merged.values()];
}

export function validateFeedbackAttachments(files: File[]): string | null {
  if (files.length > MAX_FEEDBACK_ATTACHMENTS) {
    return `Choose no more than ${MAX_FEEDBACK_ATTACHMENTS} screenshots.`;
  }
  for (const file of files) {
    if (!(FEEDBACK_ATTACHMENT_TYPES as readonly string[]).includes(file.type)) {
      return `${file.name} is not a supported image.`;
    }
    if (file.size > MAX_FEEDBACK_ATTACHMENT_BYTES) {
      return `${file.name} is larger than 10 MB.`;
    }
  }
  return null;
}

function stableSubmissionId(
  previous: { fingerprint: string; id: string } | null,
  fingerprint: string,
): { fingerprint: string; id: string } {
  return previous?.fingerprint === fingerprint
    ? previous
    : { fingerprint, id: submissionId() };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Feedback is temporarily unavailable";
}

function statusLabel(status: FeedbackTicketSummary["status"]): string {
  return status === "in_progress" ? "In progress" : `${status[0]!.toUpperCase()}${status.slice(1)}`;
}

function formatDate(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function submissionId(): string {
  if (!globalThis.crypto?.randomUUID) throw new Error("A secure randomUUID implementation is required");
  return globalThis.crypto.randomUUID();
}

export type FeedbackInboxProps = {
  onSelectTicket(ticketId: string): void;
  onNewFeedback(): void;
  pageSize?: number;
};

export function FeedbackInbox({ onSelectTicket, onNewFeedback, pageSize = 20 }: FeedbackInboxProps) {
  const { transport, reportUnread } = useHandsFeedback();
  const [tickets, setTickets] = useState<FeedbackTicketSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const requestController = useRef<AbortController | null>(null);

  const load = useCallback(async (nextCursor?: string) => {
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    const id = ++request.current;
    nextCursor ? setLoadingMore(true) : setLoading(true);
    setError(null);
    const signal = controller.signal;
    try {
      const page = await transport.listTickets({
        ...(nextCursor ? { cursor: nextCursor } : {}),
        limit: pageSize,
        signal,
      });
      if (request.current !== id) return;
      reportUnread({ total: page.unreadTotal, source: "list" });
      setTickets((current) => nextCursor ? mergeTicketPages(current, page.tickets) : page.tickets);
      setCursor(page.nextCursor);
    } catch (cause) {
      if (request.current === id && !signal.aborted) setError(errorMessage(cause));
    } finally {
      if (request.current === id) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [pageSize, reportUnread, transport]);

  useEffect(() => {
    void load();
    return () => {
      requestController.current?.abort();
      request.current += 1;
    };
  }, [load]);

  return (
    <section className="hands-feedback-inbox" aria-labelledby="hands-feedback-inbox-title">
      <header className="hands-feedback-header">
        <div>
          <h2 id="hands-feedback-inbox-title">Feedback</h2>
          <p>Your feedback and replies from the team.</p>
        </div>
        <Button onClick={onNewFeedback}>New feedback</Button>
      </header>
      {loading && (
        <div className="hands-feedback-stack" aria-label="Loading feedback">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      )}
      {error && (
        <div className="hands-feedback-error" role="alert">
          <span>{error}</span>
          <Button variant="outline" onClick={() => void load()}>Try again</Button>
        </div>
      )}
      {!loading && !error && tickets.length === 0 && (
        <EmptyState>
          <EmptyStateTitle>No feedback yet</EmptyStateTitle>
          <p>Send your first idea or report a problem.</p>
          <Button onClick={onNewFeedback}>New feedback</Button>
        </EmptyState>
      )}
      {tickets.length > 0 && (
        <ul className="hands-feedback-ticket-list">
          {tickets.map((ticket) => (
            <li key={ticket.id}>
              <button
                className="hands-feedback-ticket-row"
                data-unread={ticket.unread || undefined}
                onClick={() => onSelectTicket(ticket.id)}
                type="button"
              >
                <span className="hands-feedback-ticket-copy">
                  <span className="hands-feedback-ticket-title">{ticket.message}</span>
                  <span className="hands-feedback-ticket-meta">
                    {ticket.kind === "bug" ? "Problem" : "Feedback"} · {formatDate(ticket.updatedAt)}
                  </span>
                </span>
                <span className="hands-feedback-ticket-state">
                  {ticket.unread && <span className="hands-feedback-unread-dot" aria-label={`${ticket.unreadCount} unread`} />}
                  <span className="hands-feedback-status" data-status={ticket.status}>{statusLabel(ticket.status)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {cursor && (
        <Button variant="outline" disabled={loadingMore} onClick={() => void load(cursor)}>
          {loadingMore ? "Loading…" : "Load more"}
        </Button>
      )}
    </section>
  );
}

export type FeedbackTicketProps = {
  ticketId: string;
  onBack(): void;
  onOpenAttachment?: (input: { ticketId: string; attachmentId: string }) => void;
};

export function FeedbackTicket({ ticketId, onBack, onOpenAttachment }: FeedbackTicketProps) {
  const { transport, reportUnread } = useHandsFeedback();
  const [detail, setDetail] = useState<FeedbackTicketDetail | null>(null);
  const [reply, setReply] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadRequest = useRef(0);
  const actionController = useRef<AbortController | null>(null);
  const commentSubmission = useRef<{ fingerprint: string; id: string } | null>(null);

  const load = useCallback(async (externalSignal?: AbortSignal) => {
    const requestId = ++loadRequest.current;
    setLoading(true);
    setDetail(null);
    setError(null);
    const signal = externalSignal ?? new AbortController().signal;
    try {
      const result = await transport.getTicket({ ticketId, commentLimit: 100, signal });
      if (signal.aborted || requestId !== loadRequest.current) return;
      reportUnread({ total: result.unreadTotal, source: "detail" });
      setDetail(result);
    } catch (cause) {
      if (!signal.aborted) setError(errorMessage(cause));
    } finally {
      if (!signal.aborted && requestId === loadRequest.current) setLoading(false);
    }
  }, [reportUnread, ticketId, transport]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => {
      controller.abort();
      actionController.current?.abort();
      loadRequest.current += 1;
    };
  }, [load]);

  const send = async () => {
    const body = reply.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    actionController.current?.abort();
    const controller = new AbortController();
    actionController.current = controller;
    commentSubmission.current = stableSubmissionId(commentSubmission.current, body);
    try {
      const result = await transport.addComment({
        ticketId,
        body,
        submissionId: commentSubmission.current.id,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      reportUnread({ total: result.unreadTotal, source: "comment" });
      setDetail(result);
      setReply("");
      commentSubmission.current = null;
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorMessage(cause));
    } finally {
      if (!controller.signal.aborted) setSending(false);
    }
  };

  return (
    <section className="hands-feedback-detail" aria-labelledby="hands-feedback-ticket-title">
      <header className="hands-feedback-header">
        <Button variant="outline" onClick={onBack}>Back</Button>
        {detail && <span className="hands-feedback-status" data-status={detail.ticket.status}>{statusLabel(detail.ticket.status)}</span>}
      </header>
      {loading && <Skeleton className="h-40 w-full" />}
      {error && <div className="hands-feedback-error" role="alert">{error}</div>}
      {detail && (
        <>
          <div className="hands-feedback-ticket-body">
            <h2 id="hands-feedback-ticket-title">{detail.ticket.message}</h2>
            <span>{formatDate(detail.ticket.createdAt)}</span>
          </div>
          {detail.attachments.length > 0 && (
            <div className="hands-feedback-attachments" aria-label="Attachments">
              {detail.attachments.map((attachment) => (
                <button
                  key={attachment.id}
                  type="button"
                  disabled={!onOpenAttachment}
                  aria-label={`Open attachment ${attachment.filename}`}
                  onClick={() => onOpenAttachment?.({ ticketId, attachmentId: attachment.id })}
                >
                  {attachment.filename} · {Math.ceil(attachment.sizeBytes / 1024)} KB
                </button>
              ))}
            </div>
          )}
          <div className="hands-feedback-conversation" aria-label="Conversation">
            {detail.comments.map((comment) => (
              <article key={comment.id} data-author={comment.authorType}>
                <div className="hands-feedback-comment-meta">
                  <strong>{comment.authorType === "reporter" ? "You" : comment.authorType === "staff" ? "Team" : "Update"}</strong>
                  <span>{formatDate(comment.createdAt)}</span>
                </div>
                <p>{comment.body}</p>
              </article>
            ))}
          </div>
          <div className="hands-feedback-composer">
            <label htmlFor="hands-feedback-reply">Reply</label>
            <textarea
              id="hands-feedback-reply"
              maxLength={10_000}
              value={reply}
              onChange={(event) => setReply(event.target.value)}
            />
            <Button disabled={!reply.trim() || sending} onClick={() => void send()}>
              {sending ? "Sending…" : "Send reply"}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

export type NewFeedbackProps = {
  onCancel(): void;
  onCreated(ticketId: string): void;
};

export function NewFeedback({ onCancel, onCreated }: NewFeedbackProps) {
  const { transport, reportUnread } = useHandsFeedback();
  const [kind, setKind] = useState<FeedbackKind>("feedback");
  const [message, setMessage] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const actionController = useRef<AbortController | null>(null);
  const createSubmission = useRef<{ fingerprint: string; id: string } | null>(null);

  useEffect(() => () => actionController.current?.abort(), []);

  const submit = async () => {
    const normalized = message.trim();
    if (!normalized || sending) return;
    const attachmentError = validateFeedbackAttachments(attachments);
    if (attachmentError) {
      setError(attachmentError);
      return;
    }
    setSending(true);
    setError(null);
    actionController.current?.abort();
    const controller = new AbortController();
    actionController.current = controller;
    const fingerprint = JSON.stringify([
      kind,
      normalized,
      ...attachments.map((file) => [file.name, file.type, file.size, file.lastModified]),
    ]);
    createSubmission.current = stableSubmissionId(createSubmission.current, fingerprint);
    try {
      const result = await transport.createTicket({
        kind,
        message: normalized,
        submissionId: createSubmission.current.id,
        attachments,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      reportUnread({ total: result.unreadTotal, source: "create" });
      createSubmission.current = null;
      onCreated(result.ticket.id);
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorMessage(cause));
    } finally {
      if (!controller.signal.aborted) setSending(false);
    }
  };

  return (
    <section className="hands-feedback-new" aria-labelledby="hands-feedback-new-title">
      <header className="hands-feedback-header">
        <div>
          <h2 id="hands-feedback-new-title">New feedback</h2>
          <p>Share an idea or report a problem.</p>
        </div>
        <Button variant="outline" onClick={onCancel}>Cancel</Button>
      </header>
      <div className="hands-feedback-kind" role="group" aria-label="Feedback type">
        <Button variant={kind === "feedback" ? "primary" : "outline"} onClick={() => setKind("feedback")}>Feedback</Button>
        <Button variant={kind === "bug" ? "primary" : "outline"} onClick={() => setKind("bug")}>Problem</Button>
      </div>
      <label htmlFor="hands-feedback-message">What would you like us to know?</label>
      <textarea
        id="hands-feedback-message"
        maxLength={10_000}
        value={message}
        onChange={(event) => setMessage(event.target.value)}
      />
      <label htmlFor="hands-feedback-attachments">Screenshots (up to 3)</label>
      <Input
        id="hands-feedback-attachments"
        type="file"
        accept={FEEDBACK_ATTACHMENT_TYPES.join(",")}
        multiple
        onChange={(event) => {
          const selected = Array.from(event.currentTarget.files ?? []);
          const attachmentError = validateFeedbackAttachments(selected);
          setError(attachmentError);
          setAttachments(attachmentError ? [] : selected);
          if (attachmentError) event.currentTarget.value = "";
        }}
      />
      {error && <div className="hands-feedback-error" role="alert">{error}</div>}
      <Button disabled={!message.trim() || sending} onClick={() => void submit()}>
        {sending ? "Submitting…" : "Submit feedback"}
      </Button>
    </section>
  );
}

export type FeedbackWorkspaceProps = {
  initialTicketId?: string;
  onRouteChange?: (route: { view: "inbox" | "new" | "ticket"; ticketId?: string }) => void;
  onOpenAttachment?: FeedbackTicketProps["onOpenAttachment"];
};

export function FeedbackWorkspace({ initialTicketId, onRouteChange, onOpenAttachment }: FeedbackWorkspaceProps) {
  const { theme } = useHandsFeedback();
  const initial = useMemo(() => initialTicketId
    ? { view: "ticket" as const, ticketId: initialTicketId }
    : { view: "inbox" as const }, [initialTicketId]);
  const [route, setRoute] = useState<{ view: "inbox" | "new" | "ticket"; ticketId?: string }>(initial);
  const navigate = (next: typeof route) => {
    setRoute(next);
    onRouteChange?.(next);
  };
  return (
    <div className="hands-feedback-root" data-hands-feedback-theme={theme}>
      {route.view === "inbox" && (
        <FeedbackInbox
          onNewFeedback={() => navigate({ view: "new" })}
          onSelectTicket={(ticketId) => navigate({ view: "ticket", ticketId })}
        />
      )}
      {route.view === "new" && (
        <NewFeedback
          onCancel={() => navigate({ view: "inbox" })}
          onCreated={(ticketId) => navigate({ view: "ticket", ticketId })}
        />
      )}
      {route.view === "ticket" && route.ticketId && (
        <FeedbackTicket
          ticketId={route.ticketId}
          onBack={() => navigate({ view: "inbox" })}
          {...(onOpenAttachment ? { onOpenAttachment } : {})}
        />
      )}
    </div>
  );
}
