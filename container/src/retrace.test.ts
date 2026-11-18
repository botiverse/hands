import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classHeaderTarget, filterMapping, traceNames } from "./retrace.js";

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
