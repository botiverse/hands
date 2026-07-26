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
  register,
  success,
  type OpenApiRegistry,
} from "./common";

const AppTicketParams = AppIdParam.merge(TicketIdParam);
const AttachmentParams = AppTicketParams.merge(AttachmentIdParam);

const FeedbackUpdateInput = z
  .object({
    status: z.string().optional(),
    assignee: z.string().nullable().optional(),
  })
  .catchall(z.unknown())
  .openapi("FeedbackUpdateInput");

const FeedbackCommentInput = z
  .object({
    message: z.string().min(1),
  })
  .openapi("FeedbackCommentInput");

const ReporterHeaders = z.object({
  "X-Hands-Reporter-Id": z.string().min(16).max(200),
});

const ReporterCommentInput = z.object({
  body: z.string().min(1).max(10_000),
  submission_id: z.string().uuid(),
}).openapi("ReporterFeedbackCommentInput");

const ReporterRouteInput = z.object({
  route_subject: z.string().regex(/^rfr_v1_[A-Za-z0-9_-]+$/).max(160),
}).strict().openapi("ReporterRouteSubjectInput");

const ReporterWebhookParams = AppIdParam.extend({
  integrationId: z.string().min(1),
  webhookId: z.string().min(1),
});

export function registerFeedbackRoutes(registry: OpenApiRegistry) {
  register(registry, {
    method: "put",
    path: "/api/apps/{appId}/reporter-feedback/route-subject",
    tags: ["Reporter Feedback"],
    summary: "Bind an immutable opaque v1 reporter route subject",
    security: auth,
    request: {
      params: AppIdParam,
      headers: ReporterHeaders,
      body: { content: json(ReporterRouteInput), required: true },
    },
    responses: {
      200: success("Exact idempotent replay; subject is not returned.", GenericObject),
      201: success("Route binding created; subject is not returned.", GenericObject),
      400: error("Malformed route subject."),
      401: error("Missing or invalid bearer token."),
      403: error("Invalid reporter integration grant."),
      409: error("A different immutable v1 subject already exists."),
    },
  });

  register(registry, {
    method: "put",
    path: "/api/apps/{appId}/reporter-integrations/{integrationId}/webhooks/{webhookId}",
    tags: ["Reporter Feedback"],
    summary: "Bind one active webhook as the exact reporter-integration subscriber",
    security: auth,
    request: { params: ReporterWebhookParams },
    responses: {
      200: success("Exact idempotent replay.", GenericObject),
      201: success("Dedicated reporter webhook subscription created.", GenericObject),
      403: error("Current principal cannot administer this app."),
      409: error("App, integration, or webhook is inactive or mismatched."),
    },
  });

  register(registry, {
    method: "get",
    path: "/api/apps/{appId}/reporter-feedback-metadata",
    tags: ["Reporter Feedback"],
    summary: "Read safe route, grant, audit, and delivery metadata",
    security: auth,
    request: {
      params: AppIdParam,
      query: z.object({
        reporter_integration_id: z.string().min(1),
        reporter_id: z.string().min(16).max(200),
        token_id: z.string().min(1),
      }),
    },
    responses: {
      200: success("Safe metadata; never returns route subject, reporter id, body, or token secret.", GenericObject),
      400: error("Required coordinate or token id is missing."),
      403: error("Current principal cannot view this app."),
      503: error("Reporter audit metadata is not configured."),
    },
  });

  register(registry, {
    method: "get",
    path: "/api/apps/{appId}/reporter-feedback",
    tags: ["Reporter Feedback"],
    summary: "List feedback owned by the reporter integration",
    security: auth,
    request: {
      params: AppIdParam,
      headers: ReporterHeaders,
      query: z.object({ limit: z.coerce.number().int().min(1).max(50).default(20), cursor: z.string().optional() }),
    },
    responses: {
      200: success("Reporter-owned feedback list with authoritative unread totals.", GenericObject),
      400: error("Missing or malformed reporter id or cursor."),
      401: error("Missing or invalid bearer token."),
      403: error("Bearer grant is not an active reporter integration grant."),
      429: error("Reporter rate limit exceeded."),
    },
  });

  register(registry, {
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
  });

  register(registry, {
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
  });

  register(registry, {
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
  });

  register(registry, {
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
  });

  register(registry, {
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
  });

  register(registry, {
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
  });

  register(registry, {
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
  });

  register(registry, {
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
  });

  register(registry, {
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
  });

  register(registry, {
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
  });
}
