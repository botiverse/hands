/**
 * R8 mapping index: the first retrace of a mapping has the container stream
 * it and return a per-class index; later retraces read only the header and
 * the class blocks the trace names, by byte range, and send them inline.
 */
import { readdirSync, readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { indexMapping } from "../../container/src/retrace";
import { mappingIndexKey, rangesForTrace } from "../src/lib/r8_mapping_index";

const requests: Array<Record<string, unknown>> = [];
let containerIndex: string | undefined;

vi.mock("@cloudflare/containers", () => ({
  getRandom: async () => ({
    fetch: async (req: Request) => {
      requests.push(await req.json() as Record<string, unknown>);
      return Response.json({ retraced: "Stack trace:\njava.lang.IllegalStateException: boom\n\tat build.raft.app.Foo.run(Foo.kt:10)\n", ...(containerIndex ? { index: containerIndex } : {}) });
    },
  }),
}));

const { retraceCrashTicket } = await import("../src/routes/feedback");

const MIGRATION_DIR = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));

type BoundStatement = {
  _execute: () => { results: unknown[]; success: true; meta: { changes: number } };
  run: () => Promise<{ results: unknown[]; success: true; meta: { changes: number } }>;
  all: () => Promise<{ results: unknown[]; success: true; meta: { changes: number } }>;
  first: <T>() => Promise<T | null>;
};

function d1(db: Database.Database) {
  const prepare = (sql: string) => {
    const indexes: number[] = [];
    const normalized = sql.replace(/\?(\d+)/g, (_match, index) => {
      indexes.push(Number(index));
      return "?";
    });
    const statement = db.prepare(normalized);
    const bind = (...input: unknown[]): BoundStatement => {
      const params = (indexes.length > 0 ? indexes.map((index) => input[index - 1]) : input)
        .map((value) => value === undefined ? null : value);
      const execute = () => {
        if (statement.reader) {
          return { results: statement.all(...params), success: true as const, meta: { changes: 0 } };
        }
        const info = statement.run(...params);
        return { results: [], success: true as const, meta: { changes: info.changes } };
      };
      return {
        _execute: execute,
        run: async () => execute(),
        all: async () => execute(),
        first: async <T>() => (statement.get(...params) as T | undefined) ?? null,
      };
    };
    return {
      bind,
      run: () => bind().run(),
      all: () => bind().all(),
      first: <T>() => bind().first<T>(),
    };
  };
  return {
    prepare,
    batch: async (statements: BoundStatement[]) =>
      db.transaction(() => statements.map((statement) => statement._execute()))(),
  };
}



const MAPPING = [
  "# compiler: R8",
  "# pg_map_id: abc",
  "build.raft.app.Foo -> e74:",
  "# {\"id\":\"sourceFile\",\"fileName\":\"Foo.kt\"}",
  "    1:3:void run():10:12 -> i",
  "build.raft.app.Other -> x99:",
  "    void other() -> a",
  "build.raft.app.Bar -> x26:",
  "    1:1:void go():5:5 -> a",
  "",
].join("\n");
const TRACE = "Stack trace:\njava.lang.IllegalStateException: boom\n\tat e74.i(r8-map-id-abc:3)\n";

