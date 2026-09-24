type EventBase = {
  eventId: string;
  eventType: "feedback:comment_created" | "feedback:status_changed";
  createdAt: number;
  orgId: string;
  appId: string;
  ticketId: string;
  reporterIntegrationId: string;
  reporterId: string;
};

export function buildFeedbackCommentEvent(input: EventBase & {
  comment: {
    id: string;
    author_type: "reporter" | "staff" | "system";
    // Stored author identifier — raft:<handle>@<server> for staff/system,
    // opaque reporter:<hash> for reporter. Lets a webhook consumer render
    // "who replied" without dereferencing the anonymous reporter id.
    author_actor: string;
    body: string;
    created_at: number;
  };
}): string {
  return JSON.stringify({
    id: input.eventId,
    event: input.eventType,
    created_at: input.createdAt,
    delivered_at: input.createdAt,
    org_id: input.orgId,
    app_id: input.appId,
    payload: {
      ticket_id: input.ticketId,
      reporter_integration_id: input.reporterIntegrationId,
      reporter_id: input.reporterId,
      comment: input.comment,
    },
  });
}

export function buildFeedbackStatusEvent(input: EventBase & {
  previousStatus: string;
  status: string;
  closureReason?: string | null;
  duplicateOfTicketId?: string | null;
}): string {
  return JSON.stringify({
    id: input.eventId,
    event: input.eventType,
    created_at: input.createdAt,
    delivered_at: input.createdAt,
    org_id: input.orgId,
    app_id: input.appId,
    payload: {
      ticket_id: input.ticketId,
      reporter_integration_id: input.reporterIntegrationId,
      reporter_id: input.reporterId,
      previous_status: input.previousStatus,
      status: input.status,
      closure_reason: input.closureReason ?? null,
      duplicate_of_ticket_id: input.duplicateOfTicketId ?? null,
    },
  });
}
