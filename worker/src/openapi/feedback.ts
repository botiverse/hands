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

export function registerFeedbackRoutes(registry: OpenApiRegistry) {
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