function environment() {
  const sqlite = new Database(":memory:");
  for (const name of readdirSync(MIGRATION_DIR).sort()) {
    if (name.endsWith(".sql")) sqlite.exec(readFileSync(`${MIGRATION_DIR}${name}`, "utf8"));
  }
  sqlite.exec(`
    INSERT INTO organizations (id, slug, name, external_provider, external_id, created_at) VALUES ('org', 'org', 'Org', 'raft', 'server', 1);
    INSERT INTO apps (id, org_id, slug, name, platform, client_key, created_at) VALUES ('app', 'org', 'a', 'A', 'android', 'k', 1);
    INSERT INTO builds (id, app_id, version_name, version_code, created_at, updated_at) VALUES ('build', 'app', '1.0', 7, 1, 1);
    INSERT INTO build_assets (id, build_id, platform, filetype, r2_key, file_hash, size_bytes, created_at, artifact_kind)
      VALUES ('mapping', 'build', 'android', 'txt', 'maps/7.txt', 'h', 1, 1, 'proguard-mapping');
    INSERT INTO feedback_tickets (id, app_id, kind, message, created_at, updated_at) VALUES ('t1', 'app', 'crash', 'm', 1, 1), ('t2', 'app', 'crash', 'm', 1, 1);
  `);
  const objects = new Map<string, Uint8Array>([
    ["maps/7.txt", new TextEncoder().encode(MAPPING)],
    ["logs/t.txt", new TextEncoder().encode(TRACE)],
  ]);
  const ranged: Array<{ key: string; offset: number; length: number }> = [];
  const env = {
    DB: d1(sqlite),
    APK_BUCKET: {
      put: async (key: string, value: string) => { objects.set(key, new TextEncoder().encode(value)); },
      get: async (key: string, options?: { range?: { offset: number; length: number } }) => {
        const value = objects.get(key);
        if (!value) return null;
        const bytes = options?.range ? value.subarray(options.range.offset, options.range.offset + options.range.length) : value;
        if (options?.range) ranged.push({ key, ...options.range });
        return { text: async () => new TextDecoder().decode(bytes), arrayBuffer: async () => bytes.slice().buffer };
      },
    },
    R2_S3_ENDPOINT: "https://r2.test",
    R2_BUCKET_NAME: "bucket",
    R2_S3_ACCESS_KEY_ID: "id",
    R2_S3_SECRET_ACCESS_KEY: "secret",
  } as unknown as Env;
  return { sqlite, env, objects, ranged };
}

describe("R8 mapping index", () => {
  it("is built once by the container, then used to send only the needed blocks", async () => {
    const h = environment();
    containerIndex = await indexMapping(Readable.from([Buffer.from(MAPPING)]));

    await retraceCrashTicket(h.env, "app", "t1", 7, "logs/t.txt");
    expect(requests[0]).toMatchObject({ build_index: true, trace: TRACE });
    expect(typeof requests[0]!.mapping_url).toBe("string");
    expect(new TextDecoder().decode(h.objects.get(mappingIndexKey("maps/7.txt")))).toBe(containerIndex);

    containerIndex = undefined;
    await retraceCrashTicket(h.env, "app", "t2", 7, "logs/t.txt");
    const second = requests[1]!;
    expect(second.mapping_url).toBeUndefined();
    expect(second.mapping).toBe([
      "# compiler: R8",
      "# pg_map_id: abc",
      "build.raft.app.Foo -> e74:",
      "# {\"id\":\"sourceFile\",\"fileName\":\"Foo.kt\"}",
      "    1:3:void run():10:12 -> i",
      "",
    ].join("\n"));
    expect(h.ranged.every((r) => r.key === "maps/7.txt")).toBe(true);
    const status = h.sqlite.prepare("SELECT symbolication_status FROM feedback_tickets WHERE id = 't2'").get() as { symbolication_status: string };
    expect(status.symbolication_status).toBe("symbolicated");
  });

  it("falls back to streaming when the index is not usable", async () => {
    const h = environment();
    requests.length = 0;
    h.objects.set(mappingIndexKey("maps/7.txt"), new TextEncoder().encode("not an index"));
    await retraceCrashTicket(h.env, "app", "t1", 7, "logs/t.txt");
    expect(requests[0]).toMatchObject({ build_index: false });
    expect(typeof requests[0]!.mapping_url).toBe("string");
  });

  it("rangesForTrace refuses malformed entries", () => {
    expect(rangesForTrace("r8index v1\nheader\t5\ne74\t5\t-1\n", "at e74.i")).toBeNull();
    expect(rangesForTrace("r8index v1\nheader\t5\nx\t5\t3\n", "at e74.i")).toEqual([{ offset: 0, length: 5 }]);
  });
});

