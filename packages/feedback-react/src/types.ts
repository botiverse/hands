export type FeedbackTheme = "elegant" | "brutal";
export type FeedbackKind = "feedback" | "bug";
export type FeedbackStatus = "open" | "in_progress" | "resolved" | "closed";

export type FeedbackTicketSummary = {
  id: string;
  kind: FeedbackKind;
  status: FeedbackStatus;
  message: string;
  createdAt: number;
  updatedAt: number;
  unread: boolean;
  unreadCount: number;
  attachmentCount: number;
  commentCount: number;
};

export type FeedbackComment = {
  id: string;
  authorType: "reporter" | "staff" | "system";
  body: string;
  createdAt: number;
};

export type FeedbackAttachment = {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  createdAt: number;
};

export type FeedbackTicketPage = {
  tickets: FeedbackTicketSummary[];
  nextCursor: string | null;
  /** Hands-authoritative total for the current reporter, never consumer-derived. */
  unreadTotal: number;
};

export type FeedbackTicketDetail = {
  ticket: FeedbackTicketSummary;
  comments: FeedbackComment[];
  attachments: FeedbackAttachment[];
  nextCommentCursor: string | null;
  /** Hands-authoritative total after the detail read receipt commits. */
  unreadTotal: number;
};

export type CreateFeedbackInput = {
  kind: FeedbackKind;
  message: string;
  submissionId: string;
  attachments: File[];
};

export type AddFeedbackCommentInput = {
  ticketId: string;
  body: string;
  submissionId: string;
};

/**
 * Host-provided reporter-scoped transport.
 *
 * The React package deliberately accepts no app token, deploy token, client
 * secret, reporter id, or arbitrary ticket owner. A backend must exchange its
 * app credential for a short-lived reporter-scoped session and bind that
 * session inside this adapter.
 */
export type HandsFeedbackTransport = {
  listTickets(input: {
    cursor?: string;
    limit: number;
    signal: AbortSignal;
  }): Promise<FeedbackTicketPage>;
  getTicket(input: {
    ticketId: string;
    commentCursor?: string;
    commentLimit: number;
    signal: AbortSignal;
  }): Promise<FeedbackTicketDetail>;
  createTicket(input: CreateFeedbackInput & { signal: AbortSignal }): Promise<FeedbackTicketDetail>;
  addComment(input: AddFeedbackCommentInput & { signal: AbortSignal }): Promise<FeedbackTicketDetail>;
};

export type FeedbackUnreadChange = {
  total: number;
  source: "list" | "detail" | "create" | "comment";
};
