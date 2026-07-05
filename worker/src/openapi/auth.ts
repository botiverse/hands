import { z } from "@hono/zod-openapi";
import { GenericObject, OkResponse, error, json, register, success, type OpenApiRegistry } from "./common";

export function registerAuthRoutes(registry: OpenApiRegistry) {
  register(registry, {
    method: "get",
    path: "/health",
    tags: ["System"],
    summary: "Worker health check",
    responses: {
      200: success("Health status.", z.object({ ok: z.literal(true) }).catchall(z.unknown())),
    },
  });

  register(registry, {
    method: "get",
    path: "/.well-known/raft-agent-manifest.json",
    tags: ["Auth"],
    summary: "Raft Agent Login manifest",
    responses: {
      200: success("Agent manifest.", GenericObject),
    },
  });

  register(registry, {
    method: "get",
    path: "/api/auth/config",
    tags: ["Auth"],
    summary: "Read public auth configuration",
    responses: {
      200: success("Auth config.", GenericObject),
    },
  });

  register(registry, {
    method: "get",
    path: "/api/auth/login",
    tags: ["Auth"],
    summary: "Start Login with Raft",
    request: {
      query: z.object({ return_to: z.string().optional() }),
    },
    responses: {
      302: { description: "Redirects to Raft OAuth." },
      500: { description: "Auth configuration is incomplete.", content: json(GenericObject) },
    },
  });

  register(registry, {
    method: "get",
    path: "/login/raft/callback",
    tags: ["Auth"],
    summary: "Login with Raft callback",
    request: {
      query: z.object({
        code: z.string().optional(),
        state: z.string().optional(),
      }),
    },
    responses: {
      200: success("Agent token response when called by Raft Agent Login.", GenericObject),
      302: { description: "Browser login success redirect." },
      400: error("Invalid callback."),
      403: error("Server or principal is not allowed."),
    },
  });

  register(registry, {
    method: "get",
    path: "/api/auth/me",
    tags: ["Auth"],
    summary: "Read current authenticated principal",
    responses: {
      200: success("Current account context.", GenericObject),
    },
  });

  register(registry, {
    method: "post",
    path: "/api/auth/logout",
    tags: ["Auth"],
    summary: "Logout current browser session",
    responses: {
      200: success("Logged out.", OkResponse),
    },
  });
}

