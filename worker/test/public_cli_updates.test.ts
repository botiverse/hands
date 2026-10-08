import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import {
  handlePublicCliBinaryUpdateCheck,
  handlePublicCliBinaryVersions,
} from "../src/routes/public_v2";

function d1(sqlite: Database.Database) {
  return { prepare(sql: string) {
    const indexes: number[] = [];
    const statement = sqlite.prepare(sql.replace(/\?(\d+)/g, (_match, index) => { indexes.push(Number(index)); return "?"; }));
    const bind = (...values: unknown[]) => {
      const bound = indexes.length ? indexes.map((index) => values[index - 1]) : values;
      return {
        first: async <T>() => (statement.get(...bound) as T | undefined) ?? null,
        all: async <T>() => ({ results: statement.all(...bound) as T[] }),
        run: async () => ({ success: true, meta: { changes: statement.run(...bound).changes } }),
      };
    };
    return { bind, first: () => bind().first(), all: () => bind().all(), run: () => bind().run() };
  } };
}

describe("public cli-binary selection", () => {
  let sqlite: Database.Database;
  let env: { DB: ReturnType<typeof d1>; BUSINESS_ORIGIN: string };
  let app: Hono<{ Bindings: typeof env }>;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE apps (id TEXT PRIMARY KEY, slug TEXT, platform TEXT);
      CREATE TABLE channels (id TEXT PRIMARY KEY, app_id TEXT, slug TEXT);
      CREATE TABLE releases (id TEXT PRIMARY KEY, app_id TEXT, build_id TEXT, channel_id TEXT, product_type TEXT, release_type TEXT, status TEXT, hidden INTEGER, revision INTEGER, rollout_cohort_count INTEGER, activated_at INTEGER, availability_at INTEGER, created_at INTEGER, updated_at INTEGER);
      CREATE TABLE release_scopes (id TEXT PRIMARY KEY, release_id TEXT, scope_type TEXT, scope_value TEXT);
      CREATE TABLE builds (id TEXT PRIMARY KEY, app_id TEXT, status TEXT, version_name TEXT, version_code INTEGER, artifact_mode TEXT);
      CREATE TABLE external_build_targets (id TEXT PRIMARY KEY, build_id TEXT, target TEXT, raw_sha256 TEXT, raw_size_bytes INTEGER, gzip_sha256 TEXT, gzip_size_bytes INTEGER);
        CREATE TABLE build_assets (id TEXT PRIMARY KEY, build_id TEXT, platform TEXT, arch TEXT, variant TEXT, filetype TEXT, artifact_kind TEXT, r2_key TEXT, file_hash TEXT, size_bytes INTEGER, created_at INTEGER);
      INSERT INTO apps VALUES ('app', 'computer', 'desktop');
      INSERT INTO channels VALUES ('channel-main', 'app', 'main');
      INSERT INTO channels VALUES ('channel-alpha', 'app', 'alpha');
    `);
    env = { DB: d1(sqlite), BUSINESS_ORIGIN: "https://hands.example" };
    app = new Hono<{ Bindings: typeof env }>();
    app.get("/public/v2/apps/:slug/updates/check", handlePublicCliBinaryUpdateCheck as never);
    app.get("/public/v2/apps/:slug/versions", handlePublicCliBinaryVersions as never);
  });

  function seedRelease(id: string, version: string, status: string, activatedAt: number, options: { channel?: "main" | "alpha" | "latest"; sha256?: string; reuseArtifactFrom?: string; rolloutCohortCount?: number | null } = {}) {
    const source = options.reuseArtifactFrom ?? id;
    const buildId = `build-${source}`;
    const artifactId = `artifact-${source}`;
    const sha256 = options.sha256 ?? createHash("sha256").update(id).digest("hex");
    const channel = options.channel ?? "main";
    if (!options.reuseArtifactFrom) {
      sqlite.prepare("INSERT INTO builds VALUES (?, 'app', 'succeeded', ?, ?, 'hands_r2')").run(buildId, version, activatedAt);
      sqlite.prepare("INSERT INTO external_build_targets (id, build_id, target, raw_sha256, raw_size_bytes) VALUES (?, ?, 'linux-x64', ?, 8)").run(artifactId, buildId, sha256);
    }
    // `latest` is seeded as a real channel, not an alias, so the shadowing rule
    // can be exercised with both a genuine `latest` and `main` present.
    if (channel === "latest") {
      sqlite.prepare("INSERT OR IGNORE INTO channels VALUES ('channel-latest', 'app', 'latest')").run();
    }
    sqlite.prepare("INSERT INTO releases VALUES (?, 'app', ?, ?, 'cli-binary', 'stable', ?, 0, 1, ?, ?, NULL, ?, ?)")
      .run(id, buildId, `channel-${channel}`, status, options.rolloutCohortCount ?? null, activatedAt, activatedAt, activatedAt);
    sqlite.prepare("INSERT INTO release_scopes VALUES (?, ?, 'full', 'all')").run(`scope-${id}`, id);
  }

  /**
   * Seed a release whose bytes are hosted by Hands (build_assets) rather than declared as an
   * external target. This is the case the pinned surfaces previously could not select.
   */
  function seedHostedRelease(id: string, version: string, status: string, activatedAt: number, options: { channel?: "main" | "alpha"; sha256?: string } = {}) {
    const buildId = `build-${id}`;
    const sha256 = options.sha256 ?? createHash("sha256").update(`hosted-${id}`).digest("hex");
    const channel = options.channel ?? "main";
    sqlite.prepare("INSERT INTO builds VALUES (?, 'app', 'succeeded', ?, ?, 'hands_r2')").run(buildId, version, activatedAt);
    sqlite.prepare(
      "INSERT INTO build_assets (id, build_id, platform, arch, variant, filetype, artifact_kind, r2_key, file_hash, size_bytes, created_at) VALUES (?, ?, 'linux', 'x64', NULL, 'binary', 'installable', ?, ?, 4242, ?)",
    ).run(`asset-${id}`, buildId, `apps/app/${id}/linux-x64`, sha256, activatedAt);
    sqlite.prepare("INSERT INTO releases VALUES (?, 'app', ?, ?, 'cli-binary', 'stable', ?, 0, 1, ?, ?, NULL, ?, ?)")
      .run(id, buildId, `channel-${channel}`, status, null, activatedAt, activatedAt, activatedAt);
    sqlite.prepare("INSERT INTO release_scopes VALUES (?, ?, 'full', 'all')").run(`scope-${id}`, id);
    return sha256;
  }

  function check(extra = "") {
    return app.request(`https://hands.example/public/v2/apps/computer/updates/check?current_version=0.5.0&channel=main&platform=linux&arch=x64${extra}`, {}, env);
  }

  function versions(extra = "") {
    return app.request(`https://hands.example/public/v2/apps/computer/versions?channel=alpha&platform=linux&arch=x64${extra}`, {}, env);
  }

  it("resolves the `latest` channel alias to main and echoes the canonical channel", async () => {
    seedRelease("r1", "1.0.0", "active", 100);
    seedRelease("a1", "1.1.0", "active", 200, { channel: "alpha" });
    const viaMain = await app.request("https://hands.example/public/v2/apps/computer/updates/check?current_version=0.5.0&channel=main&platform=linux&arch=x64", {}, env);
    const viaAlias = await app.request("https://hands.example/public/v2/apps/computer/updates/check?current_version=0.5.0&channel=latest&platform=linux&arch=x64", {}, env);
    expect(viaAlias.status).toBe(200);
    const mainBody = await viaMain.json() as { release: { id: string; channel: string } };
    const aliasBody = await viaAlias.json() as { release: { id: string; channel: string } };
    // Same release as main (not alpha), and the echoed channel stays canonical.
    expect(aliasBody).toEqual(mainBody);
    expect(aliasBody.release.id).toBe("r1");
    expect(aliasBody.release.channel).toBe("main");

    const versionsMain = await app.request("https://hands.example/public/v2/apps/computer/versions?channel=main&platform=linux&arch=x64", {}, env);
    const versionsAlias = await app.request("https://hands.example/public/v2/apps/computer/versions?channel=latest&platform=linux&arch=x64", {}, env);
    expect(versionsAlias.status).toBe(200);
    const versionsAliasBody = await versionsAlias.json() as { channel: string };
    expect(versionsAliasBody).toEqual(await versionsMain.json());
    expect(versionsAliasBody.channel).toBe("main");
  });

  it("an alias never invents a channel: unknown names still answer channel_not_found", async () => {
    seedRelease("r1", "1.0.0", "active", 100);
    // `versions` looks the channel up by slug and 404s when it is missing; an
    // unknown name must take that path unchanged (aliases only map known names).
    const res = await app.request("https://hands.example/public/v2/apps/computer/versions?channel=nightly&platform=linux&arch=x64", {}, env);
    expect(res.status).toBe(404);
    expect((await res.json() as { code: string }).code).toBe("channel_not_found");
  });

  it("an alias whose canonical channel does not exist still answers channel_not_found", async () => {
    sqlite.prepare("DELETE FROM channels WHERE slug = 'main'").run();
    seedRelease("r1", "1.0.0", "active", 100, { channel: "alpha" });
    const res = await app.request(
      "https://hands.example/public/v2/apps/computer/updates/check?current_version=0.5.0&channel=latest&platform=linux&arch=x64",
      {},
      env,
    );
    expect(res.status).toBe(404);
  });

  it("a real channel named like an alias wins over the alias (no shadowing)", async () => {
    // Channel slugs are not validated at creation, so an app owner can create a
    // genuine `latest` channel. The alias must not silently redirect to `main`.
    // `seedRelease` seeds `latest` as a real channel when asked for it.
    seedRelease("r-main", "1.0.0", "active", 100);
    seedRelease("r-latest", "9.9.9", "active", 200, { channel: "latest" });

    const viaLatest = await app.request(
      "https://hands.example/public/v2/apps/computer/updates/check?current_version=0.5.0&channel=latest&platform=linux&arch=x64",
      {},
      env,
    );
    expect(viaLatest.status).toBe(200);
    const latestBody = await viaLatest.json() as { release: { id: string; channel: string } };
    expect(latestBody.release.id).toBe("r-latest");
    expect(latestBody.release.channel).toBe("latest");

    const versionsRes = await app.request(
      "https://hands.example/public/v2/apps/computer/versions?channel=latest&platform=linux&arch=x64",
      {},
      env,
    );
    expect(versionsRes.status).toBe(200);
    const versionsBody = await versionsRes.json() as { channel: string; versions: Array<{ version: string }> };
    expect(versionsBody.channel).toBe("latest");
    expect(versionsBody.versions.map((v) => v.version)).toEqual(["9.9.9"]);

    // Without a real `latest` channel the alias still resolves to main.
    sqlite.prepare("DELETE FROM channels WHERE slug = 'latest'").run();
    const fallback = await app.request(
      "https://hands.example/public/v2/apps/computer/updates/check?current_version=0.5.0&channel=latest&platform=linux&arch=x64",
      {},
      env,
    );
    expect(fallback.status).toBe(200);
    const fallbackBody = await fallback.json() as { release: { id: string; channel: string } };
    expect(fallbackBody.release.id).toBe("r-main");
    expect(fallbackBody.release.channel).toBe("main");
  });

  it("advertises only a complete gzip representation for the selected release", async () => {
    seedRelease("r1", "1.0.0", "active", 100);
    const plain = await (await check()).json() as { artifact: Record<string, unknown> };
    expect(plain.artifact).not.toHaveProperty("gzip");
    sqlite.prepare("UPDATE external_build_targets SET gzip_sha256 = ?, gzip_size_bytes = 4").run("c".repeat(64));
    const compressed = await (await check()).json() as { artifact: Record<string, unknown> };
    expect(compressed.artifact).toMatchObject({
      size_bytes: 8, sha256: createHash("sha256").update("r1").digest("hex"),
      gzip: { sha256: "c".repeat(64), size_bytes: 4,
        download_url: "https://hands.example/dl/computer/releases/r1/linux-x64.gz" },
    });
    sqlite.prepare("UPDATE external_build_targets SET gzip_size_bytes = NULL").run();
    expect((await (await check()).json() as { artifact: object }).artifact).not.toHaveProperty("gzip");
  });

  it("selects an exact pinned active version", async () => {
    seedRelease("r1", "1.0.0", "active", 100);
    seedRelease("r2", "2.0.0", "active", 200);
    const response = await check("&version=1.0.0");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ release: { id: "r1", version: "1.0.0" } });
  });

  it("selects an exact pinned superseded version while cancelled remains unavailable", async () => {
    seedRelease("old", "1.0.0", "superseded", 100, { channel: "alpha" });
    seedRelease("cancelled", "0.9.0", "cancelled", 90, { channel: "alpha" });

    const old = await check("&version=1.0.0");
    expect(old.status).toBe(200);
    await expect(old.json()).resolves.toMatchObject({ release: { id: "old", version: "1.0.0" } });

    const cancelled = await check("&version=0.9.0");
    expect(cancelled.status).toBe(404);
    await expect(cancelled.json()).resolves.toMatchObject({ code: "UPDATE_NO_COMPATIBLE_ARTIFACT" });
  });

  it("never exposes a draft through a pinned request", async () => {
    seedRelease("draft", "3.0.0", "draft", 300);
    const response = await check("&version=3.0.0&device_id=attacker-controlled");
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "UPDATE_NO_COMPATIBLE_ARTIFACT" });
  });

  it("rejects malformed active ledger integrity", async () => {
    seedRelease("drift", "1.0.0", "active", 100);
    sqlite.prepare("UPDATE external_build_targets SET raw_sha256 = 'bad' WHERE id = 'artifact-drift'").run();
    const response = await check();
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "UPDATE_IDENTITY_DRIFT" });
  });

  it("allows an exact pin that exists only on alpha", async () => {
    // Contract: a pinned lookup is not restricted to the channel named in the
    // request. It collects candidates by version/target across eligible
    // channels, and the response reports the channel the release actually lives
    // on rather than the one asked for. See the pinned-request contract comment
    // in handlePublicCliBinaryUpdateCheck.
    seedRelease("alpha-only", "4.0.0", "active", 400, { channel: "alpha" });
    const response = await check("&version=4.0.0");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      release: { id: "alpha-only", channel: "alpha", version: "4.0.0" },
    });
  });

  it("prefers main when cross-channel artifact identity matches", async () => {
    // Byte-identical duplicates are not a divergence: the identity set has one
    // member, so the request resolves normally and the ordering picks main.
    // This is what makes the divergence test below meaningful.
    const sha256 = "b".repeat(64);
    seedRelease("alpha", "5.0.0", "active", 500, { channel: "alpha", sha256 });
    seedRelease("main", "5.0.0", "active", 500, { channel: "main", reuseArtifactFrom: "alpha" });
    const response = await check("&version=5.0.0");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ release: { channel: "main", version: "5.0.0" } });
  });

  it("fails closed when a pinned cross-channel artifact diverges", async () => {
    seedRelease("alpha", "6.0.0", "active", 600, { channel: "alpha", sha256: "c".repeat(64) });
    seedRelease("main", "6.0.0", "active", 601, { channel: "main", sha256: "d".repeat(64) });
    const response = await check("&version=6.0.0");
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "UPDATE_IDENTITY_CONFLICT" });
  });

  it("lists active and superseded target-compatible versions newest first", async () => {
    seedRelease("old", "1.0.0", "superseded", 100, { channel: "alpha" });
    seedRelease("latest", "2.0.0", "active", 200, { channel: "alpha" });
    seedRelease("cancelled", "0.9.0", "cancelled", 90, { channel: "alpha" });
    seedRelease("draft", "3.0.0", "draft", 300, { channel: "alpha" });

    const response = await versions();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      schema_version: 1,
      app: { slug: "computer" },
      channel: "alpha",
      target: { platform: "linux", arch: "x64" },
      truncated: false,
      versions: [
        { version: "2.0.0", status: "active", release_id: "latest", published_at: 200 },
        { version: "1.0.0", status: "superseded", release_id: "old", published_at: 100 },
      ],
    });
  });

  it("excludes partial-rollout rows that are not universally installable", async () => {
    seedRelease("partial-active", "3.0.0", "active", 300, {
      channel: "alpha",
      rolloutCohortCount: 50,
    });
    seedRelease("partial-superseded", "2.0.0", "superseded", 200, {
      channel: "alpha",
      rolloutCohortCount: 25,
    });
    seedRelease("universal", "1.0.0", "superseded", 100, {
      channel: "alpha",
      rolloutCohortCount: 100,
    });

    const response = await versions();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      truncated: false,
      versions: [{ version: "1.0.0", release_id: "universal" }],
    });

    const pinnedPartial = await check("&version=3.0.0");
    expect(pinnedPartial.status).toBe(200);
    await expect(pinnedPartial.json()).resolves.toMatchObject({
      update_available: false,
      current_version: "0.5.0",
    });
  });

  it("returns an empty complete list for a real channel with no public versions", async () => {
    const response = await versions();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      schema_version: 1,
      channel: "alpha",
      truncated: false,
      versions: [],
    });
  });

  it("fails closed on malformed limits and malformed listed integrity", async () => {
    const invalidLimit = await versions("&limit=0");
    expect(invalidLimit.status).toBe(400);
    await expect(invalidLimit.json()).resolves.toMatchObject({ code: "VERSIONS_LIMIT_INVALID" });

    seedRelease("drift", "1.0.0", "active", 100, { channel: "alpha" });
    sqlite.prepare("UPDATE external_build_targets SET raw_sha256 = 'bad' WHERE id = 'artifact-drift'").run();
    const drift = await versions();
    expect(drift.status).toBe(409);
    await expect(drift.json()).resolves.toMatchObject({ code: "VERSION_IDENTITY_DRIFT" });
  });

  it("fails closed when duplicate channel versions have divergent target identities", async () => {
    seedRelease("first", "1.0.0", "superseded", 100, { channel: "alpha", sha256: "a".repeat(64) });
    seedRelease("second", "1.0.0", "active", 200, { channel: "alpha", sha256: "b".repeat(64) });

    const response = await versions();
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "VERSION_IDENTITY_CONFLICT" });
  });

  it("reports truncation after deduplicating exact version identities", async () => {
    seedRelease("old-a", "1.0.0", "superseded", 100, { channel: "alpha", sha256: "a".repeat(64) });
    seedRelease("old-b", "1.0.0", "superseded", 101, { channel: "alpha", reuseArtifactFrom: "old-a" });
    seedRelease("latest", "2.0.0", "active", 200, { channel: "alpha" });

    const response = await versions("&limit=1");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      truncated: true,
      versions: [{ version: "2.0.0" }],
    });
  });

  it("pinned lookup selects a Hands-hosted build and reports its hosted identity", async () => {
    const sha = seedHostedRelease("h1", "1.0.0", "active", 100);
    const res = await check("&version=1.0.0");
    expect(res.status).toBe(200);
    const body = await res.json() as { release: { id: string }; artifact: { sha256: string; size_bytes: number; download_url: string } };
    expect(body.release.id).toBe("h1");
    expect(body.artifact.sha256).toBe(sha);
    expect(body.artifact.size_bytes).toBe(4242);
    // The pinned surface hands out the immutable release-bound route, never a signed URL:
    // a client that pinned a release may refetch it after a signature would have expired.
    expect(body.artifact.download_url).toBe("https://hands.example/dl/computer/releases/h1/linux-x64");
  });

  it("both pinned surfaces resolve a hosted build identically", async () => {
    const sha = seedHostedRelease("h1", "1.0.0", "active", 100, { channel: "alpha" });
    const viaCheck = await check("&version=1.0.0");
    const viaVersions = await versions();
    expect(viaCheck.status).toBe(200);
    expect(viaVersions.status).toBe(200);
    const checkBody = await viaCheck.json() as { artifact: { sha256: string; size_bytes: number; download_url: string } };
    const versionsBody = await viaVersions.json() as { versions: Array<{ version: string; sha256: string; size_bytes: number }> };
    const listed = versionsBody.versions.find((v) => v.version === "1.0.0");
    expect(listed).toBeDefined();

    // The two surfaces have different response shapes by design (updates/check answers with one
    // artifact, versions lists many), so "aligned" is asserted on the identity they share: the
    // same hosted build must resolve to the same digest and size on both. Asserting a whole-object
    // equality would only be testing the shape difference, which is not what this change is about.
    expect(listed!.sha256).toBe(sha);
    expect(listed!.sha256).toBe(checkBody.artifact.sha256);
    expect(listed!.size_bytes).toBe(checkBody.artifact.size_bytes);
  });

  it("a hosted build uses the same download route shape as an external one", async () => {
    seedRelease("e1", "1.0.0", "active", 100, { sha256: "a".repeat(64) });
    const externalBody = await (await check("&version=1.0.0")).json() as { artifact: { download_url: string } };
    expect(externalBody.artifact.download_url).toBe("https://hands.example/dl/computer/releases/e1/linux-x64");

    sqlite.exec("DELETE FROM releases; DELETE FROM release_scopes; DELETE FROM external_build_targets;");
    seedHostedRelease("h2", "1.0.0", "active", 100);
    const hostedBody = await (await check("&version=1.0.0")).json() as { artifact: { download_url: string } };
    // Same shape, so a caller cannot tell the hosting mode from the URL.
    expect(hostedBody.artifact.download_url.replace("/h2/", "/e1/")).toBe(externalBody.artifact.download_url);
  });

  it("still answers 404 when neither hosting mode has an artifact for the target", async () => {
    sqlite.prepare("INSERT INTO builds VALUES ('build-empty', 'app', 'succeeded', '1.0.0', 100, 'hands_r2')").run();
      sqlite.prepare("INSERT INTO releases VALUES ('r-empty', 'app', 'build-empty', 'channel-main', 'cli-binary', 'stable', 'active', 0, 1, NULL, 100, NULL, 100, 100)").run();
    sqlite.prepare("INSERT INTO release_scopes VALUES ('scope-empty', 'r-empty', 'full', 'all')").run();
    const res = await check("&version=1.0.0");
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ code: "UPDATE_NO_COMPATIBLE_ARTIFACT" });
  });


  it("a sibling representation on the same target cannot hijack the pinned identity", async () => {
    // A hosted build may hold more than one installable row for one platform-arch: OHOS ships
    // an `appgallery` App Pack beside a `sideload` HAP, and #229 adds gzip / photon-wasm
    // representations next to the raw binary. The pinned surfaces must report the SAME asset
    // that the release-bound /dl URL serves, which is the variant-IS-NULL primary. Selecting
    // by `ORDER BY filetype` instead would depend on alphabetical accident - `app` sorts
    // before `hap`, so the App Pack would win and its digest would describe an object the
    // URL never returns.
    const primarySha = seedHostedRelease("h1", "1.0.0", "active", 100);
    // A sibling with a LOWER filetype would win any filetype-ordered pick, and one with a
    // HIGHER filetype must still lose to the primary. Seeding both directions makes the test
    // fail whichever way the resolver leans if it stops filtering on variant.
    sqlite.prepare(
      "INSERT INTO build_assets (id, build_id, platform, arch, variant, filetype, artifact_kind, r2_key, file_hash, size_bytes, created_at) VALUES (?, ?, 'linux', 'x64', 'z-sidecar', 'aaa', 'installable', ?, ?, 1111, ?)",
    ).run("asset-aaa", "build-h1", "apps/app/h1/linux-x64-aaa", "a".repeat(64), 100);
    sqlite.prepare(
      "INSERT INTO build_assets (id, build_id, platform, arch, variant, filetype, artifact_kind, r2_key, file_hash, size_bytes, created_at) VALUES (?, ?, 'linux', 'x64', 'gzip', 'zzz', 'installable', ?, ?, 2222, ?)",
    ).run("asset-zzz", "build-h1", "apps/app/h1/linux-x64-zzz", "b".repeat(64), 101);

    const res = await check("&version=1.0.0");
    expect(res.status).toBe(200);
    const body = await res.json() as { artifact: { sha256: string; size_bytes: number; download_url: string } };
    expect(body.artifact.sha256).toBe(primarySha);
    expect(body.artifact.size_bytes).toBe(4242);
    expect(body.artifact.download_url).toBe("https://hands.example/dl/computer/releases/h1/linux-x64");
  });

  it("the pinned surfaces stay aligned when a sibling exists, and /versions reports the same primary", async () => {
    const primarySha = seedHostedRelease("h1", "1.0.0", "active", 100, { channel: "alpha" });
    sqlite.prepare(
      "INSERT INTO build_assets (id, build_id, platform, arch, variant, filetype, artifact_kind, r2_key, file_hash, size_bytes, created_at) VALUES (?, ?, 'linux', 'x64', 'gzip', 'gz', 'installable', ?, ?, 3333, ?)",
    ).run("asset-gz", "build-h1", "apps/app/h1/linux-x64.gz", "c".repeat(64), 100);

    const viaCheck = await check("&version=1.0.0");
    const viaVersions = await versions();
    const checkBody = await viaCheck.json() as { artifact: { sha256: string; size_bytes: number } };
    const versionsBody = await viaVersions.json() as { versions: Array<{ version: string; sha256: string; size_bytes: number }> };
    const listed = versionsBody.versions.find((v) => v.version === "1.0.0");

    expect(checkBody.artifact.sha256).toBe(primarySha);
    expect(checkBody.artifact.size_bytes).toBe(4242);
    expect(listed!.sha256).toBe(primarySha);
    expect(listed!.size_bytes).toBe(4242);
  });



  it("advertises a hosted gzip sidecar with the compressed bytes' own digest", async () => {
    // #229: gzip is a separate REPRESENTATION of the same target, so its sha256/size describe
    // the COMPRESSED stream - not the raw binary. Advertising the raw digest under a gzip URL
    // would make the installer's post-download check fail on every valid payload.
    seedHostedRelease("h1", "1.0.0", "active", 100);
    const gzSha = "a".repeat(64);
    sqlite.prepare(
      "INSERT INTO build_assets (id, build_id, platform, arch, variant, filetype, artifact_kind, r2_key, file_hash, size_bytes, created_at) VALUES (?, ?, 'linux', 'x64', 'gzip', 'gz', 'installable', ?, ?, 1500, ?)",
    ).run("asset-gz", "build-h1", "apps/app/h1/linux-x64.gz", gzSha, 100);

    const res = await check("&version=1.0.0");
    expect(res.status).toBe(200);
    const body = await res.json() as { artifact: { sha256: string; size_bytes: number; gzip?: { sha256: string; size_bytes: number; download_url: string } } };
    // The raw identity must stay the primary's, and the gzip block must carry its own numbers.
    expect(body.artifact.sha256).not.toBe(gzSha);
    expect(body.artifact.size_bytes).toBe(4242);
    expect(body.artifact.gzip).toBeDefined();
    expect(body.artifact.gzip!.sha256).toBe(gzSha);
    expect(body.artifact.gzip!.size_bytes).toBe(1500);
    expect(body.artifact.gzip!.download_url).toBe("https://hands.example/dl/computer/releases/h1/linux-x64.gz");
  });

  it("advertises an optional hosted photon-wasm sidecar through its ?kind= address", async () => {
    seedHostedRelease("h1", "1.0.0", "active", 100);
    const wasmSha = "b".repeat(64);
    sqlite.prepare(
      "INSERT INTO build_assets (id, build_id, platform, arch, variant, filetype, artifact_kind, r2_key, file_hash, size_bytes, created_at) VALUES (?, ?, 'linux', 'x64', 'photon-wasm', 'wasm', 'installable', ?, ?, 900, ?)",
    ).run("asset-wasm", "build-h1", "apps/app/h1/linux-x64.wasm", wasmSha, 100);

    const res = await check("&version=1.0.0");
    expect(res.status).toBe(200);
    const body = await res.json() as { artifact: { sha256: string; photon_wasm?: { sha256: string; size_bytes: number; download_url: string } } };
    expect(body.artifact.photon_wasm).toBeDefined();
    expect(body.artifact.photon_wasm!.sha256).toBe(wasmSha);
    expect(body.artifact.photon_wasm!.size_bytes).toBe(900);
    // Without `?kind=` this URL would resolve the no-kind branch and serve the raw binary.
    expect(body.artifact.photon_wasm!.download_url).toBe(
      "https://hands.example/dl/computer/releases/h1/linux-x64?kind=photon-wasm",
    );
    // The primary identity is untouched by the presence of a sidecar.
    expect(body.artifact.sha256).not.toBe(wasmSha);
  });

  it("omits both sidecars when absent, and still answers normally", async () => {
    // @archer's contract: gzip and photon_wasm are OPTIONAL in updates/check, so a build with
    // neither must not fail the query. (Only the download surface is strict: `.gz` for a
    // missing gzip is a 4xx.)
    seedHostedRelease("h1", "1.0.0", "active", 100);
    sqlite.prepare(
      "INSERT INTO build_assets (id, build_id, platform, arch, variant, filetype, artifact_kind, r2_key, file_hash, size_bytes, created_at) VALUES (?, ?, 'linux', 'x64', 'gzip', 'gz', 'installable', ?, ?, 1500, ?)",
    ).run("asset-gz-other", "build-h1", "apps/app/h1/linux-x64.gz", "c".repeat(64), 100);
    // A gzip exists for a DIFFERENT target only; linux-x64 has none.
    sqlite.prepare("UPDATE build_assets SET platform = 'darwin' WHERE id = 'asset-gz-other'").run();

    const res = await check("&version=1.0.0");
    expect(res.status).toBe(200);
    const body = await res.json() as { artifact: { gzip?: unknown; photon_wasm?: unknown } };
    expect(body.artifact.gzip).toBeUndefined();
    expect(body.artifact.photon_wasm).toBeUndefined();
  });


  it("does not advertise hosted sidecars for a build that still declares external placement", async () => {
    // @archer's response-side requirement. A build being migrated to hosted placement can have
    // sidecar rows created BEFORE the placement flips. Advertising them while the build still
    // declares `external` would tell a client to fetch a representation that the download path
    // is (correctly) still resolving as external - the two surfaces would contradict each other.
    // The download 302 test cannot cover this: this is the RESPONSE, not the download.
    seedHostedRelease("h1", "1.0.0", "active", 100);
    sqlite.prepare("UPDATE builds SET artifact_mode = 'external' WHERE id = 'build-h1'").run();
    // Rows that exist but must not be advertised yet.
    sqlite.prepare(
      "INSERT INTO build_assets (id, build_id, platform, arch, variant, filetype, artifact_kind, r2_key, file_hash, size_bytes, created_at) VALUES (?, ?, 'linux', 'x64', 'gzip', 'gz', 'installable', ?, ?, 1500, ?)",
    ).run("x-gz", "build-h1", "apps/app/h1/linux-x64.gz", "9".repeat(64), 100);
    sqlite.prepare(
      "INSERT INTO build_assets (id, build_id, platform, arch, variant, filetype, artifact_kind, r2_key, file_hash, size_bytes, created_at) VALUES (?, ?, 'linux', 'x64', 'photon-wasm', 'wasm', 'installable', ?, ?, 900, ?)",
    ).run("x-wasm", "build-h1", "apps/app/h1/linux-x64.wasm", "8".repeat(64), 100);

    const res = await check("&version=1.0.0");
    const body = await res.json() as { artifact?: { gzip?: unknown; photon_wasm?: unknown } };
    // An external build resolves its identity through the declared columns; the hosted rows
    // must not leak into the response.
    if (body.artifact) {
      expect(body.artifact.gzip).toBeUndefined();
      expect(body.artifact.photon_wasm).toBeUndefined();
    }
  });

  it("advertises hosted sidecars once the build declares hosted placement", async () => {
    // The complement: after finalize the same rows ARE advertised. Together these pin the
    // rule to the declared mode rather than to the mere existence of rows.
    seedHostedRelease("h1", "1.0.0", "active", 100);
    sqlite.prepare("UPDATE builds SET artifact_mode = 'hands_r2' WHERE id = 'build-h1'").run();
    sqlite.prepare(
      "INSERT INTO build_assets (id, build_id, platform, arch, variant, filetype, artifact_kind, r2_key, file_hash, size_bytes, created_at) VALUES (?, ?, 'linux', 'x64', 'gzip', 'gz', 'installable', ?, ?, 1500, ?)",
    ).run("y-gz", "build-h1", "apps/app/h1/linux-x64.gz", "7".repeat(64), 100);
    sqlite.prepare(
      "INSERT INTO build_assets (id, build_id, platform, arch, variant, filetype, artifact_kind, r2_key, file_hash, size_bytes, created_at) VALUES (?, ?, 'linux', 'x64', 'photon-wasm', 'wasm', 'installable', ?, ?, 900, ?)",
    ).run("y-wasm", "build-h1", "apps/app/h1/linux-x64.wasm", "6".repeat(64), 100);

    const res = await check("&version=1.0.0");
    const body = await res.json() as { artifact?: { gzip?: { sha256: string }; photon_wasm?: { sha256: string } } };
    expect(body.artifact?.gzip?.sha256).toBe("7".repeat(64));
    expect(body.artifact?.photon_wasm?.sha256).toBe("6".repeat(64));
  });

});
