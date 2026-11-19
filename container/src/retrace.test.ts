import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classHeaderTarget, filterMapping, indexMapping, traceNames } from "./retrace.js";

test("traceNames keeps dotted names and their prefixes", () => {
  const names = traceNames("java.lang.IllegalArgumentException: bad\n\tat e74.i(r8-map-id-ab:7)\n\tat a.b.C$D.m(Unknown Source)");
  for (const name of ["e74", "e74.i", "a", "a.b", "a.b.C$D", "a.b.C$D.m", "java.lang.IllegalArgumentException"]) {
    assert.ok(names.has(name), name);
  }
});

test("classHeaderTarget recognises only class header lines", () => {
  assert.equal(classHeaderTarget("com.example.Foo -> e74:"), "e74");
  assert.equal(classHeaderTarget("com.example.Foo$Bar -> a.b.c:"), "a.b.c");
  assert.equal(classHeaderTarget("    void run() -> i"), null);
  assert.equal(classHeaderTarget("# {\"id\":\"sourceFile\",\"fileName\":\"Foo.kt\"}"), null);
  assert.equal(classHeaderTarget("    1:2:void run():10:11 -> i"), null);
});

test("filterMapping keeps the header and only the blocks the trace names", async () => {
  const mapping = [
    "# compiler: R8",
    "# pg_map_id: abc",
    "com.example.Foo -> e74:",
    "# {\"id\":\"sourceFile\",\"fileName\":\"Foo.kt\"}",
    "    1:3:void run():10:12 -> i",
    "com.example.Other -> x99:",
    "    void other() -> a",
    "com.example.Bar -> x26:",
    "    1:1:void go():5:5 -> a",
    "",
  ].join("\n");
  const dir = await mkdtemp(join(tmpdir(), "retrace-test-"));
  try {
    const out = join(dir, "filtered.txt");
    const kept = await filterMapping(Readable.from([mapping]), out, traceNames("at e74.i(x:1)\nat x26.a(x:1)"));
    assert.equal(kept, 2);
    const text = await readFile(out, "utf8");
    assert.ok(text.startsWith("# compiler: R8\n# pg_map_id: abc\n"));
    assert.ok(text.includes("com.example.Foo -> e74:\n# {\"id\":\"sourceFile\""));
    assert.ok(text.includes("    1:3:void run():10:12 -> i"));
    assert.ok(text.includes("com.example.Bar -> x26:"));
    assert.ok(!text.includes("x99"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("indexMapping gives exact byte ranges that rebuild what filterMapping keeps", async () => {
  for (const eol of ["\n", "\r\n"]) {
    const mapping = [
      "# compiler: R8",
      "# pg_map_id: abc",
      "com.example.Föo -> e74:",
      "# {\"id\":\"sourceFile\",\"fileName\":\"Föo.kt\"}",
      "    1:3:void run():10:12 -> i",
      "com.example.Other -> x99:",
      "    void other() -> a",
      "com.example.Bar -> x26:",
      "    1:1:void go():5:5 -> a",
    ].join(eol);
    const bytes = Buffer.from(mapping);
    // Split mid-line and mid-character to exercise chunk boundaries.
    const chunks = [bytes.subarray(0, 7), bytes.subarray(7, 40), bytes.subarray(40, 41), bytes.subarray(41)];
    const index = await indexMapping(Readable.from(chunks));
    const lines = index.trimEnd().split("\n");
    assert.equal(lines[0], "r8index v1");
    const headerLength = Number(lines[1]!.split("\t")[1]);
    const blocks = new Map(lines.slice(2).map((l) => {
      const [name, off, len] = l.split("\t");
      return [name!, [Number(off), Number(len)] as const];
    }));
    assert.deepEqual([...blocks.keys()], ["e74", "x99", "x26"]);
    const total = [...blocks.values()].reduce((n, [, len]) => n + len, headerLength);
    assert.equal(total, bytes.length);

    const names = traceNames("at e74.i(x:1)\nat x26.a(x:1)");
    const rebuilt = Buffer.concat([
      bytes.subarray(0, headerLength),
      ...["e74", "x26"].map((n) => { const [off, len] = blocks.get(n)!; return bytes.subarray(off, off + len); }),
    ]).toString("utf8");
    const dir = await mkdtemp(join(tmpdir(), "retrace-index-"));
    try {
      const out = join(dir, "filtered.txt");
      await filterMapping(Readable.from([bytes]), out, names);
      const filtered = await readFile(out, "utf8");
      const normalise = (t: string) => t.replace(/\r\n/g, "\n").replace(/\n+$/, "");
      assert.equal(normalise(rebuilt), normalise(filtered));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("indexMapping of a mapping without classes is header only", async () => {
  const index = await indexMapping(Readable.from([Buffer.from("# compiler: R8\n")]));
  assert.equal(index, "r8index v1\nheader\t15\n");
});
