import {
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type RefObject,
  Fragment,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowLeft,
  Bug,
  CircleCheck,
  ImagePlus,
  Lightbulb,
  MessageSquare,
  MessageSquarePlus,
  Paperclip,
  Send,
  User,
  X,
} from "lucide-react";
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
  Avatar,
  AvatarFallback,
  Badge,
  Banner,
  BannerAction,
  BannerDescription,
  Button,
  Composer,
  ComposerActions,
  ComposerAttachment,
  ComposerAttachmentBody,
  ComposerAttachmentFailedOverlay,
  ComposerAttachmentFile,
  ComposerAttachmentImage,
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
  ComposerSubmit,
  ComposerToolbar,
  ConversationPanelBody,
  ConversationPanelContent,
  ConversationPanelFooter,
  EmptyState,
  EmptyStateContent,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
  Label,
  FileContent,
  FileMeta,
  FileMetaItem,
  FileName,
  FilePreview,
  FilePreviewFile,
  FileRow,
  FileRowOpen,
  FileThumbnail,
  InboxItem,
  InboxItemBody,
  InboxItemContent,
  InboxItemHeading,
  InboxItemMetadata,
  InboxItemSender,
  InboxItemTimestamp,
  InboxItemTitle,
  InboxItemTrailing,
  InboxItemTrigger,
  MessageImageGallery,
  MessageImageGalleryItem,
  MessageImageGalleryMedia,
  MessageItem,
  MessageItemAttachments,
  MessageItemAvatarSlot,
  MessageItemBody,
  MessageItemContent,
  MessageItemContinuationTime,
  MessageItemGutter,
  MessageItemHeader,
  MessageItemSender,
  MessageItemTime,
  MessageList,
  MessageListDateDivider,
  PanelAction,
  PanelActions,
  PanelHeader,
  PanelHeaderContent,
  PanelHeading,
  PanelMeta,
  PanelNotice,
  PanelNoticeActions,
  PanelNoticeContent,
  PanelStatus,
  PanelTitle,
  RadioGroup,
  RadioGroupItem,
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlLabel,
  Skeleton,
  Spinner,
  Status,
  SystemMessage,
  SystemMessageContent,
  SystemMessageTime,
  Tabs,
  TabsLabel,
  TabsList,
  TabsTab,
} from "@botiverse/raft-ui";
import type { FeedbackMessageKey, FeedbackMessageValues } from "./locale.js";
import { useHandsFeedback } from "./provider.js";
import { MarkdownText } from "./MarkdownText.js";
import { usePullToRefresh } from "./usePullToRefresh.js";
import { FeedbackTransportError } from "./types.js";
import type {
  FeedbackAttachment,
  FeedbackClosureReason,
  FeedbackComment,
  FeedbackKind,
  FeedbackTicketDetail,
  FeedbackTicketSummary,
} from "./types.js";

type ReporterClosureReason = Extract<
  FeedbackClosureReason,
  "completed" | "no_longer_needed"
>;

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
  /** `host` entries came through `attachPendingFile`, never a file picker. */
  source?: "user" | "host";
};

/** Largest file a host may inject through `attachPendingFile`. */
export const MAX_FEEDBACK_HOST_ATTACHMENT_BYTES = 1024 * 1024;
/** At most this many host-injected files may be pending at once. */
export const MAX_FEEDBACK_HOST_ATTACHMENTS = 1;
/** MIME types a host may inject (screenshots plus small text diagnostics). */
export const FEEDBACK_HOST_ATTACHMENT_TYPES = [
  ...FEEDBACK_ATTACHMENT_TYPES,
  "application/json",
  "text/plain",
] as const;
const MAX_FEEDBACK_HOST_ATTACHMENT_NAME = 120;

export type FeedbackHostAttachmentInput = {
  /** Caller-built bytes with an explicit name and MIME type. */
  file: File;
};

export type FeedbackHostAttachmentRejection =
  /** No transient browser user activation (call only from a user gesture). */
  | "user_activation_required"
  /** The new-feedback composer is not mounted/visible. */
  | "composer_closed"
  /** A submission is in flight. */
  | "busy"
  /** Input is not exactly `{ file: File }`. */
  | "invalid_input"
  | "invalid_name"
  | "empty"
  | "too_large"
  | "unsupported_type"
  /** The same file (name, type, size, lastModified) is already pending. */
  | "duplicate"
  /** Host or total pending-attachment limit reached. */
  | "limit_reached";

export type FeedbackHostAttachmentResult =
  | { ok: true }
  | { ok: false; reason: FeedbackHostAttachmentRejection };

/**
 * Imperative handle for hosts. `attachPendingFile` only adds a file to the
 * reporter's pending list; it never uploads or submits. The reporter still
 * reviews/removes it and presses Submit.
 */
export type FeedbackWorkspaceHandle = {
  /** Low-level: stage into an already-open new-feedback composer. */
  attachPendingFile(
    input: FeedbackHostAttachmentInput,
  ): FeedbackHostAttachmentResult;
  /**
   * Opens the new-feedback form with `file` already pending, in the same
   * synchronous call (call it from a click handler, do not `await` first).
   * If the form is already open, the file is added to it. Never uploads.
   * Only on `FeedbackWorkspace`; `NewFeedback` handles do not implement it.
   */
  openNewFeedbackWithPendingFile?(
    input: FeedbackHostAttachmentInput,
  ): FeedbackHostAttachmentResult;
};

/** Handle returned by `FeedbackWorkspace`'s `ref`. */
export type FeedbackWorkspaceHostHandle = Required<FeedbackWorkspaceHandle>;

function hasTransientUserActivation() {
  const activation = (
    globalThis.navigator as
      | (Navigator & { userActivation?: { isActive?: boolean } })
      | undefined
  )?.userActivation;
  return activation?.isActive === true;
}

function fileIdentity(file: File) {
  return JSON.stringify([file.name, file.type, file.size, file.lastModified]);
}

