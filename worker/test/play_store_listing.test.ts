import { beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { exportPKCS8, generateKeyPair } from "jose";
import { storeGooglePlayBinding } from "../src/lib/google_play_bindings";
import { requireAppRole } from "../src/lib/permissions";
import { isPlayListingLanguage, PLAY_LISTING_LANGUAGES, suggestPlayListingLanguage } from "../src/lib/play_listing_languages";
import {
  handleGetPlayStoreListing,
  handleListPlayStoreListingReceipts,
  handlePushPlayStoreListing,
  normalizeStoreListingPush,
} from "../src/routes/play_store_listing";
import { openApiDocument } from "../src/openapi";
import { createHash } from "node:crypto";
import { checkImage, sniffImage, PLAY_IMAGE_TYPES } from "../src/lib/play_images";

let privateKey: string;
beforeAll(async () => {
  privateKey = await exportPKCS8((await generateKeyPair("RS256", { extractable: true })).privateKey);
});

const migrationDir = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));

function d1(sqlite: Database.Database): D1Database {
  const prepare = (sql: string) => {
    const indexes: number[] = [];
    const statement = sqlite.prepare(sql.replace(/\?(\d+)/g, (_m, index) => {
      indexes.push(Number(index));
      return "?";
    }));
    const bind = (...parameters: unknown[]) => {
      const expanded = indexes.length ? indexes.map((index) => parameters[index - 1]) : parameters;
      const runSync = () => ({ success: true, meta: { changes: statement.run(...expanded).changes } });
      return {
        _batchSync: () => (statement.reader ? { success: true, results: statement.all(...expanded) } : runSync()),
        run: async () => runSync(),
        all: async () => ({ success: true, results: statement.all(...expanded) }),
        first: async (column?: string) => {
          const row = statement.get(...expanded) as Record<string, unknown> | undefined;
          return column ? row?.[column] ?? null : row ?? null;
        },
      };
    };
    return { bind, run: () => bind().run(), all: () => bind().all(), first: () => bind().first() };
  };
  return {
    prepare,
    batch: async (statements: Array<{ _batchSync: () => unknown }>) =>
      sqlite.transaction(() => statements.map((statement) => statement._batchSync()))(),
  } as unknown as D1Database;
}

type Adapter = NonNullable<Env["PLAY_RELEASE_SERVICE"]>;
type PushInput = Parameters<Adapter["pushStoreListings"]>[0];

function adapter(overrides: Partial<Adapter> = {}): Adapter {
  const unexpected = async () => { throw new Error("unexpected adapter call"); };
  return {
    listTracks: unexpected, verifyBinding: unexpected, listReleaseStates: unexpected,
    readTrackMaximum: unexpected, promote: unexpected,
    readStoreListings: async (input) => ({ ok: true, value: {
      package_name: input.packageName, default_language: "en-US",
      listings: [{ language: "en-US", title: "Raft", shortDescription: "s", fullDescription: "f" }],
    } }),
    pushStoreListings: async (input) => ({ ok: true, value: {
      edit_id: "edit-1", package_name: input.packageName, mode: input.mode,
      outcome: input.mode === "commit" ? "committed" : "validated",
      default_language: "en-US",
      changes_not_sent_for_review: input.changesNotSentForReview === true,
      changes: input.listings.map((listing) => ({
        language: listing.language, action: "update" as const, changed_fields: ["title" as const],
        before: { language: listing.language, title: "Old" }, after: listing,
      })),
    } }),
    ...overrides,
  } as Adapter;
}

const executionContext = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

