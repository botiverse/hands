import { z } from "@hono/zod-openapi";
import {
  AppIdParam,
  GenericObject,
  auth,
  error,
  json,
  register,
  success,
  type OpenApiRegistry,
} from "./common";

const AppNotarizationParams = AppIdParam.extend({
  notarizationId: z.string().openapi({
    param: { name: "notarizationId", in: "path" },
    example: "notary_123",
  }),
});

const CreateNotarizationInput = z
  .object({
    r2_key: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/i),
    size_bytes: z.number().int().positive(),
    submission_name: z.string().max(255),
    idempotency_key: z.string().min(1).max(128),
  })
  .openapi("CreateNotarizationInput");

export function registerNotarizationRoutes(registry: OpenApiRegistry) {
  register(registry, {
    method: "post",
    path: "/api/apps/{appId}/notarizations",
    tags: ["Notarizations"],
    summary: "Submit a signed macOS artifact for Apple notarization",
    description:
      "Uses this app's encrypted App Store Connect credentials inside Hands. Apple credentials and temporary S3 credentials are never returned. The pending R2 object must be the exact SHA-256 and size supplied by the caller.",
    security: auth,
    request: {
      params: AppIdParam,
      body: { content: json(CreateNotarizationInput), required: true },
    },
    responses: {
      202: success("Submission created and exact bytes uploaded to Apple.", GenericObject),
      200: success("Idempotent replay of an existing submission.", GenericObject),
      400: error("Invalid artifact metadata or missing ASC credentials."),
      403: error("Current app principal is not a publisher."),
      409: error("Artifact binding or idempotency key mismatch."),
      502: error("Apple submission or upload failed."),
    },
  });

  register(registry, {
    method: "get",
    path: "/api/apps/{appId}/notarizations/{notarizationId}",
    tags: ["Notarizations"],
    summary: "Read notarization status and terminal developer log",
    description:
      "The app-scoped Hands row is resolved before Apple is queried. Accepted is safe to staple only when ready_for_staple is true, which requires Apple's terminal log SHA-256 to match the submitted artifact.",
    security: auth,
    request: { params: AppNotarizationParams },
    responses: {
      200: success("Current status, binding verdict, and terminal log.", GenericObject),
      403: error("Current app principal cannot view this submission."),
      404: error("No submission with this app-scoped id exists."),
      502: error("Apple status or developer-log retrieval failed."),
    },
  });
}
