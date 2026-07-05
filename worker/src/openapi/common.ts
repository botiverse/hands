import { createRoute, z } from "@hono/zod-openapi";

export type OpenApiRegistry = {
  registerPath: (route: ReturnType<typeof createRoute>) => void;
};

export const AppIdParam = z.object({
  appId: z.string().openapi({
    param: { name: "appId", in: "path" },
    example: "app_123",
  }),
});

export const OrgIdParam = z.object({
  orgId: z.string().openapi({
    param: { name: "orgId", in: "path" },
    example: "org_123",
  }),
});

export const AccountIdParam = z.object({
  accountId: z.string().openapi({
    param: { name: "accountId", in: "path" },
    example: "acct_123",
  }),
});

export const BuildIdParam = z.object({
  buildId: z.string().openapi({
    param: { name: "buildId", in: "path" },
    example: "build_123",
  }),
});

export const AssetIdParam = z.object({
  assetId: z.string().openapi({
    param: { name: "assetId", in: "path" },
    example: "asset_123",
  }),
});

export const ReleaseIdParam = z.object({
  releaseId: z.string().openapi({
    param: { name: "releaseId", in: "path" },
    example: "rel_123",
  }),
});

export const ShareIdParam = z.object({
  shareId: z.string().openapi({
    param: { name: "shareId", in: "path" },
    example: "share_123",
  }),
});

export const TokenIdParam = z.object({
  tokenId: z.string().openapi({
    param: { name: "tokenId", in: "path" },
    example: "token_123",
  }),
});

export const InviteTokenParam = z.object({
  token: z.string().openapi({
    param: { name: "token", in: "path" },
    example: "invite_token",
  }),
});

export const InviteIdParam = z.object({
  inviteId: z.string().openapi({
    param: { name: "inviteId", in: "path" },
    example: "invite_123",
  }),
});

export const WebhookIdParam = z.object({
  webhookId: z.string().openapi({
    param: { name: "webhookId", in: "path" },
    example: "webhook_123",
  }),
});

export const ChannelIdParam = z.object({
  channelId: z.string().openapi({
    param: { name: "channelId", in: "path" },
    example: "channel_123",
  }),
});

export const ProductTypeIdParam = z.object({
  ptId: z.string().openapi({
    param: { name: "ptId", in: "path" },
    example: "pt_123",
  }),
});

export const ReleaseTypeIdParam = z.object({
  rtId: z.string().openapi({
    param: { name: "rtId", in: "path" },
    example: "rt_123",
  }),
});

export const TicketIdParam = z.object({
  ticketId: z.string().openapi({
    param: { name: "ticketId", in: "path" },
    example: "ticket_123",
  }),
});

export const AttachmentIdParam = z.object({
  attachmentId: z.string().openapi({
    param: { name: "attachmentId", in: "path" },
    example: "attachment_123",
  }),
});

export const OperationIdParam = z.object({
  opId: z.string().openapi({
    param: { name: "opId", in: "path" },
    example: "op_123",
  }),
});

export const ServerIdParam = z.object({
  serverId: z.string().openapi({
    param: { name: "serverId", in: "path" },
    example: "oranix-main",
  }),
});

export const SlugParam = z.object({
  slug: z.string().openapi({
    param: { name: "slug", in: "path" },
    example: "raft-android",
  }),
});

export const R2KeyParam = z.object({
  key: z.string().openapi({
    param: { name: "key", in: "path" },
    example: "apps%2Fapp_123%2Fbuilds%2Fbuild_123%2Fapp.apk",
  }),
});

export const ErrorResponse = z
  .object({
    error: z.string(),
    detail: z.string().optional(),
  })
  .catchall(z.unknown())
  .openapi("ErrorResponse");

export const GenericObject = z
  .object({})
  .catchall(z.unknown())
  .openapi("GenericObject");

export const OkResponse = z.object({ ok: z.literal(true) }).catchall(z.unknown()).openapi("OkResponse");

export const AppRole = z.enum(["viewer", "publisher", "admin"]);
export const OrgRole = z.enum(["owner", "admin", "member", "viewer"]);
export const DeployTokenRole = z.enum(["viewer", "publisher"]);

export const auth = [{ bearerAuth: [] }, { cookieAuth: [] }];

export const json = (schema: z.ZodType) => ({
  "application/json": { schema },
});

export const text = () => ({
  "text/plain": { schema: z.string() },
});

export const html = () => ({
  "text/html": { schema: z.string() },
});

export const binary = () => ({
  "application/octet-stream": {
    schema: z.string().openapi({ format: "binary" }),
  },
});

export const multipart = () => ({
  "multipart/form-data": {
    schema: GenericObject,
  },
});

export const error = (description: string) => ({
  description,
  content: json(ErrorResponse),
});

export const success = (description: string, schema: z.ZodType = GenericObject) => ({
  description,
  content: json(schema),
});

export const noContent = (description: string) => ({ description });

export function register(registry: OpenApiRegistry, config: Parameters<typeof createRoute>[0]) {
  registry.registerPath(createRoute(config));
}