async function harness(options: { role?: "publisher" | "viewer"; principal?: "human" | "agent" | "system"; bind?: boolean } = {}) {
  const principal = options.principal ?? "agent";
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  for (const name of readdirSync(migrationDir).sort()) {
    if (name.endsWith(".sql")) sqlite.exec(readFileSync(`${migrationDir}${name}`, "utf8"));
  }
  const now = Date.now();
  sqlite.prepare("INSERT INTO apps (id, slug, name, platform, created_at) VALUES ('app', 'raft-android', 'Raft', 'android', ?)").run(now);
  sqlite.prepare(`INSERT INTO raft_accounts
    (id, provider, provider_subject, server_id, server_slug, principal_type, server_role,
     username, display_name, avatar_url, raw_profile, created_at, updated_at, last_login_at)
    VALUES ('acct', 'raft', 'acct', 'server', 'test', ?, 'member', 'acct', 'Acct', NULL, '{}', ?, ?, ?)`)
    .run(principal === "system" ? "agent" : principal, now, now, now);
  sqlite.prepare("INSERT INTO app_members (id, app_id, account_id, app_role, joined_at) VALUES ('m', 'app', 'acct', ?, ?)")
    .run(options.role ?? "publisher", now);
  const env = {
    DB: d1(sqlite),
    ENVIRONMENT: "development",
    PLAY_CRED_ENC_KEYS: JSON.stringify({ v1: "test-only-google-play-key-material-1234567890" }),
    PLAY_CRED_ENC_ACTIVE_KEY_VERSION: "v1",
    PLAY_RELEASE_SERVICE: adapter(),
  } as unknown as Env;
  if (options.bind !== false) {
    await storeGooglePlayBinding(env.DB, {
      appId: "app", packageName: "build.raft.app",
      tracks: { internal: "qa", closed: "closed", production: "production" },
      credential: { type: "service_account", client_email: "app@example.iam.gserviceaccount.com", private_key: privateKey },
      actor: "raft:human@test", keyringJson: env.PLAY_CRED_ENC_KEYS!, activeKeyVersion: "v1",
    });
  }
  const app = new Hono<{ Bindings: Env; Variables: { admin_account: any; admin_actor: string } }>();
  app.use("*", async (c, next) => {
    c.set("admin_account", principal === "system" ? undefined : {
      id: "acct", provider: "raft", provider_subject: "acct", server_id: "server", server_slug: "test",
      principal_type: principal, server_role: "member", username: "acct", display_name: "Acct",
      avatar_url: null, raw_profile: "{}", created_at: 1, updated_at: 1, last_login_at: 1,
    });
    c.set("admin_actor", `raft:${principal}@test`);
    await next();
  });
  app.get("/api/apps/:appId/distributions/play/store-listing", requireAppRole("publisher"), handleGetPlayStoreListing);
  app.post("/api/apps/:appId/distributions/play/store-listing", requireAppRole("publisher"), handlePushPlayStoreListing);
  app.get("/api/apps/:appId/distributions/play/store-listing/receipts", requireAppRole("viewer"), handleListPlayStoreListingReceipts);
  const request = (path: string, init?: RequestInit) => app.fetch(new Request(`https://hands.test${path}`, init), env, executionContext);
  const pushBody = (body: unknown) => request("/api/apps/app/distributions/play/store-listing", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const receipts = () => sqlite.prepare("SELECT * FROM play_store_listing_receipts ORDER BY created_at").all() as Array<Record<string, unknown>>;
  return { sqlite, env, request, pushBody, receipts };
}

describe("Play store listing languages", () => {
  it("is Play's 86-language list with exact case and suggestions", () => {
    expect(PLAY_LISTING_LANGUAGES).toHaveLength(86);
    expect(new Set(PLAY_LISTING_LANGUAGES).size).toBe(86);
    for (const tag of ["en-US", "zh-CN", "zh-TW", "zh-HK", "ja-JP", "ko-KR", "es-ES", "fr-FR", "de-DE", "pt-BR", "iw-IL", "es-419", "fil"]) {
      expect(isPlayListingLanguage(tag), tag).toBe(true);
    }
    expect(isPlayListingLanguage("en-us")).toBe(false);
    expect(isPlayListingLanguage("zh-Hans")).toBe(false);
    expect(suggestPlayListingLanguage("en-us")).toBe("en-US");
    expect(suggestPlayListingLanguage("zh-Hans")).toBe("zh-CN");
    expect(suggestPlayListingLanguage("he-IL")).toBe("iw-IL");
  });
});

describe("store listing push validation", () => {
  const ok = { mode: "dry_run", listings: [{ language: "en-US", title: "Raft" }] };
  it("accepts Google's Listing fields only and requires an explicit mode", () => {
    expect(normalizeStoreListingPush(ok)).toEqual({ mode: "dry_run", listings: [{ language: "en-US", title: "Raft" }], delete_unlisted_languages: false, changes_not_sent_for_review: false });
    const cases: Array<[unknown, string]> = [
      [{ listings: ok.listings }, "listing_mode_required"],
      [{ ...ok, path: "/tracks/production" }, "listing_request_invalid"],
      [{ ...ok, listings: [{ language: "en-US", short_description: "x" }] }, "listing_field_unknown"],
      [{ ...ok, listings: [{ language: "en-US", title: "x".repeat(31) }] }, "listing_field_too_long"],
      [{ ...ok, listings: [{ language: "en-US", shortDescription: "x".repeat(81) }] }, "listing_field_too_long"],
      [{ ...ok, listings: [{ language: "en-US", fullDescription: "x".repeat(4001) }] }, "listing_field_too_long"],
      [{ ...ok, listings: [{ language: "en-US", title: "" }] }, "listing_field_empty"],
      [{ ...ok, listings: [{ language: "en-US" }] }, "listing_field_missing"],
      [{ ...ok, listings: [{ language: "en-US", title: "a" }, { language: "en-US", title: "b" }] }, "listing_language_duplicate"],
      [{ ...ok, listings: [{ language: "zh-Hans", title: "a" }] }, "listing_language_unsupported"],
      [{ ...ok, listings: [] }, "listing_request_invalid"],
      [{ ...ok, changes_not_sent_for_review: "yes" }, "listing_request_invalid"],
    ];
    for (const [body, code] of cases) {
      expect(() => normalizeStoreListingPush(body), code).toThrow(expect.objectContaining({ failureCode: code }));
    }
    // Limits count code points: 30 CJK characters fit the 30-character title.
    expect(() => normalizeStoreListingPush({ ...ok, listings: [{ language: "zh-CN", title: "筏".repeat(30) }] })).not.toThrow();
    // video may be cleared.
    expect(normalizeStoreListingPush({ ...ok, listings: [{ language: "en-US", video: "" }] }).listings[0]).toEqual({ language: "en-US", video: "" });
  });
});

describe("store listing routes", () => {
  it("dry-runs through the adapter, returns the plan, and appends an immutable receipt", async () => {
    const h = await harness();
    let seen: PushInput | null = null;
    h.env.PLAY_RELEASE_SERVICE = adapter({ pushStoreListings: async (input) => { seen = input; return adapter().pushStoreListings(input); } });
    const response = await h.pushBody({ mode: "dry_run", listings: [{ language: "ja-JP", title: "Raft JP" }] });
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, any>;
    expect(body).toMatchObject({ mode: "dry_run", outcome: "validated", edit_id: "edit-1", package_name: "build.raft.app" });
    expect(body.changes[0]).toMatchObject({ language: "ja-JP", action: "update", changed_fields: ["title"], after: { title: "Raft JP" } });
    expect(seen).toMatchObject({ packageName: "build.raft.app", mode: "dry_run", deleteUnlistedLanguages: false, changesNotSentForReview: false, listings: [{ language: "ja-JP", title: "Raft JP" }] });
    expect(seen!.credential.client_email).toBe("app@example.iam.gserviceaccount.com");
    const [receipt] = h.receipts();
    expect(receipt).toMatchObject({ id: body.receipt_id, mode: "dry_run", verdict: "validated", play_edit_id: "edit-1", created_by: "raft:agent@test", languages_json: '["ja-JP"]' });
    const payload = JSON.parse(String(receipt!.payload_json));
    expect(payload.play.edit_disposition).toBe("deleted");
    expect(payload.changes[0].after.title).toEqual({ sha256: expect.stringMatching(/^[0-9a-f]{64}$/), chars: 7 });
    // The text itself is not persisted, and no credential is.
    expect(String(receipt!.payload_json)).not.toContain("Raft JP");
    expect(String(receipt!.payload_json)).not.toContain("PRIVATE KEY");
    expect(() => h.sqlite.prepare("UPDATE play_store_listing_receipts SET verdict='committed'").run()).toThrow(/immutable/);
    expect(() => h.sqlite.prepare("DELETE FROM play_store_listing_receipts").run()).toThrow(/immutable/);
    expect(h.sqlite.prepare("SELECT COUNT(*) AS n FROM play_store_listing_locks").get()).toEqual({ n: 0 });
  });

  it("commits with the opt-in flag passed through and lists receipts", async () => {
    const h = await harness({ principal: "human" });
    const response = await h.pushBody({ mode: "commit", changes_not_sent_for_review: true, listings: [{ language: "en-US", title: "Raft" }] });
    expect(await response.json()).toMatchObject({ outcome: "committed", changes_not_sent_for_review: true });
    const list = await (await h.request("/api/apps/app/distributions/play/store-listing/receipts")).json() as { receipts: any[] };
    expect(list.receipts).toHaveLength(1);
    expect(list.receipts[0]).toMatchObject({ verdict: "committed", mode: "commit", payload: { play: { edit_disposition: "committed", changes_not_sent_for_review: true } } });
  });

  it("rejects unsupported languages before any Play call, naming the Play tag", async () => {
    const h = await harness();
    const response = await h.pushBody({ mode: "commit", listings: [{ language: "zh-Hans", title: "筏" }, { language: "en", title: "Raft" }] });
    expect(response.status).toBe(400);
    const body = await response.json() as { error: Record<string, any> };
    expect(body.error).toMatchObject({ code: "gate_failed", failure_code: "listing_language_unsupported" });
    expect(body.error.message).toContain("zh-Hans (did you mean zh-CN?)");
    expect(body.error.unsupported).toEqual([{ language: "zh-Hans", suggestion: "zh-CN" }, { language: "en", suggestion: "en-US" }]);
    expect(h.receipts()).toEqual([]);
  });

  it("surfaces EDIT_IN_REVIEW as 409 edit_in_review with a failed-closed receipt", async () => {
    const h = await harness();
    h.env.PLAY_RELEASE_SERVICE = adapter({ pushStoreListings: async () => ({ ok: false, error: {
      status: 409, code: "play_edit_in_review", message: "Another change for this app is in review on Google Play",
      cause: { stage: "commit_edit", provider_cause: "EDIT_IN_REVIEW", extra: "dropped" } as never,
    } }) });
    const response = await h.pushBody({ mode: "commit", listings: [{ language: "en-US", title: "Raft" }] });
    expect(response.status).toBe(409);
    const body = await response.json() as { error: Record<string, any> };
    expect(body.error).toMatchObject({ code: "edit_in_review", failure_code: "play_edit_in_review", cause: { stage: "commit_edit", provider_cause: "EDIT_IN_REVIEW" } });
    const [receipt] = h.receipts();
    expect(receipt).toMatchObject({ id: body.error.receipt_id, verdict: "failed-closed", play_edit_id: null });
    const payload = JSON.parse(String(receipt!.payload_json));
    expect(payload.result).toEqual({ status: "failed-closed", failure_code: "play_edit_in_review", cause: { stage: "commit_edit", provider_cause: "EDIT_IN_REVIEW" } });
  });

  it("reports an unrecognised commit answer as 502 edit_state_unknown with a failed-closed receipt", async () => {
    const h = await harness();
    const tried = ["structured:/NOT_?SENT_?FOR_?REVIEW/i -> CHANGES_NOT_SENT_FOR_REVIEW", "text:/in review/i -> EDIT_IN_REVIEW"];
    h.env.PLAY_RELEASE_SERVICE = adapter({ pushStoreListings: async () => ({ ok: false, error: {
      status: 502, code: "play_edit_state_unknown", message: "Google Play answered the commit in a way Hands does not recognise",
      cause: { stage: "commit_edit", provider_cause: "OTHER", message_sha256: "a".repeat(64), message_length: 47, tried: [...tried, "Google: Für diese App…"], provider_text: "Für diese App…" } as never,
    } }) });
    const response = await h.pushBody({ mode: "commit", listings: [{ language: "en-US", title: "Raft" }] });
    expect(response.status).toBe(502);
    const body = await response.json() as { error: Record<string, any> };
    const cause = { stage: "commit_edit", provider_cause: "OTHER", message_sha256: "a".repeat(64), message_length: 47, tried };
    expect(body.error).toMatchObject({ code: "edit_state_unknown", failure_code: "play_edit_state_unknown", cause });
    expect(JSON.stringify(body)).not.toContain("Für");
    const [receipt] = h.receipts();
    expect(receipt).toMatchObject({ verdict: "failed-closed" });
    expect(JSON.parse(String(receipt!.payload_json)).result).toEqual({ status: "failed-closed", failure_code: "play_edit_state_unknown", cause });
  });

  it("shares the package edit lock with promote", async () => {
    const h = await harness();
    h.sqlite.pragma("foreign_keys = OFF");
    h.sqlite.prepare(`INSERT INTO play_edit_locks (app_id, package_name, release_id, operation_id, acquired_by, acquired_at)
      VALUES ('app', 'build.raft.app', 'r', 'promote-op', 'x', ?)`).run(Date.now());
    const response = await h.pushBody({ mode: "dry_run", listings: [{ language: "en-US", title: "Raft" }] });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "edit_conflict", failure_code: "play_edit_locked" } });
  });

  it("requires publisher, an authenticated human or agent, and a verified binding", async () => {
    const viewer = await harness({ role: "viewer" });
    expect((await viewer.pushBody({ mode: "dry_run", listings: [{ language: "en-US", title: "Raft" }] })).status).toBe(403);
    expect((await viewer.request("/api/apps/app/distributions/play/store-listing")).status).toBe(403);
    const unbound = await harness({ bind: false });
    const response = await unbound.pushBody({ mode: "dry_run", listings: [{ language: "en-US", title: "Raft" }] });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { failure_code: "play_binding_not_ready" } });
  });

  it("reads the live listing as Google Listing resources", async () => {
    const h = await harness();
    const response = await h.request("/api/apps/app/distributions/play/store-listing");
    expect(await response.json()).toEqual({
      package_name: "build.raft.app", default_language: "en-US",
      listings: [{ language: "en-US", title: "Raft", shortDescription: "s", fullDescription: "f" }],
    });
  });

  it("documents the routes in OpenAPI", () => {
    const paths = (openApiDocument as unknown as { paths: Record<string, Record<string, unknown>> }).paths;
    expect(paths["/api/apps/{appId}/distributions/play/store-listing"]?.get).toBeDefined();
    expect(paths["/api/apps/{appId}/distributions/play/store-listing"]?.post).toBeDefined();
    expect(paths["/api/apps/{appId}/distributions/play/store-listing/receipts"]?.get).toBeDefined();
  });
});

