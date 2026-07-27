import {
  type ChangeEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ArrowLeft, ImagePlus, Paperclip, Send } from "lucide-react";
import {
  Badge,
  Button,
  EmptyState,
  EmptyStateTitle,
  Input,
  Skeleton,
} from "raft-ui";
import type { FeedbackMessageKey, FeedbackMessageValues } from "./locale.js";
import { useHandsFeedback } from "./provider.js";
import { FeedbackTransportError } from "./types.js";
import type {
  FeedbackComment,
  FeedbackKind,
  FeedbackTicketDetail,
  FeedbackTicketSummary,
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
) {
  const merged = new Map(current.map((ticket) => [ticket.id, ticket]));
  for (const ticket of incoming) merged.set(ticket.id, ticket);
  return [...merged.values()];
}

export function mergeCommentPages(
  current: FeedbackComment[],
  incoming: FeedbackComment[],
) {
  const merged = new Map(current.map((comment) => [comment.id, comment]));
  for (const comment of incoming) merged.set(comment.id, comment);
  return [...merged.values()].sort(
    (left, right) =>
      left.createdAt - right.createdAt || left.id.localeCompare(right.id),
  );
}

export function validateFeedbackAttachments(files: File[]): string | null {
  if (files.length > MAX_FEEDBACK_ATTACHMENTS)
    return `Choose no more than ${MAX_FEEDBACK_ATTACHMENTS} screenshots.`;
  for (const file of files) {
    if (!(FEEDBACK_ATTACHMENT_TYPES as readonly string[]).includes(file.type))
      return `${file.name} is not a supported image.`;
    if (file.size > MAX_FEEDBACK_ATTACHMENT_BYTES)
      return `${file.name} is larger than 10 MB.`;
  }
  return null;
}

function localizedAttachmentError(
  files: File[],
  message: (key: FeedbackMessageKey, values?: FeedbackMessageValues) => string,
) {
  const error = validateFeedbackAttachments(files);
  if (!error) return null;
  if (files.length > MAX_FEEDBACK_ATTACHMENTS)
    return message("attachmentTooMany", { count: MAX_FEEDBACK_ATTACHMENTS });
  const invalid = files.find(
    (file) =>
      !(FEEDBACK_ATTACHMENT_TYPES as readonly string[]).includes(file.type),
  );
  if (invalid) return message("attachmentUnsupported", { name: invalid.name });
  const large = files.find((file) => file.size > MAX_FEEDBACK_ATTACHMENT_BYTES);
  return large ? message("attachmentTooLarge", { name: large.name }) : error;
}

function submissionId() {
  if (!globalThis.crypto?.randomUUID)
    throw new Error("A secure randomUUID implementation is required");
  return globalThis.crypto.randomUUID();
}

export function stableFeedbackSubmission(
  previous: { fingerprint: string; id: string } | null,
  fingerprint: string,
) {
  return previous?.fingerprint === fingerprint
    ? previous
    : { fingerprint, id: submissionId() };
}

export function isNearConversationBottom(
  input: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">,
  threshold = 64,
) {
  return input.scrollHeight - input.scrollTop - input.clientHeight <= threshold;
}

function useSafeError() {
  const { message } = useHandsFeedback();
  return useCallback(
    (error: unknown) => {
      const keys = {
        conflict: "errorConflict",
        invalid: "errorInvalid",
        not_found: "errorNotFound",
        rate_limited: "errorRateLimited",
        unauthorized: "errorUnauthorized",
        unavailable: "errorUnavailable",
      } as const;
      return message(
        error instanceof FeedbackTransportError
          ? keys[error.code]
          : "errorUnavailable",
      );
    },
    [message],
  );
}