function hostAttachmentRejection(
  input: unknown,
  pending: PendingAttachment[],
): FeedbackHostAttachmentRejection | null {
  if (
    !input ||
    typeof input !== "object" ||
    Object.keys(input).length !== 1 ||
    !("file" in input) ||
    typeof File === "undefined" ||
    !((input as { file: unknown }).file instanceof File)
  )
    return "invalid_input";
  const { file } = input as FeedbackHostAttachmentInput;
  const name = file.name;
  if (
    !name ||
    name.length > MAX_FEEDBACK_HOST_ATTACHMENT_NAME ||
    /[\\/\u0000-\u001f]/.test(name) ||
    name === "." ||
    name === ".."
  )
    return "invalid_name";
  if (file.size <= 0) return "empty";
  if (file.size > MAX_FEEDBACK_HOST_ATTACHMENT_BYTES) return "too_large";
  if (
    !(FEEDBACK_HOST_ATTACHMENT_TYPES as readonly string[]).includes(file.type)
  )
    return "unsupported_type";
  const identity = fileIdentity(file);
  if (pending.some((item) => fileIdentity(item.file) === identity))
    return "duplicate";
  if (
    pending.length >= MAX_FEEDBACK_ATTACHMENTS ||
    pending.filter((item) => item.source === "host").length >=
      MAX_FEEDBACK_HOST_ATTACHMENTS
  )
    return "limit_reached";
  return null;
}