const fixtureDir = fileURLToPath(new URL("./fixtures/play-images/", import.meta.url));
/** Real designer exports (play/phone/en/06-home.png, play/feature-graphic/en/feature-graphic.png). */
const PHONE = new Uint8Array(readFileSync(`${fixtureDir}phone-1080x1920.png`));
const FEATURE = new Uint8Array(readFileSync(`${fixtureDir}feature-graphic-1024x500.png`));
const hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Header-only PNG: signature, IHDR, optional tRNS, IDAT. CRCs are not checked by the sniffer. */
function png(width: number, height: number, colorType: number, trns = false): Uint8Array {
  const chunk = (type: string, data: number[]) => {
    const length = [24, 16, 8, 0].map((shift) => (data.length >>> shift) & 0xff);
    return [...length, ...[...type].map((ch) => ch.charCodeAt(0)), ...data, 0, 0, 0, 0];
  };
  const be = (n: number) => [24, 16, 8, 0].map((shift) => (n >>> shift) & 0xff);
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk("IHDR", [...be(width), ...be(height), 8, colorType, 0, 0, 0]),
    ...(trns ? chunk("tRNS", [0, 0, 0, 0, 0, 0]) : []),
    ...chunk("IDAT", [0]),
  ]);
}

function jpeg(width: number, height: number): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x0b, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x01, 0x01, 0x11, 0x00]);
}

