import { OpenAPIHono } from "@hono/zod-openapi";
import { registerAppRoutes } from "./openapi/apps";
import { registerAuthRoutes } from "./openapi/auth";
import { registerBuildRoutes } from "./openapi/builds";
import { registerFeedbackRoutes } from "./openapi/feedback";
import { registerOrgRoutes } from "./openapi/orgs";
import { registerPublicRoutes } from "./openapi/public";
import { registerReleaseRoutes } from "./openapi/releases";
import { registerSettingsRoutes } from "./openapi/settings";

const docs = new OpenAPIHono();

registerAuthRoutes(docs.openAPIRegistry);
registerPublicRoutes(docs.openAPIRegistry);
registerAppRoutes(docs.openAPIRegistry);
registerBuildRoutes(docs.openAPIRegistry);
registerReleaseRoutes(docs.openAPIRegistry);
registerFeedbackRoutes(docs.openAPIRegistry);
registerOrgRoutes(docs.openAPIRegistry);
registerSettingsRoutes(docs.openAPIRegistry);

export const openApiDocument = docs.getOpenAPI31Document({
  openapi: "3.1.0",
  info: {
    title: "Quiver API",
    version: "0.1.0",
    description:
      "Interactive API reference for Quiver. Generated from modular Hono/Zod route definitions.",
  },
  servers: [
    {
      url: "/",
      description: "Current origin",
    },
    {
      url: "http://localhost:8787",
      description: "Local wrangler dev",
    },
  ],
  tags: [
    {
      name: "System",
      description: "Operational health and public metadata.",
    },
    {
      name: "Auth",
      description: "Login with Raft, Agent Login, and current session endpoints.",
    },
    {
      name: "Public update",
      description: "Client-facing release resolution endpoints.",
    },
    {
      name: "Public feedback",
      description: "Client-facing feedback and crash submission endpoints.",
    },
    {
      name: "Public pages",
      description: "Unauthenticated share, history, and icon pages.",
    },
    {
      name: "Public downloads",
      description: "Unauthenticated signed artifact download endpoints.",
    },
    {
      name: "Apps",
      description: "App lifecycle and app-level public client configuration.",
    },
    {
      name: "Builds",
      description: "Create, inspect, and download build artifacts.",
    },
    {
      name: "Releases",
      description: "Draft, publish, scope, and operate releases.",
    },
    {
      name: "Release shares",
      description: "Create and manage revocable public release share pages.",
    },
    {
      name: "Feedback",
      description: "Triage feedback and crash tickets.",
    },
    {
      name: "Organizations",
      description: "Organization membership and access management.",
    },
    {
      name: "Invites",
      description: "Invite-link creation, refresh, revoke, and acceptance.",
    },
    {
      name: "Webhooks",
      description: "Webhook subscriptions and delivery history.",
    },
    {
      name: "Channels",
      description: "Per-app release channels.",
    },
    {
      name: "Product types",
      description: "Per-app artifact product families.",
    },
    {
      name: "Release types",
      description: "Per-app release-type configuration.",
    },
    {
      name: "App access",
      description: "App members, server grants, and scoped automation credentials.",
    },
    {
      name: "Audit",
      description: "Organization, app, and user audit trails.",
    },
    {
      name: "Operations",
      description: "Long-running app operation log and retry endpoints.",
    },
  ],
});

openApiDocument.components ??= {};
openApiDocument.components.securitySchemes = {
  bearerAuth: {
    type: "http",
    scheme: "bearer",
    description: "Quiver bearer token. Use app deploy tokens for CI and agents.",
  },
  cookieAuth: {
    type: "apiKey",
    in: "cookie",
    name: "quiver_session",
    description: "Browser session cookie set by Login with Raft.",
  },
};
