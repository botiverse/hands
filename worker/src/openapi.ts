import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { registerAppRoutes } from "./openapi/apps";
import { registerAndroidDistributionRoutes } from "./openapi/android_distribution";
import { registerAuthRoutes } from "./openapi/auth";
import { registerBuildRoutes } from "./openapi/builds";
import { feedbackRoutes } from "./openapi/feedback";
import { registerOrgRoutes } from "./openapi/orgs";
import { registerPublicRoutes } from "./openapi/public";
import { registerReleaseRoutes } from "./openapi/releases";
import { registerSettingsRoutes } from "./openapi/settings";

const docs = new OpenAPIHono();

for (const r of registerAuthRoutes()) docs.openAPIRegistry.registerPath(createRoute(r));
for (const r of registerPublicRoutes()) docs.openAPIRegistry.registerPath(createRoute(r));
for (const r of registerAppRoutes()) docs.openAPIRegistry.registerPath(createRoute(r));
for (const r of registerAndroidDistributionRoutes()) docs.openAPIRegistry.registerPath(createRoute(r));
for (const r of registerBuildRoutes()) docs.openAPIRegistry.registerPath(createRoute(r));
for (const r of registerReleaseRoutes()) docs.openAPIRegistry.registerPath(createRoute(r));
// Feedback routes are bound live via OpenAPIHono elsewhere; registering the
// same RouteConfig here keeps this document complete while avoiding a second
// source of truth.
for (const r of Object.values(feedbackRoutes)) docs.openAPIRegistry.registerPath(createRoute(r));
for (const r of registerOrgRoutes()) docs.openAPIRegistry.registerPath(createRoute(r));
for (const r of registerSettingsRoutes()) docs.openAPIRegistry.registerPath(createRoute(r));

export const openApiDocument = docs.getOpenAPI31Document({
  openapi: "3.1.0",
  info: {
    title: "Hands API",
    version: "0.1.0",
    description:
      "Interactive API reference for Hands. Generated from modular Hono/Zod route definitions.",
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
      name: "Analytics",
      description: "Authenticated app usage, device, and version metrics.",
    },
    {
      name: "Builds",
      description: "Create, inspect, and download build artifacts.",
    },
    {
      name: "Android distribution",
      description: "Immutable AAB/APK bundles, acceptance receipts, and server-side Google Play promotion.",
    },
    {
      name: "TestFlight",
      description:
        "Server-side App Store Connect upload, beta group distribution, review, and status synchronization.",
    },
    {
      name: "QA artifacts",
      description: "Exact-byte, non-release artifacts used by agents and device test lanes.",
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
    bearerFormat: "JWT",
    description: "Hands JWT from Login with Raft, or an app deploy token for scoped CI/agent access.",
  },
};