function useAutosize(value: string) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const textarea = ref.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 240)}px`;
  }, [value]);
  return ref;
}

function StatusBadge({ status }: { status: FeedbackTicketSummary["status"] }) {
  const { message } = useHandsFeedback();
  const label = message(
    status === "in_progress"
      ? "statusInProgress"
      : status === "resolved"
        ? "statusResolved"
        : status === "closed"
          ? "statusClosed"
          : "statusOpen",
  );
  const variant =
    status === "open"
      ? "warning"
      : status === "in_progress"
        ? "information"
        : status === "resolved"
          ? "success"
          : "muted";
  return (
    <Badge
      appearance="solid"
      variant={variant}
      uppercase={false}
      className="hands-feedback-status"
      data-feedback-status={status}
    >
      {label}
    </Badge>
  );
}

export type FeedbackInboxProps = {
  onSelectTicket(ticketId: string): void;
  onNewFeedback(): void;
  pageSize?: number;
  hidden?: boolean;
  readTicketId?: string | null;
  /** Newly-created authoritative ticket to expose without waiting for a list refetch. */
  upsertTicket?: FeedbackTicketSummary | null;
};

export function FeedbackInbox({
  onSelectTicket,
  onNewFeedback,
  pageSize = 20,
  hidden = false,
  readTicketId,
  upsertTicket,
}: FeedbackInboxProps) {
  const { formatDate, message, reportUnread, transport } = useHandsFeedback();
  const safeError = useSafeError();
  const [tickets, setTickets] = useState<FeedbackTicketSummary[]>([]);
  const [filter, setFilter] = useState<"all" | "open" | "resolved">("all");
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryCursor, setRetryCursor] = useState<string | undefined>(undefined);
  const request = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback(
    async (nextCursor?: string) => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      const id = ++request.current;
      nextCursor ? setLoadingMore(true) : setLoading(true);
      setError(null);
      setRetryCursor(undefined);
      try {
        const page = await transport.listTickets({
          ...(nextCursor ? { cursor: nextCursor } : {}),
          limit: pageSize,
          signal: controller.signal,
        });
        if (controller.signal.aborted || request.current !== id) return;
        reportUnread({ total: page.unreadTotal, source: "list" });
        setTickets((current) =>
          nextCursor ? mergeTicketPages(current, page.tickets) : page.tickets,
        );
        setCursor(page.nextCursor);
      } catch (cause) {
        if (!controller.signal.aborted && request.current === id) {
          setError(safeError(cause));
          setRetryCursor(nextCursor);
        }
      } finally {
        if (!controller.signal.aborted && request.current === id) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [pageSize, reportUnread, safeError, transport],
  );
  const initialLoad = useRef(load);
  initialLoad.current = load;

  useEffect(() => {
    void initialLoad.current();
    return () => {
      controllerRef.current?.abort();
      request.current += 1;
    };
  }, [pageSize, transport]);

  useEffect(() => {
    if (!readTicketId) return;
    setTickets((current) =>
      current.map((ticket) =>
        ticket.id === readTicketId
          ? { ...ticket, unread: false, unreadCount: 0 }
          : ticket,
      ),
    );
  }, [readTicketId]);

  useEffect(() => {
    if (!upsertTicket) return;
    setTickets((current) => [
      upsertTicket,
      ...current.filter((ticket) => ticket.id !== upsertTicket.id),
    ]);
  }, [upsertTicket]);

  const visibleTickets = tickets.filter(
    (ticket) =>
      filter === "all" ||
      (filter === "open"
        ? ticket.status === "open" || ticket.status === "in_progress"
        : ticket.status === "resolved" || ticket.status === "closed"),
  );

  return (
    <section
      className="hands-feedback-inbox"
      aria-labelledby="hands-feedback-inbox-title"
      hidden={hidden}
    >
      <header className="hands-feedback-header">
        <div>
          <h2 id="hands-feedback-inbox-title">{message("feedback")}</h2>
          <p>{message("inboxDescription")}</p>
        </div>
        <Button onClick={onNewFeedback}>{message("newFeedback")}</Button>
      </header>
      <div
        className="hands-feedback-filter"
        role="group"
        aria-label={message("statusFilter")}
      >
        {(["all", "open", "resolved"] as const).map((value) => (
          <Button
            key={value}
            variant={filter === value ? "primary" : "outline"}
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
          >
            {value === "all"
              ? message("all")
              : message(value === "open" ? "statusOpen" : "statusResolved")}
          </Button>
        ))}
      </div>
      <div
        className="hands-feedback-middle hands-feedback-list-scroll"
        data-feedback-list-scroll
        tabIndex={-1}
      >
        {loading && (
          <div className="hands-feedback-stack" aria-label={message("loading")}>
            <Skeleton className="hands-feedback-skeleton-row" />
            <Skeleton className="hands-feedback-skeleton-row" />
            <Skeleton className="hands-feedback-skeleton-row" />
          </div>
        )}
        {error && (
          <div className="hands-feedback-error" role="alert">
            <span>{error}</span>
            <Button variant="outline" onClick={() => void load(retryCursor)}>
              {message("retry")}
            </Button>
          </div>
        )}
        {!loading && !error && visibleTickets.length === 0 && (
          <EmptyState>
            <EmptyStateTitle>{message("emptyTitle")}</EmptyStateTitle>
            <p>{message("emptyBody")}</p>
            <Button onClick={onNewFeedback}>{message("newFeedback")}</Button>
          </EmptyState>
        )}
        {visibleTickets.length > 0 && (
          <ul className="hands-feedback-ticket-list">
            {visibleTickets.map((ticket) => (
              <li key={ticket.id}>
                <button
                  className="hands-feedback-ticket-row"
                  data-ticket-id={ticket.id}
                  data-unread={ticket.unread || undefined}
                  onClick={() => onSelectTicket(ticket.id)}
                  type="button"
                >
                  <span className="hands-feedback-ticket-copy">
                    <span className="hands-feedback-ticket-title">
                      {ticket.message}
                    </span>
                    <span className="hands-feedback-ticket-meta">
                      {ticket.kind === "bug"
                        ? message("problem")
                        : message("feedback")}{" "}
                      · {formatDate(ticket.updatedAt)}
                    </span>
                  </span>
                  <span className="hands-feedback-ticket-state">
                    {ticket.unread && (
                      <span
                        className="hands-feedback-unread-dot"
                        aria-label={message("unreadCount", {
                          count: ticket.unreadCount,
                        })}
                      />
                    )}
                    <StatusBadge status={ticket.status} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {cursor && (
          <Button
            variant="outline"
            disabled={loadingMore}
            onClick={() => void load(cursor)}
          >
            {loadingMore ? message("loadingMore") : message("loadMore")}
          </Button>
        )}
      </div>
      <div className="hands-feedback-live" aria-live="polite">
        {loadingMore ? message("loadingMore") : (error ?? "")}
      </div>
    </section>
  );
}

export type FeedbackTicketProps = {
  ticketId: string;
  onBack(): void;
  onOpenAttachment?: (input: {
    ticketId: string;
    attachmentId: string;
  }) => void;
  draft?: string;
  onDraftChange?: (value: string) => void;
  onReadSuccess?: (ticketId: string) => void;
};

export function FeedbackTicket({
  ticketId,
  onBack,
  onOpenAttachment,
  draft,
  onDraftChange,
  onReadSuccess,
}: FeedbackTicketProps) {
  const { formatDate, formatFileSize, message, reportUnread, transport } =
    useHandsFeedback();
  const safeError = useSafeError();
  const [detail, setDetail] = useState<FeedbackTicketDetail | null>(null);
  const [internalDraft, setInternalDraft] = useState("");
  const reply = draft ?? internalDraft;
  const setReply = onDraftChange ?? setInternalDraft;
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [sending, setSending] = useState(false);
  const [replyAttachments, setReplyAttachments] = useState<PendingAttachment[]>(
    [],
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryLoad, setRetryLoad] = useState<{
    cursor: string | undefined;
    refresh: boolean;
  }>({ cursor: undefined, refresh: false });
  const [actionError, setActionError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [newReplies, setNewReplies] = useState(false);
  const loadRequest = useRef(0);
  const loadController = useRef<AbortController | null>(null);
  const actionController = useRef<AbortController | null>(null);
  const commentSubmission = useRef<{ fingerprint: string; id: string } | null>(
    null,
  );
  const conversationRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useAutosize(reply);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const scrollIntent = useRef<"bottom" | "preserve" | null>(null);

  useEffect(() => {
    actionController.current?.abort();
    actionController.current = null;
    commentSubmission.current = null;
    setSending(false);
    setReplyAttachments([]);
  }, [ticketId, transport]);

  const load = useCallback(
    async (commentCursor?: string, refresh = false) => {
      loadController.current?.abort();
      const controller = new AbortController();
      loadController.current = controller;
      const requestId = ++loadRequest.current;
      commentCursor ? setLoadingMore(true) : setLoading(!refresh);
      if (!commentCursor && !refresh) setDetail(null);
      setLoadError(null);
      setRetryLoad({ cursor: undefined, refresh: false });
      const nearBottom = conversationRef.current
        ? isNearConversationBottom(conversationRef.current)
        : true;
      try {
        const result = await transport.getTicket({
          ticketId,
          ...(commentCursor ? { commentCursor } : {}),
          commentLimit: 100,
          signal: controller.signal,
        });
        if (controller.signal.aborted || requestId !== loadRequest.current)
          return;
        reportUnread({ total: result.unreadTotal, source: "detail" });
        if (!commentCursor) onReadSuccess?.(ticketId);
        setDetail((current) => {
          const next =
            commentCursor && current
              ? {
                  ...result,
                  comments: mergeCommentPages(
                    current.comments,
                    result.comments,
                  ),
                }
              : result;
          if (
            refresh &&
            current &&
            next.comments.length > current.comments.length &&
            !nearBottom
          )
            setNewReplies(true);
          return next;
        });
        scrollIntent.current = nearBottom ? "bottom" : "preserve";
        setAnnouncement(message("ticketUpdated"));
      } catch (cause) {
        if (!controller.signal.aborted && requestId === loadRequest.current) {
          setLoadError(safeError(cause));
          setRetryLoad({ cursor: commentCursor, refresh });
        }
      } finally {
        if (!controller.signal.aborted && requestId === loadRequest.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [message, onReadSuccess, reportUnread, safeError, ticketId, transport],
  );
  const initialLoad = useRef(load);
  initialLoad.current = load;

  useEffect(() => {
    void initialLoad.current();
    return () => {
      loadController.current?.abort();
      actionController.current?.abort();
      loadRequest.current += 1;
    };
  }, [ticketId, transport]);

  useLayoutEffect(() => {
    if (scrollIntent.current === "bottom" && conversationRef.current)
      conversationRef.current.scrollTop = conversationRef.current.scrollHeight;
    scrollIntent.current = null;
  }, [detail]);

  const send = async () => {
    const body = reply.trim();
    if (!body || sending) return;
    const files = replyAttachments.map(({ file }) => file);
    const attachmentError = localizedAttachmentError(files, message);
    if (attachmentError) {
      setActionError(attachmentError);
      return;
    }
    setSending(true);
    setActionError(null);
    setReplyAttachments((current) =>
      current.map((item) => ({ ...item, state: "uploading", progress: 0 })),
    );
    actionController.current?.abort();
    const controller = new AbortController();
    actionController.current = controller;
    commentSubmission.current = stableFeedbackSubmission(
      commentSubmission.current,
      JSON.stringify([
        body,
        ...files.map((file) => [
          file.name,
          file.type,
          file.size,
          file.lastModified,
        ]),
      ]),
    );
    try {
      const result = await transport.addComment({
        ticketId,
        body,
        submissionId: commentSubmission.current.id,
        attachments: files,
        signal: controller.signal,
        onAttachmentProgress: ({ index, progress }) => {
          if (controller.signal.aborted) return;
          setReplyAttachments((current) =>
            current.map((item, itemIndex) =>
              itemIndex === index
                ? { ...item, progress: Math.max(0, Math.min(1, progress)) }
                : item,
            ),
          );
        },
      });
      if (controller.signal.aborted) return;
      reportUnread({ total: result.unreadTotal, source: "comment" });
      scrollIntent.current = "bottom";
      setDetail(result);
      setReply("");
      setReplyAttachments([]);
      setNewReplies(false);
      commentSubmission.current = null;
      setAnnouncement(message("replySent"));
      requestAnimationFrame(() => textareaRef.current?.focus());
    } catch (cause) {
      if (!controller.signal.aborted) {
        setActionError(safeError(cause));
        setAnnouncement(safeError(cause));
        setReplyAttachments((current) =>
          current.map((item) =>
            item.state === "uploading" ? { ...item, state: "failed" } : item,
          ),
        );
      }
    } finally {
      if (!controller.signal.aborted) setSending(false);
    }
  };

  const chooseReplyAttachments = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.currentTarget.files ?? []);
    const combined = [
      ...replyAttachments.map(({ file }) => file),
      ...selected,
    ];
    const attachmentError = localizedAttachmentError(combined, message);
    if (attachmentError) {
      setActionError(attachmentError);
      event.currentTarget.value = "";
      return;
    }
    setActionError(null);
    setReplyAttachments((current) => [
      ...current,
      ...selected.map((file) => ({
        id: submissionId(),
        file,
        progress: 0,
        state: "ready" as const,
      })),
    ]);
    event.currentTarget.value = "";
  };

  const onReplyKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.nativeEvent.isComposing ||
      event.keyCode === 229
    )
      return;
    event.preventDefault();
    void send();
  };

  return (
    <section
      className="hands-feedback-detail"
      aria-labelledby="hands-feedback-ticket-heading"
    >
      <header className="hands-feedback-header">
        <Button
          aria-label={message("back")}
          title={message("back")}
          size="icon-sm"
          variant="outline"
          onClick={onBack}
        >
          <ArrowLeft aria-hidden="true" size={16} />
        </Button>
        <h2 id="hands-feedback-ticket-heading" tabIndex={-1}>
          {message("ticketHeading")}
        </h2>
        {detail ? <StatusBadge status={detail.ticket.status} /> : <span />}
      </header>
      <div className="hands-feedback-middle">
        {loading && <Skeleton className="hands-feedback-skeleton-detail" />}
        {loadError && (
          <div className="hands-feedback-error" role="alert">
            <span>{loadError}</span>
            <Button
              variant="outline"
              onClick={() => void load(retryLoad.cursor, retryLoad.refresh)}
            >
              {message("retry")}
            </Button>
          </div>
        )}
        {detail && (
          <>
            <div className="hands-feedback-ticket-body">
              <h3>{detail.ticket.message}</h3>
              <span>{formatDate(detail.ticket.createdAt)}</span>
            </div>
            {detail.attachments.length > 0 && (
              <div
                className="hands-feedback-attachments"
                aria-label={message("attachments")}
              >
                {detail.attachments.map((attachment) => (
                  <button
                    key={attachment.id}
                    type="button"
                    disabled={!onOpenAttachment}
                    aria-label={message("openAttachment", {
                      name: attachment.filename,
                    })}
                    onClick={() =>
                      onOpenAttachment?.({
                        ticketId,
                        attachmentId: attachment.id,
                      })
                    }
                  >
                    {message("attachmentSummary", {
                      name: attachment.filename,
                      size: formatFileSize(attachment.sizeBytes),
                    })}
                  </button>
                ))}
              </div>
            )}
            <div className="hands-feedback-conversation-toolbar">
              <strong>{message("conversation")}</strong>
              <Button
                variant="outline"
                onClick={() => void load(undefined, true)}
              >
                {message("refresh")}
              </Button>
            </div>
            <div
              className="hands-feedback-conversation"
              aria-label={message("conversation")}
              ref={conversationRef}
              onScroll={() => {
                if (
                  conversationRef.current &&
                  isNearConversationBottom(conversationRef.current)
                )
                  setNewReplies(false);
              }}
            >
              {detail.comments.length === 0 && (
                <p className="hands-feedback-muted">{message("noReplies")}</p>
              )}
              {detail.comments.map((comment) => (
                <article key={comment.id} data-author={comment.authorType}>
                  <div className="hands-feedback-comment-meta">
                    <strong>
                      {comment.authorType === "reporter"
                        ? message("you")
                        : comment.authorType === "staff"
                          ? message("team")
                          : message("update")}
                    </strong>
                    <span>{formatDate(comment.createdAt)}</span>
                  </div>
                  <p>{comment.body}</p>
                </article>
              ))}
            </div>
            {newReplies && (
              <Button
                className="hands-feedback-new-replies"
                onClick={() => {
                  if (conversationRef.current)
                    conversationRef.current.scrollTop =
                      conversationRef.current.scrollHeight;
                  setNewReplies(false);
                }}
              >
                {message("newReplies")}
              </Button>
            )}
            {detail.nextCommentCursor && (
              <Button
                variant="outline"
                disabled={loadingMore}
                onClick={() => void load(detail.nextCommentCursor!)}
              >
                {loadingMore
                  ? message("loadingMore")
                  : message("loadMoreReplies")}
              </Button>
            )}
          </>
        )}
      </div>
      {detail && (
        <div className="hands-feedback-composer">
          <label
            className="hands-feedback-sr-only"
            htmlFor={`hands-feedback-reply-${ticketId}`}
          >
            {message("reply")}
          </label>
          <textarea
            ref={textareaRef}
            id={`hands-feedback-reply-${ticketId}`}
            maxLength={10_000}
            value={reply}
            onChange={(event) => setReply(event.target.value)}
            onKeyDown={onReplyKeyDown}
            rows={1}
          />
          <input
            ref={imageInputRef}
            data-testid="hands-feedback-reply-image-input"
            className="hands-feedback-sr-only"
            type="file"
            accept={FEEDBACK_ATTACHMENT_TYPES.join(",")}
            multiple
            disabled={
              sending || replyAttachments.length >= MAX_FEEDBACK_ATTACHMENTS
            }
            onChange={chooseReplyAttachments}
          />
          <input
            ref={fileInputRef}
            data-testid="hands-feedback-reply-file-input"
            className="hands-feedback-sr-only"
            type="file"
            accept={FEEDBACK_ATTACHMENT_TYPES.join(",")}
            multiple
            disabled={
              sending || replyAttachments.length >= MAX_FEEDBACK_ATTACHMENTS
            }
            onChange={chooseReplyAttachments}
          />
          {replyAttachments.length > 0 && (
            <ul className="hands-feedback-pending-attachments hands-feedback-reply-attachments">
              {replyAttachments.map((item) => (
                <li key={item.id}>
                  <span>{item.file.name}</span>
                  {item.state === "uploading" && (
                    <progress
                      max={1}
                      value={item.progress || undefined}
                      aria-label={message("uploadProgress", {
                        name: item.file.name,
                      })}
                    />
                  )}
                  {item.state === "failed" && (
                    <span role="status">{message("uploadFailed")}</span>
                  )}
                  <Button
                    variant="outline"
                    disabled={sending}
                    onClick={() =>
                      setReplyAttachments((current) =>
                        current.filter(({ id }) => id !== item.id),
                      )
                    }
                  >
                    {message("remove")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {actionError && (
            <div className="hands-feedback-error" role="alert">
              {actionError}
            </div>
          )}
          <div className="hands-feedback-composer-toolbar">
            <div className="hands-feedback-composer-attachments">
              <Button
                aria-label={message("attachImage")}
                title={message("attachImage")}
                size="icon-sm"
                variant="outline"
                disabled={
                  sending ||
                  replyAttachments.length >= MAX_FEEDBACK_ATTACHMENTS
                }
                onClick={() => imageInputRef.current?.click()}
              >
                <ImagePlus aria-hidden="true" size={14} />
              </Button>
              <Button
                aria-label={message("attachFile")}
                title={message("attachFile")}
                size="icon-sm"
                variant="outline"
                disabled={
                  sending ||
                  replyAttachments.length >= MAX_FEEDBACK_ATTACHMENTS
                }
                onClick={() => fileInputRef.current?.click()}
              >
                <Paperclip aria-hidden="true" size={14} />
              </Button>
            </div>
            <Button
              aria-label={sending ? message("sending") : message("sendReply")}
              title={sending ? message("sending") : message("sendReply")}
              size="icon-sm"
              variant="accent"
              disabled={!reply.trim() || sending}
              onClick={() => void send()}
            >
              <Send aria-hidden="true" size={14} />
              <span className="hands-feedback-sr-only">
                {sending ? message("sending") : message("sendReply")}
              </span>
            </Button>
          </div>
        </div>
      )}
      <div
        className="hands-feedback-live"
        aria-live="polite"
        aria-atomic="true"
      >
        {announcement}
      </div>
    </section>
  );
}

type PendingAttachment = {
  id: string;
  file: File;
  progress: number;
  state: "ready" | "uploading" | "failed";
};

export type NewFeedbackProps = {
  onCancel(): void;
  onCreated(ticketId: string, detail?: FeedbackTicketDetail): void;
};

export function NewFeedback({ onCancel, onCreated }: NewFeedbackProps) {
  const { message: copy, reportUnread, transport } = useHandsFeedback();
  const safeError = useSafeError();
  const [kind, setKind] = useState<FeedbackKind>("feedback");
  const [message, setMessage] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const actionController = useRef<AbortController | null>(null);
  const createSubmission = useRef<{ fingerprint: string; id: string } | null>(
    null,
  );
  const textareaRef = useAutosize(message);
  useEffect(() => {
    actionController.current?.abort();
    actionController.current = null;
    createSubmission.current = null;
    setSending(false);
    setAttachments((current) =>
      current.map((item) => ({ ...item, state: "ready", progress: 0 })),
    );
    return () => actionController.current?.abort();
  }, [transport]);

  const submit = async () => {
    const normalized = message.trim();
    if (!normalized || sending) return;
    const files = attachments.map(({ file }) => file);
    const attachmentError = localizedAttachmentError(files, copy);
    if (attachmentError) {
      setError(attachmentError);
      return;
    }
    setSending(true);
    setError(null);
    setAttachments((current) =>
      current.map((item) => ({ ...item, state: "uploading", progress: 0 })),
    );
    actionController.current?.abort();
    const controller = new AbortController();
    actionController.current = controller;
    const fingerprint = JSON.stringify([
      kind,
      normalized,
      ...files.map((file) => [
        file.name,
        file.type,
        file.size,
        file.lastModified,
      ]),
    ]);
    createSubmission.current = stableFeedbackSubmission(
      createSubmission.current,
      fingerprint,
    );
    try {
      const result = await transport.createTicket({
        kind,
        message: normalized,
        submissionId: createSubmission.current.id,
        attachments: files,
        signal: controller.signal,
        onAttachmentProgress: ({ index, progress }) => {
          if (controller.signal.aborted) return;
          setAttachments((current) =>
            current.map((item, itemIndex) =>
              itemIndex === index
                ? { ...item, progress: Math.max(0, Math.min(1, progress)) }
                : item,
            ),
          );
        },
      });
      if (controller.signal.aborted) return;
      reportUnread({ total: result.unreadTotal, source: "create" });
      createSubmission.current = null;
      setAnnouncement(copy("feedbackCreated"));
      onCreated(result.ticket.id, result);
    } catch (cause) {
      if (!controller.signal.aborted) {
        const safe = safeError(cause);
        setError(safe);
        setAnnouncement(safe);
        setAttachments((current) =>
          current.map((item) =>
            item.state === "uploading" ? { ...item, state: "failed" } : item,
          ),
        );
      }
    } finally {
      if (!controller.signal.aborted) setSending(false);
    }
  };

  const choose = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.currentTarget.files ?? []);
    const combined = [...attachments.map(({ file }) => file), ...selected];
    const attachmentError = localizedAttachmentError(combined, copy);
    if (attachmentError) {
      setError(attachmentError);
      event.currentTarget.value = "";
      return;
    }
    setError(null);
    setAttachments((current) => [
      ...current,
      ...selected.map((file) => ({
        id: submissionId(),
        file,
        progress: 0,
        state: "ready" as const,
      })),
    ]);
    event.currentTarget.value = "";
  };

  const cancelUpload = () => {
    actionController.current?.abort();
    setSending(false);
    setAttachments((current) =>
      current.map((item) => ({ ...item, state: "ready", progress: 0 })),
    );
    setAnnouncement(copy("uploadCanceled"));
  };

  return (
    <section
      className="hands-feedback-new"
      aria-labelledby="hands-feedback-new-title"
    >
      <header className="hands-feedback-header">
        <div>
          <h2 id="hands-feedback-new-title" tabIndex={-1}>
            {copy("newFeedback")}
          </h2>
          <p>{copy("newDescription")}</p>
        </div>
        <Button variant="outline" onClick={onCancel}>
          {copy("cancel")}
        </Button>
      </header>
      <div className="hands-feedback-middle hands-feedback-new-fields">
        <div
          className="hands-feedback-kind"
          role="group"
          aria-label={copy("feedbackType")}
        >
          <Button
            aria-pressed={kind === "feedback"}
            variant={kind === "feedback" ? "primary" : "outline"}
            onClick={() => setKind("feedback")}
          >
            {copy("feedback")}
          </Button>
          <Button
            aria-pressed={kind === "bug"}
            variant={kind === "bug" ? "primary" : "outline"}
            onClick={() => setKind("bug")}
          >
            {copy("problem")}
          </Button>
        </div>
        <label htmlFor="hands-feedback-message">{copy("question")}</label>
        <textarea
          ref={textareaRef}
          id="hands-feedback-message"
          maxLength={10_000}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          rows={2}
        />
        <label htmlFor="hands-feedback-attachments">
          {copy("screenshots", { count: MAX_FEEDBACK_ATTACHMENTS })}
        </label>
        <Input
          id="hands-feedback-attachments"
          type="file"
          accept={FEEDBACK_ATTACHMENT_TYPES.join(",")}
          multiple
          disabled={sending || attachments.length >= MAX_FEEDBACK_ATTACHMENTS}
          onChange={choose}
        />
        {attachments.length > 0 && (
          <ul className="hands-feedback-pending-attachments">
            {attachments.map((item) => (
              <li key={item.id}>
                <span>{item.file.name}</span>
                {item.state === "uploading" && (
                  <progress
                    max={1}
                    value={item.progress || undefined}
                    aria-label={copy("uploadProgress", {
                      name: item.file.name,
                    })}
                  />
                )}
                {item.state === "failed" && (
                  <span role="status">{copy("uploadFailed")}</span>
                )}
                <Button
                  variant="outline"
                  disabled={sending}
                  onClick={() =>
                    setAttachments((current) =>
                      current.filter(({ id }) => id !== item.id),
                    )
                  }
                >
                  {copy("remove")}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {error && (
          <div className="hands-feedback-error" role="alert">
            {error}
          </div>
        )}
      </div>
      <footer className="hands-feedback-submit-bar">
        {sending ? (
          <Button variant="outline" onClick={cancelUpload}>
            {copy("cancel")}
          </Button>
        ) : attachments.some(({ state }) => state === "failed") ? (
          <Button
            variant="outline"
            disabled={!message.trim()}
            onClick={() => void submit()}
          >
            {copy("retryUpload")}
          </Button>
        ) : null}
        <Button
          disabled={!message.trim() || sending}
          onClick={() => void submit()}
        >
          {sending ? copy("submitting") : copy("submit")}
        </Button>
      </footer>
      <div
        className="hands-feedback-live"
        aria-live="polite"
        aria-atomic="true"
      >
        {announcement}
      </div>
    </section>
  );
}

export type FeedbackWorkspaceRoute = {
  view: "inbox" | "new" | "ticket";
  ticketId?: string;
};
export type FeedbackWorkspaceProps = {
  initialTicketId?: string;
  route?: FeedbackWorkspaceRoute;
  onRouteChange?: (route: FeedbackWorkspaceRoute) => void;
  onOpenAttachment?: FeedbackTicketProps["onOpenAttachment"];
};

export function FeedbackWorkspace({
  initialTicketId,
  route: controlledRoute,
  onRouteChange,
  onOpenAttachment,
}: FeedbackWorkspaceProps) {
  const { theme } = useHandsFeedback();
  const initial = useMemo<FeedbackWorkspaceRoute>(
    () =>
      initialTicketId
        ? { view: "ticket", ticketId: initialTicketId }
        : { view: "inbox" },
    [initialTicketId],
  );
  const [internalRoute, setInternalRoute] = useState(initial);
  const route = controlledRoute ?? internalRoute;
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [readTicketId, setReadTicketId] = useState<string | null>(null);
  const [createdTicket, setCreatedTicket] =
    useState<FeedbackTicketSummary | null>(null);
  const originTicket = useRef<string | null>(initialTicketId ?? null);
  const pendingInboxFocus = useRef<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const navigate = (next: FeedbackWorkspaceRoute) => {
    if (!controlledRoute) setInternalRoute(next);
    onRouteChange?.(next);
  };
  const back = () => {
    pendingInboxFocus.current = originTicket.current ?? "";
    navigate({ view: "inbox" });
  };
  useEffect(() => {
    if (route.view === "inbox" && pendingInboxFocus.current !== null) {
      const focusId = pendingInboxFocus.current;
      pendingInboxFocus.current = null;
      requestAnimationFrame(() => {
        const root = rootRef.current;
        const row = Array.from(
          root?.querySelectorAll<HTMLElement>("[data-ticket-id]") ?? [],
        ).find((element) => element.dataset.ticketId === focusId);
        (
          row ?? root?.querySelector<HTMLElement>("[data-feedback-list-scroll]")
        )?.focus();
      });
    } else if (route.view !== "inbox")
      requestAnimationFrame(() =>
        rootRef.current
          ?.querySelector<HTMLElement>("section:not([hidden]) h2")
          ?.focus(),
      );
  }, [route]);
  useEffect(() => {
    const viewport = globalThis.window?.visualViewport;
    const root = rootRef.current;
    if (!viewport || !root) return;
    const sync = () =>
      root.style.setProperty(
        "--hf-visual-viewport-height",
        `${viewport.height}px`,
      );
    sync();
    viewport.addEventListener("resize", sync);
    viewport.addEventListener("scroll", sync);
    return () => {
      viewport.removeEventListener("resize", sync);
      viewport.removeEventListener("scroll", sync);
    };
  }, []);
  return (
    <div
      className="hands-feedback-root"
      data-hands-feedback-theme={theme}
      ref={rootRef}
    >
      <FeedbackInbox
        hidden={route.view !== "inbox"}
        readTicketId={readTicketId}
        upsertTicket={createdTicket}
        onNewFeedback={() => navigate({ view: "new" })}
        onSelectTicket={(ticketId) => {
          originTicket.current = ticketId;
          navigate({ view: "ticket", ticketId });
        }}
      />
      {route.view === "new" && (
        <NewFeedback
          onCancel={() => navigate({ view: "inbox" })}
          onCreated={(ticketId, detail) => {
            if (detail) setCreatedTicket(detail.ticket);
            originTicket.current = ticketId;
            navigate({ view: "ticket", ticketId });
          }}
        />
      )}
      {route.view === "ticket" && route.ticketId && (
        <FeedbackTicket
          ticketId={route.ticketId}
          draft={drafts[route.ticketId] ?? ""}
          onDraftChange={(value) =>
            setDrafts((current) => ({ ...current, [route.ticketId!]: value }))
          }
          onReadSuccess={setReadTicketId}
          onBack={back}
          {...(onOpenAttachment ? { onOpenAttachment } : {})}
        />
      )}
    </div>
  );
}
