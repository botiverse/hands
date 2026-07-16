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

const ExportNotarizationCredentialsInput = z
  .object({
    submission_name: z.string().regex(/\.(dmg|pkg)$/i).max(255),
    sha256: z.string().regex(/^[a-f0-9]{64}$/i),
    size_bytes: z.number().int().positive(),
  })
  .openapi("ExportNotarizationCredentialsInput");

export function registerNotarizationRoutes(registry: OpenApiRegistry) {
  register(registry, {
    method: "post",
    path: "/api/apps/{appId}/notarization-credentials/export",
    tags: ["Notarizations"],
    summary: "Export the app's ASC key for local Apple notarization",
    description:
      "Returns a non-cacheable, audited copy of this app's encrypted App Store Connect team API key to an app publisher. The protected macOS runner submits the local signed artifact with Apple's notarytool; artifact bytes never pass through Hands or R2.",
    security: auth,
    request: {
      params: AppIdParam,
      body: {
        content: json(ExportNotarizationCredentialsInput),
        required: true,
      },
    },
    responses: {
      200: success(
        "Credential export receipt and ASC key. This response is sensitive and non-cacheable.",
        GenericObject,
      ),
      400: error("Invalid artifact metadata."),
      403: error("Current app principal is not a publisher."),
      404: error("No ASC credentials are configured for this app."),
      500: error("Credential decryption is unavailable."),
    },
  });
}