describe("Play image constraints", () => {
  it("reads the real designer exports as 24-bit PNGs with their pixel sizes", () => {
    expect(sniffImage(PHONE)).toEqual({ format: "png", contentType: "image/png", width: 1080, height: 1920, alpha: false, pngDepth: 24 });
    expect(sniffImage(FEATURE)).toMatchObject({ width: 1024, height: 500, alpha: false, pngDepth: 24 });
    expect(sniffImage(jpeg(1920, 1080))).toMatchObject({ format: "jpeg", width: 1920, height: 1080 });
    expect(sniffImage(new TextEncoder().encode("GIF89a...."))).toBeNull();
  });

  it("applies Play's documented per-type rules", () => {
    expect(() => checkImage("phoneScreenshots", PHONE, "p")).not.toThrow();
    expect(() => checkImage("tenInchScreenshots", PHONE, "p")).not.toThrow();
    expect(() => checkImage("featureGraphic", FEATURE, "f")).not.toThrow();
    const code = (fn: () => unknown) => { try { fn(); return null; } catch (error) { return (error as { failureCode: string }).failureCode; } };
    // 1024x500 is wider than 2:1, so it cannot be a screenshot.
    expect(code(() => checkImage("phoneScreenshots", FEATURE, "f"))).toBe("image_dimensions_invalid");
    expect(code(() => checkImage("featureGraphic", PHONE, "p"))).toBe("image_dimensions_invalid");
    expect(code(() => checkImage("phoneScreenshots", png(300, 600, 2), "s"))).toBe("image_dimensions_invalid");
    expect(code(() => checkImage("phoneScreenshots", png(2000, 3841, 2), "s"))).toBe("image_dimensions_invalid");
    expect(code(() => checkImage("phoneScreenshots", png(1080, 1920, 6), "s"))).toBe("image_format_unsupported");
    expect(code(() => checkImage("phoneScreenshots", png(1080, 1920, 2, true), "s"))).toBe("image_format_unsupported");
    expect(code(() => checkImage("phoneScreenshots", jpeg(1080, 1920), "s"))).toBeNull();
    // Icon: 32-bit PNG with alpha, 512x512, at most 1024 KB.
    expect(code(() => checkImage("icon", png(512, 512, 6), "i"))).toBeNull();
    expect(code(() => checkImage("icon", png(512, 512, 2), "i"))).toBe("image_format_unsupported");
    expect(code(() => checkImage("icon", jpeg(512, 512), "i"))).toBe("image_format_unsupported");
    expect(code(() => checkImage("icon", png(1024, 1024, 6), "i"))).toBe("image_dimensions_invalid");
    expect(code(() => checkImage("tvBanner", png(1280, 720, 2), "t"))).toBeNull();
    expect(code(() => checkImage("wearScreenshots", png(384, 384, 2), "w"))).toBeNull();
    expect(code(() => checkImage("wearScreenshots", png(384, 400, 2), "w"))).toBe("image_dimensions_invalid");
    expect(code(() => checkImage("appImageTypeUnspecified", PHONE, "u"))).toBe("image_type_not_supported");
    expect(PLAY_IMAGE_TYPES).toHaveLength(9);
  });
});

