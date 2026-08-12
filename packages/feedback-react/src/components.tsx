import {
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowLeft,
  Ban,
  Bug,
  Check,
  CheckCircle,
  Circle,
  Clock,
  ImagePlus,
  Lightbulb,
  MessageSquare,
  Paperclip,
  Play,
  Send,
  X,
} from "lucide-react";
import {
  Avatar,
  AvatarFallback,
  AlertDialog,
  AlertDialogAction,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Banner,
  BannerAction,
  BannerDescription,
  Badge,
  Button,
  Composer,
  ComposerActions,
  ComposerAttachment,
  ComposerAttachmentBody,
  ComposerAttachmentFailedOverlay,
  ComposerAttachmentFile,
  ComposerAttachmentMeta,
  ComposerAttachmentRemove,
  ComposerAttachments,
  ComposerAttachmentTitle,
  ComposerAttachmentUploadingOverlay,
  ComposerAttachmentUploadProgressBar,
  ComposerIconButton,
  ComposerInput,
  ComposerMeta,
  ComposerRoot,
  ComposerToolbar,
  ConversationPanelBody,
  ConversationPanelContent,
  ConversationPanelFooter,
  EmptyState,
  EmptyStateContent,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
  FileContent,
  FileMeta,
  FileMetaItem,
  FileName,
  FilePreview,
  FilePreviewFile,
  FileRow,
  FileRowOpen,
  FileThumbnail,
  MessageImageGallery,
  MessageImageGalleryItem,
  MessageImageGalleryMedia,
  MessageItem,
  MessageItemAttachments,
  MessageItemAvatarSlot,
  MessageItemBody,
  MessageItemContent,
  MessageItemFooter,
  MessageItemHeader,
  MessageItemSender,
  MessageItemTime,
  MessageList,
  MessageReferenceChip,
  MessageReferenceLabel,
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlLabel,
  Skeleton,
  Spinner,
  Tabs,
  TabsLabel,
  TabsList,
  TabsTab,
  TaskCard,
  TaskCardBody,
  TaskCardRow,
  TaskCardTitle,
  TextareaCounter,
} from "raft-ui";
import type { FeedbackMessageKey, FeedbackMessageValues } from "./locale.js";
import { useHandsFeedback } from "./provider.js";
import { usePullToRefresh } from "./usePullToRefresh.js";
import { FeedbackTransportError } from "./types.js";
import type {
  FeedbackAttachment,
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

type PendingAttachment = {
  id: string;
  file: File;
  progress: number;
  state: "ready" | "uploading" | "failed";
};

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

function PullToRefreshIndicator({
  distance,
  label,
  state,
}: {
  distance: number;
  label: string;
  state: "idle" | "pulling" | "refreshing";
}) {
  return (
    <div
      className="hands-feedback-pull-indicator"
      data-feedback-pull-state={state}
      role={state === "refreshing" ? "status" : undefined}
      style={{ height: `${distance}px` }}
    >
      {distance > 0 && <Spinner aria-hidden="true" size="sm" />}
      {state === "refreshing" && (
        <span className="hands-feedback-sr-only">{label}</span>
      )}
    </div>
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

function feedbackStatusLabel(
  status: FeedbackTicketSummary["status"],
  message: ReturnType<typeof useHandsFeedback>["message"],
) {
  return message(
    status === "in_progress"
      ? "statusInProgress"
      : status === "resolved"
        ? "statusResolved"
        : status === "closed"
          ? "statusClosed"
          : "statusOpen",
  );
}

function FeedbackKindChip({ kind }: { kind: FeedbackTicketSummary["kind"] }) {
  const { message } = useHandsFeedback();
  const isProblem = kind === "bug";
  const Icon = isProblem ? Bug : Lightbulb;
  return (
    <MessageReferenceChip
      className={`hands-feedback-reference-chip${isProblem ? " hands-feedback-problem-chip" : ""}`}
      data-feedback-kind={kind}
      variant={isProblem ? "muted" : "info"}
    >
      <span className="hands-feedback-reference-chip-content">
        <Icon aria-hidden="true" />
        <MessageReferenceLabel>
          {message(isProblem ? "problem" : "idea")}
        </MessageReferenceLabel>
      </span>
    </MessageReferenceChip>
  );
}

function FeedbackStatusChip({
  status,
}: {
  status: FeedbackTicketSummary["status"];
}) {
  const { message } = useHandsFeedback();
  const config = {
    open: {
      Icon: Circle,
      backgroundColor: "var(--color-brutal-orange)",
      variant: "warning" as const,
    },
    in_progress: {
      Icon: Play,
      backgroundColor: "var(--color-brutal-cyan)",
      variant: "information" as const,
    },
    resolved: {
      Icon: CheckCircle,
      backgroundColor: "var(--color-brutal-lime)",
      variant: "success" as const,
    },
    closed: {
      Icon: Ban,
      backgroundColor: "var(--color-brutal-stone)",
      variant: "muted" as const,
    },
  }[status];
  const StatusIcon = config.Icon;
  return (
    <Badge
      appearance="solid"
      uppercase={false}
      variant={config.variant}
      data-feedback-status={status}
      style={{ backgroundColor: config.backgroundColor }}
    >
      <StatusIcon aria-hidden="true" size={10} />
      {feedbackStatusLabel(status, message)}
    </Badge>
  );
}

function FeedbackErrorBanner({
  busy = false,
  busyLabel,
  error,
  onRetry,
  retryLabel,
}: {
  busy?: boolean;
  busyLabel?: string;
  error: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <Banner
      className="hands-feedback-error-banner"
      status="destructive"
      size="sm"
    >
      <BannerDescription>{error}</BannerDescription>
      {onRetry && retryLabel && (
        <BannerAction>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            loading={busy}
            loadingLabel={busyLabel ?? retryLabel}
            onClick={onRetry}
          >
            {retryLabel}
          </Button>
        </BannerAction>
      )}
    </Banner>
  );
}

function FeedbackCloseDialog({
  busy,
  error,
  onConfirm,
  onOpenChange,
  open,
}: {
  busy: boolean;
  error: string | null;
  onConfirm(): void;
  onOpenChange(open: boolean): void;
  open: boolean;
}) {
  const { message } = useHandsFeedback();
  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!busy) onOpenChange(nextOpen);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {message("closeTicketConfirm")}
          </AlertDialogTitle>
        </AlertDialogHeader>
        <AlertDialogBody>
          <AlertDialogDescription>
            {message("closeTicketDescription")}
          </AlertDialogDescription>
          {open && error && <FeedbackErrorBanner error={error} />}
        </AlertDialogBody>
        <AlertDialogFooter>
          <AlertDialogCancel size="sm" disabled={busy}>
            {message("cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            size="sm"
            variant="accent"
            loading={busy}
            loadingLabel={message("closingTicket")}
            disabled={busy}
            onClick={onConfirm}
          >
            {message("closeTicket")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

type FeedbackComposerProps = {
  id: string;
  label: string;
  value: string;
  onChange(value: string): void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  attachments: PendingAttachment[];
  onAttachmentsChange(event: ChangeEvent<HTMLInputElement>): void;
  onRemoveAttachment(id: string): void;
  busy: boolean;
  error?: string | null;
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  showCounter?: boolean;
  imageInputLabel?: string;
  testIdPrefix: "new" | "reply";
  actions: ReactNode;
};

function FeedbackComposer({
  id,
  label,
  value,
  onChange,
  textareaRef,
  attachments,
  onAttachmentsChange,
  onRemoveAttachment,
  busy,
  error,
  onKeyDown,
  placeholder,
  showCounter = false,
  imageInputLabel,
  testIdPrefix,
  actions,
}: FeedbackComposerProps) {
  const { message } = useHandsFeedback();
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const attachmentsDisabled =
    busy || attachments.length >= MAX_FEEDBACK_ATTACHMENTS;

  return (
    <ComposerRoot
      className="hands-feedback-composer-root"
      onSubmit={(event) => event.preventDefault()}
    >
      <label className="hands-feedback-sr-only" htmlFor={id}>
        {label}
      </label>
      <input
        ref={imageInputRef}
        data-testid={`hands-feedback-${testIdPrefix}-image-input`}
        className="hands-feedback-sr-only"
        aria-label={imageInputLabel}
        type="file"
        accept={FEEDBACK_ATTACHMENT_TYPES.join(",")}
        multiple
        disabled={attachmentsDisabled}
        onChange={onAttachmentsChange}
      />
      <input
        ref={fileInputRef}
        data-testid={`hands-feedback-${testIdPrefix}-file-input`}
        className="hands-feedback-sr-only"
        type="file"
        accept={FEEDBACK_ATTACHMENT_TYPES.join(",")}
        multiple
        disabled={attachmentsDisabled}
        onChange={onAttachmentsChange}
      />
      {attachments.length > 0 && (
        <ComposerAttachments aria-label={message("attachments")}>
          {attachments.map((item) => (
            <ComposerAttachment key={item.id}>
              <ComposerAttachmentFile>
                <ImagePlus aria-hidden="true" />
                <ComposerAttachmentBody>
                  <ComposerAttachmentTitle>
                    {item.file.name}
                  </ComposerAttachmentTitle>
                  <ComposerAttachmentMeta>
                    {item.file.type || message("attachments")}
                  </ComposerAttachmentMeta>
                </ComposerAttachmentBody>
              </ComposerAttachmentFile>
              {item.state === "uploading" && (
                <>
                  <ComposerAttachmentUploadingOverlay>
                    {message("uploadProgress", { name: item.file.name })}
                  </ComposerAttachmentUploadingOverlay>
                  <ComposerAttachmentUploadProgressBar
                    value={item.progress * 100}
                  />
                </>
              )}
              {item.state === "failed" && (
                <ComposerAttachmentFailedOverlay role="status">
                  {message("uploadFailed")}
                </ComposerAttachmentFailedOverlay>
              )}
              <ComposerAttachmentRemove
                aria-label={`${message("remove")} ${item.file.name}`}
                title={`${message("remove")} ${item.file.name}`}
                disabled={busy}
                onClick={() => onRemoveAttachment(item.id)}
              >
                <X aria-hidden="true" size={12} />
              </ComposerAttachmentRemove>
            </ComposerAttachment>
          ))}
        </ComposerAttachments>
      )}
      {error && (
        <FeedbackErrorBanner error={error} />
      )}
      <Composer className="hands-feedback-composer">
        <ComposerInput
          ref={textareaRef}
          id={id}
          maxLength={10_000}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          {...(onKeyDown ? { onKeyDown } : {})}
          {...(placeholder ? { placeholder } : {})}
          rows={showCounter ? 5 : 1}
        />
        <ComposerToolbar className="hands-feedback-composer-toolbar">
          <ComposerMeta>
            <ComposerIconButton
              aria-label={message("attachImage")}
              title={message("attachImage")}
              disabled={attachmentsDisabled}
              onClick={() => imageInputRef.current?.click()}
            >
              <ImagePlus aria-hidden="true" size={14} />
            </ComposerIconButton>
            <ComposerIconButton
              aria-label={message("attachFile")}
              title={message("attachFile")}
              disabled={attachmentsDisabled}
              onClick={() => fileInputRef.current?.click()}
            >
              <Paperclip aria-hidden="true" size={14} />
            </ComposerIconButton>
            {showCounter && (
              <TextareaCounter
                className="hands-feedback-composer-counter"
                value={value}
                limit={10_000}
              />
            )}
          </ComposerMeta>
          <ComposerActions className="hands-feedback-composer-actions">
            {actions}
          </ComposerActions>
        </ComposerToolbar>
      </Composer>
    </ComposerRoot>
  );
}

export type FeedbackInboxProps = {
  onSelectTicket(
    ticketId: string,
    ticket?: FeedbackTicketSummary,
  ): void;
  onNewFeedback(): void;
  pageSize?: number;
  hidden?: boolean;
  readTicketId?: string | null;
  /** Changes whenever the same ticket is authoritatively read again. */
  readTicketVersion?: number;
  /** Newly-created authoritative ticket to expose without waiting for a list refetch. */
  upsertTicket?: FeedbackTicketSummary | null;
  /** Enables touch pull-to-refresh on the list viewport. */
  enablePullToRefresh?: boolean;
};

export function FeedbackInbox({
  onSelectTicket,
  onNewFeedback,
  pageSize = 20,
  hidden = false,
  readTicketId,
  readTicketVersion,
  upsertTicket,
  enablePullToRefresh = false,
}: FeedbackInboxProps) {
  const { formatDate, message, reportUnread, transport } = useHandsFeedback();
  const safeError = useSafeError();
  const [tickets, setTickets] = useState<FeedbackTicketSummary[]>([]);
  const [filter, setFilter] = useState<"all" | "open" | "resolved">("all");
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryCursor, setRetryCursor] = useState<string | undefined>(undefined);
  const [ticketToClose, setTicketToClose] =
    useState<FeedbackTicketSummary | null>(null);
  const [closingTicket, setClosingTicket] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const request = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const closeControllerRef = useRef<AbortController | null>(null);

  const load = useCallback(
    async (nextCursor?: string, refresh = false, retry = false) => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      const id = ++request.current;
      if (retry) setRetrying(true);
      else nextCursor ? setLoadingMore(true) : !refresh && setLoading(true);
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
        setError(null);
        setRetryCursor(undefined);
      } catch (cause) {
        if (!controller.signal.aborted && request.current === id) {
          setError(safeError(cause));
          setRetryCursor(nextCursor);
        }
      } finally {
        if (!controller.signal.aborted && request.current === id) {
          setLoading(false);
          setLoadingMore(false);
          if (retry) setRetrying(false);
        }
      }
    },
    [pageSize, reportUnread, safeError, transport],
  );
  const initialLoad = useRef(load);
  initialLoad.current = load;
  const pullToRefresh = usePullToRefresh<HTMLDivElement>({
    enabled: enablePullToRefresh,
    onRefresh: () => load(undefined, true),
  });

  useEffect(() => {
    void initialLoad.current();
    return () => {
      controllerRef.current?.abort();
      closeControllerRef.current?.abort();
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
  }, [readTicketId, readTicketVersion]);

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
  const emptyKind = tickets.length === 0 ? "all" : filter;
  const EmptyIcon =
    emptyKind === "open"
      ? Clock
      : emptyKind === "resolved"
        ? Check
        : MessageSquare;
  const emptyTitleKey =
    emptyKind === "open"
      ? "emptyActiveTitle"
      : emptyKind === "resolved"
        ? "emptyEndedTitle"
        : "emptyAllTitle";
  const emptyBodyKey =
    emptyKind === "open"
      ? "emptyActiveBody"
      : emptyKind === "resolved"
        ? "emptyEndedBody"
        : "emptyAllBody";

  const closeSelectedTicket = async () => {
    if (!ticketToClose || !transport.closeTicket || closingTicket) return;
    setClosingTicket(true);
    setCloseError(null);
    closeControllerRef.current?.abort();
    const controller = new AbortController();
    closeControllerRef.current = controller;
    try {
      const result = await transport.closeTicket({
        ticketId: ticketToClose.id,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      reportUnread({ total: result.unreadTotal, source: "close" });
      setTickets((current) =>
        current.map((ticket) =>
          ticket.id === result.ticket.id ? result.ticket : ticket,
        ),
      );
      setTicketToClose(null);
      setAnnouncement(message("ticketClosed"));
    } catch (cause) {
      if (!controller.signal.aborted) setCloseError(safeError(cause));
    } finally {
      if (!controller.signal.aborted) setClosingTicket(false);
    }
  };

  return (
    <section
      className="hands-feedback-inbox"
      aria-labelledby="hands-feedback-inbox-title"
      hidden={hidden}
    >
      <header className="hands-feedback-header">
        <div className="hands-feedback-header-title">
          <span className="hands-feedback-header-icon" aria-hidden="true">
            <MessageSquare size={16} />
          </span>
          <h2 id="hands-feedback-inbox-title">{message("workspaceTitle")}</h2>
        </div>
        <Button size="xs" onClick={onNewFeedback}>
          {message("newFeedback")}
        </Button>
      </header>
      <div className="hands-feedback-content hands-feedback-inbox-content">
        {tickets.length > 0 && (
          <Tabs<"all" | "open" | "resolved">
            className="hands-feedback-filter"
            value={filter}
            onValueChange={setFilter}
          >
            <TabsList aria-label={message("statusFilter")}>
              {(["all", "open", "resolved"] as const).map((value) => (
                <TabsTab key={value} value={value}>
                  <TabsLabel>
                    {value === "all"
                      ? message("all")
                      : message(value === "open" ? "active" : "ended")}
                  </TabsLabel>
                </TabsTab>
              ))}
            </TabsList>
          </Tabs>
        )}
        <div
          className="hands-feedback-middle hands-feedback-list-scroll"
          data-feedback-list-scroll
          data-feedback-empty-scroll={
            !loading && !error && visibleTickets.length === 0
              ? "true"
              : undefined
          }
          ref={pullToRefresh.scrollRef}
          tabIndex={-1}
        >
          <PullToRefreshIndicator
            distance={pullToRefresh.distance}
            label={message("refreshing")}
            state={pullToRefresh.state}
          />
          {loading && (
            <div
              className="hands-feedback-stack"
              aria-label={message("loading")}
            >
              <Skeleton className="hands-feedback-skeleton-row" />
              <Skeleton className="hands-feedback-skeleton-row" />
              <Skeleton className="hands-feedback-skeleton-row" />
            </div>
          )}
          {error && (
            <FeedbackErrorBanner
              busy={retrying}
              busyLabel={message("loading")}
              error={error}
              retryLabel={message("retry")}
              onRetry={() => void load(retryCursor, true, true)}
            />
          )}
          {!loading && !error && visibleTickets.length === 0 && (
            <EmptyState
              className="hands-feedback-empty"
              data-feedback-empty-kind={emptyKind}
            >
              <EmptyStateIcon className="hands-feedback-empty-icon">
                <EmptyIcon aria-hidden="true" size={20} />
              </EmptyStateIcon>
              <EmptyStateContent>
                <EmptyStateTitle className="hands-feedback-empty-title">
                  {message(emptyTitleKey)}
                </EmptyStateTitle>
                <EmptyStateDescription className="hands-feedback-empty-description">
                  {message(emptyBodyKey)}
                </EmptyStateDescription>
              </EmptyStateContent>
            </EmptyState>
          )}
          {visibleTickets.length > 0 && (
            <ul
              className="hands-feedback-ticket-list"
              aria-label={message("workspaceTitle")}
            >
              {visibleTickets.map((ticket) => {
                const ticketTitle = ticket.message.split("\n", 1)[0];
                return (
                  <li key={ticket.id}>
                    <TaskCard className="hands-feedback-ticket-card">
                      <button
                        type="button"
                        className="hands-feedback-ticket-open"
                        data-ticket-id={ticket.id}
                        data-unread={ticket.unread || undefined}
                        aria-label={ticketTitle}
                        onClick={() => onSelectTicket(ticket.id, ticket)}
                      />
                      <TaskCardRow className="hands-feedback-ticket-content">
                        <TaskCardBody className="hands-feedback-ticket-body">
                          <TaskCardTitle
                            className="hands-feedback-ticket-title"
                            title={ticketTitle}
                          >
                            {ticketTitle}
                          </TaskCardTitle>
                          <div className="hands-feedback-ticket-date">
                            {formatDate(ticket.updatedAt)}
                          </div>
                          <div className="hands-feedback-ticket-meta">
                            <FeedbackKindChip kind={ticket.kind} />
                            <FeedbackStatusChip status={ticket.status} />
                            {transport.closeTicket &&
                              ticket.status !== "closed" && (
                                <MessageReferenceChip
                                  render={<button type="button" />}
                                  className="hands-feedback-close-chip hands-feedback-reference-chip"
                                  variant="accent"
                                  onClick={() => {
                                    setCloseError(null);
                                    setTicketToClose(ticket);
                                  }}
                                >
                                  <span className="hands-feedback-reference-chip-content">
                                    <X aria-hidden="true" />
                                    <MessageReferenceLabel>
                                      {message("closeTicket")}
                                    </MessageReferenceLabel>
                                  </span>
                                </MessageReferenceChip>
                              )}
                          </div>
                        </TaskCardBody>
                        {ticket.unread ? (
                          <Badge
                            appearance="solid"
                            variant="accent"
                            uppercase={false}
                            className="hands-feedback-unread-count"
                            data-feedback-unread-count={Math.max(
                              1,
                              ticket.unreadCount,
                            )}
                            aria-label={message("unreadCount", {
                              count: Math.max(1, ticket.unreadCount),
                            })}
                          >
                            {ticket.unreadCount > 99
                              ? "99+"
                              : Math.max(1, ticket.unreadCount)}
                          </Badge>
                        ) : null}
                      </TaskCardRow>
                    </TaskCard>
                  </li>
                );
              })}
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
      </div>
      <div className="hands-feedback-live" aria-live="polite">
        {pullToRefresh.refreshing
          ? message("refreshing")
          : loadingMore
            ? message("loadingMore")
            : (error ?? announcement)}
      </div>
      {transport.closeTicket && (
        <FeedbackCloseDialog
          open={ticketToClose !== null}
          busy={closingTicket}
          error={closeError}
          onOpenChange={(open) => {
            if (!open) {
              setCloseError(null);
              setTicketToClose(null);
            }
          }}
          onConfirm={() => void closeSelectedTicket()}
        />
      )}
    </section>
  );
}

export type FeedbackTicketProps = {
  ticketId: string;
  initialTicket?: FeedbackTicketSummary;
  onBack(): void;
  onOpenAttachment?: (input: FeedbackAttachmentOpenInput) => void;
  draft?: string;
  onDraftChange?: (value: string) => void;
  onReadSuccess?: (ticketId: string) => void;
  onTicketUpdated?: (ticket: FeedbackTicketSummary) => void;
  /** Enables touch pull-to-refresh on the conversation viewport. */
  enablePullToRefresh?: boolean;
};

function previewTicketDetail(
  ticket: FeedbackTicketSummary | undefined,
): FeedbackTicketDetail | null {
  if (!ticket) return null;
  return {
    ticket,
    comments: [],
    attachments: [],
    nextCommentCursor: null,
    unreadTotal: 0,
  };
}

type FeedbackAttachmentOpenInput = {
  ticketId: string;
  attachmentId: string;
};

type FeedbackConversationMessageProps = {
  authorType: FeedbackComment["authorType"];
  body: string;
  createdAt: number;
  ticketId: string;
  attachments?: FeedbackTicketDetail["attachments"];
  onOpenAttachment?: (input: FeedbackAttachmentOpenInput) => void;
  footer?: ReactNode;
};

function FeedbackImageAttachment({
  attachment,
  ticketId,
  onOpenAttachment,
}: {
  attachment: FeedbackAttachment;
  ticketId: string;
  onOpenAttachment?: (input: FeedbackAttachmentOpenInput) => void;
}) {
  const { formatFileSize, message, transport } = useHandsFeedback();
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    if (
      !transport.getAttachment ||
      typeof URL.createObjectURL !== "function"
    )
      return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    void transport
      .getAttachment({
        ticketId,
        attachmentId: attachment.id,
        signal: controller.signal,
      })
      .then((blob) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setPreviewUrl(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment.id, ticketId, transport]);

  return (
    <MessageImageGalleryItem
      render={onOpenAttachment ? <button type="button" /> : undefined}
      className={onOpenAttachment ? "hands-feedback-image-button" : undefined}
      aria-label={
        onOpenAttachment
          ? message("openAttachment", { name: attachment.filename })
          : undefined
      }
      onClick={
        onOpenAttachment
          ? () => onOpenAttachment({ ticketId, attachmentId: attachment.id })
          : undefined
      }
    >
      <MessageImageGalleryMedia>
        {previewUrl ? (
          <img alt={attachment.filename} src={previewUrl} />
        ) : (
          <span className="hands-feedback-image-placeholder">
            <ImagePlus aria-hidden="true" />
            <span>{attachment.filename}</span>
            <small>{formatFileSize(attachment.sizeBytes)}</small>
          </span>
        )}
      </MessageImageGalleryMedia>
      {previewUrl && (
        <>
          <span className="hands-feedback-sr-only">{attachment.filename}</span>
          <span className="hands-feedback-sr-only">
            {formatFileSize(attachment.sizeBytes)}
          </span>
        </>
      )}
    </MessageImageGalleryItem>
  );
}

function FeedbackConversationMessage({
  authorType,
  body,
  createdAt,
  ticketId,
  attachments = [],
  onOpenAttachment,
  footer,
}: FeedbackConversationMessageProps) {
  const { formatDate, formatFileSize, message } = useHandsFeedback();
  const sender =
    authorType === "reporter"
      ? message("you")
      : authorType === "staff"
        ? message("team")
        : message("update");
  const openAttachment = (attachmentId: string) =>
    onOpenAttachment?.({ ticketId, attachmentId });

  return (
    <MessageItem data-author={authorType}>
      <MessageItemAvatarSlot>
        <Avatar
          size="md"
          type={authorType === "reporter" ? "human" : "agent"}
        >
          <AvatarFallback>{sender.slice(0, 1).toUpperCase()}</AvatarFallback>
        </Avatar>
      </MessageItemAvatarSlot>
      <MessageItemContent>
        <MessageItemHeader>
          <MessageItemSender>{sender}</MessageItemSender>
          <MessageItemTime>{formatDate(createdAt)}</MessageItemTime>
        </MessageItemHeader>
        <MessageItemBody>{body}</MessageItemBody>
        {attachments.length > 0 && (
          <MessageItemAttachments>
            <MessageImageGallery>
              {attachments
                .filter((attachment) =>
                  attachment.contentType.startsWith("image/"),
                )
                .map((attachment) => (
                  <FeedbackImageAttachment
                    key={attachment.id}
                    attachment={attachment}
                    ticketId={ticketId}
                    {...(onOpenAttachment ? { onOpenAttachment } : {})}
                  />
                ))}
            </MessageImageGallery>
            {attachments
              .filter(
                (attachment) =>
                  !attachment.contentType.startsWith("image/"),
              )
              .map((attachment) => (
                <FileRow key={attachment.id}>
                  <FileRowOpen
                    disabled={!onOpenAttachment}
                    aria-label={message("openAttachment", {
                      name: attachment.filename,
                    })}
                    onClick={() => openAttachment(attachment.id)}
                  >
                    <FileThumbnail>
                      <FilePreview>
                        <FilePreviewFile />
                      </FilePreview>
                    </FileThumbnail>
                    <FileContent>
                      <FileName>{attachment.filename}</FileName>
                      <FileMeta>
                        <FileMetaItem>
                          {formatFileSize(attachment.sizeBytes)}
                        </FileMetaItem>
                      </FileMeta>
                    </FileContent>
                  </FileRowOpen>
                </FileRow>
              ))}
          </MessageItemAttachments>
        )}
        {footer && <MessageItemFooter>{footer}</MessageItemFooter>}
      </MessageItemContent>
    </MessageItem>
  );
}

export function FeedbackTicket({
  ticketId,
  initialTicket,
  onBack,
  onOpenAttachment,
  draft,
  onDraftChange,
  onReadSuccess,
  onTicketUpdated,
  enablePullToRefresh = false,
}: FeedbackTicketProps) {
  const { message, reportUnread, transport } = useHandsFeedback();
  const safeError = useSafeError();
  const [detail, setDetail] = useState<FeedbackTicketDetail | null>(() =>
    previewTicketDetail(
      initialTicket?.id === ticketId ? initialTicket : undefined,
    ),
  );
  const [internalDraft, setInternalDraft] = useState("");
  const reply = draft ?? internalDraft;
  const setReply = onDraftChange ?? setInternalDraft;
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [retryingLoad, setRetryingLoad] = useState(false);
  const [sending, setSending] = useState(false);
  const [closing, setClosing] = useState(false);
  const [confirmingClose, setConfirmingClose] = useState(false);
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
  const scrollIntent = useRef<"bottom" | "preserve" | null>(null);

  useEffect(() => {
    actionController.current?.abort();
    actionController.current = null;
    commentSubmission.current = null;
    setSending(false);
    setClosing(false);
    setConfirmingClose(false);
    setReplyAttachments([]);
    setDetail(
      previewTicketDetail(
        initialTicket?.id === ticketId ? initialTicket : undefined,
      ),
    );
    setLoading(true);
    setRetryingLoad(false);
    setLoadError(null);
  }, [initialTicket, ticketId, transport]);

  const load = useCallback(
    async (commentCursor?: string, refresh = false, retry = false) => {
      loadController.current?.abort();
      const controller = new AbortController();
      loadController.current = controller;
      const requestId = ++loadRequest.current;
      if (retry) setRetryingLoad(true);
      else commentCursor ? setLoadingMore(true) : setLoading(!refresh);
      if (!retry && !commentCursor && !refresh)
        setDetail((current) =>
          current?.ticket.id === ticketId
            ? current
            : previewTicketDetail(
                initialTicket?.id === ticketId ? initialTicket : undefined,
              ),
        );
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
        setLoadError(null);
        setRetryLoad({ cursor: undefined, refresh: false });
      } catch (cause) {
        if (!controller.signal.aborted && requestId === loadRequest.current) {
          setLoadError(safeError(cause));
          setRetryLoad({ cursor: commentCursor, refresh });
        }
      } finally {
        if (!controller.signal.aborted && requestId === loadRequest.current) {
          setLoading(false);
          setLoadingMore(false);
          if (retry) setRetryingLoad(false);
        }
      }
    },
    [
      initialTicket,
      message,
      onReadSuccess,
      reportUnread,
      safeError,
      ticketId,
      transport,
    ],
  );
  const initialLoad = useRef(load);
  initialLoad.current = load;
  const pullToRefresh = usePullToRefresh<HTMLDivElement>({
    enabled: enablePullToRefresh,
    onRefresh: () => load(undefined, true),
  });
  const setConversationViewport = useCallback(
    (node: HTMLDivElement | null) => {
      conversationRef.current = node;
      pullToRefresh.scrollRef(node);
    },
    [pullToRefresh.scrollRef],
  );

  useEffect(() => {
    void initialLoad.current();
    return () => {
      loadController.current?.abort();
      actionController.current?.abort();
      loadRequest.current += 1;
    };
  }, [ticketId, transport]);

  useEffect(() => {
    const refreshOnFocus = () => void initialLoad.current(undefined, true);
    window.addEventListener("focus", refreshOnFocus);
    return () => window.removeEventListener("focus", refreshOnFocus);
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

  const closeTicket = async () => {
    if (!detail || !transport.closeTicket || closing) return;
    setClosing(true);
    setActionError(null);
    actionController.current?.abort();
    const controller = new AbortController();
    actionController.current = controller;
    try {
      const result = await transport.closeTicket({ ticketId, signal: controller.signal });
      if (controller.signal.aborted) return;
      reportUnread({ total: result.unreadTotal, source: "close" });
      setDetail(result);
      setConfirmingClose(false);
      onTicketUpdated?.(result.ticket);
      setAnnouncement(message("ticketClosed"));
    } catch (cause) {
      if (!controller.signal.aborted) {
        const safe = safeError(cause);
        setActionError(safe);
        setAnnouncement(safe);
      }
    } finally {
      if (!controller.signal.aborted) setClosing(false);
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
        <div className="hands-feedback-header-title">
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
            {message("workspaceTitle")}
          </h2>
        </div>
      </header>
      <ConversationPanelContent className="hands-feedback-detail-content">
        <ConversationPanelBody className="hands-feedback-detail-body">
          {loading && !detail && (
            <Skeleton className="hands-feedback-skeleton-detail" />
          )}
          {loadError && (
            <FeedbackErrorBanner
              busy={retryingLoad}
              busyLabel={message("loading")}
              error={loadError}
              retryLabel={message("retry")}
              onRetry={() =>
                void load(retryLoad.cursor, retryLoad.refresh, true)
              }
            />
          )}
          {detail && (
            <>
            <MessageList
              rootClassName="hands-feedback-conversation-root"
              className="hands-feedback-conversation"
              aria-label={message("conversation")}
              ref={setConversationViewport}
              onScroll={() => {
                if (
                  conversationRef.current &&
                  isNearConversationBottom(conversationRef.current)
                )
                  setNewReplies(false);
              }}
            >
              <PullToRefreshIndicator
                distance={pullToRefresh.distance}
                label={message("refreshing")}
                state={pullToRefresh.state}
              />
              <FeedbackConversationMessage
                authorType="reporter"
                body={detail.ticket.message}
                createdAt={detail.ticket.createdAt}
                ticketId={ticketId}
                attachments={detail.attachments}
                {...(onOpenAttachment ? { onOpenAttachment } : {})}
                footer={
                  <>
                    <FeedbackKindChip kind={detail.ticket.kind} />
                    <FeedbackStatusChip status={detail.ticket.status} />
                    {transport.closeTicket &&
                      detail.ticket.status !== "closed" && (
                        <MessageReferenceChip
                          render={<button type="button" />}
                          className="hands-feedback-close-chip hands-feedback-reference-chip"
                          variant="accent"
                          onClick={() => {
                            setActionError(null);
                            setConfirmingClose(true);
                          }}
                        >
                          <span className="hands-feedback-reference-chip-content">
                            <X aria-hidden="true" />
                            <MessageReferenceLabel>
                              {message("closeTicket")}
                            </MessageReferenceLabel>
                          </span>
                        </MessageReferenceChip>
                      )}
                  </>
                }
              />
              {detail.comments.map((comment) => (
                <FeedbackConversationMessage
                  key={comment.id}
                  authorType={comment.authorType}
                  body={comment.body}
                  createdAt={comment.createdAt}
                  ticketId={ticketId}
                />
              ))}
            </MessageList>
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
        </ConversationPanelBody>
        {detail && detail.ticket.status !== "closed" && (
          <ConversationPanelFooter className="hands-feedback-reply-footer">
            <FeedbackComposer
              id={`hands-feedback-reply-${ticketId}`}
              label={message("reply")}
              value={reply}
              onChange={setReply}
              textareaRef={textareaRef}
              attachments={replyAttachments}
              onAttachmentsChange={chooseReplyAttachments}
              onRemoveAttachment={(id) =>
                setReplyAttachments((current) =>
                  current.filter((item) => item.id !== id),
                )
              }
              busy={sending}
              error={actionError}
              onKeyDown={onReplyKeyDown}
              placeholder={message("replyPlaceholder")}
              testIdPrefix="reply"
              actions={
                <Button
                  aria-label={
                    sending ? message("sending") : message("sendReply")
                  }
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
              }
            />
          </ConversationPanelFooter>
        )}
      </ConversationPanelContent>
      <div
        className="hands-feedback-live"
        aria-live="polite"
        aria-atomic="true"
      >
        {pullToRefresh.refreshing ? message("refreshing") : announcement}
      </div>
      {transport.closeTicket && (
        <FeedbackCloseDialog
          open={confirmingClose}
          busy={closing}
          error={confirmingClose ? actionError : null}
          onOpenChange={(open) => {
            if (!closing) setConfirmingClose(open);
          }}
          onConfirm={() => void closeTicket()}
        />
      )}
    </section>
  );
}

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
        <div className="hands-feedback-header-title">
          <Button
            aria-label={copy("back")}
            title={copy("back")}
            size="icon-sm"
            variant="outline"
            onClick={onCancel}
          >
            <ArrowLeft aria-hidden="true" size={16} />
          </Button>
          <h2 id="hands-feedback-new-title" tabIndex={-1}>
            {copy("newFeedback")}
          </h2>
        </div>
      </header>
      <div className="hands-feedback-middle hands-feedback-new-fields">
        <span className="hands-feedback-field-label">{copy("type")}</span>
        <SegmentedControl<FeedbackKind>
          className="hands-feedback-kind"
          value={kind}
          onValueChange={(value) => {
            if (value) setKind(value);
          }}
          aria-label={copy("feedbackType")}
        >
          <SegmentedControlItem
            className="hands-feedback-kind-item"
            value="feedback"
          >
            <SegmentedControlLabel>{copy("idea")}</SegmentedControlLabel>
          </SegmentedControlItem>
          <SegmentedControlItem
            className="hands-feedback-kind-item"
            value="bug"
          >
            <SegmentedControlLabel>{copy("problem")}</SegmentedControlLabel>
          </SegmentedControlItem>
        </SegmentedControl>
        <span className="hands-feedback-field-label">{copy("question")}</span>
        <FeedbackComposer
          id="hands-feedback-message"
          value={message}
          label={copy("question")}
          onChange={setMessage}
          textareaRef={textareaRef}
          attachments={attachments}
          onAttachmentsChange={choose}
          onRemoveAttachment={(id) =>
            setAttachments((current) =>
              current.filter((item) => item.id !== id),
            )
          }
          busy={sending}
          error={error}
          placeholder={copy("describePlaceholder")}
          showCounter
          imageInputLabel={copy("screenshots", {
            count: MAX_FEEDBACK_ATTACHMENTS,
          })}
          testIdPrefix="new"
          actions={
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={sending ? cancelUpload : onCancel}
              >
                {copy("cancel")}
              </Button>
              <Button
                size="sm"
                variant="accent"
                disabled={!message.trim() || sending}
                onClick={() => void submit()}
              >
                <Send aria-hidden="true" size={14} />
                {sending
                  ? copy("submitting")
                  : attachments.some(({ state }) => state === "failed")
                    ? copy("retryUpload")
                    : copy("submit")}
              </Button>
            </>
          }
        />
        <p className="hands-feedback-form-note">
          {copy("attachmentHint", { count: MAX_FEEDBACK_ATTACHMENTS })}
        </p>
      </div>
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
export type FeedbackWorkspaceNavigationOptions = {
  replace?: boolean;
};
export type FeedbackWorkspaceProps = {
  initialTicketId?: string;
  route?: FeedbackWorkspaceRoute;
  onRouteChange?: (
    route: FeedbackWorkspaceRoute,
    options?: FeedbackWorkspaceNavigationOptions,
  ) => void;
  onOpenAttachment?: FeedbackTicketProps["onOpenAttachment"];
  /** Enables mobile pull-to-refresh for the inbox and ticket conversation. */
  enablePullToRefresh?: boolean;
};

export function FeedbackWorkspace({
  initialTicketId,
  route: controlledRoute,
  onRouteChange,
  onOpenAttachment,
  enablePullToRefresh = false,
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
  const [readTicket, setReadTicket] = useState({
    id: null as string | null,
    version: 0,
  });
  const [createdTicket, setCreatedTicket] =
    useState<FeedbackTicketSummary | null>(null);
  const [routeTicket, setRouteTicket] =
    useState<FeedbackTicketSummary | null>(null);
  const originTicket = useRef<string | null>(initialTicketId ?? null);
  const pendingInboxFocus = useRef<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const navigate = (
    next: FeedbackWorkspaceRoute,
    options?: FeedbackWorkspaceNavigationOptions,
  ) => {
    if (!controlledRoute) setInternalRoute(next);
    onRouteChange?.(next, options);
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
        enablePullToRefresh={enablePullToRefresh}
        hidden={route.view !== "inbox"}
        readTicketId={readTicket.id}
        readTicketVersion={readTicket.version}
        upsertTicket={createdTicket}
        onNewFeedback={() => {
          setRouteTicket(null);
          navigate({ view: "new" });
        }}
        onSelectTicket={(ticketId, ticket) => {
          setRouteTicket(ticket ?? null);
          originTicket.current = ticketId;
          navigate({ view: "ticket", ticketId });
        }}
      />
      {route.view === "new" && (
        <NewFeedback
          onCancel={() => navigate({ view: "inbox" })}
          onCreated={(ticketId, detail) => {
            if (detail) {
              setCreatedTicket(detail.ticket);
              setRouteTicket(detail.ticket);
            }
            originTicket.current = ticketId;
            navigate({ view: "ticket", ticketId }, { replace: true });
          }}
        />
      )}
      {route.view === "ticket" && route.ticketId && (
        <FeedbackTicket
          enablePullToRefresh={enablePullToRefresh}
          ticketId={route.ticketId}
          {...(routeTicket?.id === route.ticketId
            ? { initialTicket: routeTicket }
            : {})}
          draft={drafts[route.ticketId] ?? ""}
          onDraftChange={(value) =>
            setDrafts((current) => ({ ...current, [route.ticketId!]: value }))
          }
          onReadSuccess={(ticketId) =>
            setReadTicket((current) => ({
              id: ticketId,
              version: current.version + 1,
            }))
          }
          onTicketUpdated={setCreatedTicket}
          onBack={back}
          {...(onOpenAttachment ? { onOpenAttachment } : {})}
        />
      )}
    </div>
  );
}
