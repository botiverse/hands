import { z } from "@hono/zod-openapi";
import {
  AppIdParam,
  AttachmentIdParam,
  GenericObject,
  TicketIdParam,
  auth,
  binary,
  error,
  json,
  multipart,
  success,
  type RouteConfigList,
} from "./common";

const AppTicketParams = AppIdParam.merge(TicketIdParam);
const AttachmentParams = AppTicketParams.merge(AttachmentIdParam);

const FeedbackUpdateInput = z
  .object({
    status: z.string().optional(),
    assignee: z.string().nullable().optional(),
    closure_reason: z.enum([
      "completed",
      "no_longer_needed",
      "not_planned",
      "cannot_reproduce",
      "duplicate",
    ]).optional(),
    duplicate_of_ticket_id: z.string().nullable().optional(),
  })
  .catchall(z.unknown())
  .openapi("FeedbackUpdateInput");

// The staff comment body the handler actually reads: `body` is the text and
// `internal` selects a staff-only note. The spec previously advertised
// `{message}` — field-name drift that also hid `internal` from the docs.
const FeedbackCommentInput = z
  .object({
    body: z.string().min(1),
    internal: z.boolean().optional(),
  })
  .openapi("FeedbackCommentInput");

const ReporterHeaders = z.object({
  "X-Hands-Reporter-Id": z.string().min(16).max(200),
});

const ReporterCommentInput = z.object({
  body: z.string().min(1).max(10_000),
  submission_id: z.string().uuid(),
}).openapi("ReporterFeedbackCommentInput");

const ReporterCloseInput = z.object({
  closure_reason: z.enum(["no_longer_needed", "duplicate"]).optional(),
  submission_id: z.string().uuid().optional(),
}).openapi("ReporterFeedbackCloseInput");