describe("store listing images route", () => {
  function multipart(request: unknown, files: Record<string, Uint8Array>) {
    const form = new FormData();
    form.append("request", JSON.stringify(request));
    for (const [name, bytes] of Object.entries(files)) form.append(name, new Blob([bytes], { type: "image/png" }), `${name}.png`);
    return form;
  }
  const phoneSet = {
    language: "en-US", imageType: "phoneScreenshots",
    images: [{ part: "p1", sha256: hex(PHONE), aiGeneratedState: "aiGeneratedStateNotAiGenerated" }, { part: "p2", sha256: hex(PHONE) }],
  };
  const featureSet = { language: "en-US", imageType: "featureGraphic", images: [{ part: "f1", sha256: hex(FEATURE) }] };

  it("dry-runs real screenshots + feature graphic with the text in one adapter call and records each image", async () => {
    const h = await harness();
    let seen: PushInput | null = null;
    h.env.PLAY_RELEASE_SERVICE = adapter({ pushStoreListings: async (input) => {
      seen = input;
      return { ok: true, value: {
        edit_id: "edit-9", package_name: input.packageName, mode: input.mode, outcome: "validated", default_language: "en-US",
        changes_not_sent_for_review: false, changes: [],
        image_changes: input.images!.map((set) => ({ language: set.language, imageType: set.imageType, action: "replace" as const, before: [],
          // Google reports a different sha256 for the first phone screenshot: a warning, not a failure.
          after: set.images.map((image, i) => {
            const differs = set.imageType === "phoneScreenshots" && i === 0;
            return { id: `img-${i}`, sha256: image.sha256, provider_sha256: differs ? "f".repeat(64) : image.sha256, sha256_match: !differs,
              size_bytes: image.bytes.byteLength, aiGeneratedState: image.aiGeneratedState ?? null };
          }) })),
      } };
    } });
    const response = await h.request("/api/apps/app/distributions/play/store-listing", {
      method: "POST",
      body: multipart({ mode: "dry_run", listings: [{ language: "en-US", title: "Raft" }], images: [phoneSet, featureSet] }, { p1: PHONE, p2: PHONE, f1: FEATURE }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, any>;
    expect(body.image_changes.map((c: any) => [c.imageType, c.action, c.after.length])).toEqual([["phoneScreenshots", "replace", 2], ["featureGraphic", "replace", 1]]);
    expect(body.image_warnings).toEqual([{ code: "provider_sha256_mismatch", language: "en-US", imageType: "phoneScreenshots", index: 0 }]);
    expect(seen!.listings).toEqual([{ language: "en-US", title: "Raft" }]);
    expect(seen!.images!.map((set) => [set.imageType, set.images.map((i) => [i.contentType, i.bytes.byteLength, i.aiGeneratedState ?? null])])).toEqual([
      ["phoneScreenshots", [["image/png", PHONE.byteLength, "aiGeneratedStateNotAiGenerated"], ["image/png", PHONE.byteLength, null]]],
      ["featureGraphic", [["image/png", FEATURE.byteLength, null]]],
    ]);
    const payload = JSON.parse(String(h.receipts()[0]!.payload_json));
    expect(payload.requested.images[1]).toEqual({ language: "en-US", imageType: "featureGraphic", images: [{
      sha256: hex(FEATURE), size_bytes: FEATURE.byteLength, content_type: "image/png", width: 1024, height: 500, aiGeneratedState: null,
    }] });
    expect(payload.image_changes[0].after[0]).toEqual({
      id: "img-0", sha256: hex(PHONE), provider_sha256: "f".repeat(64), sha256_match: false,
      size_bytes: PHONE.byteLength, aiGeneratedState: "aiGeneratedStateNotAiGenerated",
    });
    expect(payload.image_warnings).toEqual(body.image_warnings);
    expect(h.receipts()[0]).toMatchObject({ verdict: "validated" });
  });

  it("rejects images that break Play's rules before any adapter call", async () => {
    const h = await harness();
    const cases: Array<[unknown, Record<string, Uint8Array>, string]> = [
      [{ ...featureSet, images: [{ part: "f1", sha256: hex(PHONE) }] }, { f1: PHONE }, "image_dimensions_invalid"],
      [{ ...phoneSet, images: [phoneSet.images[0]] }, { p1: PHONE }, "image_count_invalid"],
      [{ ...featureSet, imageType: "appImageTypeUnspecified" }, { f1: FEATURE }, "image_type_not_supported"],
      [{ ...featureSet, imageType: "promoGraphic" }, { f1: FEATURE }, "image_type_invalid"],
      [{ ...featureSet, language: "zh-Hans" }, { f1: FEATURE }, "listing_language_unsupported"],
      [featureSet, { f1: PHONE }, "image_integrity_mismatch"],
      [featureSet, { f1: FEATURE, extra: FEATURE }, "image_request_invalid"],
      [featureSet, {}, "image_part_missing"],
      [{ ...featureSet, images: [{ ...featureSet.images[0], aiGeneratedState: "yes" }] }, { f1: FEATURE }, "image_ai_generated_state_invalid"],
    ];
    for (const [set, files, code] of cases) {
      const response = await h.request("/api/apps/app/distributions/play/store-listing", {
        method: "POST", body: multipart({ mode: "dry_run", images: [set] }, files),
      });
      expect(response.status, code).toBe(400);
      expect(await response.json(), code).toMatchObject({ error: { failure_code: code } });
    }
    expect(h.receipts()).toEqual([]);
  });

  it("fails closed when the adapter predates images", async () => {
    const h = await harness();
    h.env.PLAY_RELEASE_SERVICE = adapter({ pushStoreListings: async (input) => ({ ok: true, value: {
      edit_id: "e", package_name: input.packageName, mode: input.mode, outcome: "validated", default_language: "en-US",
      changes_not_sent_for_review: false, changes: [],
    } }) });
    const response = await h.request("/api/apps/app/distributions/play/store-listing", {
      method: "POST", body: multipart({ mode: "commit", images: [featureSet] }, { f1: FEATURE }),
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { failure_code: "play_images_not_acknowledged" } });
    expect(h.receipts()[0]).toMatchObject({ verdict: "failed-closed" });
  });
});