describe("retraceInput", () => {
  it("keeps only the SDK's stack trace section", async () => {
    const { retraceInput } = await import("../src/lib/r8_mapping_index");
    const log = [
      "Crash log", "Package: build.raft.app", "Message: boom", "",
      "Stack trace:",
      "java.lang.IllegalStateException: boom",
      "\tat x26.c(r8-map-id-abc:3)",
      "\tSuppressed: kotlinx.coroutines.internal.DiagnosticCoroutineContextException: [x28@1]",
      "", "",
      "Process uptime: 1 ms", "",
      "All threads:", "  Thread main (RUNNABLE):", "\tat a.b(c:1)", "",
    ].join("\n");
    expect(retraceInput(log)).toBe([
      "Stack trace:",
      "java.lang.IllegalStateException: boom",
      "\tat x26.c(r8-map-id-abc:3)",
      "\tSuppressed: kotlinx.coroutines.internal.DiagnosticCoroutineContextException: [x28@1]",
      "",
    ].join("\n"));
  });

  it("falls back to the head of a log without the section", async () => {
    const { retraceInput } = await import("../src/lib/r8_mapping_index");
    expect(retraceInput("java.lang.X: y\n\tat a.b(c:1)\n")).toBe("java.lang.X: y\n\tat a.b(c:1)\n");
    const long = "line of text\n".repeat(5_000);
    const head = retraceInput(long);
    expect(head.length).toBeLessThanOrEqual(24_000);
    expect(head.endsWith("\n")).toBe(true);
    expect(retraceInput("Stack trace:\n\nrest")).toBe("Stack trace:\n\nrest");
  });
});

describe("filterClassBlock", () => {
  const block = [
    "androidx.compose.ui.node.LayoutNodeKt -> x26:",
    "# {\"id\":\"sourceFile\",\"fileName\":\"LayoutNode.kt\"}",
    "    1:3:void requireOwner(androidx.compose.ui.node.LayoutNode):10:12 -> c",
    "    4:4:void throwIllegal():40:40 -> c",
    "      # {\"id\":\"com.android.tools.r8.rewriteFrame\",\"conditions\":[\"throws(Ljava/lang/IllegalStateException;)\"],\"actions\":[\"removeInnerFrames(1)\"]}",
    "    5:9:void unrelated():50:54 -> d",
    "      # {\"id\":\"com.android.tools.r8.residualsignature\",\"signature\":\"()V\"}",
    "    int field -> e",
    "",
  ].join("\n");

  it("keeps the header, class metadata and the entered method's lines with their metadata", async () => {
    const { filterClassBlock } = await import("../src/lib/r8_mapping_index");
    expect(filterClassBlock(block, new Set(["c"]))).toBe([
      "androidx.compose.ui.node.LayoutNodeKt -> x26:",
      "# {\"id\":\"sourceFile\",\"fileName\":\"LayoutNode.kt\"}",
      "    1:3:void requireOwner(androidx.compose.ui.node.LayoutNode):10:12 -> c",
      "    4:4:void throwIllegal():40:40 -> c",
      "      # {\"id\":\"com.android.tools.r8.rewriteFrame\",\"conditions\":[\"throws(Ljava/lang/IllegalStateException;)\"],\"actions\":[\"removeInnerFrames(1)\"]}",
      "",
    ].join("\n"));
  });

  it("keeps only the header and class metadata for a class no frame enters", async () => {
    const { filterClassBlock } = await import("../src/lib/r8_mapping_index");
    expect(filterClassBlock(block, undefined)).toBe([
      "androidx.compose.ui.node.LayoutNodeKt -> x26:",
      "# {\"id\":\"sourceFile\",\"fileName\":\"LayoutNode.kt\"}",
      "",
    ].join("\n"));
  });

  it("reads frame methods per class", async () => {
    const { traceFrameMethods } = await import("../src/lib/r8_mapping_index");
    const methods = traceFrameMethods("java.lang.X: y\n\tat x26.c(r8-map-id-a:3)\n\tat x26.d(Unknown Source:1)\n\tat a.b.C$D.<init>(C.kt:1)\n");
    expect([...methods.get("x26")!]).toEqual(["c", "d"]);
    expect([...methods.get("a.b.C$D")!]).toEqual(["<init>"]);
  });
});