export type FeedbackPendingAttachmentOpenInput = {
  file: File;
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

function localizedPendingAttachmentError(
  pending: PendingAttachment[],
  message: (key: FeedbackMessageKey, values?: FeedbackMessageValues) => string,
) {
  if (pending.length > MAX_FEEDBACK_ATTACHMENTS)
    return message("attachmentTooMany", { count: MAX_FEEDBACK_ATTACHMENTS });
  return localizedAttachmentError(
    pending.filter((item) => item.source !== "host").map(({ file }) => file),
    message,
  );
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

function FeedbackStatusChip({
  closureReason,
  status,
}: {
  closureReason: FeedbackTicketSummary["closureReason"];
  status: FeedbackTicketSummary["status"];
}) {
  const { message } = useHandsFeedback();
  const displayStatus =
    status === "closed" && closureReason === "completed"
      ? "resolved"
      : status;
  // Raft Design System: a status chip is a soft Badge with a Status pixel
  // (badge.md); `solid` is the sticker for counts that wait for the person.
  const variant = {
    open: "warning" as const,
    in_progress: "information" as const,
    resolved: "success" as const,
    closed: "muted" as const,
  }[displayStatus];
  return (
    <Badge
      appearance="soft"
      variant={variant}
      data-feedback-status={status}
      data-feedback-display-status={displayStatus}
    >
      <Status variant={variant} size="md" aria-hidden="true" />
      {feedbackStatusLabel(displayStatus, message)}
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
      // Orange, as raft-design colours what went wrong; still announced as
      // an alert, because each of these stops what the reporter was doing.
      status="warning"
      role="alert"
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
  initialReason,
  onConfirm,
  onOpenChange,
  open,
}: {
  busy: boolean;
  error: string | null;
  initialReason: ReporterClosureReason;
  onConfirm(reason: ReporterClosureReason): void;
  onOpenChange(open: boolean): void;
  open: boolean;
}) {
  const { message } = useHandsFeedback();
  const [reason, setReason] = useState<ReporterClosureReason>(initialReason);
  useEffect(() => {
    if (open) setReason(initialReason);
  }, [initialReason, open]);
  const choices: Array<{
    reason: ReporterClosureReason;
    label: FeedbackMessageKey;
    hint: FeedbackMessageKey;
  }> = [
    {
      reason: "completed",
      label: "closeChoiceCompleted",
      hint: "closeChoiceCompletedHint",
    },
    {
      reason: "no_longer_needed",
      label: "closeChoiceNoLongerNeeded",
      hint: "closeChoiceNoLongerNeededHint",
    },
  ];
  // Closing ends the conversation for the reporter, so it is confirmed
  // (raft-design Feedback: confirm what can't be put back where it happened),
  // and the confirm button repeats the action's name.
  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!busy) onOpenChange(nextOpen);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{message("closeTicket")}</AlertDialogTitle>
        </AlertDialogHeader>
        <AlertDialogBody className="hands-feedback-close-body">
          <AlertDialogDescription>
            {message("closeDialogDescription")}
          </AlertDialogDescription>
          <RadioGroup<ReporterClosureReason>
            className="hands-feedback-close-reasons"
            aria-label={message("closeReasonMenu")}
            value={reason}
            onValueChange={(value) => setReason(value)}
            disabled={busy}
          >
            {choices.map((choice) => (
              <label
                key={choice.reason}
                className="hands-feedback-close-reason"
                data-feedback-close-reason={choice.reason}
              >
                <RadioGroupItem value={choice.reason} />
                <span className="hands-feedback-close-reason-text">
                  <span className="hands-feedback-close-reason-label">
                    {message(choice.label)}
                  </span>
                  <span className="hands-feedback-close-reason-hint">
                    {message(choice.hint)}
                  </span>
                </span>
              </label>
            ))}
          </RadioGroup>
          {open && error && <FeedbackErrorBanner error={error} />}
        </AlertDialogBody>
        <AlertDialogFooter>
          <AlertDialogCancel size="md" disabled={busy}>
            {message("cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            size="md"
            variant="primary"
            loading={busy}
            loadingLabel={message("closingTicket")}
            disabled={busy}
            onClick={() => onConfirm(reason)}
          >
            {message("closeTicket")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function defaultReporterClosureReason(
  status: FeedbackTicketSummary["status"],
): ReporterClosureReason {
  return status === "resolved" ? "completed" : "no_longer_needed";
}

function ReporterClosureReasonLabel({
  reason,
}: {
  reason: FeedbackTicketSummary["closureReason"];
}) {
  const { message } = useHandsFeedback();
  if (!reason) return null;
  const reasonKey: FeedbackMessageKey = reason === "completed"
    ? "closeReasonCompleted"
    : reason === "no_longer_needed"
      ? "closeReasonNoLongerNeeded"
      : reason === "not_planned"
        ? "closeReasonNotPlanned"
        : reason === "cannot_reproduce"
          ? "closeReasonCannotReproduce"
          : "closeReasonDuplicate";
  return (
    <span className="hands-feedback-closure-reason">
      {message("closedReason", {
        reason: message(reasonKey),
      })}
    </span>
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
  onOpenAttachment?: (input: FeedbackPendingAttachmentOpenInput) => void;
  busy: boolean;
  error?: string | null;
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  showCounter?: boolean;
  imageInputLabel?: string;
  testIdPrefix: "new" | "reply";
  actions: ReactNode;
};

function FeedbackPendingAttachmentImage({
  file,
  onOpenAttachment,
}: {
  file: File;
  onOpenAttachment?: (input: FeedbackPendingAttachmentOpenInput) => void;
}) {
  const { message } = useHandsFeedback();
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const isImage = file.type.startsWith("image/");
  useLayoutEffect(() => {
    if (!isImage || typeof URL.createObjectURL !== "function") return;
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => {
      if (typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(url);
    };
  }, [file, isImage]);

  if (!isImage || !previewUrl) {
    return (
      <ComposerAttachmentFile
        render={onOpenAttachment ? <button type="button" /> : undefined}
        className={
          onOpenAttachment ? "hands-feedback-pending-file-button" : undefined
        }
        aria-label={
          onOpenAttachment
            ? message("openAttachment", { name: file.name })
            : undefined
        }
        onClick={
          onOpenAttachment ? () => onOpenAttachment({ file }) : undefined
        }
      >
        {isImage ? (
          <ImagePlus aria-hidden="true" />
        ) : (
          <Paperclip aria-hidden="true" />
        )}
        <ComposerAttachmentBody>
          <ComposerAttachmentTitle>{file.name}</ComposerAttachmentTitle>
          <ComposerAttachmentMeta>
            {file.type || message("attachments")}
          </ComposerAttachmentMeta>
        </ComposerAttachmentBody>
      </ComposerAttachmentFile>
    );
  }

  return (
    <ComposerAttachmentImage
      render={onOpenAttachment ? <button type="button" /> : undefined}
      className={
        onOpenAttachment
          ? "hands-feedback-pending-image-button"
          : "hands-feedback-pending-image"
      }
      aria-label={
        onOpenAttachment
          ? message("openAttachment", { name: file.name })
          : undefined
      }
      title={`${file.name} · ${file.type || message("attachments")}`}
      onClick={
        onOpenAttachment ? () => onOpenAttachment({ file }) : undefined
      }
    >
      <img alt="" src={previewUrl} />
    </ComposerAttachmentImage>
  );
}

function PendingAttachmentList({
  attachments,
  busy,
  onRemove,
  onOpenAttachment,
}: {
  attachments: PendingAttachment[];
  busy: boolean;
  onRemove(id: string): void;
  onOpenAttachment?: (input: FeedbackPendingAttachmentOpenInput) => void;
}) {
  const { message } = useHandsFeedback();
  const onRemoveAttachment = onRemove;
  const totalUploadProgress = attachments.length
    ? Math.round(
        (attachments.reduce((sum, item) => sum + item.progress, 0) /
          attachments.length) *
          100,
      )
    : 0;
  return (
    <>
      {attachments.length > 0 && (
        <ComposerAttachments aria-label={message("attachments")}>
          {attachments.map((item) => (
            <ComposerAttachment key={item.id}>
              <FeedbackPendingAttachmentImage
                file={item.file}
                {...(onOpenAttachment ? { onOpenAttachment } : {})}
              />
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
      {busy && attachments.length > 0 && (
        <div
          className="hands-feedback-upload-summary"
          role="status"
          aria-live="polite"
        >
          {message("uploadOverall", { progress: totalUploadProgress })}
        </div>
      )}
    </>
  );
}

function FeedbackComposer({
  id,
  label,
  value,
  onChange,
  textareaRef,
  attachments,
  onAttachmentsChange,
  onRemoveAttachment,
  onOpenAttachment,
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
      <PendingAttachmentList
        attachments={attachments}
        busy={busy}
        onRemove={onRemoveAttachment}
        {...(onOpenAttachment ? { onOpenAttachment } : {})}
      />
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
          <ComposerActions>
            <ComposerIconButton
              aria-label={message("attachImage")}
              title={message("attachImage")}
              disabled={attachmentsDisabled}
              onClick={() => imageInputRef.current?.click()}
            >
              <ImagePlus aria-hidden="true" />
            </ComposerIconButton>
            <ComposerIconButton
              aria-label={message("attachFile")}
              title={message("attachFile")}
              disabled={attachmentsDisabled}
              onClick={() => fileInputRef.current?.click()}
            >
              <Paperclip aria-hidden="true" />
            </ComposerIconButton>
          </ComposerActions>
          <ComposerMeta className="hands-feedback-composer-actions">
            {actions}
          </ComposerMeta>
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
  /** Hides the inbox title text/icon in the header (actions stay right). */
  hideHeaderTitle?: boolean;
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
  hideHeaderTitle = false,
}: FeedbackInboxProps) {
  const { formatDate, locale, message, reportUnread, transport } =
    useHandsFeedback();
  const safeError = useSafeError();
  const [tickets, setTickets] = useState<FeedbackTicketSummary[]>([]);
  const [filter, setFilter] = useState<"all" | "open" | "resolved">("all");
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryCursor, setRetryCursor] = useState<string | undefined>(undefined);
  const request = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);

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
    setTickets((current) => {
      // A ticket changed elsewhere (created, replied to, closed) keeps the
      // latest comment the list already showed for it unless it brings one.
      const previous = current.find((ticket) => ticket.id === upsertTicket.id);
      const merged =
        upsertTicket.latestComment === undefined && previous
          ? { ...upsertTicket, latestComment: previous.latestComment ?? null }
          : upsertTicket;
      return [
        merged,
        ...current.filter((ticket) => ticket.id !== upsertTicket.id),
      ];
    });
  }, [upsertTicket]);

  const visibleTickets = tickets.filter(
    (ticket) =>
      filter === "all" ||
      (filter === "open"
        ? ticket.status === "open" || ticket.status === "in_progress"
        : ticket.status === "resolved" || ticket.status === "closed"),
  );
  const emptyKind = tickets.length === 0 ? "all" : filter;
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

  return (
    <section
      className="hands-feedback-inbox"
      {...(hideHeaderTitle
        ? { "aria-label": message("workspaceTitle") }
        : { "aria-labelledby": "hands-feedback-inbox-title" })}
      hidden={hidden}
    >
      {/* The host may own the page title (hideHeaderTitle); then the inbox
          starts at its filter row. */}
      <PanelHeader className="hands-feedback-header" hidden={hideHeaderTitle}>
        <PanelHeaderContent>
          <PanelHeading>
            <PanelTitle render={<h2 id="hands-feedback-inbox-title" />}>
              {message("workspaceTitle")}
            </PanelTitle>
          </PanelHeading>
        </PanelHeaderContent>
      </PanelHeader>
      {/* One row: the status tabs once there is something to filter, and
          the screen's one pink button, which is there from the first paint. */}
      {(
        <div className="hands-feedback-toolbar">
          {tickets.length > 0 ? (
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
          ) : (
            <span />
          )}
          <Button
            size="sm"
            variant="primary"
            className="hands-feedback-toolbar-action"
            onClick={onNewFeedback}
          >
            <MessageSquarePlus aria-hidden="true" />
            {message("newFeedback")}
          </Button>
        </div>
      )}
      <div
        className="hands-feedback-middle hands-feedback-list-scroll"
        data-feedback-list-scroll
        data-feedback-empty-scroll={
          !loading && !error && visibleTickets.length === 0 ? "true" : undefined
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
            className="hands-feedback-ticket-list"
            aria-label={message("loading")}
            aria-busy="true"
          >
            {["60%", "48%", "40%"].map((width) => (
              <InboxItem key={width} aria-hidden disabled>
                <InboxItemContent className="hands-feedback-skeleton-row">
                  <Skeleton variant="line" style={{ width }} />
                  <Skeleton variant="line" style={{ width: "80%" }} />
                  <Skeleton variant="line" style={{ width: "9rem" }} />
                </InboxItemContent>
                <InboxItemTrailing>
                  <Skeleton variant="line" style={{ width: "3rem" }} />
                </InboxItemTrailing>
              </InboxItem>
            ))}
          </div>
        )}
        {error && (
          <div className="hands-feedback-inset">
            <FeedbackErrorBanner
              busy={retrying}
              busyLabel={message("loading")}
              error={error}
              retryLabel={message("retry")}
              onRetry={() => void load(retryCursor, true, true)}
            />
          </div>
        )}
        {!loading && !error && visibleTickets.length === 0 && (
          <EmptyState
            className="hands-feedback-empty"
            data-feedback-empty-kind={emptyKind}
          >
            <EmptyStateContent>
              <EmptyStateIcon className="hands-feedback-empty-icon">
                <MessageSquare aria-hidden="true" />
              </EmptyStateIcon>
              <EmptyStateTitle className="hands-feedback-empty-title">
                {message(emptyTitleKey)}
              </EmptyStateTitle>
              <EmptyStateDescription className="hands-feedback-empty-description">
                {message(emptyBodyKey)}
              </EmptyStateDescription>
              {emptyKind !== "all" && (
                <Button variant="outline" onClick={() => setFilter("all")}>
                  {message("showAll")}
                </Button>
              )}
            </EmptyStateContent>
          </EmptyState>
        )}
        {visibleTickets.length > 0 && (
          <ul
            className="hands-feedback-ticket-list"
            aria-label={message("workspaceTitle")}
          >
            {visibleTickets.map((ticket) => (
              <FeedbackTicketRow
                key={ticket.id}
                ticket={ticket}
                formatDate={formatDate}
                locale={locale}
                message={message}
                onSelect={() => onSelectTicket(ticket.id, ticket)}
              />
            ))}
          </ul>
        )}
        {cursor && (
          <div className="hands-feedback-inset">
            <Button
              variant="outline"
              disabled={loadingMore}
              onClick={() => void load(cursor)}
            >
              {loadingMore ? message("loadingMore") : message("loadMore")}
            </Button>
          </div>
        )}
      </div>
      <div className="hands-feedback-live" aria-live="polite">
        {pullToRefresh.refreshing
          ? message("refreshing")
          : loadingMore
            ? message("loadingMore")
            : (error ?? "")}
      </div>
    </section>
  );
}

/** Today: the clock time; yesterday: "Yesterday"; earlier: the date. */
function formatListTime(
  value: number,
  locale: string,
  message: ReturnType<typeof useHandsFeedback>["message"],
) {
  const at = new Date(value);
  const now = new Date();
  if (sameDay(value, now.getTime()))
    return new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(at);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(value, yesterday.getTime())) return message("yesterday");
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  }).format(at);
}

/** The text of a comment as one plain line, for the list preview. */
function previewLine(body: string) {
  return body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~>#]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function commentSender(
  authorType: FeedbackComment["authorType"],
  message: ReturnType<typeof useHandsFeedback>["message"],
) {
  return authorType === "reporter"
    ? message("you")
    : authorType === "staff"
      ? message("team")
      : message("update");
}

function FeedbackTicketRow({
  ticket,
  formatDate,
  locale,
  message,
  onSelect,
}: {
  ticket: FeedbackTicketSummary;
  formatDate: (value: number) => string;
  locale: string;
  message: ReturnType<typeof useHandsFeedback>["message"];
  onSelect(): void;
}) {
  const title = ticket.message.split("\n", 1)[0];
  const latest = ticket.latestComment;
  const preview = latest ? previewLine(latest.bodyPreview) : "";
  // The list orders by the latest conversation activity; show that time.
  const activityAt = latest?.createdAt ?? ticket.createdAt;
  const replies = ticket.commentCount;
  const unreadCount = ticket.unread ? Math.max(1, ticket.unreadCount) : 0;
  const KindIcon = ticket.kind === "bug" ? Bug : Lightbulb;
  return (
    <li className="hands-feedback-ticket-item">
      <InboxItem
        className="hands-feedback-ticket-row"
        data-ticket-row={ticket.id}
        data-unread={ticket.unread || undefined}
      >
        <InboxItemTrigger
          className="hands-feedback-ticket-open"
          data-ticket-id={ticket.id}
          data-unread={ticket.unread || undefined}
          aria-label={
            unreadCount
              ? `${title}, ${message("unreadCount", { count: unreadCount })}`
              : title
          }
          onClick={onSelect}
        />
        <InboxItemContent>
          <InboxItemHeading>
            <InboxItemTitle
              className="hands-feedback-ticket-title"
              title={title}
              data-feedback-kind={ticket.kind}
            >
              <KindIcon
                aria-label={message(ticket.kind === "bug" ? "problem" : "idea")}
              />
              {title}
            </InboxItemTitle>
          </InboxItemHeading>
          {latest && preview && (
            <InboxItemBody className="hands-feedback-ticket-preview">
              <InboxItemSender>
                {commentSender(latest.authorType, message)}:{" "}
              </InboxItemSender>
              {preview}
            </InboxItemBody>
          )}
          <InboxItemMetadata className="hands-feedback-ticket-meta">
            <FeedbackStatusChip
              status={ticket.status}
              closureReason={ticket.closureReason}
            />
            <Badge appearance="outline" variant="muted">
              {replies === 0
                ? message("noReplies")
                : replies === 1
                  ? message("replyCountOne")
                  : message("replyCountOther", { count: replies })}
            </Badge>
            {unreadCount > 0 && (
              <Badge
                variant="accent"
                className="hands-feedback-unread-count"
                data-feedback-unread-count={unreadCount}
              >
                {message("newCount", {
                  count: unreadCount > 99 ? "99+" : unreadCount,
                })}
              </Badge>
            )}
          </InboxItemMetadata>
        </InboxItemContent>
        <InboxItemTrailing>
          <InboxItemTimestamp>
            <time
              dateTime={new Date(activityAt).toISOString()}
              title={formatDate(activityAt)}
            >
              {formatListTime(activityAt, locale, message)}
            </time>
          </InboxItemTimestamp>
        </InboxItemTrailing>
      </InboxItem>
    </li>
  );
}

export type FeedbackTicketProps = {
  ticketId: string;
  initialTicket?: FeedbackTicketSummary;
  onBack(): void;
  onOpenAttachment?: (input: FeedbackAttachmentOpenInput) => void;
  onOpenPendingAttachment?: (
    input: FeedbackPendingAttachmentOpenInput,
  ) => void;
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
  /** A later message from the same sender on the same day. */
  continuation?: boolean;
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

function sameDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

/**
 * The day between messages, as Raft Chat's timeline draws it: Today,
 * Yesterday, then the weekday and date.
 */
function FeedbackDateDivider({ at }: { at: number }) {
  const { locale, message } = useHandsFeedback();
  const day = new Date(at);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const label = sameDay(at, now.getTime())
    ? message("today")
    : sameDay(at, yesterday.getTime())
      ? message("yesterday")
      : new Intl.DateTimeFormat(locale, {
          weekday: "long",
          month: "long",
          day: "numeric",
          ...(day.getFullYear() === now.getFullYear()
            ? {}
            : { year: "numeric" }),
        }).format(day);
  return (
    <MessageListDateDivider>
      <time dateTime={day.toISOString().slice(0, 10)}>{label}</time>
    </MessageListDateDivider>
  );
}

function FeedbackConversationMessage({
  authorType,
  body,
  createdAt,
  ticketId,
  attachments = [],
  onOpenAttachment,
  continuation = false,
}: FeedbackConversationMessageProps) {
  const { formatDate, formatFileSize, locale, message } = useHandsFeedback();
  const sentAt = new Date(createdAt);
  const time = new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(
    sentAt,
  );
  const openAttachment = (attachmentId: string) =>
    onOpenAttachment?.({ ticketId, attachmentId });

  const content = (
    <>
      <MessageItemBody>
        <MarkdownText source={body} />
      </MessageItemBody>
      {attachments.length > 0 && (
        <MessageItemAttachments>
          <MessageImageGallery>
            {attachments
              .filter((attachment) => attachment.contentType.startsWith("image/"))
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
            .filter((attachment) => !attachment.contentType.startsWith("image/"))
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
    </>
  );

  // The next message from the same sender on the same day merges under the
  // first one (raft-design Conversation: dates and grouping).
  if (continuation) {
    return (
      <div className="hands-feedback-message-row">
        <MessageItem compact data-author={authorType}>
          <MessageItemGutter>
            <MessageItemContinuationTime
              render={
                <time
                  dateTime={sentAt.toISOString()}
                  title={formatDate(createdAt)}
                />
              }
            >
              {time.replace(/\s?[AP]M$/i, "")}
            </MessageItemContinuationTime>
          </MessageItemGutter>
          <MessageItemContent>{content}</MessageItemContent>
        </MessageItem>
      </div>
    );
  }

  return (
    <div className="hands-feedback-message-row">
      <MessageItem data-author={authorType}>
        <MessageItemAvatarSlot>
          <Avatar
            size="md"
            type={authorType === "reporter" ? "human" : "server"}
          >
            <AvatarFallback>
              {authorType === "reporter" ? (
                <User aria-hidden="true" />
              ) : (
                <MessageSquare aria-hidden="true" />
              )}
            </AvatarFallback>
          </Avatar>
        </MessageItemAvatarSlot>
        <MessageItemContent>
          <MessageItemHeader>
            <MessageItemSender>{commentSender(authorType, message)}</MessageItemSender>
            {/* As in Raft Chat: the clock time right after the sender, the day
                in the list's date lines, the full date and time on hover. */}
            <MessageItemTime
              render={
                <time
                  dateTime={sentAt.toISOString()}
                  title={formatDate(createdAt)}
                />
              }
            >
              {time}
            </MessageItemTime>
          </MessageItemHeader>
          {content}
        </MessageItemContent>
      </MessageItem>
    </div>
  );
}

export function FeedbackTicket({
  ticketId,
  initialTicket,
  onBack,
  onOpenAttachment,
  onOpenPendingAttachment,
  draft,
  onDraftChange,
  onReadSuccess,
  onTicketUpdated,
  enablePullToRefresh = false,
}: FeedbackTicketProps) {
  const { locale, message, reportUnread, transport } = useHandsFeedback();
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

  const closeTicket = async (reason: ReporterClosureReason) => {
    if (!detail || !transport.closeTicket || closing) return;
    setClosing(true);
    setActionError(null);
    actionController.current?.abort();
    const controller = new AbortController();
    actionController.current = controller;
    try {
      const result = await transport.closeTicket({
        ticketId,
        reason,
        signal: controller.signal,
      });
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

  const ticket = detail?.ticket;
  const canClose =
    Boolean(transport.closeTicket) && ticket !== undefined && ticket.status !== "closed";
  const openClose = () => {
    setActionError(null);
    setConfirmingClose(true);
  };
  const title = ticket?.message.split("\n", 1)[0] || message("workspaceTitle");

  return (
    <section
      className="hands-feedback-detail"
      aria-labelledby="hands-feedback-ticket-heading"
    >
      {/* A pushed page: Back, the ticket's first line, its status on the
          title's line; kind and closure underneath. When the host embeds the
          workspace in a page with its own header, this header replaces it. */}
      <PanelHeader className="hands-feedback-header">
        <PanelAction
          aria-label={message("back")}
          title={message("back")}
          onClick={onBack}
        >
          <ArrowLeft aria-hidden="true" />
        </PanelAction>
        <PanelHeaderContent>
          <PanelHeading>
            <PanelTitle
              render={<h2 id="hands-feedback-ticket-heading" tabIndex={-1} />}
              title={title}
            >
              {title}
            </PanelTitle>
            {ticket && (
              <PanelStatus>
                <FeedbackStatusChip
                  status={ticket.status}
                  closureReason={ticket.closureReason}
                />
              </PanelStatus>
            )}
          </PanelHeading>
          {ticket && (
            <PanelMeta data-feedback-kind={ticket.kind}>
              {message(ticket.kind === "bug" ? "problem" : "idea")}
              {ticket.status === "closed" && ticket.closureReason && (
                <>
                  {" · "}
                  <ReporterClosureReasonLabel reason={ticket.closureReason} />
                </>
              )}
            </PanelMeta>
          )}
        </PanelHeaderContent>
        {canClose && ticket?.status !== "resolved" && (
          <PanelActions>
            <PanelAction
              aria-label={message("closeTicket")}
              title={message("closeTicket")}
              disabled={closing}
              onClick={openClose}
            >
              <CircleCheck aria-hidden="true" />
            </PanelAction>
          </PanelActions>
        )}
      </PanelHeader>
      {/* Resolved by the team: ask the reporter the one question left. */}
      {canClose && ticket?.status === "resolved" && (
        <PanelNotice status="success" className="hands-feedback-resolved-notice">
          <PanelNoticeContent>{message("resolvedNotice")}</PanelNoticeContent>
          <PanelNoticeActions>
            <Button
              size="sm"
              variant="outline"
              disabled={closing}
              onClick={openClose}
            >
              {message("closeTicket")}
            </Button>
          </PanelNoticeActions>
        </PanelNotice>
      )}
      <ConversationPanelContent className="hands-feedback-detail-content">
        <ConversationPanelBody className="hands-feedback-detail-body">
          {loading && !detail && (
            <Skeleton className="hands-feedback-skeleton-detail" />
          )}
          {loadError && (
            <div className="hands-feedback-inset">
              <FeedbackErrorBanner
                busy={retryingLoad}
                busyLabel={message("loading")}
                error={loadError}
                retryLabel={message("retry")}
                onRetry={() =>
                  void load(retryLoad.cursor, retryLoad.refresh, true)
                }
              />
            </div>
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
                <FeedbackDateDivider at={detail.ticket.createdAt} />
                <FeedbackConversationMessage
                  authorType="reporter"
                  body={detail.ticket.message}
                  createdAt={detail.ticket.createdAt}
                  ticketId={ticketId}
                  attachments={detail.attachments}
                  {...(onOpenAttachment ? { onOpenAttachment } : {})}
                />
                {detail.comments.map((comment, index) => {
                  const previous =
                    index === 0
                      ? {
                          authorType: "reporter" as const,
                          createdAt: detail.ticket.createdAt,
                        }
                      : detail.comments[index - 1]!;
                  const newDay = !sameDay(previous.createdAt, comment.createdAt);
                  return (
                    <Fragment key={comment.id}>
                      {newDay && <FeedbackDateDivider at={comment.createdAt} />}
                      {comment.authorType === "system" ? (
                        <SystemMessage data-author="system">
                          <SystemMessageContent>
                            {previewLine(comment.body)}
                          </SystemMessageContent>
                          <SystemMessageTime
                            render={
                              <time
                                dateTime={new Date(comment.createdAt).toISOString()}
                              />
                            }
                          >
                            {new Intl.DateTimeFormat(locale, {
                              timeStyle: "short",
                            }).format(new Date(comment.createdAt))}
                          </SystemMessageTime>
                        </SystemMessage>
                      ) : (
                        <FeedbackConversationMessage
                          authorType={comment.authorType}
                          body={comment.body}
                          createdAt={comment.createdAt}
                          ticketId={ticketId}
                          continuation={
                            !newDay && previous.authorType === comment.authorType
                          }
                        />
                      )}
                    </Fragment>
                  );
                })}
              </MessageList>
              {newReplies && (
                <Button
                  variant="outline"
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
                <div className="hands-feedback-inset">
                  <Button
                    variant="outline"
                    disabled={loadingMore}
                    onClick={() => void load(detail.nextCommentCursor!)}
                  >
                    {loadingMore
                      ? message("loadingMore")
                      : message("loadMoreReplies")}
                  </Button>
                </div>
              )}
            </>
          )}
        </ConversationPanelBody>
        {detail && detail.ticket.status === "closed" && (
          <ConversationPanelFooter className="hands-feedback-closed-footer">
            <p className="hands-feedback-closed-note">
              {message("closedDescription")}
            </p>
          </ConversationPanelFooter>
        )}
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
              {...(onOpenPendingAttachment
                ? { onOpenAttachment: onOpenPendingAttachment }
                : {})}
              busy={sending}
              error={confirmingClose ? null : actionError}
              onKeyDown={onReplyKeyDown}
              placeholder={message("replyPlaceholder")}
              testIdPrefix="reply"
              actions={
                <ComposerSubmit
                  aria-label={
                    sending ? message("sending") : message("sendReply")
                  }
                  title={sending ? message("sending") : message("sendReply")}
                  size="icon-sm"
                  disabled={!reply.trim() || sending}
                  onClick={() => void send()}
                >
                  <Send aria-hidden="true" />
                  <span className="hands-feedback-sr-only">
                    {sending ? message("sending") : message("sendReply")}
                  </span>
                </ComposerSubmit>
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
      {transport.closeTicket && ticket && (
        <FeedbackCloseDialog
          open={confirmingClose}
          busy={closing}
          error={confirmingClose ? actionError : null}
          initialReason={defaultReporterClosureReason(ticket.status)}
          onOpenChange={(open) => {
            if (!closing) setConfirmingClose(open);
          }}
          onConfirm={(reason) => void closeTicket(reason)}
        />
      )}
    </section>
  );
}

export type NewFeedbackProps = {
  onCancel(): void;
  onCreated(ticketId: string, detail?: FeedbackTicketDetail): void;
  onOpenPendingAttachment?: (
    input: FeedbackPendingAttachmentOpenInput,
  ) => void;
  /** Host handle; see `FeedbackWorkspaceHandle`. */
  ref?: Ref<FeedbackWorkspaceHandle>;
};

type NewFeedbackInternalProps = NewFeedbackProps & {
  /** Workspace-only: a pre-validated host file present from first render. */
  initialHostFile?: File | null;
  onInitialHostFileConsumed?: () => void;
};

export function NewFeedback(props: NewFeedbackProps) {
  return <NewFeedbackForm {...props} />;
}

function NewFeedbackForm({
  onCancel,
  onCreated,
  onOpenPendingAttachment,
  ref,
  initialHostFile,
  onInitialHostFileConsumed,
}: NewFeedbackInternalProps) {
  const { message: copy, reportUnread, transport } = useHandsFeedback();
  const safeError = useSafeError();
  const [kind, setKind] = useState<FeedbackKind>("feedback");
  const [message, setMessage] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>(() =>
    initialHostFile
      ? [
          {
            id: submissionId(),
            file: initialHostFile,
            progress: 0,
            state: "ready",
            source: "host",
          },
        ]
      : [],
  );
  useEffect(() => {
    if (initialHostFile) onInitialHostFileConsumed?.();
    // Consume once on mount; later prop changes never inject.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const actionController = useRef<AbortController | null>(null);
  const createSubmission = useRef<{ fingerprint: string; id: string } | null>(
    null,
  );
  const textareaRef = useAutosize(message);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const sendingRef = useRef(sending);
  sendingRef.current = sending;
  useImperativeHandle(
    ref,
    () => ({
      attachPendingFile(input) {
        // The user-action gate comes first: without a live user gesture
        // nothing below runs and nothing is mutated.
        if (!hasTransientUserActivation())
          return { ok: false, reason: "user_activation_required" };
        if (sendingRef.current) return { ok: false, reason: "busy" };
        const reason = hostAttachmentRejection(input, attachmentsRef.current);
        if (reason) return { ok: false, reason };
        const next: PendingAttachment[] = [
          ...attachmentsRef.current,
          {
            id: submissionId(),
            file: input.file,
            progress: 0,
            state: "ready",
            source: "host",
          },
        ];
        attachmentsRef.current = next;
        setAttachments(next);
        return { ok: true };
      },
    }),
    [],
  );
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
    const attachmentError = localizedPendingAttachmentError(attachments, copy);
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
    const combined = [
      ...attachments,
      ...selected.map((file) => ({
        id: "",
        file,
        progress: 0,
        state: "ready" as const,
      })),
    ];
    const attachmentError = localizedPendingAttachmentError(combined, copy);
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
      <PanelHeader className="hands-feedback-header">
        <PanelAction
          aria-label={copy("back")}
          title={copy("back")}
          onClick={sending ? cancelUpload : onCancel}
        >
          <ArrowLeft aria-hidden="true" />
        </PanelAction>
        <PanelHeaderContent>
          <PanelHeading>
            <PanelTitle render={<h2 id="hands-feedback-new-title" tabIndex={-1} />}>
              {copy("newFeedback")}
            </PanelTitle>
          </PanelHeading>
          <PanelMeta>{copy("newMeta")}</PanelMeta>
        </PanelHeaderContent>
      </PanelHeader>
      <div className="hands-feedback-middle">
        <div className="hands-feedback-new-fields">
          {/* A group, not a field control: a Field label would name only the
              first option. */}
          <div className="hands-feedback-field">
            <Label render={<span id="hands-feedback-kind-label" />}>
              {copy("type")}
            </Label>
            <SegmentedControl<FeedbackKind>
              aria-labelledby="hands-feedback-kind-label"
              className="hands-feedback-kind"
              value={kind}
              onValueChange={(value) => {
                if (value) setKind(value);
              }}
            >
              <SegmentedControlItem
                className="hands-feedback-kind-item"
                value="feedback"
              >
                <Lightbulb aria-hidden="true" />
                <SegmentedControlLabel>{copy("idea")}</SegmentedControlLabel>
              </SegmentedControlItem>
              <SegmentedControlItem
                className="hands-feedback-kind-item"
                value="bug"
              >
                <Bug aria-hidden="true" />
                <SegmentedControlLabel>{copy("problem")}</SegmentedControlLabel>
              </SegmentedControlItem>
            </SegmentedControl>
          </div>
          {/* The same composer as a reply: the message, then the attach
              buttons at its bottom left and the pink send at its bottom
              right. Back leaves (or cancels an upload in flight). */}
          <FeedbackComposer
            id="hands-feedback-message"
            label={copy("question")}
            value={message}
            onChange={setMessage}
            textareaRef={textareaRef}
            attachments={attachments}
            onAttachmentsChange={choose}
            onRemoveAttachment={(id) =>
              setAttachments((current) =>
                current.filter((item) => item.id !== id),
              )
            }
            {...(onOpenPendingAttachment
              ? { onOpenAttachment: onOpenPendingAttachment }
              : {})}
            busy={sending}
            error={error}
            placeholder={copy("describePlaceholder")}
            showCounter
            imageInputLabel={copy("screenshots", {
              count: MAX_FEEDBACK_ATTACHMENTS,
            })}
            testIdPrefix="new"
            actions={
              <ComposerSubmit
                size="icon-sm"
                aria-label={
                  sending
                    ? copy("submitting")
                    : attachments.some(({ state }) => state === "failed")
                      ? copy("retryUpload")
                      : copy("sendFeedback")
                }
                title={copy("sendFeedback")}
                disabled={!message.trim() || sending}
                onClick={() => void submit()}
              >
                <Send aria-hidden="true" />
              </ComposerSubmit>
            }
          />
          <p className="hands-feedback-form-note">
            {copy("attachmentHint", { count: MAX_FEEDBACK_ATTACHMENTS })}
          </p>
        </div>
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
  onOpenPendingAttachment?: FeedbackTicketProps["onOpenPendingAttachment"];
  /** Enables mobile pull-to-refresh for the inbox and ticket conversation. */
  enablePullToRefresh?: boolean;
  /** Hides the inbox title text/icon; ticket and composer headers keep theirs. */
  hideHeaderTitle?: boolean;
  /**
   * Host handle. `attachPendingFile` targets the new-feedback composer only
   * and returns `composer_closed` on any other route.
   */
  ref?: Ref<FeedbackWorkspaceHostHandle>;
};

export function FeedbackWorkspace({
  initialTicketId,
  route: controlledRoute,
  onRouteChange,
  onOpenAttachment,
  onOpenPendingAttachment,
  enablePullToRefresh = false,
  hideHeaderTitle = false,
  ref,
}: FeedbackWorkspaceProps) {
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
  const newFeedbackRef = useRef<FeedbackWorkspaceHandle | null>(null);
  // A validated host file waiting for the new-feedback form to mount. It is
  // set in the same synchronous call as the route change and consumed by the
  // form's initial state, so there is no deferred injection step.
  const [hostSeed, setHostSeed] = useState<File | null>(null);
  const navigateRef = useRef<(next: FeedbackWorkspaceRoute) => void>(() => {});
  useImperativeHandle(
    ref,
    () => ({
      attachPendingFile(input) {
        if (!hasTransientUserActivation())
          return { ok: false, reason: "user_activation_required" };
        const composer = newFeedbackRef.current;
        if (!composer) return { ok: false, reason: "composer_closed" };
        return composer.attachPendingFile(input);
      },
      openNewFeedbackWithPendingFile(input) {
        if (!hasTransientUserActivation())
          return { ok: false, reason: "user_activation_required" };
        const composer = newFeedbackRef.current;
        if (composer) return composer.attachPendingFile(input);
        const reason = hostAttachmentRejection(input, []);
        if (reason) return { ok: false, reason };
        setHostSeed(input.file);
        setRouteTicket(null);
        navigateRef.current({ view: "new" });
        return { ok: true };
      },
    }),
    [],
  );
  const pendingInboxFocus = useRef<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const navigate = (
    next: FeedbackWorkspaceRoute,
    options?: FeedbackWorkspaceNavigationOptions,
  ) => {
    if (!controlledRoute) setInternalRoute(next);
    onRouteChange?.(next, options);
  };
  navigateRef.current = navigate;
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
      ref={rootRef}
    >
      <FeedbackInbox
        enablePullToRefresh={enablePullToRefresh}
        hideHeaderTitle={hideHeaderTitle}
        hidden={route.view !== "inbox"}
        readTicketId={readTicket.id}
        readTicketVersion={readTicket.version}
        upsertTicket={createdTicket}
        onNewFeedback={() => {
          setHostSeed(null);
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
        <NewFeedbackForm
          ref={newFeedbackRef}
          initialHostFile={hostSeed}
          onInitialHostFileConsumed={() => setHostSeed(null)}
          {...(onOpenPendingAttachment ? { onOpenPendingAttachment } : {})}
          onCancel={() => {
            setHostSeed(null);
            navigate({ view: "inbox" });
          }}
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
          {...(onOpenPendingAttachment
            ? { onOpenPendingAttachment }
            : {})}
        />
      )}
    </div>
  );
}
