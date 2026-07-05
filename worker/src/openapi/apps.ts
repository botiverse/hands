import { z } from "@hono/zod-openapi";
import {
  AppIdParam,
  GenericObject,
  OkResponse,
  auth,
  binary,
  error,
  json,
  register,
  success,
  type OpenApiRegistry,
} from "./common";

const AppInput = z
  .object({
    slug: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    platform: z.string().optional(),
    description: z.string().nullable().optional(),
    public_history_enabled: z.boolean().optional(),
  })
  .catchall(z.unknown())
  .openapi("AppInput");

const ClientKeyResponse = z
  .object({
    client_key: z.string().nullable(),
  })
  .catchall(z.unknown())
  .openapi("ClientKeyResponse");

export function registerAppRoutes(registry: OpenApiRegistry) {
  register(registry, {
    method: "get",
    path: "/api/apps",
    tags: ["Apps"],
    summary: "List apps visible to the current principal",
    security: auth,
    responses: {
      200: success("App list.", z.object({ apps: z.array(GenericObject) })),
      401: error("Missing or invalid authentication."),
    },
  });

  register(registry, {
    method: "post",
    path: "/api/apps",
    tags: ["Apps"],
    summary: "Create an app",
    security: auth,
    request: { body: { content: json(AppInput), required: true } },
    responses: {
      201: success("Created app.", GenericObject),
      400: error("Invalid app payload."),
      403: error("Current principal cannot create apps."),
      409: error("App slug already exists."),
    },
  });

  register(registry, {
    method: "get",
    path: "/api/apps/{appId}",
    tags: ["Apps"],
    summary: "Get app details",
    security: auth,
    request: { params: AppIdParam },
    responses: {
      200: success("App details.", GenericObject),
      403: error("Current principal cannot view the app."),
      404: error("App was not found."),
    },
  });

  register(registry, {
    method: "patch",
    path: "/api/apps/{appId}",
    tags: ["Apps"],
    summary: "Update app details",
    security: auth,
    request: {
      params: AppIdParam,
      body: { content: json(AppInput), required: true },
    },
    responses: {
      200: success("Updated app.", GenericObject),
      400: error("Invalid app payload."),
      403: error("Current principal cannot update the app."),
      404: error("App was not found."),
    },
  });

  register(registry, {
    method: "post",
    path: "/api/apps/{appId}/archive",
    tags: ["Apps"],
    summary: "Archive or restore an app",
    security: auth,
    request: {
      params: AppIdParam,
      body: {
        content: json(z.object({ archived: z.boolean().optional() }).catchall(z.unknown())),
        required: false,
      },
    },
    responses: {
      200: success("Archive state updated.", GenericObject),
      403: error("Current principal cannot archive the app."),
      404: error("App was not found."),
    },
  });

  register(registry, {
    method: "post",
    path: "/api/apps/{appId}/purge",
    tags: ["Apps"],
    summary: "Permanently purge an archived app",
    security: auth,
    request: {
      params: AppIdParam,
      body: {
        content: json(z.object({ confirm_slug: z.string().optional() }).catchall(z.unknown())),
        required: true,
      },
    },
    responses: {
      200: success("App purged.", OkResponse),
      400: error("App must be archived and confirmed before purge."),
      403: error("Current principal cannot purge the app."),
      404: error("App was not found."),
    },
  });

  register(registry, {
    method: "put",
    path: "/api/apps/{appId}/icon",
    tags: ["Apps"],
    summary: "Upload app-level fallback icon",
    security: auth,
    request: {
      params: AppIdParam,
      body: {
        content: binary(),
        required: true,
      },
    },
    responses: {
      200: success("Icon uploaded.", GenericObject),
      400: error("Icon upload failed."),
      403: error("Current principal cannot upload app icon."),
    },
  });

  register(registry, {
    method: "get",
    path: "/api/apps/{appId}/client-key",
    tags: ["Apps"],
    summary: "Read the app public client key",
    description: "Client keys identify public SDK feedback/crash submissions. They are not admin secrets.",
    security: auth,
    request: { params: AppIdParam },
    responses: {
      200: success("Client key.", ClientKeyResponse),
      403: error("Current principal cannot read the client key."),
      404: error("App was not found."),
    },
  });

  register(registry, {
    method: "post",
    path: "/api/apps/{appId}/rotate-client-key",
    tags: ["Apps"],
    summary: "Rotate the app public client key",
    security: auth,
    request: { params: AppIdParam },
    responses: {
      200: success("Rotated client key.", ClientKeyResponse),
      403: error("Current principal cannot rotate the client key."),
      404: error("App was not found."),
    },
  });
}