export const feedbackRoutes = {
  listReporter: {
    method: "get",
    path: "/api/apps/{appId}/reporter-feedback",
    tags: ["Reporter Feedback"],
    summary: "List the authenticated reporter's feedback tickets",
    security: auth,
    request: {
      params: AppIdParam,
      headers: ReporterHeaders,
      query: z.object({
        limit: z.coerce.number().int().min(1).max(100).optional(),
        cursor: z.string().optional(),
      }),
    },
    responses: {
      200: success("Reporter-owned feedback ticket list.", GenericObject),
      400: error("Missing or malformed reporter id."),
      401: error("Missing or invalid bearer token."),
      403: error("Invalid reporter integration grant."),
      429: error("Reporter rate limit exceeded."),
    },
  },
  mintReporterSession: {
    method: "post",
    path: "/api/apps/{appId}/reporter-feedback/session",
    tags: ["Reporter Feedback"],
    summary: "Mint a reporter session for an integration",
    security: auth,
    request: {
      params: AppIdParam,
      body: { content: json(GenericObject), required: true },
    },
    responses: {
      201: success("Reporter session minted.", GenericObject),
      400: error("Invalid reporter session request."),
      401: error("Missing or invalid bearer token."),
      403: error("Invalid reporter integration grant."),
      429: error("Reporter session mint rate limit exceeded."),
    },
  },
  bindReporterRouteSubject: {
    method: "put",
    path: "/api/apps/{appId}/reporter-feedback/route-subject",
    tags: ["Reporter Feedback"],
    summary: "Bind the reporter route subject",
    security: auth,
    request: {
      params: AppIdParam,
      headers: ReporterHeaders,
      body: { content: json(GenericObject), required: true },
    },
    responses: {
      200: success("Reporter route subject bound.", GenericObject),
      400: error("Invalid route subject payload."),
      401: error("Missing or invalid bearer token."),
      403: error("Invalid reporter integration grant."),
      404: error("Reporter route subject not found."),
      429: error("Reporter rate limit exceeded."),
    },
  },
  getReporter: {
    method: "get",
    path: "/api/apps/{appId}/reporter-feedback/{ticketId}",
    tags: ["Reporter Feedback"],
    summary: "Get reporter-owned feedback details",
    security: auth,
    request: {
      params: AppTicketParams,
      headers: ReporterHeaders,
      query: z.object({
        comment_limit: z.coerce.number().int().min(1).max(100).default(50),
        comment_cursor: z.string().optional(),
      }),
    },
    responses: {
      200: success("Reporter-owned feedback details; successful reads advance the authoritative receipt.", GenericObject),
      400: error("Missing or malformed reporter id."),
      401: error("Missing or invalid bearer token."),
      403: error("Invalid reporter integration grant."),
      404: error("Ticket is not owned by this reporter integration."),
      429: error("Reporter rate limit exceeded."),
    },
  },
  addReporterComment: {
    method: "post",
    path: "/api/apps/{appId}/reporter-feedback/{ticketId}/comments",
    tags: ["Reporter Feedback"],
    summary: "Add an idempotent reporter comment with optional image attachments",
    security: auth,
    request: {
      params: AppTicketParams,
      headers: ReporterHeaders,
      body: {
        content: { ...json(ReporterCommentInput), ...multipart() },
        required: true,
      },
    },
    responses: {
      200: success("Exact idempotent replay.", GenericObject),
      201: success("Reporter comment created.", GenericObject),
      400: error("Invalid reporter id, body, submission id, or attachment."),
      401: error("Missing or invalid bearer token."),
      403: error("Invalid reporter integration grant."),
      404: error("Ticket is not owned by this reporter integration."),
      409: error("Submission id was already used with a different body or attachment set."),
      429: error("Reporter rate limit exceeded."),
    },
  },
  closeReporter: {
    method: "post",
    path: "/api/apps/{appId}/reporter-feedback/{ticketId}/close",
    tags: ["Reporter Feedback"],
    summary: "Close a reporter-owned feedback ticket",
    description: "Idempotently moves only the authenticated reporter's ticket to the closed state with a user-appropriate closure reason. This route cannot reopen tickets or change assignees.",
    security: auth,
    request: {
      params: AppTicketParams,
      headers: ReporterHeaders,
      body: { content: json(ReporterCloseInput), required: true },
    },
    responses: {
      200: success("Ticket closed or already closed.", GenericObject),
      400: error("Missing or malformed reporter id or closure reason."),
      401: error("Missing or invalid bearer token."),
      403: error("Invalid reporter integration grant."),
      404: error("Ticket is not owned by this reporter integration."),
      409: error("Ticket changed concurrently; retry."),
      429: error("Reporter rate limit exceeded."),
    },
  },
  downloadReporterAttachment: {
    method: "get",
    path: "/api/apps/{appId}/reporter-feedback/{ticketId}/attachments/{attachmentId}",
    tags: ["Reporter Feedback"],
    summary: "Download a reporter-visible submission or reporter-comment attachment",
    security: auth,
    request: { params: AttachmentParams, headers: ReporterHeaders },
    responses: {
      200: { description: "Attachment stream.", content: binary() },
      400: error("Missing or malformed reporter id."),
      401: error("Missing or invalid bearer token."),
      403: error("Invalid reporter integration grant."),
      404: error("Attachment is not reporter-visible or not owned."),
      429: error("Reporter rate limit exceeded."),
    },
  },
  listFeedback: {
    method: "get",
    path: "/api/apps/{appId}/feedback",
    tags: ["Feedback"],
    summary: "List feedback and crash tickets",
    security: auth,
    request: {
      params: AppIdParam,
      query: z.object({
        status: z.string().optional(),
        kind: z.enum(["feedback", "bug", "crash"]).optional(),
        limit: z.coerce.number().int().optional(),
        cursor: z.string().optional(),
      }),
    },
    responses: {
      200: success("Feedback ticket list.", z.object({ tickets: z.array(GenericObject) }).catchall(z.unknown())),
      403: error("Current principal cannot view feedback."),
    },
  },
  listMaterialDelta: {
    method: "get",
    path: "/api/apps/{appId}/feedback/material-delta",
    tags: ["Feedback"],
    summary: "List materially changed feedback ticket snapshots",
    description: "Returns current snapshots after an opaque per-app cursor. Process a whole page before persisting next_cursor.",
    security: auth,
    request: {
      params: AppIdParam,
      query: z.object({
        cursor: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      }),
    },
    responses: {
      200: success(
        "Materially changed feedback snapshots.",
        z.object({
          tickets: z.array(GenericObject),
          next_cursor: z.string(),
          has_more: z.boolean(),
        }),
      ),
      400: error("Invalid material cursor or limit."),
      403: error("Current principal cannot view feedback."),
    },
  },
  feedbackStats: {
    method: "get",
    path: "/api/apps/{appId}/feedback/stats",
    tags: ["Feedback"],
    summary: "Read feedback ticket statistics",
    security: auth,
    request: { params: AppIdParam },
    responses: {
      200: success("Feedback stats.", GenericObject),
      403: error("Current principal cannot view feedback stats."),
    },
  },
  listCrashGroups: {
    method: "get",
    path: "/api/apps/{appId}/feedback/crash-groups",
    tags: ["Feedback"],
    summary: "List crash groups by signature",
    security: auth,
    request: {
      params: AppIdParam,
      query: z.object({
        status: z.string().optional(),
        limit: z.coerce.number().int().optional(),
      }),
    },
    responses: {
      200: success("Crash group list.", z.object({ groups: z.array(GenericObject) }).catchall(z.unknown())),
      403: error("Current principal cannot view crash groups."),
    },
  },
  getFeedback: {
    method: "get",
    path: "/api/apps/{appId}/feedback/{ticketId}",
    tags: ["Feedback"],
    summary: "Get feedback ticket details",
    security: auth,
    request: { params: AppTicketParams },
    responses: {
      200: success("Feedback ticket details.", GenericObject),
      403: error("Current principal cannot view feedback ticket."),
      404: error("Feedback ticket was not found."),
    },
  },
  updateFeedback: {
    method: "patch",
    path: "/api/apps/{appId}/feedback/{ticketId}",
    tags: ["Feedback"],
    summary: "Update feedback ticket status or assignee",
    security: auth,
    request: {
      params: AppTicketParams,
      body: { content: json(FeedbackUpdateInput), required: true },
    },
    responses: {
      200: success("Updated feedback ticket.", GenericObject),
      400: error("Invalid feedback update."),
      403: error("Current principal cannot update feedback ticket."),
      404: error("Feedback ticket was not found."),
    },
  },
  addFeedbackComment: {
    method: "post",
    path: "/api/apps/{appId}/feedback/{ticketId}/comments",
    tags: ["Feedback"],
    summary: "Add a comment to a feedback ticket",
    security: auth,
    request: {
      params: AppTicketParams,
      body: { content: json(FeedbackCommentInput), required: true },
    },
    responses: {
      201: success("Created feedback comment.", GenericObject),
      400: error("Invalid comment payload."),
      403: error("Current principal cannot comment on feedback ticket."),
      404: error("Feedback ticket was not found."),
    },
  },
  downloadFeedbackAttachment: {
    method: "get",
    path: "/api/apps/{appId}/feedback/{ticketId}/attachments/{attachmentId}",
    tags: ["Feedback"],
    summary: "Download feedback attachment",
    security: auth,
    request: { params: AttachmentParams },
    responses: {
      200: { description: "Attachment stream.", content: binary() },
      403: error("Current principal cannot download feedback attachment."),
      404: error("Feedback attachment was not found."),
    },
  },
};
